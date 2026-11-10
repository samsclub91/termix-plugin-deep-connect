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
}));

vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  listCredentials: vi.fn(async () => credentialState.credentials),
}));

import { toast } from "sonner";
import * as ui from "@termix-ssh/plugin-sdk/ui";
import type {
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
    pluginId: "lansweeper-connector",
    t,
    listHosts,
    confirm,
    tabs: {
      getLayout: vi.fn(() => ({ tabs: [] })),
      onReady: vi.fn((listener: () => void) => {
        onReadyListeners.push(listener);
        return () => {};
      }),
      connectHost: vi.fn(),
    },
  } as unknown as TermixApp;
  return {
    app,
    confirm,
    listHosts,
    connectHost: app.tabs.connectHost as never,
    fireReady: () => onReadyListeners.forEach((listener) => listener()),
    t,
  };
}

const SETTINGS = {
  settleBudgetMs: 500,
  pollMs: 10,
  defaultTabBudgetMs: 200,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetDeepLinkConsumerForTests();
  credentialState.credentials = credentials as unknown[];
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
  });

  it("adds the viewonly note without applying view-only", async () => {
    const double = makeApp();
    vi.useFakeTimers();
    const task = consumeDeepLink(
      double.app,
      "?connect=10.0.0.5&type=ssh&viewonly=1",
      SETTINGS,
    );
    await vi.advanceTimersByTimeAsync(400);
    await task;
    expect(
      (double.confirm.mock.calls[0][0].description as string).includes(
        "deepLink.viewOnlyNote",
      ),
    ).toBe(true);
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
        locationSearch: () => "?view=lansweeper-connect&connect=h1",
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
    // Nothing to scrub: the URL carries no deep-link parameters.
    expect(scrub).not.toHaveBeenCalled();
    expect(double.listHosts).not.toHaveBeenCalled();
    expect(double.confirm).not.toHaveBeenCalled();
  });

  it("consumes an intent exactly once", async () => {
    const double = makeApp();
    const scrub = vi.fn();
    vi.useFakeTimers();
    startDeepLinkConsumer(double.app, {
      env: { locationSearch: () => "?connect=10.0.0.5&type=vnc", scrub },
    });
    await vi.advanceTimersByTimeAsync(100);
    startDeepLinkConsumer(double.app, {
      env: { locationSearch: () => "?connect=10.0.0.5&type=vnc", scrub },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(double.confirm).toHaveBeenCalledTimes(1);
    expect(double.connectHost).toHaveBeenCalledTimes(1);
  });
});
