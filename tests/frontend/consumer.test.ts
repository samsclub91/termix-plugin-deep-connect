import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@termix-ssh/plugin-sdk/ui", () => ({
  createQuickConnectHost: vi.fn((input: Record<string, unknown>) => ({
    ...input,
  })),
  getDefaultConnectionTab: vi.fn(() => null),
  listHostProtocols: vi.fn(() => []),
}));

// The SDK exposes the redacted credential LIST as a module function (not an
// app member); stand in for it with hoisted state the tests can set.
const credentialState = vi.hoisted(() => ({
  credentials: [] as unknown[],
  post: vi.fn(async () => ({ data: { created: true, hostId: 42 } })),
}));

vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  listCredentials: vi.fn(async () => credentialState.credentials),
}));

// Deliberately NOT exporting usePluginApi from this mock: without an injected
// `adoptApi` the consumer must fall back to the v1 ad-hoc flow, and these
// mocks exercise exactly that.
import { toast } from "sonner";
import * as ui from "@termix-ssh/plugin-sdk/ui";
import type {
  PluginApiClient,
  PluginCredentialSummary,
  PluginHostRecord,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  consumeDeepLink,
  resetDeepLinkConsumerForTests,
  startDeepLinkConsumer,
} from "../../src/frontend/consumer";

const listProtocols = vi.mocked(ui.listHostProtocols);
const defaultTab = vi.mocked(ui.getDefaultConnectionTab);
const quickConnect = vi.mocked(ui.createQuickConnectHost);
const toastError = vi.mocked(toast.error, true);
const toastSuccess = vi.mocked(toast.success, true);
const post = credentialState.post as unknown as ReturnType<typeof vi.fn>;

const hosts: PluginHostRecord[] = [
  { id: "1", name: "Web Server 1", ip: "192.168.5.16", port: 22 },
];
const credentials: PluginCredentialSummary[] = [
  { id: 7, name: "Deploy Key", username: "deploy", authType: "password" },
];

interface AppDouble {
  app: TermixApp;
  confirm: ReturnType<typeof vi.fn>;
  listHosts: ReturnType<typeof vi.fn>;
  connectHost: ReturnType<typeof vi.fn>;
  openTab: ReturnType<typeof vi.fn>;
  fireReady: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function makeApp(options?: {
  hosts?: PluginHostRecord[];
  credentials?: PluginCredentialSummary[];
  confirmResult?: boolean;
}): AppDouble {
  const onReadyListeners: (() => void)[] = [];
  const t = (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key;
  const confirm = vi.fn(async () => options?.confirmResult ?? true);
  const listHosts = vi.fn(async () => options?.hosts ?? hosts);
  const app = {
    pluginId: "deep-connect",
    t,
    listHosts,
    confirm,
    // Deliberately NO `api` member in the default double: without an
    // injected adoptApi the consumer must resolve the v1 fallback (exactly
    // what a hook-less call would surface on a core without the route).
    tabs: {
      getLayout: vi.fn(() => ({ tabs: [] })),
      onReady: vi.fn((listener: () => void) => {
        onReadyListeners.push(listener);
        return () => {};
      }),
      connectHost: vi.fn(),
      openTab: vi.fn(),
    },
  } as unknown as TermixApp;
  return {
    app,
    confirm,
    listHosts,
    connectHost: app.tabs.connectHost as never,
    openTab: (app.tabs as unknown as { openTab: ReturnType<typeof vi.fn> })
      .openTab,
    fireReady: () => onReadyListeners.forEach((listener) => listener()),
    t,
  };
}

const SETTINGS = {
  settleBudgetMs: 500,
  pollMs: 10,
  defaultTabBudgetMs: 200,
};

function adoptSettings(
  api: {
    post: ReturnType<typeof vi.fn>;
  } | null,
): { settleBudgetMs: number; pollMs: number; defaultTabBudgetMs: number; adoptApi: () => PluginApiClient } {
  return {
    ...SETTINGS,
    adoptApi: () => (api ? { post: api as unknown } : null) as unknown as PluginApiClient,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDeepLinkConsumerForTests();
  credentialState.credentials = credentials as unknown[];
  post.mockResolvedValue({ data: { created: true, hostId: 42 } });
  listProtocols.mockReturnValue([
    { id: "rdp", defaultPort: 3389 },
    { id: "vnc", defaultPort: 5900 },
  ] as never);
  defaultTab.mockReturnValue(null as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("consumeDeepLink", () => {
  it("waits for the protocol registry before consuming the intent", async () => {
    const double = makeApp();
    listProtocols
      .mockReturnValueOnce([] as never)
      .mockReturnValueOnce([] as never)
      .mockReturnValue([{ id: "rdp", defaultPort: 3389 }] as never);
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=Web%20Server%201&type=ssh",
      SETTINGS,
    );
    defaultTab
      .mockReturnValueOnce(null as never)
      .mockReturnValueOnce(null as never)
      .mockReturnValue("terminal" as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(double.confirm).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await task;
    expect(double.listHosts.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(double.confirm).toHaveBeenCalledTimes(1);
    expect(double.connectHost).toHaveBeenCalledTimes(1);
  });

  it("confirms once and connects a saved host with the default poll", async () => {
    const double = makeApp();
    defaultTab
      .mockReturnValueOnce(null as never)
      .mockReturnValueOnce(null as never)
      .mockReturnValue("terminal" as never);
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=Web%20Server%201",
      SETTINGS,
    );
    await vi.advanceTimersByTimeAsync(100);
    await task;
    expect(double.confirm).toHaveBeenCalledTimes(1);
    const confirmArgs = double.confirm.mock.calls[0][0];
    expect(confirmArgs.title).toBe(
      double.t("deepLink.confirmTitle", { host: "Web Server 1" }),
    );
    expect(confirmArgs.confirmLabel).toBe("deepLink.openAction");
    expect(confirmArgs.destructive).toBe(false);
    expect(double.connectHost).toHaveBeenCalledWith(hosts[0], "terminal");
    // "ssh" is omitted on purpose; the default connection was polled.
    expect(defaultTab).toHaveBeenCalled();
  });

  it("passes a registered plugin protocol straight through", async () => {
    const double = makeApp();
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=10.0.0.5&type=vnc",
      SETTINGS,
    );
    await vi.advanceTimersByTimeAsync(0);
    await task;
    expect(double.confirm).toHaveBeenCalledTimes(1);
    const host = double.connectHost.mock.calls[0][0] as Record<string, unknown>;
    expect(double.connectHost.mock.calls[0][1]).toBe("vnc");
    expect(host.connectionType).toBe("vnc");
    expect(quickConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        ip: "10.0.0.5",
        port: 5900,
        authType: "password",
        password: "",
        username: "",
      }),
    );
  });

  it("carries an ad-hoc ssh credential's username but never a secret value", async () => {
    // No injected adoptApi and the SDK mock has no usePluginApi: the v1
    // fallback runs — one confirm with the not-carried note, no host create.
    const double = makeApp();
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=10.0.0.5&type=ssh&credential=deploy%20key",
      SETTINGS,
    );
    await vi.advanceTimersByTimeAsync(400);
    await task;
    const builderArgs = quickConnect.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(builderArgs).toMatchObject({ username: "deploy", authType: "none" });
    expect("password" in builderArgs).toBe(false);
    expect("credentialId" in builderArgs).toBe(false);
    expect(double.confirm).toHaveBeenCalledTimes(1);
    const description = double.confirm.mock.calls[0][0].description as string;
    expect(description).toContain("deepLink.adhocCredentialNote");
    expect(post).not.toHaveBeenCalled();
  });

  it("adds the viewonly note without applying view-only", async () => {
    const double = makeApp();
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=10.0.0.5&type=ssh&viewonly=1",
      adoptSettings(credentialState.post as never),
    );
    await vi.advanceTimersByTimeAsync(400);
    await task;
    expect(
      (double.confirm.mock.calls[0][0].description as string).includes(
        "deepLink.viewOnlyNote",
      ),
    ).toBe(true);
  });

  it("creates and reconnects through the saved flow when the user confirms adoption", async () => {
    const nowHosts: PluginHostRecord[] = [...hosts];
    const double = makeApp({ hosts: nowHosts });
    defaultTab.mockReturnValue("terminal" as never);
    post.mockResolvedValue({ data: { created: true, hostId: 42 } });
    const created: PluginHostRecord = {
      id: "42",
      name: "10.0.0.5",
      ip: "10.0.0.5",
      port: 22,
    };
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=10.0.0.5&type=ssh&credential=deploy%20key",
      adoptSettings(credentialState.post as never),
    );
    // The create "lands" while the request resolves: the record is visible
    // to the consumer's post-create list fetch, like the real server.
    post.mockImplementation(async () => {
      nowHosts.push(created);
      return { data: { created: true, hostId: 42 } };
    });
    await vi.advanceTimersByTimeAsync(300);
    await task;
    // The confirm ran before the create: the adopt dialog, with its own keys.
    expect(double.confirm).toHaveBeenCalledTimes(1);
    const dialog = double.confirm.mock.calls[0][0];
    expect(dialog.title).toBe(double.t("deepLink.adoptTitle", { host: "10.0.0.5" }));
    expect(dialog.confirmLabel).toBe("deepLink.adoptAction");
    expect(dialog.description).toContain("deepLink.adoptDescription");
    // The real en.json text carries the folder name; the double's t() only
    // renders params, so assert the interpolation payload.
    expect(dialog.description).toContain('"name":"Deploy Key"');
    expect(post).toHaveBeenCalledWith("/adopt", {
      hostName: "10.0.0.5",
      type: "ssh",
      credentialId: 7,
      port: 22,
    });
    await Promise.resolve();
    expect(toastSuccess).toHaveBeenCalledWith(
      double.t("deepLink.adoptCreated", { host: "10.0.0.5" }),
    );
    // No second confirm: the adopt dialog already consented to the connect,
    // and the plan was not rebuilt as an ad-hoc quick connect.
    expect(double.confirm).toHaveBeenCalledTimes(1);
    expect(double.connectHost).toHaveBeenCalledWith(created, "terminal");
    // A fresh record's default-connection registry has not filled; the SSH
    // adopt passes the terminal type straight through instead of polling.
    expect(defaultTab).not.toHaveBeenCalled();
  });

  it("adopts an ad-hoc vnc link with the protocol default port and passes the type", async () => {
    const nowHosts: PluginHostRecord[] = [...hosts];
    const created: PluginHostRecord = {
      id: "43",
      name: "10.0.0.9",
      ip: "10.0.0.9",
      port: 5900,
    };
    post.mockImplementation(async () => {
      nowHosts.push(created);
      return { data: { created: true, hostId: 43 } };
    });
    const double = makeApp({ hosts: nowHosts });
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=10.0.0.9&type=vnc&credential=deploy%20key",
      adoptSettings(credentialState.post as never),
    );
    await vi.advanceTimersByTimeAsync(300);
    await task;
    expect(post).toHaveBeenCalledWith("/adopt", {
      hostName: "10.0.0.9",
      type: "vnc",
      credentialId: 7,
      port: 5900,
    });
    // The intended protocol opens directly: connectHost's gate reads the
    // shell store, which lags the write just made, and mis-fallbacks.
    expect(double.openTab).toHaveBeenCalledWith(created, "vnc");
    expect(double.connectHost).not.toHaveBeenCalled();
  });

  it("creates nothing and opens nothing when the adopt confirm is declined", async () => {
    const double = makeApp({ confirmResult: false });
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=10.0.0.5&type=vnc&credential=deploy%20key",
      adoptSettings(credentialState.post as never),
    );
    await vi.advanceTimersByTimeAsync(100);
    await task;
    expect(double.confirm).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    expect(double.connectHost).not.toHaveBeenCalled();
  });

  it("ensures the remote-desktop settings when a plugin-made record gets a vnc link", async () => {
    const pluginMade: PluginHostRecord = {
      id: "9",
      name: "192.168.103.99",
      ip: "192.168.103.99",
      port: 5900,
      folder: "Ad-Hoc Hosts",
      tags: ["ad-hoc"],
      connectionType: "vnc",
      protocolAuth: { vnc: { authType: "credential", credentialId: 7 } },
    } as PluginHostRecord;
    const double = makeApp({ hosts: [pluginMade] });
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=192.168.103.99&type=vnc&credential=deploy%20key",
      adoptSettings(credentialState.post as never),
    );
    await vi.advanceTimersByTimeAsync(300);
    await task;
    // The plain saved-open confirm consented to the whole flow; the ensure
    // rides behind it with no extra dialog.
    const titles = double.confirm.mock.calls
      .map((call) => (call[0] as { title: string }).title)
      .join("|");
    expect(titles).toContain("deepLink.confirmTitle");
    expect(titles).not.toContain("deepLink.adoptUpdateTitle");
    expect(post).toHaveBeenCalledWith("/adopt", {
      hostName: "192.168.103.99",
      type: "vnc",
      credentialId: 7,
      // No port: the record's own 5900 belongs to the primary protocol; the
      // route resolves the link protocol's default server-side.
      sshOff: true,
    });
    expect(double.openTab).toHaveBeenCalledWith(
      pluginMade,
      "vnc",
      { label: "192.168.103.99" },
    );
    expect(double.connectHost).not.toHaveBeenCalled();
  });

  it("offers one update confirm when the user's own record lacks the protocol login", async () => {
    const userHost: PluginHostRecord = {
      id: "9",
      name: "wag-server01",
      ip: "10.4.0.15",
      port: 22,
      folder: "Site",
      tags: ["prod"],
      connectionType: "ssh",
    };
    const double = makeApp({ hosts: [userHost] });
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=wag-server01&type=vnc&credential=deploy%20key",
      adoptSettings(credentialState.post as never),
    );
    await vi.advanceTimersByTimeAsync(300);
    await task;
    expect(double.confirm).toHaveBeenCalledTimes(1);
    const dialog = double.confirm.mock.calls[0][0];
    expect(dialog.title).toContain("deepLink.adoptUpdateTitle");
    expect(dialog.confirmLabel).toBe("deepLink.adoptUpdateAction");
    expect(post).toHaveBeenCalledWith("/adopt", {
      hostName: "wag-server01",
      type: "vnc",
      credentialId: 7,
    });
    expect(post.mock.calls[0][0]).not.toHaveProperty("sshOff");
    expect(double.openTab).toHaveBeenCalledWith(
      userHost,
      "vnc",
      { label: "wag-server01" },
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      double.t("deepLink.adoptUpdated", { host: "wag-server01" }),
    );
  });

  it("carries an explicit link port into the ensure for a cross-protocol link", async () => {
    const pluginMade: PluginHostRecord = {
      id: "9",
      name: "wag-itvm15",
      ip: "wag-itvm15",
      port: 5900,
      folder: "Ad-Hoc Hosts",
      tags: ["ad-hoc"],
      connectionType: "vnc",
      protocolAuth: { vnc: { authType: "credential", credentialId: 7 } },
    } as PluginHostRecord;
    const double = makeApp({ hosts: [pluginMade] });
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=wag-itvm15&type=rdp&credential=deploy%20key&domain=WAG&port=33389",
      adoptSettings(credentialState.post as never),
    );
    await vi.advanceTimersByTimeAsync(300);
    await task;
    expect(post).toHaveBeenCalledWith("/adopt", {
      hostName: "wag-itvm15",
      type: "rdp",
      credentialId: 7,
      domain: "WAG",
      port: 33389,
      sshOff: true,
    });
    expect(double.openTab).toHaveBeenCalledWith(
      pluginMade,
      "rdp",
      { label: "wag-itvm15" },
    );
  });

  it("leaves a user-shaped record alone when it already has the protocol login", async () => {
    const userHost: PluginHostRecord = {
      id: "9",
      name: "wag-server01",
      ip: "10.4.0.15",
      port: 22,
      folder: "Site",
      tags: ["prod"],
      connectionType: "ssh",
      protocolAuth: { vnc: { authType: "credential", credentialId: 7 } },
    } as PluginHostRecord;
    const double = makeApp({ hosts: [userHost] });
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=wag-server01&type=vnc&credential=deploy%20key",
      adoptSettings(credentialState.post as never),
    );
    await vi.advanceTimersByTimeAsync(300);
    await task;
    expect(post).toHaveBeenCalledTimes(0);
    expect(double.connectHost).toHaveBeenCalledWith(userHost, "vnc");
    // The dialog does not claim the link's credential: the session rides the
    // login already saved on the host.
    const desc = (double.confirm.mock.calls[0][0].description as string) ?? "";
    expect(desc).toContain("deepLink.hostCredentialNote");
    expect(desc).not.toContain("deepLink.credentialNote");
  });

  it("falls back to the interactive ad-hoc flow when the route is unavailable", async () => {
    post.mockRejectedValue(new Error("route gone"));
    const double = makeApp();
    defaultTab.mockReturnValue("terminal" as never);
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=10.0.0.5&type=ssh&credential=deploy%20key",
      adoptSettings(credentialState.post as never),
    );
    await vi.advanceTimersByTimeAsync(400);
    await task;
    expect(toastError).toHaveBeenCalledWith("deepLink.adoptUnavailable");
    // Two confirms: the adopt prompt, then the plain ad-hoc one.
    expect(double.confirm).toHaveBeenCalledTimes(2);
    const fallbackArgs = double.confirm.mock.calls[1][0];
    expect(fallbackArgs.description).toContain("deepLink.adhocCredentialNote");
    expect(quickConnect).toHaveBeenCalled();
    expect(double.connectHost).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default connect and fails when the registry never fills", async () => {
    const double = makeApp();
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=10.0.0.5&type=ssh",
      SETTINGS,
    );
    await vi.advanceTimersByTimeAsync(500);
    await task;
    expect(toastError).toHaveBeenCalledWith("deepLink.connectFailed");
    expect(double.connectHost).not.toHaveBeenCalled();
  });

  it("does nothing when the confirm is declined", async () => {
    const double = makeApp({ confirmResult: false });
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=10.0.0.5&type=vnc",
      SETTINGS,
    );
    await vi.advanceTimersByTimeAsync(0);
    await task;
    expect(double.confirm).toHaveBeenCalledTimes(1);
    expect(double.connectHost).not.toHaveBeenCalled();
  });

  it("surfaces a missing host", async () => {
    const double = makeApp();
    vi.useFakeTimers();
    const task = consumeDeepLink(double.app, "?connect=ghost", SETTINGS);
    await vi.advanceTimersByTimeAsync(0);
    await task;
    expect(toastError).toHaveBeenCalledWith(
      double.t("deepLink.hostNotFound", { host: "ghost" }),
    );
    expect(double.confirm).not.toHaveBeenCalled();
  });

  it("surfaces an unknown ad-hoc connection type", async () => {
    const double = makeApp();
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=10.0.0.5&type=telnet",
      SETTINGS,
    );
    await vi.advanceTimersByTimeAsync(0);
    await task;
    expect(toastError).toHaveBeenCalledWith(
      double.t("deepLink.typeUnknown", { type: "telnet" }),
    );
  });

  it("surfaces a missing credential by name", async () => {
    const double = makeApp();
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=10.0.0.5&type=ssh&credential=ghost",
      SETTINGS,
    );
    await vi.advanceTimersByTimeAsync(0);
    await task;
    expect(toastError).toHaveBeenCalledWith(
      double.t("deepLink.credentialNotFound", { name: "ghost" }),
    );
  });

  it("proceeds when the settle budget is spent without hosts or protocols", async () => {
    const double = makeApp({ hosts: [] });
    listProtocols.mockReturnValue([] as never);
    vi.useFakeTimers();
    const task = consumeDeepLink(double.app, "?connect=10.0.0.5&type=rdp", {
      settleBudgetMs: 20,
      pollMs: 10,
      defaultTabBudgetMs: 40,
    });
    await vi.advanceTimersByTimeAsync(100);
    await task;
    // The registry read as empty at the end of the budget: the ad-hoc rdp
    // link reads as an unknown type, per the plan's settle-window behavior.
    expect(toastError).toHaveBeenCalledWith(
      double.t("deepLink.typeUnknown", { type: "rdp" }),
    );
  });

  it("uses the shell onReady signal when the layout is not up yet", async () => {
    const double = makeApp();
    (
      double.app.tabs.getLayout as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValue(null);
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=Web%20Server%201&type=ssh",
      SETTINGS,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(double.confirm).not.toHaveBeenCalled();
    double.fireReady();
    await vi.advanceTimersByTimeAsync(500);
    await task;
    expect(double.confirm).toHaveBeenCalledTimes(1);
    expect(double.app.tabs.onReady).toHaveBeenCalled();
  });
});

describe("startDeepLinkConsumer", () => {
  it("no-ops on a standalone ?view= page and does not scrub there", () => {
    const double = makeApp();
    const scrub = vi.fn();
    startDeepLinkConsumer(double.app, {
      env: {
        locationSearch: () => "?view=deep-connect&connect=h1",
        scrub,
      },
    });
    expect(scrub).not.toHaveBeenCalled();
    expect(double.listHosts).not.toHaveBeenCalled();
    expect(double.confirm).not.toHaveBeenCalled();
  });

  it("scrubs the deep-link parameters from the URL before connecting", async () => {
    const double = makeApp();
    const scrub = vi.fn();
    vi.useFakeTimers();
    startDeepLinkConsumer(double.app, {
      env: {
        locationSearch: () => "?connect=Web%20Server%201&type=ssh&tab=x",
        scrub,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(scrub).toHaveBeenCalledWith("?tab=x");
    await vi.advanceTimersByTimeAsync(100);
    expect(double.confirm).toHaveBeenCalledTimes(1);
  });

  it("ignores a URL without a connect parameter", () => {
    const double = makeApp();
    const scrub = vi.fn();
    startDeepLinkConsumer(double.app, {
      env: { locationSearch: () => "?tab=x", scrub },
    });
    expect(scrub).not.toHaveBeenCalled();
    expect(double.confirm).not.toHaveBeenCalled();
  });

  it("connects through the normal app path when params exist", async () => {
    const double = makeApp();
    const scrub = vi.fn();
    vi.useFakeTimers();
    startDeepLinkConsumer(double.app, {
      env: { locationSearch: () => "?connect=10.0.0.5&type=vnc", scrub },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(double.confirm).toHaveBeenCalledTimes(1);
    expect(double.connectHost).toHaveBeenCalledTimes(1);
  });
});
