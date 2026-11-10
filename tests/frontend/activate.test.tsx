import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import type { ReactNode } from "react";

// The UI kit is served by Termix at runtime; the standalone component and the
// stub tab are the only importers, and neither needs real UI kit behavior.
vi.mock("@termix-ssh/plugin-sdk/ui", () => ({
  listHostProtocols: vi.fn(() => []),
  Button: ({ children }: { children: ReactNode }) => (
    <button>{children as never}</button>
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
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const listProtocols = vi.mocked(ui.listHostProtocols);

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  cleanup();
});

describe(`${manifest.id} activate`, () => {
  it("registers the standalone tab and no rail item", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual(["deep-connect"]);
    expect(rendered.registered.railItems()).toEqual([]);
  });

  it("renders the tab's empty state as a plain tab", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    rendered.renderTab("deep-connect", { isVisible: true });
    expect(await screen.findByText(locales.tab.empty)).toBeTruthy();
  });

  it("starts silently when the URL carries no deep link", async () => {
    // The consumer no-ops without ?connect= or ?view= — the activation above
    // ran it every time; the protocol registry was never read and nothing
    // crashed.
    expect(listProtocols).not.toHaveBeenCalled();
  });
});
