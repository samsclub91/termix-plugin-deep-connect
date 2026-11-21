import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
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
    /** The view landing's own-type adoption classification. */
    classify: boolean;
  }>,
) {
  return resolveConnectPlan({
    intent: parseDeepLinkConnect(search)!,
    hosts: overrides?.hosts ?? hosts,
    credentials: overrides?.credentials ?? credentials,
    protocols: overrides?.protocols ?? protocols,
    buildQuickConnect: echoBuilder as never,
    classifyAdoptByIntentType: overrides?.classify === true || undefined,
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
      authType: "none",
    });
    expect(result.host).not.toHaveProperty("quickConnectLogin");
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

  it("offers adoption for an ad-hoc link with a resolvable credential", () => {
    const result = plan("?connect=10.0.0.9&type=vnc&credential=vnc");
    expect(result.status).toBe("adhoc");
    expect(result.dialog?.adopt).toEqual({
      hostName: "10.0.0.9",
      type: "vnc",
      credentialId: 8,
      port: 5900,
    });
    // The credential rides by id on the quick connect too, so nothing is
    // marked not-carried — and the ad-hoc record stays as the fallback if
    // the user declines the create.
    expect(result.dialog?.credentialNotCarried).toBeUndefined();
    expect(result.dialog?.credentialRides).toBe(true);
    expect(result.host).toMatchObject({ connectionType: "vnc", port: 5900 });
  });

  it("offers adoption for plain ad-hoc SSH with a credential", () => {
    const result = plan(
      "?connect=192.168.103.227&type=ssh&credential=deploy%20key",
    );
    expect(result.dialog?.adopt).toMatchObject({
      hostName: "192.168.103.227",
      type: "ssh",
      credentialId: 7,
      port: 22,
    });
    const result2 = plan(
      "?connect=192.168.103.227&credential=deploy%20key&using=adhoc",
    );
    expect(result2.dialog?.adopt).toMatchObject({ type: "ssh", port: 22 });
    // SSH keeps the v1.2 carry shape: username rides, no id login, and the
    // credential does not "ride by id" on the quick connect.
    expect(result2.host).toMatchObject({
      authType: "none",
      username: "deploy",
    });
    expect(result2.host).not.toHaveProperty("quickConnectLogin");
    expect(result2.dialog?.credentialRides).toBeUndefined();
    // A no-type link that matches nothing stays a refusal — adoption is for
    // links the plugin can actually act on.
    expect(
      plan("?connect=192.168.103.227&credential=deploy%20key").status,
    ).toBe("hostNotFound");
  });

  it("carries the domain and port override into the adopt request", () => {
    const result = plan(
      "?connect=10.0.0.5&type=rdp&domain=WAG&port=3390&credential=vnc&using=adhoc",
    );
    expect(result.dialog?.adopt).toEqual({
      hostName: "10.0.0.5",
      type: "rdp",
      credentialId: 8,
      port: 3390,
      domain: "WAG",
    });
  });

  it("keeps the not-carried note for connections the adopt route cannot serve", () => {
    // No credential at all: nothing to attach, plain ad-hoc.
    const result = plan("?connect=10.0.0.5&type=vnc");
    expect(result.dialog?.adopt).toBeUndefined();
    expect(result.dialog?.credentialNotCarried).toBeUndefined();
    // An unknown type never reaches the adopt branch.
    expect(plan("?connect=10.0.0.5&type=telnet&credential=vnc").status).toBe(
      "typeUnknown",
    );
  });

  it("does not offer adoption when the link resolved a saved host", () => {
    const result = plan("?connect=web%20server%201&credential=deploy%20key");
    expect(result.status).toBe("saved");
    expect(result.dialog?.adopt).toBeUndefined();
    expect(result.dialog?.credential).toEqual(credentials[0]);
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

  it("carries a verified credential by id on ad-hoc RDP/VNC quick connects", () => {
    const result = plan("?connect=10.0.0.9&type=vnc&credential=vnc");
    const login = (result.host as Record<string, unknown>)
      .quickConnectLogin as Record<string, unknown>;
    expect(login).toMatchObject({ protocol: "vnc", credentialId: 8 });
    expect("username" in login).toBe(false);
    expect("password" in login).toBe(false);
    expect((result.host as Record<string, unknown>).connectionType).toBe("vnc");
    const rdp = plan(
      "?connect=10.0.0.5&type=rdp&credential=deploy%20key&domain=WAG",
    );
    const rdpLogin = (rdp.host as Record<string, unknown>)
      .quickConnectLogin as Record<string, unknown>;
    expect(rdpLogin).toMatchObject({ protocol: "rdp", credentialId: 7 });
    expect("username" in rdpLogin).toBe(false);
    expect("password" in rdpLogin).toBe(false);
  });

  it("refuses an ad-hoc link naming a credential it cannot verify", () => {
    // Same refusal as the saved-host path and v1.2: a link must not open a
    // session that silently ignores the login it claims to use.
    expect(plan("?connect=10.0.0.5&type=ssh&credential=ghost").status).toBe(
      "credentialNotFound",
    );
    expect(plan("?connect=10.0.0.5&type=vnc&credential=ghost").status).toBe(
      "credentialNotFound",
    );
    expect(
      plan("?connect=10.0.0.5&type=rdp&using=adhoc&credential=ghost").status,
    ).toBe("credentialNotFound");
  });

  it("carries viewonly=1 onto the quick connect login for plugin protocols", () => {
    const result = plan("?connect=10.0.0.5&type=vnc&viewonly=1");
    const login = (result.host as Record<string, unknown>)
      .quickConnectLogin as Record<string, unknown>;
    expect(login.viewOnly).toBe(true);
    expect(result.dialog?.viewOnly).toBe(true);
    expect(result.dialog?.viewOnlyApplied).toBe(true);
    expect(result.host).toMatchObject({ connectionType: "vnc" });
  });

  it("applies viewonly=1 together with the credential id on the same login", () => {
    const result = plan("?connect=10.0.0.9&type=vnc&credential=vnc&viewonly=1");
    const login = (result.host as Record<string, unknown>)
      .quickConnectLogin as Record<string, unknown>;
    expect(login).toMatchObject({ credentialId: 8, viewOnly: true });
  });

  it("keeps viewonly=1 a note on saved-host and SSH paths", () => {
    const ssh = plan("?connect=10.0.0.5&type=ssh&viewonly=1");
    expect(ssh.dialog?.viewOnly).toBe(true);
    expect(ssh.dialog?.viewOnlyApplied).toBeUndefined();
    expect(ssh.host).not.toHaveProperty("quickConnectLogin");
    const saved = plan("?connect=web%20server%201&viewonly=1&type=vnc");
    expect(saved.status).toBe("saved");
    expect(saved.dialog?.viewOnly).toBe(true);
    expect(saved.dialog?.viewOnlyApplied).toBeUndefined();
  });

  it("never writes viewOnly=false into a built record", () => {
    // A non-1 value parses to undefined and the built login carries NO
    // viewOnly key at all — false is not a value any plan produces
    // (restrict-only: links may turn input off, never on).
    const plain = plan("?connect=10.0.0.5&type=vnc&viewonly=0");
    const login = (plain.host as Record<string, unknown>).quickConnectLogin as
      Record<string, unknown> | undefined;
    expect(login?.viewOnly ?? undefined).toBeUndefined();
  });
});

describe("resolveConnectPlan classifyAdoptByIntentType (the view landing)", () => {
  // The standalone `?view=` page has NO protocol registry: the shell never
  // mounts there, so its shell-fed registries stay empty. The landing
  // classifies an ad-hoc ADOPTION by the link's own `type=` — adoption only
  // writes a host record, and the backend route validates connectionType
  // itself (ADOPTABLE_TYPES in src/backend/adopt.ts: ssh, vnc, rdp — the
  // set mirrored in the plan's ADOPTABLE_TYPES).
  const noRegistry: DeepLinkProtocol[] = [];

  it("classifies an ad-hoc vnc adoption by the link's own type without a registry", () => {
    const result = plan("?connect=10.0.0.9&type=vnc&credential=vnc", {
      protocols: noRegistry,
      classify: true,
    });
    expect(result.status).toBe("adhoc");
    expect(result.dialog?.adopt).toEqual({
      hostName: "10.0.0.9",
      type: "vnc",
      credentialId: 8,
      // No registry default to fall back on: no port — the adopt route
      // applies its own protocol default server-side.
    });
    expect(result.dialog?.credentialRides).toBe(true);
    // The landing opens no sessions: no quick-connect fallback record and
    // no tab type are built on this leg.
    expect(result.host).toBeUndefined();
    expect(result.typeToPass).toBeUndefined();
  });

  it("carries the link's explicit port and rdp domain into the classified adopt", () => {
    const result = plan(
      "?connect=10.0.0.5&type=rdp&domain=WAG&port=3390&credential=deploy%20key&using=adhoc",
      { protocols: noRegistry, classify: true },
    );
    expect(result.dialog?.adopt).toEqual({
      hostName: "10.0.0.5",
      type: "rdp",
      credentialId: 7,
      port: 3390,
      domain: "WAG",
    });
  });

  it("keeps a credential-less ad-hoc vnc link adopt-less for the cannotAdopt refusal", () => {
    const result = plan("?connect=10.0.0.5&type=vnc&using=adhoc", {
      protocols: noRegistry,
      classify: true,
    });
    expect(result.status).toBe("adhoc");
    expect(result.dialog?.adopt).toBeUndefined();
    expect(result.host).toBeUndefined();
  });

  it("keeps typeUnknown for a type the adopt route cannot create", () => {
    // A registered-elsewhere or fake type: the view cannot adopt it (the
    // route refuses) and cannot open it, so the refusal stays exactly like
    // the unclassified case — the route's accepted set is the whole
    // classification, no new client-side deny-list beyond it.
    expect(
      plan("?connect=10.0.0.5&type=telnet&credential=vnc", {
        protocols: noRegistry,
        classify: true,
      }).status,
    ).toBe("typeUnknown");
    expect(
      plan("?connect=10.0.0.5&type=custom-proto&credential=vnc", {
        protocols: noRegistry,
        classify: true,
      }).status,
    ).toBe("typeUnknown");
  });

  it("a settled registry still wins when its protocol IS found (classification never fires)", () => {
    // With a real protocol the plan behaves byte-identically to the
    // registry-driven path the shell and desktop consumers always take.
    const classified = plan("?connect=10.0.0.9&type=vnc&credential=vnc", {
      classify: true,
    });
    const plain = plan("?connect=10.0.0.9&type=vnc&credential=vnc");
    expect(classified.dialog?.adopt).toEqual(plain.dialog?.adopt);
    expect(classified.host).toEqual(plain.host);
    expect(classified.typeToPass).toBe(plain.typeToPass);
  });

  it("saved-host resolution is untouched by the classification", () => {
    const result = plan("?connect=web%20server%201&type=vnc", {
      protocols: noRegistry,
      classify: true,
    });
    expect(result.status).toBe("saved");
    expect(result.host).toEqual(hosts[0]);
    expect(result.dialog?.adopt).toBeUndefined();
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

  it("hands a verified credential to the builder WITHOUT username or password", () => {
    const spy = vi.fn((input: Record<string, unknown>) => ({ ...input }));
    resolveConnectPlan({
      intent: parseDeepLinkConnect(
        "?connect=10.0.0.5&type=rdp&credential=deploy%20key&domain=WAG",
      )!,
      hosts,
      credentials,
      protocols,
      buildQuickConnect: spy as never,
    });
    const buildArgs = spy.mock.calls[0][0] as Record<string, unknown>;
    expect(buildArgs).toMatchObject({
      ip: "10.0.0.5",
      port: 3389,
      domain: "WAG",
    });
    // Values ride only as the id stamped onto the built login.
    expect("username" in buildArgs).toBe(false);
    expect("authType" in buildArgs).toBe(false);
    expect("password" in buildArgs).toBe(false);
    expect("credentialId" in buildArgs).toBe(false);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });
});

describe("viewOnly restrict-only invariant (source scan)", () => {
  // Belt and braces on top of the behavioral tests: no source file may build
  // a viewOnly value of false from link input. The parser only ever emits
  // true or undefined, and every stamp site writes the literal `true`.
  const srcDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../src",
  );

  function* sourceFiles(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* sourceFiles(full);
      else if (/\.tsx?$/.test(entry.name)) yield full;
    }
  }

  it("no code path builds viewOnly=false", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      const text = readFileSync(file, "utf8");
      if (/viewOnly\s*(?::|=)\s*false/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
