import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, act, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";

// The UI kit is served by Termix at runtime; tests stand in for its pieces
// with pass-through components so text assertions stay honest.
vi.mock("@termix-ssh/plugin-sdk/ui", () => ({
  listHostProtocols: vi.fn(() => []),
  // The consumer module imports these two; the saved-host/null-app paths in
  // this suite never reach them, but the import bindings must resolve.
  createQuickConnectHost: vi.fn((input: Record<string, unknown>) => input),
  getDefaultConnectionTab: vi.fn(() => null),
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>,
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import * as ui from "@termix-ssh/plugin-sdk/ui";
import {
  goTarget,
  resetGoStateForTests,
  StandaloneHandoff,
} from "../../src/frontend/StandaloneHandoff";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type {
  PluginHostRecord,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { setStandaloneApp } from "../../src/frontend/standalone-app";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const listProtocols = vi.mocked(ui.listHostProtocols);

const savedHost: PluginHostRecord = {
  id: "1",
  name: "Web Server 1",
  ip: "192.168.5.16",
  port: 22,
};

/**
 * A stand-in for the frame-bridged app the standalone view connects through:
 * hosts list, tab bridge and (for ad-hoc links) the api client surface.
 */
function makeViewApp(hosts: PluginHostRecord[]): TermixApp {
  return {
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    listHosts: vi.fn(async () => hosts),
    notifyHostsChanged: vi.fn(),
    api: { post: vi.fn() },
    tabs: {
      getLayout: vi.fn(() => ({ tabs: [] })),
      onReady: vi.fn(() => () => {}),
      connectHost: vi.fn(),
      openTab: vi.fn(),
    },
  } as unknown as TermixApp;
}

// Render the standalone through a throwaway plugin module so it gets the
// real SDK i18n scope (renderWithApp provides it). The link grammar arrives
// ONLY through props.params — like core 26.11.3 handing the frame its query.
let rendered: RenderedPluginApp | null = null;

async function renderHandoff(params: string) {
  const testPlugin = {
    activate(app: TermixApp) {
      app.registerTab("deep-connect", StandaloneHandoff as never, {
        titleKey: "tab.title",
        hostless: true,
        singleton: true,
      });
    },
  };
  rendered = await renderWithApp(testPlugin, {
    manifest: manifestJson as never,
    locales,
  });
  rendered.renderTab("deep-connect", {
    view: "deep-connect",
    params: new URLSearchParams(params),
  });
}

describe("goTarget", () => {
  it("keeps the grammar first-seen, adds view= and go=1, drops the rest", () => {
    expect(
      goTarget(
        "?view=deep-connect&connect=H%201&type=rdp&domain=WAG&zzz=1&port=3390&using=name&credential=adm&viewonly=1",
      ),
    ).toBe(
      "/?view=deep-connect&connect=H%201&type=rdp&domain=WAG&port=3390&using=name&credential=adm&viewonly=1&go=1",
    );
  });

  it("stays well-formed without any deep-link parameters", () => {
    expect(goTarget("?tab=x&zzz=1")).toBe("/?view=deep-connect&go=1");
  });
});

describe("StandaloneHandoff", () => {
  beforeEach(() => {
    // Spied: every window.open below in these tests is the frame's bridged
    // escape hatch stand-in.
    vi.spyOn(window, "open").mockImplementation(() => null);
    // The protocol registry must be settled for the connect paths; the
    // refusal test below overrides it.
    listProtocols.mockReturnValue([
      { id: "rdp", defaultPort: 3389 },
      { id: "vnc", defaultPort: 5900 },
    ] as never);
  });

  afterEach(async () => {
    await rendered?.deactivate();
    rendered = null;
    cleanup();
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
    setStandaloneApp(null);
    resetGoStateForTests();
    window.localStorage.removeItem("deep-connect.go-armed");
    vi.restoreAllMocks();
  });

  it("shows the empty state when the params have no connect parameter", async () => {
    await renderHandoff("view=deep-connect");
    expect(screen.getByText(locales.handoff.noPayload)).toBeTruthy();
    expect(screen.getByText(locales.tab.empty)).toBeTruthy();
    expect(screen.queryByText(locales.handoff.cancel)).toBeNull();
  });

  it("consumes props.params and never touches window.location.search", async () => {
    window.history.replaceState(null, "", "/?zzz=foreign");
    await renderHandoff("connect=H1&type=rdp&credential=adm");
    // The confirm is rendered from the params, not the (empty-in-a-frame)
    // location: the same location would show the empty state.
    expect(screen.getByText("Open H1?")).toBeTruthy();
    expect(document.body.textContent).toContain("Using credential adm.");
    expect(document.body.textContent).toContain("Connection type: RDP.");
    expect(screen.getByText(locales.handoff.go)).toBeTruthy();
    // Rendering scrubs nothing: the frame never owns the page URL.
    expect(window.location.search).toBe("?zzz=foreign");
  });

  it("the grace timer can never bypass the confirm", async () => {
    vi.useFakeTimers();
    await renderHandoff("connect=10.0.0.5&type=rdp&using=adhoc");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    // Long past the grace period: still the confirm card, nothing opened.
    expect(screen.getByText(locales.handoff.go)).toBeTruthy();
    expect(screen.getByText(locales.handoff.cancel)).toBeTruthy();
    expect(screen.queryByText(locales.handoff.opening)).toBeNull();
    expect(window.open).not.toHaveBeenCalled();
  });

  it("refuses a doomed ad-hoc link on the confirm click", async () => {
    listProtocols.mockReturnValue([] as never);
    await renderHandoff("connect=10.0.0.5&type=rdp&using=adhoc");
    fireEvent.click(screen.getByText(locales.handoff.go));
    expect(screen.getByText(locales.handoff.noPlugin)).toBeTruthy();
    expect(window.open).not.toHaveBeenCalled();
  });

  it("clears itself out on cancel, from the captured params", async () => {
    await renderHandoff("connect=H1&type=rdp&domain=WAG&zzz=1");
    fireEvent.click(screen.getByText(locales.handoff.cancel));
    expect(screen.getByText(locales.handoff.cancelled)).toBeTruthy();
  });

  it("connects a saved host in place and shows the session-opened state", async () => {
    const app = makeViewApp([savedHost]);
    setStandaloneApp(app);
    await renderHandoff("connect=Web%20Server%201");
    fireEvent.click(screen.getByText(locales.handoff.go));
    await waitFor(() =>
      expect(screen.getByText(locales.handoff.sessionOpened)).toBeTruthy(),
    );
    const connectHost = (
      app.tabs as unknown as { connectHost: ReturnType<typeof vi.fn> }
    ).connectHost;
    expect(connectHost).toHaveBeenCalledTimes(1);
    expect(connectHost).toHaveBeenCalledWith(savedHost, undefined);
    expect(window.open).not.toHaveBeenCalled();
  });

  it("falls back to one go=1 new tab when no app surface exists", async () => {
    setStandaloneApp(null);
    await renderHandoff("connect=H1&type=rdp");
    fireEvent.click(screen.getByText(locales.handoff.go));
    await waitFor(() =>
      expect(screen.getByText(locales.handoff.fallbackNote)).toBeTruthy(),
    );
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledWith(
      "/?view=deep-connect&connect=H1&type=rdp&go=1",
      "_blank",
    );
    expect(screen.queryByText(locales.handoff.sessionOpened)).toBeNull();
  });

  it("cannot be skipped by a bare go=1 link: no marker, no auto-consume", async () => {
    const app = makeViewApp([savedHost]);
    setStandaloneApp(app);
    await renderHandoff("connect=Web%20Server%201&go=1");
    await waitFor(() =>
      expect(screen.getByText(locales.handoff.go)).toBeTruthy(),
    );
    // A crafted URL without the armed marker lands on the confirm card.
    const connectHost = (
      app.tabs as unknown as { connectHost: ReturnType<typeof vi.fn> }
    ).connectHost;
    expect(connectHost).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it("an armed go=1 auto-consumes once and never re-windows", async () => {
    const app = makeViewApp([savedHost]);
    setStandaloneApp(app);
    window.localStorage.setItem("deep-connect.go-armed", "1");
    await renderHandoff("connect=Web%20Server%201&go=1");
    await waitFor(() =>
      expect(screen.getByText(locales.handoff.sessionOpened)).toBeTruthy(),
    );
    const connectHost = (
      app.tabs as unknown as { connectHost: ReturnType<typeof vi.fn> }
    ).connectHost;
    expect(connectHost).toHaveBeenCalledTimes(1);
    expect(window.open).not.toHaveBeenCalled();
    // The one-shot marker is spent with the auto-consume.
    expect(window.localStorage.getItem("deep-connect.go-armed")).toBeNull();

    // A second armed delivery in the same page shares the first run: the
    // auto-consume executes at most once per module life and opens nothing.
    window.localStorage.setItem("deep-connect.go-armed", "1");
    await renderHandoff("connect=Web%20Server%201&go=1");
    await waitFor(() =>
      expect(screen.getByText(locales.handoff.sessionOpened)).toBeTruthy(),
    );
    expect(connectHost).toHaveBeenCalledTimes(1);
    expect(window.open).not.toHaveBeenCalled();
  });

  it("an armed go=1 with a missing surface ends in the error card", async () => {
    setStandaloneApp(null);
    window.localStorage.setItem("deep-connect.go-armed", "1");
    await renderHandoff("connect=H1&go=1");
    await waitFor(() =>
      expect(screen.getByText(locales.deepLink.connectFailed)).toBeTruthy(),
    );
    // The go=1 view NEVER opens another window: failures dead-end here.
    expect(window.open).not.toHaveBeenCalled();
  });

  it("a go=1 link without a connect parameter shows the empty state", async () => {
    window.localStorage.setItem("deep-connect.go-armed", "1");
    await renderHandoff("go=1");
    expect(screen.getByText(locales.handoff.noPayload)).toBeTruthy();
    expect(window.open).not.toHaveBeenCalled();
  });

  it("keeps window.location.search out of the standalone path entirely", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/frontend/StandaloneHandoff.tsx"),
      "utf8",
    );
    // The frame's location.search is always empty in a sandbox; the params
    // ride props. Any read of location.search here would consume nothing.
    expect(source.includes("location.search")).toBe(false);
  });
});
