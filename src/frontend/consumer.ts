import { toast } from "sonner";
import {
  createQuickConnectHost,
  getDefaultConnectionTab,
  listHostProtocols,
} from "@termix-ssh/plugin-sdk/ui";
import {
  listCredentials,
  notifyHostsChanged as sdkNotifyHostsChanged,
} from "@termix-ssh/plugin-sdk/frontend";
import type {
  PluginApiClient,
  PluginCredentialSummary,
  PluginHostRecord,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  parseDeepLinkConnect,
  parseTermixLinkUrl,
  stripDeepLinkParams,
  type DeepLinkConnectIntent,
} from "./deep-link";
import {
  resolveConnectPlan,
  type AdoptRequest,
  type ConnectPlan,
  type DeepLinkProtocol,
} from "./connect-plan";

/**
 * Consumes a raw `?connect=` deep link at activate time, exactly once, inside
 * the real app shell. A browser `?view=` page never mounts the shell (its
 * shell callbacks are unbound there), so consumers only run on the normal
 * app — the standalone `?view=` page resolves its link itself, with the
 * honest landing below (`resolveStandaloneLanding`).
 *
 * Gating (ported from core's use-deep-link-connect):
 *  - `app.tabs.onReady` fires once the shell has restored its tabs after
 *    login (skipped when the layout is already up).
 *  - the host list resolves with rows and the host-protocol registry has
 *    entries, both read directly — both registries settle shortly after the
 *    plugin runtime starts, within the settle budget below.
 *
 * The URL is scrubbed of deep-link parameters before anything else happens,
 * so a refresh can never retrigger a consumed intent, and the consumed flag
 * is module-scoped so a disable/enable cycle cannot parse twice.
 *
 * Desktop `termix://` links (app.deepLinks, Termix 26.11.3) run through the
 * SAME plan and the SAME confirm: startTermixLinkConsumer parses each link
 * with parseTermixLinkUrl and feeds the shared runner below. The OS scheme is
 * attacker-reachable, so a link opens nothing and writes nothing before its
 * confirm is accepted — for both sources, "os-scheme" and "command-line".
 */
export interface DeepLinkConsumerSettings {
  /** Milliseconds to wait for the host list and protocol registry to settle. */
  settleBudgetMs?: number;
  /** Poll interval while settling and while polling for a default tab. */
  pollMs?: number;
  /** Milliseconds to poll the host-action registry for a default connection. */
  defaultTabBudgetMs?: number;
  /** Injected instead of DOM reads (tests); defaults to window functions. */
  env?: {
    locationSearch?: () => string;
    scrub?: (cleaned: string) => void;
  };
  /**
   * The plugin API client (adopt POST). Injected for tests; defaults to
   * the SDK bridge client for this plugin.
   */
  adoptApi?: () => PluginApiClient;
}

interface ResolvedSettings {
  settleBudgetMs: number;
  pollMs: number;
  defaultTabBudgetMs: number;
  adoptApi?: DeepLinkConsumerSettings["adoptApi"];
}

const DEFAULT_SETTLE_BUDGET_MS = 4000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_TAB_BUDGET_MS = 2000;

function resolveSettings(options: DeepLinkConsumerSettings): ResolvedSettings {
  return {
    settleBudgetMs: options.settleBudgetMs ?? DEFAULT_SETTLE_BUDGET_MS,
    pollMs: options.pollMs ?? DEFAULT_POLL_MS,
    defaultTabBudgetMs: options.defaultTabBudgetMs ?? DEFAULT_TAB_BUDGET_MS,
    adoptApi: options.adoptApi,
  };
}

/** Module-scoped guard: one search-param intent per page load, even across re-activates. */
let consumed = false;

/**
 * Desktop links this session has already enqueued (port of core's own guard
 * in use-host-links.ts: "Each link opens a host once, even when a remount
 * replays it"). Core's deep-links onOpen replays its ≤20 recent links to
 * EVERY new registration too, so a plugin disable/enable re-delivers them to
 * the re-registered consumer and each old link would re-confirm serially.
 * The check runs on link OBJECT identity — a fresh delivery of the same URL
 * is a new object and still runs.
 */
let handledTermixLinks = new WeakSet<object>();

function shellReady(app: TermixApp): Promise<void> {
  return new Promise((resolve) => {
    if (app.tabs.getLayout() !== null) {
      resolve();
      return;
    }
    const disposer = app.tabs.onReady(() => {
      disposer();
      resolve();
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits (up to ~3s) for a freshly written host row to show up in the live
 * host list, which can lag the write by a settle. Shared by the adopt-then-
 * connect tail of the shell consumer. Caller connects against the adopt
 * request's own shape when this comes back undefined.
 */
async function pollCreatedHost(
  app: TermixApp,
  createdHostId: number,
): Promise<PluginHostRecord | undefined> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const rows = await app.listHosts();
      const found = (Array.isArray(rows) ? rows : []).find(
        (row) => String(row.id) === String(createdHostId),
      );
      if (found) return found;
    } catch {
      // list can lag one settle behind; retry briefly.
    }
    await sleep(300);
  }
  return undefined;
}

/**
 * Runs the full consume pipeline for one parsed browser search string once
 * the shell is ready and the registries settled. Kept as the search-string
 * entry the tests drive: parse, then the shared intent runner.
 */
export async function consumeDeepLink(
  app: TermixApp,
  search: string,
  settings: Required<
    Pick<
      DeepLinkConsumerSettings,
      "settleBudgetMs" | "pollMs" | "defaultTabBudgetMs"
    >
  > & { adoptApi?: DeepLinkConsumerSettings["adoptApi"] },
): Promise<void> {
  const intent = parseDeepLinkConnect(search);
  if (!intent) return;
  await runConnectIntent(app, intent, {
    settleBudgetMs: settings.settleBudgetMs,
    pollMs: settings.pollMs,
    defaultTabBudgetMs: settings.defaultTabBudgetMs,
    adoptApi: settings.adoptApi,
  });
}

/** Hosts, credentials and protocols an intent resolves against, settled. */
interface PlanContext {
  hosts: PluginHostRecord[];
  credentials: PluginCredentialSummary[];
  protocols: DeepLinkProtocol[];
}

/**
 * Settles the context an intent resolves against: shell readiness plus the
 * host list and the host-protocol registry. Both registries fill shortly
 * after the plugin runtime starts, within the settle budget below.
 * Shared by the browser search consumer and the desktop termix:// consumer.
 */
async function settlePlanContext(
  app: TermixApp,
  intent: DeepLinkConnectIntent,
  settings: ResolvedSettings,
): Promise<PlanContext> {
  await shellReady(app);

  // Settle: a host row plus at least one registered protocol. Both registries
  // fill shortly after the plugin runtime starts; a user with no hosts at all
  // falls through when the budget is up (the ad-hoc path needs no hosts).
  let hosts: PluginHostRecord[] = [];
  let credentials: PluginCredentialSummary[] = [];
  let protocols: DeepLinkProtocol[] = [];
  const deadline = Date.now() + settings.settleBudgetMs;
  while (true) {
    try {
      const next = await app.listHosts();
      if (Array.isArray(next)) hosts = next;
    } catch {
      // Not signed in to the host list yet; retry until the budget is spent.
      // A persistent failure keeps hosts empty and surfaces toasts below.
    }
    protocols = listHostProtocols() as unknown as DeepLinkProtocol[];
    if ((hosts.length > 0 && protocols.length > 0) || Date.now() >= deadline) {
      break;
    }
    await sleep(settings.pollMs);
  }
  if (intent.credentialName) {
    try {
      const rows = await listCredentials();
      credentials = Array.isArray(rows) ? rows : [];
    } catch {
      credentials = [];
    }
  }
  return { hosts, credentials, protocols };
}

/**
 * Runs the full consume pipeline for one parsed intent once the shell is
 * ready and the registries settled. Shared by the browser search consumer
 * and the desktop termix:// link consumer. Exported only for tests.
 */
export async function runConnectIntent(
  app: TermixApp,
  intent: DeepLinkConnectIntent,
  settings: ResolvedSettings,
): Promise<void> {
  const t = app.t;

  const { hosts, credentials, protocols } = await settlePlanContext(
    app,
    intent,
    settings,
  );

  const plan = resolveConnectPlan({
    intent,
    hosts,
    credentials,
    protocols,
    buildQuickConnect: createQuickConnectHost,
  });
  if (plan.status === "hostNotFound") {
    toast.error(t("deepLink.hostNotFound", { host: intent.hostName }));
    return;
  }
  if (plan.status === "typeUnknown") {
    toast.error(t("deepLink.typeUnknown", { type: intent.type ?? "" }));
    return;
  }
  if (plan.status === "credentialNotFound") {
    toast.error(
      t("deepLink.credentialNotFound", { name: intent.credentialName ?? "" }),
    );
    return;
  }
  await confirmAndConnect(app, plan, settings, intent);
}

/**
 * The shell's host store refreshes only on these window events (its own
 * create/edit flows dispatch them; a plugin-side create/update broadcast
 * reaches it through none of them from the plugin's own document). On core
 * 26.11.3 a plugin frontend usually runs in a sandboxed frame whose window
 * is NOT the shell's window — there the SDK's `notifyHostsChanged()` (the
 * bridge calls `hosts.changed` host-side, and core dispatches the same
 * event on the shell's window and reloads the host list) is the call that
 * actually reaches the store. Both paths run; each is a no-op where it
 * does not apply.
 */
export function notifyShellHostsChanged(): void {
  if (typeof window !== "undefined") {
    for (const name of ["termix:hosts-changed", "ssh-hosts:changed"]) {
      try {
        window.dispatchEvent(new CustomEvent(name));
      } catch {
        // A stub env without CustomEvent; nothing to do — the plain flow runs.
      }
    }
  }
  try {
    sdkNotifyHostsChanged();
  } catch {
    // An unbridged SDK host: the window events above still work when this
    // code runs inside the shell's own document.
  }
}

/** A remote-desktop protocol the consumer can ensure on an existing host. */
type EnsureProtocol = "vnc" | "rdp";

function isEnsureProtocol(type: string): type is EnsureProtocol {
  return type === "vnc" || type === "rdp";
}

/**
 * A confirmed VNC/RDP link against a saved host may need its protocol's
 * connect action to exist: the action is allowed by remote-desktop's own
 * host settings, which a vnc login never implies. The record the connector
 * reads cannot show another plugin's settings, so the rule is:
 *  - records this plugin made (or an earlier release of it made, in the same
 *    neutral folder/tag shape) get ensured under ONE confirm — the plain
 *    saved-open confirm — and the update rides right behind it;
 *  - a user's own record without a protocol login gets one update confirm
 *    ("Update & connect") that carries the consent for both;
 *  - anything else shaped by the user is left exactly as it is.
 * The route itself re-checks ownership and refuses what it may not edit.
 *
 * Returns true when this function handled the whole flow (dialog, ensure and
 * connect) — the caller must not run the plain saved flow as well.
 */
async function maybeEnsureSavedHost(
  app: TermixApp,
  plan: ConnectPlan,
  intent: DeepLinkConnectIntent,
  settings: ResolvedSettings,
): Promise<boolean> {
  const t = app.t;
  const type = intent.type;
  if (!type || !isEnsureProtocol(type)) return false;
  const host = plan.host;
  if (!host || !host.id) return false;
  const recordHasLogin = !!host.protocolAuth?.[type];
  const pluginMade =
    host.folder === "Ad-Hoc Hosts" &&
    (Array.isArray(host.tags) ? host.tags : []).includes("ad-hoc");
  if (recordHasLogin && !pluginMade) {
    // The session will use the record's own protocol login (which may differ
    // from the link's credential) — the plain flow must say so.
    if (plan.dialog) plan.dialog.protocolSaved = true;
    return false;
  }

  const credential = plan.dialog?.credential;
  if (!credential || typeof credential.id !== "number") return false;
  const hostLabel = String(host.name ?? host.ip ?? "");

  // Consent first, and exactly one dialog. A plugin-made record gets its own
  // plain open confirm (the same one the plain flow would show) before the
  // ensure rides in; a user-shaped record gets the update confirm instead.
  if (pluginMade) {
    const parts = [
      t("deepLink.confirmDescription", { host: host.ip ?? hostLabel }),
    ];
    parts.push(t("deepLink.credentialNote", { name: credential.name }));
    const ok = await app.confirm({
      title: t("deepLink.confirmTitle", { host: hostLabel }),
      description: parts.join(" "),
      confirmLabel: t("deepLink.openAction"),
      destructive: false,
    });
    if (!ok) return true; // declined: nothing opens, nothing changes
  } else {
    const ok = await app.confirm({
      title: t("deepLink.adoptUpdateTitle", { host: hostLabel }),
      description: t("deepLink.adoptUpdateDescription", {
        host: hostLabel,
        protocol: type.toUpperCase(),
        name: credential.name,
      }),
      confirmLabel: t("deepLink.adoptUpdateAction"),
      destructive: false,
    });
    if (!ok) return true; // declined: nothing opens, nothing changes
  }

  const api = (settings.adoptApi?.() ?? app.api) as PluginApiClient | undefined;
  if (!api || typeof api.post !== "function") return false;
  try {
    await api.post("/adopt", {
      hostName: hostLabel,
      type,
      credentialId: credential.id,
      // The record's own port belongs to its PRIMARY protocol (a VNC-create
      // record holds 5900); a cross-protocol link without an explicit port
      // must NOT inherit it or the ensure writes rdpPort: 5900 and RDP
      // negotiates against the VNC server. Omitted port = the route resolves
      // the protocol's default.
      ...(intent.port ? { port: intent.port } : {}),
      // RDP's AD domain must ride the ensure the same way it rides the
      // create: the link names it, the login stores it by reference.
      ...(intent.domain ? { domain: intent.domain } : {}),
      // Only records the plugin itself made may have their SSH toggle
      // reaffirmed off; a user-shaped record keeps every toggle it has.
      ...(pluginMade ? { sshOff: true } : {}),
    });
  } catch {
    // Non-fatal: the route may have refused (a shared host it cannot edit).
    // Whatever login the record has is what the session will ride.
    if (plan.dialog) plan.dialog.protocolSaved = recordHasLogin;
    return false; // the plain saved flow decides below
  }
  if (!recordHasLogin) {
    toast.success(t("deepLink.adoptUpdated", { host: hostLabel }));
  }
  // Wake the shell's host store so the tab below (and its 3s grace window)
  // resolves the just-written record: the gate, the tab's useHost and the
  // per-protocol logins all read the store this event refreshes.
  notifyShellHostsChanged();
  // Open the intended protocol DIRECTLY: connectHost's action gate reads the
  // shell's store, which can lag the write we just performed, and its
  // fallback would open whichever protocol the store already knows instead
  // of the one the link asked for. The session resolves server-side by host
  // id, where (after this POST) the protocol's toggle, port and login are
  // current.
  // One beat for the store reload we just triggered to land.
  await sleep(300);
  app.tabs.openTab(host as PluginHostRecord, type, { label: hostLabel });
  return true;
}

async function confirmAndConnect(
  app: TermixApp,
  plan: ConnectPlan,
  settings: ResolvedSettings,
  intent?: DeepLinkConnectIntent,
): Promise<void> {
  const t = app.t;
  const dialog = plan.dialog!;
  const adopt = dialog.adopt;
  if (adopt) {
    const outcome = await confirmAdoptAndConnect(app, adopt, dialog, settings);
    if (outcome === "handled") return;
    // The create was unavailable (fallback): the ad-hoc quick connect under
    // the plan still runs — the interactive session instead of the saved one.
    // Surface the credential as not carried ONLY when it does not already
    // ride by id: a plugin-protocol fallback record carries
    // quickConnectLogin.credentialId and the server resolves the login,
    // so there is nothing to prompt for.
    if (
      dialog.credential &&
      !dialog.credentialNotCarried &&
      !dialog.credentialRides
    ) {
      dialog.credentialNotCarried = {
        name: dialog.credential.name,
        protocol: adopt.type,
      };
    }
  } else if (plan.status === "saved" && intent) {
    // A VNC/RDP link against a saved host: make sure the record covers the
    // protocol before the connect (the route repairs what its records may
    // miss; a user's own shaped record stays untouched).
    let handled = false;
    try {
      handled = await maybeEnsureSavedHost(app, plan, intent, settings);
    } catch {
      // Non-fatal: the plain saved flow decides below.
    }
    if (handled) return;
  }
  await connectResolvedPlan(app, plan, settings, /* confirmFirst */ true);
}

/**
 * Adoption: the plan says this link can become a saved host in the
 * "Ad-Hoc Hosts" folder (credential attached by id, never a secret), which
 * lets the connect ride the supported saved-host path — real connections
 * with server-side credential resolution instead of an interactive prompt.
 */
type AdoptOutcome = "handled" | "fallback";

async function confirmAdoptAndConnect(
  app: TermixApp,
  adopt: AdoptRequest,
  dialog: NonNullable<ConnectPlan["dialog"]>,
  settings: ResolvedSettings,
): Promise<AdoptOutcome> {
  const t = app.t;
  if (!dialog.credential) return "fallback";
  // The app object the shell hands to activate carries a non-hook API client
  // (usePluginApi() is a React hook and throws in module-scope code like
  // this), so route POSTs go through `app.api`.
  const api = (settings.adoptApi?.() ?? app.api) as PluginApiClient | undefined;
  if (!api || typeof api.post !== "function") return "fallback";

  const ok = await app.confirm({
    title: t("deepLink.adoptTitle", { host: dialog.address }),
    description: t("deepLink.adoptDescription", {
      host: dialog.address,
      name: dialog.credential.name,
    }),
    confirmLabel: t("deepLink.adoptAction"),
    destructive: false,
  });
  // Declined: the user said no — nothing opens, not even the ad-hoc fallback.
  if (!ok) return "handled";

  let createdHostId: number | null = null;
  try {
    const { data } = await api.post<{
      created: boolean;
      hostId: number;
      reason?: string;
    }>("/adopt", {
      hostName: adopt.hostName,
      type: adopt.type,
      credentialId: adopt.credentialId,
      port: adopt.port,
      ...(adopt.domain ? { domain: adopt.domain } : {}),
    });
    createdHostId = data.hostId ?? null;
  } catch {
    // No adopt route (older core) or refused: note it and keep the ad-hoc
    // fallback instead of dying silently.
    toast.error(t("deepLink.adoptUnavailable"));
    return "fallback";
  }
  if (createdHostId === null) return "fallback";
  // Wake the shell's host store so tabs opened below can resolve the row.
  notifyShellHostsChanged();

  // The saved host now exists; find it and connect through the saved flow
  // (server-side credential expansion — the secret never leaves Termix). The
  // list can lag a few seconds behind the write, so poll long enough for the
  // row to surface, and if it still is not listable, connect against the
  // record shape we wrote — every field comes from the adopt request itself.
  const created = await pollCreatedHost(app, createdHostId);
  const hostToConnect: PluginHostRecord =
    created ??
    ({
      id: String(createdHostId),
      name: adopt.hostName,
      ip: adopt.hostName,
      port: adopt.port,
      connectionType: adopt.type,
    } as PluginHostRecord);
  toast.success(t("deepLink.adoptCreated", { host: adopt.hostName }));

  // Open the intended protocol DIRECTLY instead of riding connectHost's
  // action gate: the gate reads the shell's own host store, which can lag the
  // write we just made, and its fallback then opens a DIFFERENT protocol's
  // session (VNC link opens the RDP record, or nothing at all). The tab
  // itself resolves the session server-side by host id, where our record is
  // already fully written. SSH keeps the terminal hand-off (its gate is
  // trivially true and the terminal needs no per-protocol toggle).
  const label = hostToConnect.name ?? adopt.hostName;
  if (adopt.type !== "ssh") {
    app.tabs.openTab(hostToConnect, adopt.type);
    return "handled";
  }
  const savedPlan: ConnectPlan = {
    status: "saved",
    host: hostToConnect,
    typeToPass: "terminal",
    dialog: {
      saved: true,
      hostLabel: label,
      address: String(hostToConnect.ip ?? label),
      credential: dialog.credential,
      viewOnly: dialog.viewOnly,
      // The saved flow's session rides the host record, not the link: the
      // view-only request stays a NOTE on this path (see connect-plan).
    },
  };
  await connectResolvedPlan(app, savedPlan, settings, /* confirmFirst */ false);
  return "handled";
}

/**
 * Presents the plan's confirm dialog (skippable — adoption already got one)
 * and opens the session. The shared tail of both the ad-hoc and the saved
 * flow; failures surface as toasts, never silent voids.
 */
async function connectResolvedPlan(
  app: TermixApp,
  plan: ConnectPlan,
  settings: ResolvedSettings,
  confirmFirst: boolean,
): Promise<void> {
  const t = app.t;
  const dialog = plan.dialog!;
  if (confirmFirst) {
    const parts: string[] = [
      t("deepLink.confirmDescription", { host: dialog.address }),
    ];
    if (dialog.saved && dialog.credential) {
      parts.push(
        dialog.protocolSaved
          ? t("deepLink.hostCredentialNote")
          : t("deepLink.credentialNote", { name: dialog.credential.name }),
      );
    }
    if (!dialog.saved && dialog.credential) {
      parts.push(
        dialog.credentialNotCarried
          ? t("deepLink.adhocCredentialNote", {
              name: dialog.credentialNotCarried.name,
              protocol: (dialog.credentialNotCarried.protocol ??
                "ssh") as string,
            })
          : t("deepLink.credentialNote", { name: dialog.credential.name }),
      );
    }
    if (dialog.viewOnly) {
      parts.push(
        t(
          dialog.viewOnlyApplied
            ? "deepLink.viewOnlyNote"
            : "deepLink.viewOnlySavedNote",
        ),
      );
    }
    const ok = await app.confirm({
      title: t(dialog.saved ? "deepLink.confirmTitle" : "deepLink.adhocTitle", {
        host: dialog.hostLabel,
      }),
      description: parts.join(" "),
      confirmLabel: t("deepLink.openAction"),
      destructive: false,
    });
    if (!ok) return;
  }

  const host = plan.host! as Parameters<typeof app.tabs.connectHost>[0];
  // Pass the type through only for REGISTERED plugin protocols (rdp, vnc,
  // ...). "ssh" has no tab type of its own — the ssh-terminal plugin
  // registers "terminal" — so plain ssh opens the host's default connection.
  if (plan.typeToPass) {
    app.tabs.connectHost(host, plan.typeToPass);
    return;
  }
  // The default connection comes from the host-action registry, which plugin
  // frontends fill shortly after the runtime settles. Poll briefly rather
  // than silently opening nothing.
  const steps = Math.max(
    1,
    Math.round(settings.defaultTabBudgetMs / settings.pollMs),
  );
  for (let attempt = 0; attempt < steps; attempt++) {
    await sleep(settings.pollMs);
    const resolved = getDefaultConnectionTab(host as never);
    if (resolved) {
      app.tabs.connectHost(host, resolved);
      return;
    }
  }
  toast.error(t("deepLink.connectFailed"));
}

/**
 * What the standalone `?view=` page can honestly do with a confirmed link:
 *  - "saved": the link matched a real saved host (read from the live host
 *    list, which works inside a frame). Nothing opens from a frame — shell
 *    callbacks are unbound and the host store is empty on that page, so
 *    every tabs.* call dead-ends unobservably — the landing is Termix
 *    itself, where the user starts the session from the Hosts list.
 *  - "adopted": the consented adoption POST verified (2xx with a host id —
 *    created now, or an existing record matched/updated). Same landing.
 *  - "cannotAdopt": ad-hoc, but nothing can be attached or saved (no usable
 *    `credential=`) and the frame bridge has no id-less open path — the view
 *    refuses in place.
 *  - "adoptFailed": the POST failed or its response carried no host id —
 *    no navigation, no "saved" claim.
 *  - "unresolved": host, credential or type never resolved (or the live
 *    surfaces could not be read — a type outside the adopt route's set, the
 *    only set this registry-less page can adopt for, refuses here too); the
 *    view explains and nothing happens.
 */
export type StandaloneLanding =
  | { kind: "saved"; hostLabel: string }
  | { kind: "adopted"; hostLabel: string }
  | { kind: "cannotAdopt" }
  | { kind: "adoptFailed" }
  | {
      kind: "unresolved";
      reason:
        | "hostNotFound"
        | "credentialNotFound"
        | "typeUnknown"
        | "listUnavailable";
    };

/** How long the landing may wait for the live host list / protocol registry. */
const STANDALONE_SETTLE_MS = 1500;

/**
 * The credential list for the landing. The SDK module is the real surface
 * (SDK 2.11.0); an app-level list is honored first when the runtime bridges
 * one, which is also the seam test doubles use. Both are redacted summaries
 * — a name, an optional username, never a secret.
 */
async function listCredentialsForLanding(
  app: TermixApp,
): Promise<PluginCredentialSummary[]> {
  const member = (
    app as {
      listCredentials?: () => Promise<unknown>;
    }
  ).listCredentials;
  if (typeof member === "function") {
    try {
      const rows = await member.call(app);
      if (Array.isArray(rows)) return rows as PluginCredentialSummary[];
    } catch {
      return [];
    }
  }
  try {
    const rows = await listCredentials();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * The standalone `?view=` page's landing resolver — runs on the user's
 * confirm click, AFTER the styled card was accepted (the one consent of the
 * whole flow). Same plan as the shell consumer (resolveConnectPlan), but the
 * frame reality shapes the tail:
 *  - the live `listHosts` / `listCredentials` fetches verify what the link
 *    resolves against (a frame can fetch; it cannot open sessions);
 *  - the adoption POST is the ONLY write, and it is only trusted when its
 *    response hands back a host id;
 *  - the protocol registry is NEVER consulted: on the `?view=` page the
 *    shell never mounts, so the shell-fed protocol registry (like the host
 *    store) never populates and settle-polling it could only burn its whole
 *    budget and then wrongly refuse. Ad-hoc intents with an explicit type
 *    classify for ADOPTION by the link's own type instead
 *    (classifyAdoptByIntentType) and the backend route validates
 *    connectionType itself (accepted set: ssh, vnc, rdp — `ADOPTABLE_TYPES`
 *    in src/backend/adopt.ts, mirrored in connect-plan); a type outside
 *    that set never adopts and still refuses as typeUnknown;
 *  - this path NEVER calls `tabs.connectHost`/`tabs.openTab`: on the
 *    standalone page those bridges dead-end host-side and their rejections
 *    are unobservable, so a "success" read off them would be a lie. The app-
 *    root tab and the finish card are the view's job, not this resolver's.
 */
export async function resolveStandaloneLanding(
  app: TermixApp,
  intent: DeepLinkConnectIntent,
  options: Pick<DeepLinkConsumerSettings, "adoptApi"> = {},
): Promise<StandaloneLanding> {
  if (!app || typeof app.listHosts !== "function") {
    return { kind: "unresolved", reason: "listUnavailable" };
  }
  // An explicit ad-hoc link never reads hosts; every other link needs the
  // live list and refuses to claim anything while it stays unreadable.
  let hosts: PluginHostRecord[] = [];
  if (intent.using !== "adhoc") {
    let answered = false;
    const deadline = Date.now() + STANDALONE_SETTLE_MS;
    while (true) {
      try {
        const rows = await app.listHosts();
        if (Array.isArray(rows)) {
          hosts = rows;
          answered = true;
        }
      } catch {
        // The list can lag one settle behind; retry until the budget is spent.
      }
      if (answered || Date.now() >= deadline) break;
      await sleep(150);
    }
    if (!answered) return { kind: "unresolved", reason: "listUnavailable" };
  }
  let credentials: PluginCredentialSummary[] = [];
  if (intent.credentialName) {
    credentials = await listCredentialsForLanding(app);
  }
  // The protocol registry is deliberately NOT polled on this path (unlike
  // settlePlanContext): on the standalone `?view=` page the shell never
  // mounts, so the shell-fed protocol registry (like the host store) never
  // populates — a settle poll can only burn its whole budget and then
  // wrongly refuse links the adopt route can serve. ADOPTION writes a host
  // record only, and the backend route validates connectionType itself
  // (accepted set: ssh, vnc, rdp — `ADOPTABLE_TYPES` in
  // src/backend/adopt.ts, mirrored in connect-plan), so ad-hoc intents with
  // an explicit type classify for ADOPTION by the link's own type.
  // typeUnknown stays the refusal for types outside that set, exactly like
  // a type the grammar cannot parse — there is no further client-side type
  // list beyond those mirrors. The hosts/credentials settle above is
  // untouched: saved-host matches and credential names still resolve
  // against the live surfaces. The DESKTOP and shell consumers keep their
  // registry settle (settlePlanContext) — those contexts really do have one.
  const plan = resolveConnectPlan({
    intent,
    hosts,
    credentials,
    // The view's registry is always empty (shell-fed, never mounts here);
    // intent-classified adoptions skip it entirely.
    protocols: [],
    buildQuickConnect: createQuickConnectHost,
    classifyAdoptByIntentType: true,
  });
  if (plan.status === "hostNotFound") {
    return { kind: "unresolved", reason: "hostNotFound" };
  }
  if (plan.status === "typeUnknown") {
    return { kind: "unresolved", reason: "typeUnknown" };
  }
  if (plan.status === "credentialNotFound") {
    return { kind: "unresolved", reason: "credentialNotFound" };
  }
  if (plan.status === "saved") {
    const recordName = (plan.host as PluginHostRecord | undefined)?.name;
    return {
      kind: "saved",
      hostLabel:
        typeof recordName === "string" && recordName
          ? recordName
          : intent.hostName,
    };
  }
  // Ad-hoc: the only write this surface can honestly complete is the adopt
  // POST, and only when the plan built a verified adopt request. A
  // credential-less address (nothing to attach or save) refuses here; a type
  // the route cannot create already refused above as typeUnknown.
  const adopt = plan.dialog?.adopt;
  if (!adopt) {
    return { kind: "cannotAdopt" };
  }
  const api = (options.adoptApi?.() ?? app.api) as PluginApiClient | undefined;
  if (!api || typeof api.post !== "function") {
    return { kind: "adoptFailed" };
  }
  let savedName = adopt.hostName;
  try {
    const { data } = await api.post<{
      created: boolean;
      hostId: number | string;
      reason?: string;
      hostName?: string;
      error?: string;
    }>("/adopt", {
      hostName: adopt.hostName,
      type: adopt.type,
      credentialId: adopt.credentialId,
      // An intent-classified adoption (the view has no registry) carries no
      // default port: omitting it lets the route apply its own protocol
      // default (22/5900/3389 — the route's `DEFAULT_PORTS`) server-side.
      ...(adopt.port === undefined ? {} : { port: adopt.port }),
      ...(adopt.domain ? { domain: adopt.domain } : {}),
    });
    // The response IS the verification: a host id (created now, or an
    // existing record matched/updated) is the only trusted "saved" fact.
    const hostId = data?.hostId;
    if (hostId === null || hostId === undefined || String(hostId) === "") {
      return { kind: "adoptFailed" };
    }
    if (typeof data?.hostName === "string" && data.hostName) {
      savedName = data.hostName;
    }
  } catch {
    // Route unavailable or refused: an error card, no navigation, no claim.
    return { kind: "adoptFailed" };
  }
  // Wake the shell's host store both ways (window events + the SDK bridge —
  // a frame runs in its own window, so the events alone never reach the
  // shell), so the app the user is about to open can list the record.
  notifyShellHostsChanged();
  return { kind: "adopted", hostLabel: savedName };
}

/**
 * Registers the activate-time consumer for browser `?connect=` links. Call
 * once from `activate`. No-ops when the page has no search string at all —
 * core 26.11.3 runs this frontend in a sandboxed frame whose URL carries no
 * query and forwards none of the page's search to background frames, so an
 * empty search means this context cannot receive a web link; the standalone
 * `?view=deep-connect` page is the web consumer there. A NON-empty search (a
 * context that really carries the link) still consumes as before, except on
 * a standalone `?view=` URL (the hand-off component owns it) — or without a
 * connect parameter, or when an intent was already consumed.
 */
export function startDeepLinkConsumer(
  app: TermixApp,
  options: DeepLinkConsumerSettings = {},
): void {
  const env = options.env ?? {};
  if (consumed) return;
  const search = (env.locationSearch ?? (() => window.location.search))();
  if (!search) return;
  const params = new URLSearchParams(search);
  // The standalone hand-off page owns deep-link params on a ?view= URL.
  if (params.has("view")) return;
  const cleaned = stripDeepLinkParams(search);
  if (cleaned !== search) {
    const scrub =
      env.scrub ??
      ((next: string) => {
        window.history.replaceState(
          window.history.state,
          "",
          window.location.pathname + next + window.location.hash,
        );
      });
    scrub(cleaned);
  }
  const intent = parseDeepLinkConnect(search);
  if (!intent) return;
  consumed = true;
  void runConnectIntent(app, intent, resolveSettings(options));
}

/**
 * Registers the activate-time consumer for desktop `termix://` links
 * (app.deepLinks, Termix 26.11.3). No-op when the shell does not expose the
 * seam (a web browser never has termix:// links — `app.deepLinks` is
 * undefined there). Core replays links that arrived before registration, so
 * a link the desktop app was opened with still lands; links run one at a
 * time in arrival order, and EVERY parsed link still confirms first. Core
 * replays to every NEW registration as well (a plugin disable/enable
 * re-delivers its recent links), so a link object already enqueued this
 * session is dropped before the replay promise chain instead of
 * re-confirming. Core's own termix://host/<id> form is core's —
 * parseTermixLinkUrl ignores it.
 */
export function startTermixLinkConsumer(
  app: TermixApp,
  options: DeepLinkConsumerSettings = {},
): void {
  const deepLinks = app.deepLinks;
  if (!deepLinks || typeof deepLinks.onOpen !== "function") return;
  const settings = resolveSettings(options);
  let chain: Promise<void> = Promise.resolve();
  const disposer = deepLinks.onOpen((link) => {
    const intent = parseTermixLinkUrl(link?.url ?? "");
    if (!intent) return; // termix://host/<id> and anything unparsable
    // Replay dedup BEFORE the promise chain, in arrival order: a link object
    // core already handed to a listener this session runs at most once, so a
    // disable/enable replay does not re-confirm consumed links.
    if (handledTermixLinks.has(link)) return;
    handledTermixLinks.add(link);
    chain = chain.then(async () => {
      try {
        await runConnectIntent(app, intent, settings);
      } catch {
        // One failed link must not poison the queue for the next one.
      }
    });
  });
  app.onDispose?.(disposer);
}

/** Test seam: forget the module-scoped consumption guards and replay dedup. */
export function resetDeepLinkConsumerForTests(): void {
  consumed = false;
  handledTermixLinks = new WeakSet<object>();
}
