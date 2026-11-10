/**
 * Termix plugin backends load a backend entry even when the plugin only
 * contributes UI. This plugin registers one route family: the ad-hoc host
 * adoption route (POST /plugin-api/deep-connect/adopt) used by the
 * consumer when the user confirms creating a saved host from a deep link.
 */
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { registerAdoptRoutes } from "./adopt";

export async function activate(ctx: PluginContext): Promise<void> {
  registerAdoptRoutes(ctx);
}

export async function deactivate(): Promise<void> {
  // Everything registered through ctx is disposed by core.
}
