import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";

// The UI kit is served by Termix at runtime; tests stand in for its pieces
// with pass-through components so text assertions stay honest.
vi.mock("@termix-ssh/plugin-sdk/ui", () => ({
  listHostProtocols: vi.fn(() => []),
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
  handoffTarget,
  StandaloneHandoff,
} from "../../src/frontend/StandaloneHandoff";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const listProtocols = vi.mocked(ui.listHostProtocols);

// Render the standalone through a throwaway plugin module so it gets the
// real SDK i18n scope (renderWithApp provides it).
let rendered: RenderedPluginApp | null = null;

async function renderHandoff() {
  const testPlugin = {
    activate(app: TermixApp) {
      app.registerTab("lansweeper-connect", StandaloneHandoff as never, {
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
  rendered.renderTab("lansweeper-connect", { view: "lansweeper-connect" });
}

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  cleanup();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("handoffTarget", () => {
  it("keeps only the seven deep-link parameters, first-seen order, no view", () => {
    expect(
      handoffTarget(
        "?view=lansweeper-connect&connect=H%201&type=rdp&domain=WAG&zzz=1&port=3390&using=name&credential=adm&viewonly=1",
        "https://termix.example.com",
        "/",
      ),
    ).toBe(
      "https://termix.example.com/?connect=H%201&type=rdp&domain=WAG&port=3390&using=name&credential=adm&viewonly=1",
    );
  });

  it("drops everything when there are no deep-link parameters", () => {
    expect(handoffTarget("?tab=x&zzz=1", "https://t", "/")).toBe("https://t/?");
  });
});

describe("StandaloneHandoff", () => {
  it("shows the empty state when the URL has no connect parameter", async () => {
    window.history.replaceState(null, "", "/?view=lansweeper-connect");
    await renderHandoff();
    expect(screen.getByText(locales.handoff.noPayload)).toBeTruthy();
    expect(screen.getByText(locales.tab.empty)).toBeTruthy();
    expect(screen.queryByText(locales.handoff.cancel)).toBeNull();
  });

  it("clears the captured link from the URL when cancelled", async () => {
    window.history.replaceState(
      null,
      "",
      "/?view=lansweeper-connect&connect=H1&type=rdp&domain=WAG&zzz=1",
    );
    await renderHandoff();
    fireEvent.click(screen.getByText(locales.handoff.cancel));
    expect(window.location.search).toBe("?zzz=1");
    expect(screen.getByText(locales.handoff.cancelled)).toBeTruthy();
  });

  it("captures the URL once: a later navigation cannot swap the link", async () => {
    window.history.replaceState(
      null,
      "",
      "/?view=lansweeper-connect&connect=H1&type=rdp",
    );
    await renderHandoff();
    // A foreign navigation lands while the card is open; the cancel must
    // still clear the CAPTURED parameters, not the new ones.
    window.history.replaceState(null, "", "/?connect=H2");
    fireEvent.click(screen.getByText(locales.handoff.cancel));
    expect(window.location.search).toBe("");
  });

  it("auto-runs after the grace period and refuses a doomed ad-hoc link", async () => {
    vi.useFakeTimers();
    window.history.replaceState(
      null,
      "",
      "/?view=lansweeper-connect&connect=10.0.0.5&type=rdp&using=adhoc",
    );
    listProtocols.mockReturnValue([] as never);
    await renderHandoff();
    expect(screen.getByText(locales.handoff.cancel)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(screen.getByText(locales.handoff.noPlugin)).toBeTruthy();
    // No hand-off happened: the URL keeps its parameters for the card.
    expect(window.location.search).toBe(
      "?view=lansweeper-connect&connect=10.0.0.5&type=rdp&using=adhoc",
    );
  });

  it("hands off a registered ad-hoc protocol after the grace period", async () => {
    vi.useFakeTimers();
    window.history.replaceState(
      null,
      "",
      "/?view=lansweeper-connect&connect=10.0.0.5&type=rdp&using=adhoc",
    );
    listProtocols.mockReturnValue([{ id: "rdp", defaultPort: 3389 }] as never);
    await renderHandoff();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(screen.getByText(locales.handoff.opening)).toBeTruthy();
    expect(screen.queryByText(locales.handoff.cancel)).toBeNull();
  });
});
