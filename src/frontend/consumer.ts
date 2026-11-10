import { toast } from "sonner";
import {
  createQuickConnectHost,
  getDefaultConnectionTab,
  listHostProtocols,
} from "@termix-ssh/plugin-sdk/ui";
import { listCredentials } from "@termix-ssh/plugin-sdk/frontend";
import type {
  PluginApiClient,
  PluginCredentialSummary,
  PluginHostRecord,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  parseDeepLinkConnect,
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
 * app — that is why the standalone hand-off page relaunches the app first.
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

const DEFAULT_SETTLE_BUDGET_MS = 4000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_TAB_BUDGET_MS = 2000;

/** Module-scoped guard: one intent per page load, even across re-activates. */
let consumed = false;

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
 * Runs the full consume pipeline once the shell is ready and the registries
 * settled. Exported only for tests; use {@link startDeepLinkConsumer}.
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
  const t = app.t;

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
 * create/edit flows dispatch them; a plugin-side write reaches it through
 * none). A tab opened right after an adoption or an ensure reads that store
 * (GuacamoleApp's useHost), so without the event it races a stale store and
 * can give up with "host not found". Two names because the shell listens for
 * both.
 */
function notifyShellHostsChanged(): void {
  if (typeof window === "undefined") return;
  for (const name of ["termix:hosts-changed", "ssh-hosts:changed"]) {
    try {
      window.dispatchEvent(new CustomEvent(name));
    } catch {
      // A stub env without CustomEvent; nothing to do — the plain flow runs.
    }
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
  settings: { pollMs: number; defaultTabBudgetMs: number; adoptApi?: DeepLinkConsumerSettings["adoptApi"] },
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
      port: intent.port ?? host.port,
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
  app.tabs.openTab(
    host as PluginHostRecord,
    type,
    { label: hostLabel },
  );
  return true;
}

async function confirmAndConnect(
  app: TermixApp,
  plan: ConnectPlan,
  settings: { pollMs: number; defaultTabBudgetMs: number; adoptApi?: DeepLinkConsumerSettings["adoptApi"] },
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
    // Surface the credential as not carried, same as plan v1 would.
    if (dialog.credential && !dialog.credentialNotCarried) {
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
  settings: { pollMs: number; defaultTabBudgetMs: number; adoptApi?: DeepLinkConsumerSettings["adoptApi"] },
): Promise<AdoptOutcome> {
  const t = app.t;
  if (!dialog.credential) return "fallback";
  // The app object the shell hands to activate carries a non-hook API client
  // (usePluginApi() is a React hook and throws in module-scope code like
  // this), so route POSTs go through `app.api`.
  const api = (settings.adoptApi?.() ?? app.api) as
    | PluginApiClient
    | undefined;
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
  const created = await (async () => {
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
  })();
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
  settings: { pollMs: number; defaultTabBudgetMs: number },
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
    if (dialog.credentialNotCarried) {
      parts.push(
        t("deepLink.adhocCredentialNote", {
          name: dialog.credentialNotCarried.name,
          protocol: (dialog.credentialNotCarried.protocol ?? "ssh") as string,
        }),
      );
    }
    if (dialog.viewOnly) {
      parts.push(t("deepLink.viewOnlyNote"));
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
 * Registers the activate-time consumer. Call once from `activate`. No-ops on
 * a standalone `?view=` page (the hand-off component owns that URL), without
 * a connect parameter, or when an intent was already consumed.
 */
export function startDeepLinkConsumer(
  app: TermixApp,
  options: DeepLinkConsumerSettings = {},
): void {
  const env = options.env ?? {};
  if (consumed) return;
  const search = (env.locationSearch ?? (() => window.location.search))();
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
  void consumeDeepLink(app, search, {
    settleBudgetMs: options.settleBudgetMs ?? DEFAULT_SETTLE_BUDGET_MS,
    pollMs: options.pollMs ?? DEFAULT_POLL_MS,
    defaultTabBudgetMs: options.defaultTabBudgetMs ?? DEFAULT_TAB_BUDGET_MS,
    adoptApi: options.adoptApi,
  });
}

/** Test seam: forget the module-scoped consumption guard. */
export function resetDeepLinkConsumerForTests(): void {
  consumed = false;
}
