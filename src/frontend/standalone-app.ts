import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";

/**
 * The app surface activate received, kept for the standalone `?view=` page.
 *
 * Core 26.11.3 runs API-2 plugin frontends in sandboxed frames, standalone
 * included, and the frame's app object bridges tab calls (`tabs.connectHost`,
 * `tabs.openTab`), hosts (`listHosts`, `notifyHostsChanged`) and the
 * credential list to the real shell. The standalone component receives only
 * `view` + `params` — the app itself is handed to `activate`, so this holder
 * is the one seam between the two. Reading it is feature-detection: a missing
 * or stubbed app means the in-view connect cannot be attempted and the
 * hand-off falls back to its new-tab path.
 */
let holder: TermixApp | null = null;

export function setStandaloneApp(app: TermixApp | null): void {
  holder = app;
}

export function getStandaloneApp(): TermixApp | null {
  return holder;
}
