import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";

/**
 * The app surface activate received, kept for the standalone `?view=` page.
 *
 * Core 26.11.3 runs API-2 plugin frontends in sandboxed frames, standalone
 * included, and the frame's app object bridges hosts (`listHosts`) and the
 * API client (the adoption POST) to the real backend. The standalone
 * component receives only `view` + `params` — the app itself is handed to
 * `activate`, so this holder is the one seam between the two. Reading it is
 * feature-detection: a missing or stubbed app means the link cannot be
 * resolved or saved from the view, which refuses in place (with a manual
 * path into Termix) instead of claiming anything.
 */
let holder: TermixApp | null = null;

export function setStandaloneApp(app: TermixApp | null): void {
  holder = app;
}

export function getStandaloneApp(): TermixApp | null {
  return holder;
}
