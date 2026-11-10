import type {
  PluginCredentialSummary,
  PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  DEEP_LINK_PARAMS,
  findConnectableHost,
  type DeepLinkConnectIntent,
} from "./deep-link";

/**
 * A plugin protocol a deep link may target (a slice of the host-protocol
 * registry's definition). Structurally compatible with the full
 * `HostProtocolDef` from `@termix-ssh/plugin-sdk/ui`, so the live registry
 * list can flow straight into these functions while tests stay DOM-free.
 */
export interface DeepLinkProtocol {
  id: string;
  defaultPort: number;
  quickConnect?: { showDomain?: boolean } | null;
}

/** A credential's name is resolved to this little summary, never a secret. */
export type ResolvedCredential = PluginCredentialSummary;

/**
 * What the builder should hand back for a quick-connect record. The real
 * builder is core's `createQuickConnectHost` from `@termix-ssh/plugin-sdk/ui`;
 * tests inject a stub, so the plan logic stays decoupled from the registry.
 */
export type QuickConnectRecord = PluginHostRecord | Record<string, unknown>;
export type QuickConnectBuilder = (input: {
  ip: string;
  port: number;
  username?: string;
  authType?: string;
  password?: string;
  credentialId?: string;
  protocol?:
    | {
        id: string;
        pluginId?: string;
        settingKey?: string;
        portKey?: string;
        defaultPort: number;
        titleKey?: string;
        descriptionKey?: string;
        connectionOriginNoteKey?: string;
        icon?: unknown;
        order?: number;
        quickConnect?: { showDomain?: boolean } | null;
      }
    | unknown;
  domain?: string;
}) => QuickConnectRecord;

export type ConnectPlanStatus =
  "saved" | "adhoc" | "hostNotFound" | "typeUnknown" | "credentialNotFound";

/** The dialog text pieces the shell consumer needs to present the plan. */
export interface ConnectPlanDialog {
  /** Which title key applies: saved hosts say their name, ad-hoc their address. */
  saved: boolean;
  /** The label shown in the title: the saved host's name, or the address. */
  hostLabel: string;
  /** The address a session opens for (same as the label for saved hosts). */
  address: string;
  /** A credential the link asked for, verified against the user's list. */
  credential?: {
    id: number;
    name: string;
    username?: string;
    authType?: string;
  };
  /** Set when a asked-for credential could not ride the session (ad-hoc). */
  credentialNotCarried?: { name: string; protocol?: string };
  /** The link asked for observe-only (viewonly=1). Parsed, not applied. */
  viewOnly?: boolean;
}

export interface ConnectPlan {
  status: ConnectPlanStatus;
  host?: QuickConnectRecord;
  /** Pass this tab type to connectHost only for registered plugin protocols. */
  typeToPass?: string;
  dialog?: ConnectPlanDialog;
}

/**
 * Resolves a parsed deep link into a connect plan. Pure: hosts, credentials
 * and the protocol registry come in as plain data (an empty protocol list
 * means "registry not settled yet"), and the quick-connect builder is
 * injected. No DOM, no fetches, no secrets — credential summaries carry a
 * name, an optional username and an auth type, never a value.
 *
 * Behavior notes:
 * - Saved hosts keep their own log-in. A `credential=` name is verified
 *   against the user's credential list and surfaced in the confirm text, but
 *   the host record is never rewritten.
 * - Ad-hoc SSH carries a resolved credential's username; the password/key
 *   cannot ride (plugins get redacted summaries, and an id-less quick-connect
 *   host cannot expand a stored credential server-side), so the session
 *   prompts. A plugin therefore never asks Termix for a secret.
 * - Ad-hoc RDP/VNC carries username and an AD domain; remote-desktop shows
 *   its own prompt for the password.
 * - `connectionType` is set explicitly on ad-hoc hosts: remote-desktop reads
 *   its auth payload only when it matches the quick-connect login's protocol.
 */
export function resolveConnectPlan(options: {
  intent: DeepLinkConnectIntent;
  hosts: readonly PluginHostRecord[];
  credentials?: readonly PluginCredentialSummary[];
  protocols: readonly DeepLinkProtocol[];
  buildQuickConnect: QuickConnectBuilder;
}): ConnectPlan {
  const { intent, hosts, protocols, buildQuickConnect } = options;
  const savedHost =
    intent.using === "adhoc" ? undefined : findConnectableHost(hosts, intent);
  if (!savedHost && !intent.type && intent.using !== "adhoc") {
    return { status: "hostNotFound" };
  }

  const coreSsh = !intent.type || intent.type === "ssh";
  const protocol = coreSsh
    ? undefined
    : protocols.find((p) => p.id === intent.type);
  if (!savedHost && !coreSsh && !protocol) {
    return { status: "typeUnknown" };
  }

  // Credential=<name>: resolved against the user's own list. Never a secret.
  let credential: ResolvedCredential | undefined;
  if (intent.credentialName) {
    const wanted = intent.credentialName.toLowerCase();
    credential = (options.credentials ?? []).find(
      (row) => row.name.toLowerCase() === wanted,
    );
    if (!credential) return { status: "credentialNotFound" };
  }

  if (savedHost) {
    // The saved host's own login wins; the credential name rides only in the
    // confirm text (upstream: saved-host per-protocol credential override is
    // a core-owned seam, deliberately untouched here).
    return {
      status: "saved",
      host: savedHost,
      // An explicitly asked plugin protocol passes through, ssh/unknown does
      // not: the default connection is polled by the consumer instead.
      typeToPass:
        protocol && intent.type === protocol.id ? protocol.id : undefined,
      dialog: {
        saved: true,
        hostLabel: savedHost.name,
        address: savedHost.ip,
        credential,
        viewOnly: intent.viewOnly,
      },
    };
  }

  const address = intent.hostName;
  const username = credential?.username ?? "";
  let host: QuickConnectRecord;
  if (coreSsh) {
    // Ad-hoc SSH: carry the username, never a secret. authType "none" makes
    // the terminal open its own auth dialog after the server refuses the
    // empty attempt — the password stored under this credential's name stays
    // in Termix (a plugin gets redacted summaries and cannot inline it; see
    // the core fix that inlines passwords, reachable only to core itself).
    host = buildQuickConnect({
      ip: address,
      port: intent.port ?? 22,
      username,
      authType: "none",
    });
  } else {
    // Ad-hoc RDP/VNC: username and domain ride; the password prompt comes
    // from remote-desktop itself (quickConnectLogin has no credentialId
    // support and plugins get no secret values).
    host = buildQuickConnect({
      protocol: protocol as DeepLinkProtocol,
      ip: address,
      port: intent.port ?? (protocol as DeepLinkProtocol).defaultPort,
      username,
      authType: "password",
      password: "",
      domain: intent.domain,
    });
  }
  // createQuickConnectHost leaves connectionType unset; without it the
  // plugin-side gate `quickConnectLogin.protocol === connectionType` drops
  // the auth payload and the session opens unauthenticated.
  host = {
    ...(host as Record<string, unknown>),
    connectionType: coreSsh ? "ssh" : protocol!.id,
  } as QuickConnectRecord;

  return {
    status: "adhoc",
    host,
    typeToPass: protocol ? protocol.id : undefined,
    dialog: {
      saved: false,
      hostLabel: username ? `${username}@${address}` : address,
      address,
      credential,
      credentialNotCarried: credential
        ? {
            name: credential.name,
            protocol: protocol ? protocol.id : "ssh",
          }
        : undefined,
      viewOnly: intent.viewOnly,
    },
  };
}

/**
 * The deep-link parameter names, re-exported for the hand-off page so the
 * link grammar has exactly one definition.
 */
export { DEEP_LINK_PARAMS };
