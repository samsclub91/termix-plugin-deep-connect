import { toast } from "sonner";
import {
  createQuickConnectHost,
  getDefaultConnectionTab,
  listHostProtocols,
} from "@termix-ssh/plugin-sdk/ui";
import { listCredentials } from "@termix-ssh/plugin-sdk/frontend";
import type {
  PluginCredentialSummary,
  PluginHostRecord,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { parseDeepLinkConnect, stripDeepLinkParams } from "./deep-link";
import {
  resolveConnectPlan,
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
  >,
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
  await confirmAndConnect(app, plan, settings);
}

async function confirmAndConnect(
  app: TermixApp,
  plan: ConnectPlan,
  settings: { pollMs: number; defaultTabBudgetMs: number },
): Promise<void> {
  const t = app.t;
  const dialog = plan.dialog!;
  const parts: string[] = [
    t("deepLink.confirmDescription", { host: dialog.address }),
  ];
  if (dialog.saved && dialog.credential) {
    parts.push(t("deepLink.credentialNote", { name: dialog.credential.name }));
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
  });
}

/** Test seam: forget the module-scoped consumption guard. */
export function resetDeepLinkConsumerForTests(): void {
  consumed = false;
}
