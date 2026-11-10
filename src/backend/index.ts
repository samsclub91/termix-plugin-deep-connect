/**
 * Every Termix plugin is loaded through a backend entry, even with no
 * backend surface (build writes the same empty entry for theme-only
 * plugins). This plugin declares no routes, tables, actions or secrets, so
 * its backend stays empty.
 */
export async function activate(_ctx: unknown): Promise<void> {}

export async function deactivate(): Promise<void> {
  // Everything registered through ctx is disposed by core.
}
