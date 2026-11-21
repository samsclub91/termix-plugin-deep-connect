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

/** Connection types the adopt route can create a record for. */
export const ADOPTABLE_TYPES = new Set(["ssh", "vnc", "rdp"]);

export type ConnectPlanStatus =
  "saved" | "adhoc" | "hostNotFound" | "typeUnknown" | "credentialNotFound";

/** What the consumer should ask the plugin backend to create, on confirm. */
export interface AdoptRequest {
  hostName: string;
  type: string;
  credentialId: number;
  /**
   * The link's port, when a protocol (or the link itself) supplied one.
   * Omitted when no default was available — the view's own-type
   * classification knows no registry default port: the adopt route applies
   * its own protocol default server-side, so an omitted port is not a guess.
   */
  port?: number;
  domain?: string;
}

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
  /**
   * Set when creating a saved host for this link (with the credential
   * attached by id) would let the session carry the credential server-side.
   * The consumer offers the create-confirm first; `host` below stays the
   * ad-hoc fallback if the create does not happen.
   */
  adopt?: AdoptRequest;
  /** Set when a asked-for credential could not ride the session (ad-hoc). */
  credentialNotCarried?: { name: string; protocol?: string };
  /**
   * The link's verified credential rides the quick connect by id
   * (quickConnectLogin.credentialId, resolved server-side by the protocol
   * plugin): nothing is prompted for, there is no not-carried story, and an
   * adoption fallback still carries it.
   */
  credentialRides?: boolean;
  /** The session rides the host's saved protocol login, not the link's. */
  protocolSaved?: boolean;
  /** The link asked for observe-only (viewonly=1). Parsed, only ever true. */
  viewOnly?: boolean;
  /**
   * Set when the view-only request is APPLIED on the session (an ad-hoc
   * plugin-protocol quick connect opens with its input off). Absent on saved
   * hosts and SSH links, where the request stays a note on this path.
   */
  viewOnlyApplied?: boolean;
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
 * - Ad-hoc RDP/VNC links WITH a verified credential carry it by id
 *   (quickConnectLogin.credentialId): the remote-desktop plugin resolves the
 *   saved credential on the server, where its secret never leaves Termix.
 *   No username or password is put on the quick connect; the RDP domain
 *   keeps riding in the login's fields. Adoption is still offered on top —
 *   the saved host makes the link keep working from then on.
 * - Ad-hoc SSH keeps the v1.2 behavior exactly (protocol plugins do not
 *   cover ssh, so there is no seam to resolve through): a verified
 *   credential rides as its username on an authType "none" record — the
 *   password/key cannot ride and the session prompts — and adoption remains
 *   the way the credential actually rides server-side.
 * - An ad-hoc link naming an unknown credential is refused outright
 *   (credentialNotFound) — same as v1.2. A link must not silently open a
 *   session that ignores the login it claims.
 * - Ad-hoc RDP/VNC links WITHOUT a credential (or with verification
 *   unavailable) still build the v1-shaped username/password prompt record,
 *   and remote-desktop shows its own prompt for the password.
 * - viewonly=1 applies on ad-hoc plugin-protocol quick connects:
 *   quickConnectLogin.viewOnly is set to true and nothing else — restrict
 *   only, it can only ever turn input off.
 * - `connectionType` is set explicitly on ad-hoc hosts: remote-desktop reads
 *   its auth payload only when it matches the quick-connect login's protocol.
 */
export function resolveConnectPlan(options: {
  intent: DeepLinkConnectIntent;
  hosts: readonly PluginHostRecord[];
  credentials?: readonly PluginCredentialSummary[];
  protocols: readonly DeepLinkProtocol[];
  buildQuickConnect: QuickConnectBuilder;
  /**
   * The standalone view's landing classification (the `?view=` page only).
   * The protocol registry never populates there: the shell never mounts on
   * that page, so its shell-fed registries stay empty and a registry gate
   * refuses links the adopt route can serve. ADOPTION only writes a host
   * record, so an ad-hoc intent with an explicit type classifies by the
   * link's own `type=` — the backend route validates connectionType itself,
   * and its accepted set (`ADOPTABLE_TYPES` in src/backend/adopt.ts: ssh,
   * vnc, rdp, mirrored in the constant above) is the complete set of types
   * this classifier knows. A type outside it never adopts and keeps the
   * typeUnknown refusal, exactly like a type the grammar cannot parse — no
   * further client-side type lists exist beyond these mirrors. The landing
   * opens no sessions, so the quick-connect fallback record is not built for
   * an intent classified here.
   */
  classifyAdoptByIntentType?: boolean;
}): ConnectPlan {
  const { intent, hosts, protocols, buildQuickConnect } = options;
  const savedHost =
    intent.using === "adhoc" ? undefined : findConnectableHost(hosts, intent);
  if (!savedHost && !intent.type && intent.using !== "adhoc") {
    return { status: "hostNotFound" };
  }

  const coreSsh = !intent.type || intent.type === "ssh";
  const linkType = intent.type ?? "";
  const protocol = coreSsh
    ? undefined
    : protocols.find((p) => p.id === intent.type);
  // The view landing has no registry to consult, so the link's own type
  // classifies the ADOPTION and the backend route validates it (accepted
  // set ssh/vnc/rdp — `ADOPTABLE_TYPES` in src/backend/adopt.ts, mirrored
  // above; anything outside that set keeps the typeUnknown refusal below).
  const adoptByIntent =
    !protocol &&
    !coreSsh &&
    options.classifyAdoptByIntentType === true &&
    ADOPTABLE_TYPES.has(linkType);
  if (!savedHost && !coreSsh && !protocol && !adoptByIntent) {
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
  if (adoptByIntent) {
    // The view's landing consumes only the adoption from the plan: it opens
    // no sessions and builds no quick-connect fallback, so this leg returns
    // the adopt dialog (or, credential-less, nothing to attach — the
    // landing maps the missing adopt request to its cannotAdopt refusal).
    // The link's own type IS the adopt type (validated by the backend
    // route); with no registry default to fall back on, an absent link port
    // stays absent — the route applies its protocol's default (22/5900/3389,
    // its own `DEFAULT_PORTS`) server-side.
    return {
      status: "adhoc",
      dialog: {
        saved: false,
        hostLabel: username ? `${username}@${address}` : address,
        address,
        ...(credential
          ? {
              credential,
              credentialRides: true,
              adopt: {
                hostName: address,
                type: linkType,
                credentialId: credential.id,
                ...(intent.port ? { port: intent.port } : {}),
                ...(intent.domain ? { domain: intent.domain } : {}),
              },
            }
          : {}),
        viewOnly: intent.viewOnly,
        // viewOnlyApplied is deliberately unset: the view opens no session,
        // so nothing here ever applied view-only — no true claim this path
        // cannot stand behind.
      },
    };
  }
  // The verified credential rides by id on plugin-protocol quick connects
  // (the protocol plugin resolves it server-side); SSH always keeps the v1.2
  // username-carry shape because ssh has no resolving protocol plugin.
  const credentialById = !!credential && !coreSsh;
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
  } else if (credentialById) {
    // Ad-hoc RDP/VNC with a verified credential: the quick connect carries
    // the credential by id and nothing secret-shaped — no username, no
    // password. The server resolves the login (ctx.credentials.resolveLogin)
    // and the RDP domain keeps riding in the login's fields.
    host = buildQuickConnect({
      protocol: protocol as DeepLinkProtocol,
      ip: address,
      port: intent.port ?? (protocol as DeepLinkProtocol).defaultPort,
      ...(intent.domain ? { domain: intent.domain } : {}),
    });
  } else {
    // Ad-hoc RDP/VNC without a credential: username and domain ride; the
    // password prompt comes from remote-desktop itself.
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
  // Stamp what core's builder alone cannot produce, keyed off the link:
  //   quickConnectLogin.credentialId (verified credential, plugin protocols),
  //   quickConnectLogin.viewOnly = true (viewonly=1 — restrict-only: it is
  //   only ever added, and only ever true; no path ever writes false),
  // then connectionType, which the protocol-plugin gate requires
  // (quickConnectLogin.protocol === connectionType).
  if (!coreSsh && (credentialById || intent.viewOnly)) {
    const record = host as Record<string, unknown>;
    const login: Record<string, unknown> = {
      ...((record.quickConnectLogin as Record<string, unknown> | undefined) ??
        {}),
      protocol: protocol!.id,
    };
    if (credentialById && credential) {
      login.credentialId = credential.id;
      // "Omit username/password": the record carries the id, not values.
      delete login.username;
      delete login.password;
    }
    if (intent.viewOnly) login.viewOnly = true;
    host = { ...record, quickConnectLogin: login } as QuickConnectRecord;
  }
  // createQuickConnectHost leaves connectionType unset; without it the
  // plugin-side gate `quickConnectLogin.protocol === connectionType` drops
  // the auth payload and the session opens unauthenticated.
  host = {
    ...(host as Record<string, unknown>),
    connectionType: coreSsh ? "ssh" : protocol!.id,
  } as QuickConnectRecord;

  const typeForAdopt = coreSsh ? "ssh" : protocol!.id;
  if (credential && ADOPTABLE_TYPES.has(typeForAdopt)) {
    // Adoption candidate: the consumer offers to create the saved host so
    // the credential rides server-side; the built quick connect is the
    // fallback when the confirm is declined or the route is unavailable —
    // and on plugin protocols it now also carries the credential by id.
    return {
      status: "adhoc",
      host,
      typeToPass: protocol ? protocol.id : undefined,
      dialog: {
        saved: false,
        hostLabel: username ? `${username}@${address}` : address,
        address,
        credential,
        ...(credentialById ? { credentialRides: true } : {}),
        adopt: {
          hostName: address,
          type: typeForAdopt,
          credentialId: credential.id,
          port:
            intent.port ??
            (coreSsh ? 22 : (protocol as DeepLinkProtocol).defaultPort),
          ...(intent.domain ? { domain: intent.domain } : {}),
        },
        viewOnly: intent.viewOnly,
        viewOnlyApplied: intent.viewOnly && !coreSsh ? true : undefined,
      },
    };
  }

  return {
    status: "adhoc",
    host,
    typeToPass: protocol ? protocol.id : undefined,
    dialog: {
      saved: false,
      hostLabel: username ? `${username}@${address}` : address,
      address,
      credential,
      ...(credentialById ? { credentialRides: true } : {}),
      credentialNotCarried:
        credential && !credentialById
          ? {
              name: credential.name,
              protocol: protocol ? protocol.id : "ssh",
            }
          : undefined,
      viewOnly: intent.viewOnly,
      viewOnlyApplied: intent.viewOnly && !coreSsh ? true : undefined,
    },
  };
}

/**
 * The deep-link parameter names, re-exported for the hand-off page so the
 * link grammar has exactly one definition.
 */
export { DEEP_LINK_PARAMS };
