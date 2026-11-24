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
  // The landing resolver module imports these two; the flows in this suite
  // never reach them, but the import bindings must resolve.
  createQuickConnectHost: vi.fn((input: Record<string, unknown>) => input),
  getDefaultConnectionTab: vi.fn(() => null),
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import * as ui from "@termix-ssh/plugin-sdk/ui";
import { StandaloneHandoff } from "../../src/frontend/StandaloneHandoff";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type {
  PluginCredentialSummary,
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

const deployKey: PluginCredentialSummary = {
  id: 5,
  name: "Deploy Key",
  username: "deploy",
  authType: "password",
};

interface AdoptDouble {
  /** The value the api.post resolves with (the verify target), or rejects. */
  result?: { data: unknown };
  reject?: boolean;
}

/**
 * A stand-in for the frame-bridged app the landing resolves through: the
 * live host list, the app-level credential list the resolver honors, the
 * api client (the adoption POST) — and the TAB SPIES that must never fire:
 * the standalone path opens sessions only inside Termix's shell, never from
 * this page.
 */
function makeViewApp(options?: {
  hosts?: PluginHostRecord[];
  credentials?: PluginCredentialSummary[];
  adopt?: AdoptDouble;
}): TermixApp {
  const post = vi.fn(async () => {
    if (options?.adopt?.reject) throw new Error("adopt route refused");
    return options?.adopt?.result ?? { data: { created: true, hostId: 42 } };
  });
  return {
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    listHosts: vi.fn(async () => options?.hosts ?? [savedHost]),
    listCredentials: vi.fn(async () => options?.credentials ?? []),
    notifyHostsChanged: vi.fn(),
    api: { post },
    tabs: {
      getLayout: vi.fn(() => ({ tabs: [] })),
      onReady: vi.fn(() => () => {}),
      connectHost: vi.fn(),
      openTab: vi.fn(),
    },
  } as unknown as TermixApp;
}

/** The tab spies of the app double, for the zero-call assertions. */
function tabSpies(app: TermixApp): {
  connectHost: ReturnType<typeof vi.fn>;
  openTab: ReturnType<typeof vi.fn>;
} {
  const tabs = app.tabs as unknown as {
    connectHost: ReturnType<typeof vi.fn>;
    openTab: ReturnType<typeof vi.fn>;
  };
  return { connectHost: tabs.connectHost, openTab: tabs.openTab };
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

describe("StandaloneHandoff", () => {
  beforeEach(() => {
    // Spied: every window.open below in these tests is the frame's bridged
    // escape hatch stand-in (root-relative → the app page origin).
    vi.spyOn(window, "open").mockImplementation(() => null);
    // The ?view= page's registry NEVER populates (the shell never mounts
    // there): the landing resolves without consulting it at all, so the
    // empty value below is the live truth, not a "not settled yet" stand-in.
    listProtocols.mockReturnValue([] as never);
  });

  afterEach(async () => {
    await rendered?.deactivate();
    rendered = null;
    cleanup();
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
    setStandaloneApp(null);
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
    const app = makeViewApp();
    setStandaloneApp(app);
    vi.useFakeTimers();
    await renderHandoff("connect=10.0.0.5&type=rdp&using=adhoc");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    // Long past the grace period: still the confirm card, nothing resolved,
    // nothing opened, nothing saved.
    expect(screen.getByText(locales.handoff.go)).toBeTruthy();
    expect(screen.getByText(locales.handoff.cancel)).toBeTruthy();
    expect(window.open).not.toHaveBeenCalled();
    expect(tabSpies(app).connectHost).not.toHaveBeenCalled();
    expect(tabSpies(app).openTab).not.toHaveBeenCalled();
  });

  it("refuses a connection type the adopt route cannot create", async () => {
    // From the view, the classification set is the adopt route's accepted
    // set (ssh/vnc/rdp — validated by the backend itself): a type outside it
    // (the registry is absent on this page and never consulted) keeps the
    // plain typeUnknown refusal. No poll runs first: this card is instant.
    const app = makeViewApp();
    setStandaloneApp(app);
    await renderHandoff("connect=10.0.0.5&type=telnet&using=adhoc");
    fireEvent.click(screen.getByText(locales.handoff.go));
    // The link's own type is not one the save route can create: the plain
    // refusal card shows — post, tabs and windows untouched.
    await waitFor(
      () => expect(screen.getByText(locales.handoff.noPlugin)).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(tabSpies(app).connectHost).not.toHaveBeenCalled();
    expect(tabSpies(app).openTab).not.toHaveBeenCalled();
    expect(
      (app.api as unknown as { post: ReturnType<typeof vi.fn> }).post,
    ).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it("clears itself out on cancel, from the captured params", async () => {
    await renderHandoff("connect=H1&type=rdp&domain=WAG&zzz=1");
    fireEvent.click(screen.getByText(locales.handoff.cancel));
    expect(screen.getByText(locales.handoff.cancelled)).toBeTruthy();
  });

  it("lands a saved host honestly: no connect call, one app-root tab", async () => {
    const app = makeViewApp({ hosts: [savedHost] });
    setStandaloneApp(app);
    await renderHandoff("connect=Web%20Server%201");
    fireEvent.click(screen.getByText(locales.handoff.go));
    // The truthful finish: Termix opens in a new tab with the record ready,
    // and the card says the page itself cannot open sessions.
    await waitFor(() =>
      expect(screen.getByText(locales.handoff.finishTitle)).toBeTruthy(),
    );
    expect(screen.getByText(locales.handoff.openTermix)).toBeTruthy();
    expect(
      screen.getByText(
        locales.handoff.finishSaved.replace("{{host}}", "Web Server 1"),
      ),
    ).toBeTruthy();
    expect(document.body.textContent).toContain(
      "this page cannot open sessions",
    );
    // The landing tab rides the click, root-relative, exactly one.
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledWith("/", "_blank");
    // The standalone path NEVER dispatches a session: the tab bridge is
    // dead on this page and its failures are unobservable.
    expect(tabSpies(app).connectHost).not.toHaveBeenCalled();
    expect(tabSpies(app).openTab).not.toHaveBeenCalled();
  });

  it("the landing card's [Open Termix] is the manual path", async () => {
    const app = makeViewApp({ hosts: [savedHost] });
    setStandaloneApp(app);
    await renderHandoff("connect=Web%20Server%201");
    fireEvent.click(screen.getByText(locales.handoff.go));
    await waitFor(() =>
      expect(screen.getByText(locales.handoff.openTermix)).toBeTruthy(),
    );
    const bridge = window.open as ReturnType<typeof vi.fn>;
    const afterLanding = bridge.mock.calls.length;
    fireEvent.click(screen.getByText(locales.handoff.openTermix));
    expect(window.open).toHaveBeenCalledTimes(afterLanding + 1);
    expect((window.open as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual(
      ["/", "_blank"],
    );
    expect(tabSpies(app).connectHost).not.toHaveBeenCalled();
  });

  it("adopts a credentialed ad-hoc link: verified POST, then landing", async () => {
    const app = makeViewApp({
      credentials: [deployKey],
      adopt: { result: { data: { created: true, hostId: 42 } } },
    });
    setStandaloneApp(app);
    await renderHandoff(
      new URLSearchParams({
        connect: "10.0.0.5",
        type: "vnc",
        credential: "Deploy Key",
        using: "adhoc",
      }).toString(),
    );
    fireEvent.click(screen.getByText(locales.handoff.go));
    await waitFor(() =>
      expect(screen.getByText(locales.handoff.finishTitle)).toBeTruthy(),
    );
    const post = (app.api as unknown as { post: ReturnType<typeof vi.fn> })
      .post;
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/adopt", {
      hostName: "10.0.0.5",
      type: "vnc",
      credentialId: 5,
      // No port: the view has no protocol registry to default from, so the
      // adopt route applies its own protocol default server-side.
    });
    // The tab opens only AFTER the verified response: adoption first,
    // landing second, in that order.
    const bridge = window.open as ReturnType<typeof vi.fn>;
    expect(bridge.mock.calls.length).toBe(1);
    expect(bridge.mock.calls[0]).toEqual(["/", "_blank"]);
    expect(post.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.mock.invocationCallOrder[0],
    );
    expect(
      screen.getByText(
        locales.handoff.finishAdopted.replace("{{host}}", "10.0.0.5"),
      ),
    ).toBeTruthy();
    expect(tabSpies(app).connectHost).not.toHaveBeenCalled();
    expect(tabSpies(app).openTab).not.toHaveBeenCalled();
  });

  it("adopts a VNC console link on the registry-less view instantly (the fix-pass regression)", async () => {
    // THE LIVE SOAK FINDING, as a test: on a real ?view= page the protocol
    // registry NEVER populates (the shell never mounts there). The old
    // landing polled it for its whole settle budget and then refused with
    // the typeUnknown card — every VNC console link was dead from the web.
    // Now the adoption classifies by the link's own type with no registry
    // read at all: same confirm → verified POST → the landing card, fast.
    const app = makeViewApp({
      credentials: [deployKey],
      adopt: { result: { data: { created: true, hostId: 42 } } },
    });
    setStandaloneApp(app);
    await renderHandoff("connect=10.0.0.5&type=vnc&credential=Deploy%20Key");
    expect(listProtocols).not.toHaveBeenCalled(); // rendering: no poll leg
    const started = Date.now();
    fireEvent.click(screen.getByText(locales.handoff.go));
    await waitFor(() =>
      expect(screen.getByText(locales.handoff.finishTitle)).toBeTruthy(),
    );
    // The whole confirm→save→landing flow stays far under the old 1500ms
    // registry settle budget — no dead wait survives in the path.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(listProtocols).not.toHaveBeenCalled();
    const post = (app.api as unknown as { post: ReturnType<typeof vi.fn> })
      .post;
    expect(post).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(
        locales.handoff.finishAdopted.replace("{{host}}", "10.0.0.5"),
      ),
    ).toBeTruthy();
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledWith("/", "_blank");
    expect(tabSpies(app).connectHost).not.toHaveBeenCalled();
    expect(tabSpies(app).openTab).not.toHaveBeenCalled();
  });

  it("no 'saved' claim and no tab when the adoption POST fails", async () => {
    const app = makeViewApp({
      credentials: [deployKey],
      adopt: { reject: true },
    });
    setStandaloneApp(app);
    await renderHandoff(
      new URLSearchParams({
        connect: "10.0.0.5",
        type: "vnc",
        credential: "Deploy Key",
        using: "adhoc",
      }).toString(),
    );
    fireEvent.click(screen.getByText(locales.handoff.go));
    await waitFor(() =>
      expect(screen.getByText(locales.handoff.adoptFailedTitle)).toBeTruthy(),
    );
    expect(screen.getByText(locales.handoff.adoptFailed)).toBeTruthy();
    // A failed save is the end: no navigation, no "Session opened" claim.
    expect(window.open).not.toHaveBeenCalled();
    expect(tabSpies(app).connectHost).not.toHaveBeenCalled();
    expect(tabSpies(app).openTab).not.toHaveBeenCalled();
  });

  it("verifies the adoption response: 2xx without a host id fails", async () => {
    const app = makeViewApp({
      credentials: [deployKey],
      adopt: { result: { data: { created: false } } },
    });
    setStandaloneApp(app);
    await renderHandoff(
      new URLSearchParams({
        connect: "10.0.0.5",
        type: "vnc",
        credential: "Deploy Key",
        using: "adhoc",
      }).toString(),
    );
    fireEvent.click(screen.getByText(locales.handoff.go));
    await waitFor(() =>
      expect(screen.getByText(locales.handoff.adoptFailedTitle)).toBeTruthy(),
    );
    expect(window.open).not.toHaveBeenCalled();
    expect(tabSpies(app).openTab).not.toHaveBeenCalled();
  });

  it("refuses a credential-less ad-hoc link in place: no adopt, no tab", async () => {
    const app = makeViewApp();
    setStandaloneApp(app);
    await renderHandoff("connect=10.0.0.5&type=vnc&using=adhoc");
    fireEvent.click(screen.getByText(locales.handoff.go));
    await waitFor(() =>
      expect(screen.getByText(locales.handoff.cannotAdoptTitle)).toBeTruthy(),
    );
    expect(screen.getByText(locales.handoff.cannotAdopt)).toBeTruthy();
    // Refusal means refusal: no adoption POST, no window, no session — and
    // the manual path is the card's only button.
    const post = (app.api as unknown as { post: ReturnType<typeof vi.fn> })
      .post;
    expect(post).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(tabSpies(app).connectHost).not.toHaveBeenCalled();
    expect(tabSpies(app).openTab).not.toHaveBeenCalled();
    expect(screen.getByText(locales.handoff.openTermix)).toBeTruthy();
  });

  it("refuses in place when the app surface is missing: no tab, manual path", async () => {
    setStandaloneApp(null);
    await renderHandoff("connect=H1&type=rdp");
    fireEvent.click(screen.getByText(locales.handoff.go));
    await waitFor(() =>
      expect(screen.getByText(locales.handoff.noSurfaceTitle)).toBeTruthy(),
    );
    // Nothing ran with the outcome unknown: no window before a resolution.
    expect(window.open).not.toHaveBeenCalled();
    // The manual [Open Termix] is the way out, and it bridges on click.
    fireEvent.click(screen.getByText(locales.handoff.openTermix));
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledWith("/", "_blank");
  });

  it("reports a missing saved host as an error card with no navigation", async () => {
    const ghost = makeViewApp({ hosts: [] });
    setStandaloneApp(ghost);
    await renderHandoff("connect=ghost");
    fireEvent.click(screen.getByText(locales.handoff.go));
    await waitFor(() =>
      expect(screen.getByText("No saved host matches ghost.")).toBeTruthy(),
    );
    expect(screen.getByText(locales.handoff.connectFailedHint)).toBeTruthy();
    expect(window.open).not.toHaveBeenCalled();
    expect(tabSpies(ghost).connectHost).not.toHaveBeenCalled();
    expect(tabSpies(ghost).openTab).not.toHaveBeenCalled();
  });

  it("reports a missing credential as an error card with no navigation", async () => {
    const noCred = makeViewApp({ credentials: [] });
    setStandaloneApp(noCred);
    await renderHandoff(
      new URLSearchParams({
        connect: "10.0.0.5",
        type: "vnc",
        credential: "Ghost",
        using: "adhoc",
      }).toString(),
    );
    fireEvent.click(screen.getByText(locales.handoff.go));
    await waitFor(() =>
      expect(screen.getByText("No saved credential named Ghost.")).toBeTruthy(),
    );
    expect(screen.getByText(locales.handoff.connectFailedHint)).toBeTruthy();
    expect(window.open).not.toHaveBeenCalled();
    expect(tabSpies(noCred).connectHost).not.toHaveBeenCalled();
    expect(tabSpies(noCred).openTab).not.toHaveBeenCalled();
  });

  it("a crafted go=1 link is just an ordinary grammar link", async () => {
    const app = makeViewApp();
    setStandaloneApp(app);
    await renderHandoff("connect=10.0.0.5&go=1");
    // No armed-marker machinery left: the confirm card shows, nothing runs.
    expect(screen.getByText(locales.handoff.go)).toBeTruthy();
    expect(window.open).not.toHaveBeenCalled();
    expect(tabSpies(app).connectHost).not.toHaveBeenCalled();
    expect(tabSpies(app).openTab).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(locales.handoff.cancel));
    expect(screen.getByText(locales.handoff.cancelled)).toBeTruthy();
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

  it("the standalone path never calls the tab bridge and never claims a session", () => {
    // Source-level guard: no tab bridge call, no go=1 machinery, and no
    // "Session opened" claim can come back into the standalone component.
    const source = readFileSync(
      resolve(process.cwd(), "src/frontend/StandaloneHandoff.tsx"),
      "utf8",
    );
    for (const banned of [
      "connectHost",
      "openTab",
      "go=1",
      "go-armed",
      "goTarget",
      "fallbackNote",
      "sessionOpened",
    ]) {
      expect(source.includes(banned)).toBe(false);
    }
    // And the locale file has no session-opened claims left either.
    const en = readFileSync(resolve(process.cwd(), "locales/en.json"), "utf8");
    for (const banned of [
      '"sessionOpened"',
      '"fallbackNote"',
      "Session opened",
    ]) {
      expect(en.includes(banned)).toBe(false);
    }
  });
});
