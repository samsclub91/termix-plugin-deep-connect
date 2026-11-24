import { describe, expect, it } from "vitest";
import type { PluginHostRecord } from "@termix-ssh/plugin-sdk/frontend";
import {
  findConnectableHost,
  isCoreHostLink,
  parseDeepLinkConnect,
  parseTermixLinkUrl,
  stripDeepLinkParams,
} from "../../src/frontend/deep-link";

function makeHost(name: string, ip: string): PluginHostRecord {
  return {
    id: name,
    name,
    ip,
    port: 22,
  };
}

describe("parseDeepLinkConnect", () => {
  it("returns null when there is no connect parameter", () => {
    expect(parseDeepLinkConnect("")).toBeNull();
    expect(parseDeepLinkConnect("?foo=bar")).toBeNull();
    expect(parseDeepLinkConnect("?connect")).toBeNull();
    expect(parseDeepLinkConnect("?connect=")).toBeNull();
    expect(parseDeepLinkConnect("?connect=%20%20")).toBeNull();
  });

  it("parses a bare host name", () => {
    expect(parseDeepLinkConnect("?connect=Web%20Server%201")?.hostName).toBe(
      "Web Server 1",
    );
  });

  it("trims whitespace around the host value", () => {
    expect(parseDeepLinkConnect("?connect=%20web-01%20")?.hostName).toBe(
      "web-01",
    );
  });

  it("parses type and credential alongside the host", () => {
    const intent = parseDeepLinkConnect(
      "?connect=web-01&type=ssh&credential=Deploy%20Key",
    );
    expect(intent?.type).toBe("ssh");
    expect(intent?.credentialName).toBe("Deploy Key");
  });

  it("leaves unknown URL parameters alone for stripDeepLinkParams", () => {
    // The parser is pure: it must not reject URLs carrying extra parameters,
    // because other app state may ride the same query string.
    expect(
      parseDeepLinkConnect("?connect=web-01&view=dashboard")?.hostName,
    ).toBe("web-01");
  });

  it("parses a valid port and ignores invalid ones", () => {
    expect(parseDeepLinkConnect("?connect=10.0.0.5&port=5900")?.port).toBe(
      5900,
    );
    expect(
      parseDeepLinkConnect("?connect=10.0.0.5&port=0")?.port,
    ).toBeUndefined();
    expect(
      parseDeepLinkConnect("?connect=10.0.0.5&port=-1")?.port,
    ).toBeUndefined();
    expect(
      parseDeepLinkConnect("?connect=10.0.0.5&port=abc")?.port,
    ).toBeUndefined();
  });

  it("parses an explicit using value and ignores unknown ones", () => {
    expect(parseDeepLinkConnect("?connect=web-01&using=adhoc")?.using).toBe(
      "adhoc",
    );
    expect(parseDeepLinkConnect("?connect=web-01&using=name")?.using).toBe(
      "name",
    );
    expect(
      parseDeepLinkConnect("?connect=web-01&using=nonsense")?.using,
    ).toBeUndefined();
    expect(parseDeepLinkConnect("?connect=web-01")?.using).toBeUndefined();
  });

  it("parses a domain for RDP-style direct auth", () => {
    expect(
      parseDeepLinkConnect(
        "?connect=BG-DW11SAL03&type=rdp&credential=adm&domain=WAG",
      )?.domain,
    ).toBe("WAG");
    expect(
      parseDeepLinkConnect("?connect=web-01&domain=")?.domain,
    ).toBeUndefined();
  });

  it("parses viewonly=1 as an observe-only request and ignores other values", () => {
    expect(
      parseDeepLinkConnect("?connect=10.0.0.5&type=vnc&viewonly=1")?.viewOnly,
    ).toBe(true);
    expect(
      parseDeepLinkConnect("?connect=web-01&viewonly=true")?.viewOnly,
    ).toBeUndefined();
    expect(
      parseDeepLinkConnect("?connect=web-01&viewonly=0")?.viewOnly,
    ).toBeUndefined();
    expect(parseDeepLinkConnect("?connect=web-01")?.viewOnly).toBeUndefined();
  });

  it("never builds viewOnly=false: the restrict-only invariant", () => {
    // The parameter is only ever accepted as the exact value "1" (no trim,
    // no coercion), and the parsed intent can only carry viewOnly: true or
    // undefined.
    for (const value of [
      "0",
      "true",
      "false",
      "yes",
      "on",
      "1 ",
      "",
      "11",
      "1,",
      "01",
    ]) {
      const intent = parseDeepLinkConnect(
        `?connect=web-01&viewonly=${encodeURIComponent(value)}`,
      );
      expect(intent?.viewOnly === false).toBe(false);
      if (value === "1") expect(intent?.viewOnly).toBe(true);
      else expect(intent?.viewOnly).toBeUndefined();
    }
  });
});

describe("stripDeepLinkParams", () => {
  it("removes all deep-link params including viewonly while keeping others", () => {
    expect(
      stripDeepLinkParams(
        "?connect=10.0.0.5&type=vnc&credential=vnc&port=5900&using=adhoc&domain=WAG&viewonly=1&tab=x",
      ),
    ).toBe("?tab=x");
  });

  it("removes connect, type and credential while keeping others", () => {
    expect(
      stripDeepLinkParams("?connect=web-01&type=ssh&credential=k&tab=x"),
    ).toBe("?tab=x");
  });

  it("returns an empty string when nothing else remains", () => {
    expect(stripDeepLinkParams("?connect=web-01")).toBe("");
  });

  it("returns the original search untouched when no deep-link params exist", () => {
    expect(stripDeepLinkParams("?view=dashboard")).toBe("?view=dashboard");
    expect(stripDeepLinkParams("")).toBe("");
  });
});

describe("findConnectableHost", () => {
  const hosts = [
    makeHost("Web Server 1", "192.168.5.16"),
    makeHost("mk-sw1", "192.168.20.2"),
  ];

  it("matches a host by case-insensitive name", () => {
    expect(findConnectableHost(hosts, { hostName: "web server 1" })).toEqual(
      hosts[0],
    );
  });

  it("falls back to an exact IP match", () => {
    expect(findConnectableHost(hosts, { hostName: "192.168.20.2" })).toEqual(
      hosts[1],
    );
  });

  it("skips saved-host lookup entirely when using=adhoc", () => {
    expect(
      findConnectableHost(hosts, { hostName: "Web Server 1", using: "adhoc" }),
    ).toBeUndefined();
  });

  it("returns undefined when nothing matches", () => {
    expect(
      findConnectableHost(hosts, { hostName: "does-not-exist" }),
    ).toBeUndefined();
    expect(findConnectableHost([], { hostName: "web-01" })).toBeUndefined();
    expect(findConnectableHost([], { hostName: "" })).toBeUndefined();
  });
});

describe("isCoreHostLink", () => {
  it("claims core's termix://host/<id> form", () => {
    expect(isCoreHostLink("termix://host/12")).toBe(true);
    expect(isCoreHostLink("termix://host/12?anything=1")).toBe(true);
    // Case-sensitive, exactly like core's own hostIdOf: a form core would
    // not act on is not core's form.
    expect(isCoreHostLink("termix://HOST/12")).toBe(false);
  });

  it("leaves everything else to the plugin", () => {
    expect(isCoreHostLink("termix://connect/web-01?type=vnc")).toBe(false);
    expect(isCoreHostLink("termix://deep-connect?connect=web-01")).toBe(false);
    // The host/ namespace is core's even when the segment is not an id.
    expect(isCoreHostLink("termix://host/web-01")).toBe(true);
    expect(isCoreHostLink("termix://host/")).toBe(true);
    expect(isCoreHostLink("https://termix.example.com/?connect=web-01")).toBe(
      false,
    );
    expect(isCoreHostLink("not a url")).toBe(false);
  });
});

describe("parseTermixLinkUrl", () => {
  it("parses the query form with the same grammar", () => {
    expect(
      parseTermixLinkUrl("termix://deep-connect?connect=web-01&type=vnc"),
    ).toEqual({
      hostName: "web-01",
      type: "vnc",
      credentialName: undefined,
      port: undefined,
      using: undefined,
      domain: undefined,
      viewOnly: undefined,
    });
  });

  it("parses full grammar parameters on the termix:// scheme", () => {
    expect(
      parseTermixLinkUrl(
        "termix://connect/10.0.0.5?type=rdp&credential=adm&port=3390&domain=WAG&using=adhoc&viewonly=1",
      ),
    ).toEqual({
      hostName: "10.0.0.5",
      type: "rdp",
      credentialName: "adm",
      port: 3390,
      using: "adhoc",
      domain: "WAG",
      viewOnly: true,
    });
  });

  it("takes a path target under connect/", () => {
    expect(parseTermixLinkUrl("termix://connect/web-01")?.hostName).toBe(
      "web-01",
    );
    expect(
      parseTermixLinkUrl("termix://connect/Web%20Server%201?type=ssh")
        ?.hostName,
    ).toBe("Web Server 1");
    expect(
      parseTermixLinkUrl("termix://connect/Web%20Server%201?type=ssh")?.type,
    ).toBe("ssh");
  });

  it("decodes a percent-encoded path target and trims it", () => {
    expect(parseTermixLinkUrl("termix://connect/%20web-01%20")?.hostName).toBe(
      "web-01",
    );
  });

  it("ignores extra path segments after the target", () => {
    // Asset managers append labels; only the first segment is the target.
    expect(parseTermixLinkUrl("termix://connect/web-01/launch")?.hostName).toBe(
      "web-01",
    );
  });

  it("prefers an explicit connect= in the query over a path target", () => {
    const intent = parseTermixLinkUrl("termix://connect/web-01?connect=other");
    expect(intent?.hostName).toBe("other");
  });

  it("ignores core's termix://host/<id> form", () => {
    expect(parseTermixLinkUrl("termix://host/12")).toBeNull();
    expect(parseTermixLinkUrl("termix://host/12?connect=web-01")).toBeNull();
    expect(parseTermixLinkUrl("termix://host/web-01")).toBeNull();
  });

  it("returns null for non-termix or unusable URLs", () => {
    expect(
      parseTermixLinkUrl("https://example.com/?connect=web-01"),
    ).toBeNull();
    expect(parseTermixLinkUrl("termix:connect/web-01")).toBeNull();
    expect(parseTermixLinkUrl("not a url")).toBeNull();
    expect(parseTermixLinkUrl("")).toBeNull();
  });

  it("returns null when no target is present", () => {
    expect(parseTermixLinkUrl("termix://connect")).toBeNull();
    expect(parseTermixLinkUrl("termix://connect?type=vnc")).toBeNull();
    expect(parseTermixLinkUrl("termix://deep-connect")).toBeNull();
    expect(parseTermixLinkUrl("termix://connect/")).toBeNull();
    expect(parseTermixLinkUrl("termix://connect/%20%20")).toBeNull();
  });

  it("never builds viewOnly=false from a termix link", () => {
    const bad = parseTermixLinkUrl(
      "termix://connect/web-01?type=vnc&viewonly=0",
    );
    expect(bad?.viewOnly).toBeUndefined();
    expect(bad?.viewOnly === false).toBe(false);
  });
});
