import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginHostRecord,
  PluginCredentialSummary,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  resolveConnectPlan,
  type DeepLinkProtocol,
} from "../../src/frontend/connect-plan";
import { parseDeepLinkConnect } from "../../src/frontend/deep-link";

// An honest echo: the stub returns exactly the input it was given, so tests
// assert the fields the plan hands to core's createQuickConnectHost.
const echoBuilder = (input: Record<string, unknown>) => ({ ...input });

const hosts: PluginHostRecord[] = [
  { id: "1", name: "Web Server 1", ip: "192.168.5.16", port: 22 },
  { id: "2", name: "mk-sw1", ip: "192.168.20.2", port: 22 },
];

const credentials: PluginCredentialSummary[] = [
  { id: 7, name: "Deploy Key", username: "deploy", authType: "password" },
  { id: 8, name: "vnc", username: "vnc", authType: "password" },
];

const protocols: DeepLinkProtocol[] = [
  { id: "rdp", defaultPort: 3389 },
  { id: "vnc", defaultPort: 5900 },
];

function plan(
  search: string,
  overrides?: Partial<{
    hosts: PluginHostRecord[];
    credentials: PluginCredentialSummary[];
    protocols: DeepLinkProtocol[];
  }>,
) {
  return resolveConnectPlan({
    intent: parseDeepLinkConnect(search)!,
    hosts: overrides?.hosts ?? hosts,
    credentials: overrides?.credentials ?? credentials,
    protocols: overrides?.protocols ?? protocols,
    buildQuickConnect: echoBuilder as never,
  });
}

describe("resolveConnectPlan", () => {
  it("matches a saved host by case-insensitive name and keeps it as-is", () => {
    const result = plan("?connect=web%20server%201&type=ssh");
    expect(result.status).toBe("saved");
    expect(result.host).toEqual(hosts[0]);
    expect(result.typeToPass).toBeUndefined();
    expect(result.dialog?.saved).toBe(true);
    expect(result.dialog?.hostLabel).toBe("Web Server 1");
  });

  it("falls back to an exact IP match", () => {
    const result = plan("?connect=192.168.20.2");
    expect(result.status).toBe("saved");
    expect(result.host).toEqual(hosts[1]);
  });

  it("skips saved-host lookup entirely when using=adhoc", () => {
    const result = plan("?connect=Web%20Server%201&type=ssh&using=adhoc");
    expect(result.status).toBe("adhoc");
    expect(result.host).toMatchObject({ ip: "Web Server 1", authType: "none" });
  });

  it("reports a missing host when there is no match and no type", () => {
    expect(plan("?connect=ghost").status).toBe("hostNotFound");
    expect(plan("?connect=ghost&type=ssh").status).toBe("adhoc");
  });

  it("builds an ad-hoc SSH record with a port override and no secret", () => {
    const result = plan("?connect=10.0.0.5&type=ssh&port=2222");
    expect(result.status).toBe("adhoc");
    expect(result.host).toMatchObject({
      ip: "10.0.0.5",
      port: 2222,
      username: "",
      authType: "none",
    });
    expect("password" in (result.host as object)).toBe(false);
    // ssh is never passed as a tab type: the terminal plugin owns "terminal".
    expect(result.typeToPass).toBeUndefined();
    expect(result.dialog).toMatchObject({
      saved: false,
      hostLabel: "10.0.0.5",
    });
  });

  it("carries a resolved credential's username for ad-hoc SSH, never a value", () => {
    const result = plan("?connect=10.0.0.5&type=ssh&credential=deploy%20key");
    expect(result.status).toBe("adhoc");
    expect(result.host).toMatchObject({
      ip: "10.0.0.5",
      username: "deploy",
      authType: "none",
    });
    expect("password" in (result.host as object)).toBe(false);
    expect(result.dialog?.credential).toEqual(credentials[0]);
    expect(result.dialog?.credentialNotCarried).toMatchObject({
      name: "Deploy Key",
      protocol: "ssh",
    });
  });

  it("reports an unknown credential name", () => {
    expect(plan("?connect=10.0.0.5&type=ssh&credential=ghost").status).toBe(
      "credentialNotFound",
    );
  });

  it("passes a registered plugin protocol through and fixes connectionType", () => {
    const result = plan("?connect=10.0.0.5&type=vnc");
    expect(result.status).toBe("adhoc");
    expect(result.host).toMatchObject({
      ip: "10.0.0.5",
      connectionType: "vnc",
      authType: "password",
    });
    expect(result.typeToPass).toBe("vnc");
  });

  it("uses the protocol's default port unless the link overrides it", () => {
    const defaulted = plan("?connect=10.0.0.5&type=vnc");
    expect((defaulted.host as Record<string, unknown>).port).toBe(5900);
    const overridden = plan("?connect=10.0.0.5&type=vnc&port=6001");
    expect((overridden.host as Record<string, unknown>).port).toBe(6001);
  });

  it("carries the AD domain on ad-hoc RDP links", () => {
    const result = plan("?connect=10.0.0.5&type=rdp&domain=WAG&port=3390");
    expect(result.host).toMatchObject({
      connectionType: "rdp",
      port: 3390,
    });
    expect((result.host as Record<string, unknown>).domain).toBe("WAG");
  });

  it("flags a carried credential as not-carried on ad-hoc remote-desktop links", () => {
    const result = plan("?connect=10.0.0.5&type=vnc&credential=vnc");
    expect(result.dialog?.credentialNotCarried).toEqual({
      name: "vnc",
      protocol: "vnc",
    });
  });

  it("reports a type no plugin provides for ad-hoc links", () => {
    expect(plan("?connect=10.0.0.5&type=telnet").status).toBe("typeUnknown");
  });

  it("treats an unset protocol registry as no match for ad-hoc links", () => {
    const result = plan("?connect=10.0.0.5&type=rdp", { protocols: [] });
    expect(result.status).toBe("typeUnknown");
  });

  it("keeps a saved host when its type is unknown and omits the type", () => {
    const result = plan("?connect=mk-sw1&type=telnet");
    expect(result.status).toBe("saved");
    expect(result.host).toEqual(hosts[1]);
    expect(result.typeToPass).toBeUndefined();
  });

  it("verifies a saved host's requested credential without touching the host", () => {
    const result = plan("?connect=web%20server%201&credential=deploy%20key");
    expect(result.status).toBe("saved");
    expect(result.host).toEqual(hosts[0]);
    expect(result.dialog?.credential).toEqual(credentials[0]);
  });

  it("reports a saved host's missing credential by name", () => {
    expect(plan("?connect=mk-sw1&credential=ghost").status).toBe(
      "credentialNotFound",
    );
  });

  it("carries viewonly=1 into the dialog payload without acting on it", () => {
    const result = plan("?connect=10.0.0.5&type=vnc&viewonly=1");
    expect(result.dialog?.viewOnly).toBe(true);
    expect(result.host).toMatchObject({ connectionType: "vnc" });
  });
});

describe("resolveConnectPlan builder isolation", () => {
  it("passes ad-hoc remote-desktop credentials as password-only with an empty secret", () => {
    const spy = vi.fn((input: Record<string, unknown>) => ({ ...input }));
    resolveConnectPlan({
      intent: parseDeepLinkConnect("?connect=10.0.0.5&type=rdp")!,
      hosts,
      credentials,
      protocols,
      buildQuickConnect: spy as never,
    });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        ip: "10.0.0.5",
        authType: "password",
        password: "",
      }),
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });
});
