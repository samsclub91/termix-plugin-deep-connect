import type { PluginHostRecord } from "@termix-ssh/plugin-sdk/frontend";

/**
 * Deep-link connect intent parsed from URL query parameters.
 *
 * Grammar:
 *   ?connect=<name|address>&type=<ssh|rdp|vnc|...>&credential=<name>&port=<n>&domain=<AD>&using=<name|adhoc>&viewonly=1
 *
 * `connect` is a saved host name (or IP) by default. When the value does not
 * match a saved host and a type is present — or `using=adhoc` is explicit —
 * the value is treated as an ADDRESS and the launcher builds an ephemeral
 * quick-connect session instead, mirroring an asset manager's ad-hoc mode
 * (Lansweeper asset actions carry the target directly).
 *
 * Mirrors the Royal TS `rtsx://` parameter shapes (protocol identifier, URI or
 * name lookup, credential by name) so asset-management URL actions port
 * directly, but intentionally WITHOUT Royal's password= parameter: secrets
 * never travel in URLs or OS argument strings.
 */
export interface DeepLinkConnectIntent {
  /** Saved host name (or IP) — or, for ad-hoc connects, a raw address. */
  hostName: string;
  /** Optional protocol/tab type; omitted connects with the host default. */
  type?: string;
  /** Optional credential reference by name, resolved at connect time. */
  credentialName?: string;
  /** Optional port override for ad-hoc connects (saved hosts keep theirs). */
  port?: number;
  /** Royal-style lookup control; absent means auto (saved host, then ad-hoc). */
  using?: "adhoc" | "name";
  /** Optional AD domain for RDP-style direct auth (ad-hoc connects). */
  domain?: string;
  /**
   * Observe-only request (viewonly=1, exact value only). Restrict-only by
   * design: a link may add input filtering, never grant interactivity.
   * Applied on ad-hoc RDP/VNC quick connects (quickConnectLogin.viewOnly,
   * resolved by the protocol plugin); a saved host or an SSH link still just
   * reads the note.
   */
  viewOnly?: boolean;
}

/** Every query parameter the deep-link connector claims on a URL. */
export const DEEP_LINK_PARAMS = [
  "connect",
  "type",
  "credential",
  "port",
  "using",
  "domain",
  "viewonly",
] as const;

const USING_VALUES = ["adhoc", "name"] as const;

/**
 * Returns the search string with all deep-link parameters removed. Other
 * parameters are preserved. Used to scrub the URL so a refresh cannot
 * retrigger a consumed intent.
 */
export function stripDeepLinkParams(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of DEEP_LINK_PARAMS) params.delete(key);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Reads a {@link DeepLinkConnectIntent} from a window-style search string.
 * Pure: reads parameters only; URL mutation is the caller's job (see
 * stripDeepLinkParams). Returns null when there is no connect parameter or
 * its value is empty. Unknown using= values are ignored (auto mode); a port
 * that fails to parse as a positive integer is ignored.
 */
export function parseDeepLinkConnect(
  search: string,
): DeepLinkConnectIntent | null {
  const params = new URLSearchParams(search);
  const hostName = params.get("connect")?.trim() ?? "";
  if (!hostName) return null;
  const rawUsing = params.get("using")?.trim();
  const using = USING_VALUES.find((v) => v === rawUsing);
  const rawPort = params.get("port")?.trim();
  const port = rawPort ? Number.parseInt(rawPort, 10) : undefined;
  return {
    hostName,
    type: params.get("type")?.trim() || undefined,
    credentialName: params.get("credential")?.trim() || undefined,
    port: port != null && !Number.isNaN(port) && port > 0 ? port : undefined,
    using,
    domain: params.get("domain")?.trim() || undefined,
    // Exact value "1" only: no trim, no coercion — any other spelling means
    // the link is not asking for view-only (restrict-only param).
    viewOnly: params.get("viewonly") === "1" ? true : undefined,
  };
}

/** Parses a URL, or returns null when the string is not a usable URL. */
function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Termix's own link namespace: `termix://host/<id>` opens a saved host, and
 * core handles it itself (it still asks first when the link came from
 * outside). Nothing else in that namespace is core's; the plugin only ever
 * parses links OUTSIDE it.
 */
export function isCoreHostLink(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed || parsed.protocol !== "termix:") return false;
  // Same segment walk as core's hostIdOf: authority + path segments.
  const parts = `${parsed.host}${parsed.pathname}`.split("/").filter(Boolean);
  return parts.length > 0 && parts[0] === "host";
}

/**
 * Reads a {@link DeepLinkConnectIntent} from a desktop `termix://` link, so
 * OS-scheme links and browser search strings share ONE grammar (see
 * parseDeepLinkConnect). Accepted forms:
 *
 *   termix://connect/<target>?type=…&credential=…   (target in the path)
 *   termix://<host>?connect=<target>&type=…         (target in the query)
 *
 * An explicit connect= in the query wins over a path target. Any termix://
 * authority works for the query form (the plugin id is conventional, not
 * required); a path target must sit under `connect`. Extra path segments
 * after the target are ignored, so asset managers can append labels. Core's
 * termix://host/<id> form is never parsed here — core owns it (and asks
 * before it connects). Returns null for anything without a target.
 */
export function parseTermixLinkUrl(url: string): DeepLinkConnectIntent | null {
  const parsed = parseUrl(url);
  if (!parsed || parsed.protocol !== "termix:") return null;
  // The documented desktop forms carry an authority (termix://connect/…,
  // termix://<plugin>?…); an opaque termix: path form is not ours.
  if (!parsed.host) return null;
  if (isCoreHostLink(url)) return null;
  const segments = `${parsed.host}${parsed.pathname}`
    .split("/")
    .filter(Boolean);
  const params = new URLSearchParams(parsed.search);
  if (
    segments[0] === "connect" &&
    segments.length > 1 &&
    !params.has("connect")
  ) {
    let target = "";
    try {
      target = decodeURIComponent(segments[1] ?? "").trim();
    } catch {
      return null; // A malformed percent sequence is never a target.
    }
    if (!target) return null;
    params.set("connect", target);
  }
  return parseDeepLinkConnect(`?${params}`);
}

/**
 * Resolves a parsed intent against the loaded host list. Case-insensitive
 * name match first, exact-IP fallback second: asset inventories may reference
 * either a display name or an address. Explicit using=adhoc skips saved-host
 * lookup entirely.
 */
export function findConnectableHost(
  hosts: readonly PluginHostRecord[],
  intent: Pick<DeepLinkConnectIntent, "hostName" | "using">,
): PluginHostRecord | undefined {
  if (intent.using === "adhoc") return undefined;
  const wanted = intent.hostName.toLowerCase();
  return (
    hosts.find((host) => host.name?.toLowerCase() === wanted) ??
    hosts.find((host) => host.ip === intent.hostName)
  );
}
