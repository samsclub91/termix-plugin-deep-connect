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
   * Observe-only request for ad-hoc connects (viewonly=1). Restrict-only by
   * design: a link may add input filtering, never grant interactivity.
   * Reserved — the connect path does not apply this yet; a host's own
   * read-only setting still applies wherever Termix provides one.
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
    viewOnly: params.get("viewonly")?.trim() === "1" ? true : undefined,
  };
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
