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
  notifyHostsChanged: vi.fn(),
}));

// Deliberately NOT exporting usePluginApi from this mock: without an injected
// `adoptApi` the consumer must fall back to the v1 ad-hoc flow, and these
// mocks exercise exactly that.
import { toast } from "sonner";
import * as ui from "@termix-ssh/plugin-sdk/ui";
import {
  notifyHostsChanged as sdkNotify,
  type PluginApiClient,
  type PluginCredentialSummary,
  type PluginHostRecord,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  consumeDeepLink,
  resetDeepLinkConsumerForTests,
  runConnectIntentSilently,
  startDeepLinkConsumer,
  startTermixLinkConsumer,
} from "../../src/frontend/consumer";
import { parseDeepLinkConnect } from "../../src/frontend/deep-link";

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

interface TestLink {
  url: string;
  source: "os-scheme" | "command-line";
}

interface AppDouble {
  app: TermixApp;
  confirm: ReturnType<typeof vi.fn>;
  listHosts: ReturnType<typeof vi.fn>;
  connectHost: ReturnType<typeof vi.fn>;
  openTab: ReturnType<typeof vi.fn>;
  onOpen: ReturnType<typeof vi.fn>;
  fireReady: () => void;
  disposeAll: () => void;
  deliverLink: (link: TestLink) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function makeApp(options?: {
  hosts?: PluginHostRecord[];
  credentials?: PluginCredentialSummary[];
  confirmResult?: boolean;
  /** Queued termix:// links replayed to the listener on registration. */
  queuedLinks?: TestLink[];
}): AppDouble {
  const onReadyListeners: (() => void)[] = [];
  const disposers: (() => void)[] = [];
  const t = (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key;
  const confirm = vi.fn(async () => options?.confirmResult ?? true);
  const listHosts = vi.fn(async () => options?.hosts ?? hosts);
  // A faithful stand-in for core's deep-links module: deliveries land in a
  // recent list (≤20) that every NEW registration replays — the same link
  // objects, exactly what a plugin disable/enable hands back — and the
  // returned disposer removes only that listener from later deliveries.
  const activeListeners = new Set<(link: TestLink) => void>();
  const recentLinks: TestLink[] = [];
  const onOpen = vi.fn((listener: (link: TestLink) => void): (() => void) => {
    activeListeners.add(listener);
    for (const link of recentLinks) {
      listener(link);
    }
    return () => activeListeners.delete(listener);
  });
  const deliverLink = (link: TestLink): void => {
    recentLinks.push(link);
    if (recentLinks.length > 20) recentLinks.shift();
    for (const listener of [...activeListeners]) {
      listener(link);
    }
  };
  for (const link of options?.queuedLinks ?? []) {
    deliverLink(link);
  }
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
    onDispose: (fn: () => void) => {
      disposers.push(fn);
    },
    ...(options?.queuedLinks ? { deepLinks: { onOpen } } : {}),
  } as unknown as TermixApp;
  return {
    app,
    confirm,
    listHosts,
    connectHost: app.tabs.connectHost as never,
    openTab: (app.tabs as unknown as { openTab: ReturnType<typeof vi.fn> })
      .openTab,
    onOpen,
    fireReady: () => onReadyListeners.forEach((listener) => listener()),
    disposeAll: () => disposers.forEach((disposer) => disposer()),
    deliverLink,
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
): {
  settleBudgetMs: number;
  pollMs: number;
  defaultTabBudgetMs: number;
  adoptApi: () => PluginApiClient;
} {
  return {
    ...SETTINGS,
    adoptApi: () =>
      (api ? { post: api as unknown } : null) as unknown as PluginApiClient,
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

  it("carries an ad-hoc rdp/vnc credential by id on the quick connect", async () => {
    // The route IS injected but refuses (adopt unavailable): the fallback
    // quick connect now carries the credential by id, so there is no
    // not-carried note and no prompt story.
    post.mockRejectedValue(new Error("route gone"));
    const double = makeApp();
    defaultTab.mockReturnValue(null as never);
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=10.0.0.5&type=vnc&credential=deploy%20key",
      adoptSettings(credentialState.post as never),
    );
    await vi.advanceTimersByTimeAsync(400);
    await task;
    expect(toastError).toHaveBeenCalledWith("deepLink.adoptUnavailable");
    expect(double.confirm).toHaveBeenCalledTimes(2);
    const fallbackArgs = double.confirm.mock.calls[1][0];
    expect(fallbackArgs.description).toContain("deepLink.credentialNote");
    expect(fallbackArgs.description).not.toContain(
      "deepLink.adhocCredentialNote",
    );
    expect(quickConnect).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "10.0.0.5", port: 5900 }),
    );
    const host = double.connectHost.mock.calls[0][0] as Record<string, unknown>;
    const login = host.quickConnectLogin as Record<string, unknown>;
    expect(login).toMatchObject({ protocol: "vnc", credentialId: 7 });
    expect("username" in login).toBe(false);
    expect("password" in login).toBe(false);
  });

  it("applies viewonly=1 on an ad-hoc plugin-protocol quick connect", async () => {
    const double = makeApp();
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=10.0.0.5&type=vnc&viewonly=1",
      SETTINGS,
    );
    await vi.advanceTimersByTimeAsync(400);
    await task;
    const host = double.connectHost.mock.calls[0][0] as Record<string, unknown>;
    const login = host.quickConnectLogin as Record<string, unknown>;
    expect(login.viewOnly).toBe(true);
    expect(login.protocol).toBe("vnc");
    const description = double.confirm.mock.calls[0][0].description as string;
    expect(description).toContain("deepLink.viewOnlyNote");
    expect(description).not.toContain("deepLink.viewOnlySavedNote");
  });

  it("adds the viewonly note without applying view-only on ssh links", async () => {
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
        "deepLink.viewOnlySavedNote",
      ),
    ).toBe(true);
    // SSH quick connects never carry a quickConnectLogin.
    expect(quickConnect.mock.calls[0][0]).not.toHaveProperty(
      "quickConnectLogin",
    );
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
    expect(dialog.title).toBe(
      double.t("deepLink.adoptTitle", { host: "10.0.0.5" }),
    );
    expect(dialog.confirmLabel).toBe("deepLink.adoptAction");
    expect(dialog.description).toContain("deepLink.adoptDescription");
    // The real en.json text carries the folder name; the double's t() only
    // renders params, so assert the interpolation payload.
    expect(dialog.description).toContain('\"name\":\"Deploy Key\"');
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
    expect(double.openTab).toHaveBeenCalledWith(pluginMade, "vnc", {
      label: "192.168.103.99",
    });
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
    expect(double.openTab).toHaveBeenCalledWith(userHost, "vnc", {
      label: "wag-server01",
    });
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
    expect(double.openTab).toHaveBeenCalledWith(pluginMade, "rdp", {
      label: "wag-itvm15",
    });
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

  it("no-ops when the page has no search string at all (in-frame)", () => {
    const double = makeApp();
    const scrub = vi.fn();
    startDeepLinkConsumer(double.app, {
      env: { locationSearch: () => "", scrub },
    });
    // A sandboxed frame's location carries no search and the shell forwards
    // none: nothing consumes, nothing scrubs — the standalone ?view= page
    // owns web consumption.
    expect(scrub).not.toHaveBeenCalled();
    expect(listProtocols).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(double.confirm).not.toHaveBeenCalled();
  });
});

describe("runConnectIntentSilently", () => {
  it("connects a saved host straight through connectHost, no dialog", async () => {
    const double = makeApp();
    const outcome = await runConnectIntentSilently(
      double.app,
      parseDeepLinkConnect("?connect=Web%20Server%201")!,
      SETTINGS,
    );
    expect(outcome).toBe("opened");
    expect(double.connectHost).toHaveBeenCalledTimes(1);
    expect(double.connectHost).toHaveBeenCalledWith(hosts[0], undefined);
    expect(double.confirm).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(double.openTab).not.toHaveBeenCalled();
  });

  it("passes the link's protocol as the connect type for a saved host", async () => {
    const double = makeApp();
    const outcome = await runConnectIntentSilently(
      double.app,
      parseDeepLinkConnect("?connect=Web%20Server%201&type=vnc")!,
      SETTINGS,
    );
    expect(outcome).toBe("opened");
    expect(double.connectHost).toHaveBeenCalledWith(hosts[0], "vnc");
  });

  it("reports failure (with a toast) for an unresolved host, no retries", async () => {
    const double = makeApp({ hosts: [] });
    vi.useFakeTimers();
    const run = runConnectIntentSilently(
      double.app,
      parseDeepLinkConnect("?connect=Ghost&using=name")!,
      SETTINGS,
    );
    await vi.advanceTimersByTimeAsync(600);
    const outcome = await run;
    vi.useRealTimers();
    expect(outcome).toBe("failed");
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("hostNotFound"),
    );
    expect(double.connectHost).not.toHaveBeenCalled();
    expect(double.confirm).not.toHaveBeenCalled();
  });

  it("reports failure for a credential name that does not resolve", async () => {
    credentialState.credentials = [];
    const double = makeApp();
    const outcome = await runConnectIntentSilently(
      double.app,
      parseDeepLinkConnect(
        "?connect=10.0.0.5&type=vnc&credential=Nope&using=adhoc",
      )!,
      SETTINGS,
    );
    expect(outcome).toBe("failed");
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("credentialNotFound"),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("adopts a credentialed ad-hoc link and opens the protocol tab on the new id", async () => {
    const created: PluginHostRecord = {
      id: "42",
      name: "10.0.0.5",
      ip: "10.0.0.5",
      port: 5900,
      connectionType: "vnc",
    };
    const double = makeApp({ hosts: [created] });
    const outcome = await runConnectIntentSilently(
      double.app,
      parseDeepLinkConnect(
        "?connect=10.0.0.5&type=vnc&credential=Deploy%20Key&using=adhoc",
      )!,
      { ...SETTINGS, adoptApi: () => ({ post }) as unknown as PluginApiClient },
    );
    expect(outcome).toBe("opened");
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/adopt", {
      hostName: "10.0.0.5",
      type: "vnc",
      credentialId: 7,
      port: 5900,
    });
    expect(sdkNotify).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("adoptCreated"),
    );
    expect(double.openTab).toHaveBeenCalledTimes(1);
    expect(double.openTab).toHaveBeenCalledWith(created, "vnc");
    expect(double.connectHost).not.toHaveBeenCalled();
    expect(double.confirm).not.toHaveBeenCalled();
  });

  it("opens the terminal hand-off when an ssh link adopts", async () => {
    const created: PluginHostRecord = {
      id: "42",
      name: "10.0.0.5",
      ip: "10.0.0.5",
      port: 22,
    };
    const double = makeApp({ hosts: [created] });
    const outcome = await runConnectIntentSilently(
      double.app,
      parseDeepLinkConnect(
        "?connect=10.0.0.5&credential=Deploy%20Key&using=adhoc",
      )!,
      { ...SETTINGS, adoptApi: () => ({ post }) as unknown as PluginApiClient },
    );
    expect(outcome).toBe("opened");
    expect(post).toHaveBeenCalledWith("/adopt", {
      hostName: "10.0.0.5",
      type: "ssh",
      credentialId: 7,
      port: 22,
    });
    expect(double.openTab).not.toHaveBeenCalled();
    expect(double.connectHost).toHaveBeenCalledWith(created, "terminal");
  });

  it("cannot open a credential-less ad-hoc link from a view", async () => {
    const double = makeApp();
    const outcome = await runConnectIntentSilently(
      double.app,
      parseDeepLinkConnect("?connect=10.0.0.5&type=vnc&using=adhoc")!,
      SETTINGS,
    );
    expect(outcome).toBe("unavailable");
    expect(post).not.toHaveBeenCalled();
    expect(double.openTab).not.toHaveBeenCalled();
    expect(double.connectHost).not.toHaveBeenCalled();
  });

  it("is unavailable when the app surface cannot act", async () => {
    const double = makeApp();
    // No usable app at all (a stubbed or unbridged holder entry).
    expect(
      await runConnectIntentSilently(
        null as unknown as TermixApp,
        parseDeepLinkConnect("?connect=Web%20Server%201")!,
        SETTINGS,
      ),
    ).toBe("unavailable");
    // An app without a tabs surface.
    const bareApp = { listHosts: double.listHosts } as unknown as TermixApp;
    expect(
      await runConnectIntentSilently(
        bareApp,
        parseDeepLinkConnect("?connect=Web%20Server%201")!,
        SETTINGS,
      ),
    ).toBe("unavailable");
    expect(double.connectHost).not.toHaveBeenCalled();
  });

  it("is unavailable when the adopt route refuses and the open leg throws", async () => {
    const double = makeApp({ hosts: [] });
    // Route failure:
    post.mockRejectedValueOnce(new Error("404"));
    const failed = await runConnectIntentSilently(
      double.app,
      parseDeepLinkConnect(
        "?connect=10.0.0.5&type=vnc&credential=Deploy%20Key&using=adhoc",
      )!,
      { ...SETTINGS, adoptApi: () => ({ post }) as unknown as PluginApiClient },
    );
    expect(failed).toBe("unavailable");
    // Open-leg failure: the row exists on the list but tabs refuse.
    const throwing = makeApp({
      hosts: [{ id: "42", name: "10.0.0.5" } as PluginHostRecord],
    });
    throwing.openTab.mockImplementationOnce(() => {
      throw new Error("bridge refused");
    });
    const legFailed = await runConnectIntentSilently(
      throwing.app,
      parseDeepLinkConnect(
        "?connect=10.0.0.5&type=vnc&credential=Deploy%20Key&using=adhoc",
      )!,
      {
        ...SETTINGS,
        adoptApi: () => ({ post }) as unknown as PluginApiClient,
      },
    );
    expect(legFailed).toBe("unavailable");
    vi.useRealTimers();
  });
});

describe("startTermixLinkConsumer", () => {
  function linkSettings() {
    return {
      settleBudgetMs: 200,
      pollMs: 10,
      defaultTabBudgetMs: 100,
    };
  }

  it("no-ops when the shell does not expose the deepLinks seam", () => {
    const double = makeApp();
    startTermixLinkConsumer(double.app, linkSettings());
    expect(double.confirm).not.toHaveBeenCalled();
    // The registration never even reached a listener.
    expect(double.onOpen).not.toHaveBeenCalled();
  });

  it("connects a query-form link through the same grammar and confirm", async () => {
    const double = makeApp({
      queuedLinks: [
        {
          url: "termix://deep-connect?connect=Web%20Server%201",
          source: "os-scheme",
        },
      ],
    });
    defaultTab.mockReturnValue("terminal" as never);
    vi.useFakeTimers();
    startTermixLinkConsumer(double.app, linkSettings());
    await vi.advanceTimersByTimeAsync(300);
    expect(double.confirm).toHaveBeenCalledTimes(1);
    expect(double.connectHost).toHaveBeenCalledWith(hosts[0], "terminal");
  });

  it("parses the path form and a registered protocol type", async () => {
    const double = makeApp({
      queuedLinks: [
        { url: "termix://connect/10.0.0.5?type=vnc", source: "os-scheme" },
      ],
    });
    vi.useFakeTimers();
    startTermixLinkConsumer(double.app, linkSettings());
    await vi.advanceTimersByTimeAsync(300);
    expect(double.confirm).toHaveBeenCalledTimes(1);
    expect(double.connectHost.mock.calls[0][1]).toBe("vnc");
    const host = double.connectHost.mock.calls[0][0] as Record<string, unknown>;
    expect(host.connectionType).toBe("vnc");
  });

  it("confirms command-line links too — every source confirms first", async () => {
    const double = makeApp({
      queuedLinks: [
        { url: "termix://connect/10.0.0.5?type=vnc", source: "command-line" },
      ],
    });
    vi.useFakeTimers();
    startTermixLinkConsumer(double.app, linkSettings());
    await vi.advanceTimersByTimeAsync(300);
    expect(double.confirm).toHaveBeenCalledTimes(1);
    expect(double.connectHost).toHaveBeenCalledTimes(1);
  });

  it("ignores core's termix://host/<id> links entirely", async () => {
    const double = makeApp({
      queuedLinks: [
        { url: "termix://host/12", source: "os-scheme" },
        { url: "termix://host/12?connect=web-01", source: "os-scheme" },
      ],
    });
    vi.useFakeTimers();
    startTermixLinkConsumer(double.app, linkSettings());
    await vi.advanceTimersByTimeAsync(300);
    expect(double.confirm).not.toHaveBeenCalled();
    expect(double.connectHost).not.toHaveBeenCalled();
  });

  it("runs replayed links one at a time in arrival order", async () => {
    const double = makeApp({
      queuedLinks: [
        { url: "termix://connect/Web%20Server%201", source: "os-scheme" },
        { url: "termix://connect/10.0.0.5?type=vnc", source: "os-scheme" },
        { url: "termix://connect/bogus%%target?type=vnc", source: "os-scheme" },
      ],
    });
    // The saved-host link connects through the polled default connection.
    defaultTab.mockReturnValueOnce("terminal" as never);
    vi.useFakeTimers();
    startTermixLinkConsumer(double.app, linkSettings());
    await vi.advanceTimersByTimeAsync(500);
    expect(double.confirm).toHaveBeenCalledTimes(2);
    expect(double.confirm.mock.calls[0][0].title).toContain("Web Server 1");
    expect(double.confirm.mock.calls[1][0].title).not.toContain("Web Server 1");
    expect(double.connectHost).toHaveBeenCalledTimes(2);
    // Strict arrival order: each link completed before the next started.
    expect(double.confirm.mock.invocationCallOrder[0]).toBeLessThan(
      double.confirm.mock.invocationCallOrder[1],
    );
  });

  it("ignores a replayed link after re-registration, and runs a new link", async () => {
    const double = makeApp({
      queuedLinks: [
        { url: "termix://connect/Web%20Server%201", source: "os-scheme" },
      ],
    });
    defaultTab.mockReturnValue("terminal" as never);
    vi.useFakeTimers();
    // First registration: core replays the launch link; it confirms once.
    startTermixLinkConsumer(double.app, linkSettings());
    await vi.advanceTimersByTimeAsync(300);
    expect(double.confirm).toHaveBeenCalledTimes(1);
    expect(double.connectHost).toHaveBeenCalledTimes(1);
    // Plugin disable/enable: the disposer fires, activate registers again,
    // and core replays the SAME link object to the new listener. The replay
    // must NOT enqueue or re-confirm the already-consumed link.
    double.disposeAll();
    startTermixLinkConsumer(double.app, linkSettings());
    await vi.advanceTimersByTimeAsync(300);
    expect(double.confirm).toHaveBeenCalledTimes(1);
    expect(double.connectHost).toHaveBeenCalledTimes(1);
    // A genuinely new delivery (a fresh link object — the guard is identity,
    // not the URL) still runs, after the replayed delivery was dropped.
    double.deliverLink({
      url: "termix://connect/10.0.0.5?type=vnc",
      source: "os-scheme",
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(double.confirm).toHaveBeenCalledTimes(2);
    expect(double.connectHost).toHaveBeenCalledTimes(2);
    expect(double.connectHost.mock.calls[1][1]).toBe("vnc");
  });

  it("carries the credential id and view-only flag through a termix link", async () => {
    const double = makeApp({
      queuedLinks: [
        {
          url: "termix://connect/10.0.0.5?type=vnc&credential=deploy%20key&viewonly=1",
          source: "os-scheme",
        },
      ],
    });
    vi.useFakeTimers();
    startTermixLinkConsumer(double.app, linkSettings());
    await vi.advanceTimersByTimeAsync(300);
    expect(double.confirm).toHaveBeenCalledTimes(1);
    const host = double.connectHost.mock.calls[0][0] as Record<string, unknown>;
    expect(host.quickConnectLogin).toMatchObject({
      protocol: "vnc",
      credentialId: 7,
      viewOnly: true,
    });
  });

  it("surfaces refusals as toasts without confirming anything", async () => {
    const double = makeApp({
      queuedLinks: [{ url: "termix://connect/ghost", source: "os-scheme" }],
    });
    vi.useFakeTimers();
    startTermixLinkConsumer(double.app, linkSettings());
    await vi.advanceTimersByTimeAsync(300);
    expect(toastError).toHaveBeenCalledWith(
      double.t("deepLink.hostNotFound", { host: "ghost" }),
    );
    expect(double.confirm).not.toHaveBeenCalled();
  });
});
