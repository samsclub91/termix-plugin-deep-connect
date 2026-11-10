import type {
  PluginContext,
  PluginHostCreateInput,
} from "@termix-ssh/plugin-sdk/backend";

/**
 * Ad-hoc host adoption.
 *
 * A deep link without a saved host normally runs an ad-hoc quick connect,
 * which cannot carry a stored credential (plugins get redacted summaries, and
 * an id-less host cannot expand one server-side). This route gives those
 * links the supported path instead, when the user confirms it in the shell:
 * it creates a real host record filed in the "Ad-Hoc Hosts" folder with the
 * resolved credential attached by id, and the connect then rides core's own
 * saved-host flow — the credential is expanded server-side where the secret
 * never leaves Termix.
 *
 * The route runs as the calling user (core wraps plugin routes with the
 * request actor), holds `hosts:write`, and never sees or stores a secret:
 * the credential rides as an id, exactly like a hand-created host would.
 *
 * Records are intentionally neutral: the plugin serves any URL source, so
 * created hosts carry a generic "ad-hoc" tag, a folder named "Ad-Hoc Hosts",
 * and a note with the date — no vendor branding.
 */

const ADOPTABLE_TYPES = new Set(["ssh", "vnc", "rdp"]);
const DEFAULT_PORTS: Record<string, number> = { ssh: 22, vnc: 5900, rdp: 3389 };
const FOLDER = "Ad-Hoc Hosts";
const TAG = "ad-hoc";

export const ADOPT_FOLDER = FOLDER;

interface AdoptBody {
  hostName?: unknown;
  type?: unknown;
  credentialId?: unknown;
  port?: unknown;
  domain?: unknown;
}

// The SDK hands back a framework router by generic; define the two-member
// shape this route actually uses (typed locally: Express types are a core
// dependency, not one the plugin compiles against).
interface PluginRouteResponse {
  /** Set before json() to end with a non-2xx status. */
  status(code: number): PluginRouteResponse;
  json(payload: unknown): void;
}
interface AdoptRoute {
  post(
    path: string,
    handler: (
      req: { body?: unknown },
      res: PluginRouteResponse,
    ) => void | Promise<void>,
  ): void;
}

export function registerAdoptRoutes(ctx: PluginContext): void {
  const router = ctx.http.router<AdoptRoute>();
  router.post("/adopt", async (req, res) => {
    const body = (req.body ?? {}) as AdoptBody;
    const hostName = typeof body.hostName === "string" ? body.hostName.trim() : "";
    const type = typeof body.type === "string" ? body.type.toLowerCase() : "";
    const credentialId = Number(body.credentialId);

    if (!hostName || !ADOPTABLE_TYPES.has(type) || !Number.isInteger(credentialId) || credentialId <= 0) {
      res.status(400).json({
        error: "hostName, a supported connection type and a numeric credentialId are required",
      });
      return;
    }

    // Idempotent: a matching host name or address means the saved-host flow
    // takes over with no duplicate record.
    const existing = await ctx.hosts.list();
    const dup = existing.find((row) => row.name === hostName || row.ip === hostName);
    if (dup) {
      res.json({ created: false, hostId: dup.id, reason: "exists" });
      return;
    }

    const portNumber = Number(body.port);
    const port = Number.isInteger(portNumber) && portNumber > 0 ? portNumber : DEFAULT_PORTS[type];

    const input: PluginHostCreateInput = {
      name: hostName,
      ip: hostName,
      port,
      username: "",
      authType: "credential",
      credentialId,
      overrideCredentialUsername: false,
      connectionType: type,
      tags: [TAG],
      folder: FOLDER,
      pin: false,
      notes: `Created from a URI deep link on ${new Date().toISOString().slice(0, 10)}`,
      statusCheckEnabled: false,
    };
    if (type === "ssh") {
      input.enableSsh = true;
      input.sshPort = port;
    } else {
      const auth: {
        authType: "credential";
        credentialId: number;
        fields?: Record<string, string>;
      } = { authType: "credential", credentialId };
      // RDP's domain rides in the protocol login's fields; the credential's
      // own domain (when configured) would be applied by the credential.
      const domain = typeof body.domain === "string" ? body.domain.trim() : "";
      if (type === "rdp" && domain) auth.fields = { domain };
      input.protocolAuth = { [type]: auth };
    }

    try {
      const record = await ctx.hosts.create(input);
      res.json({
        created: true,
        hostId: record.id,
        hostName: record.name ?? hostName,
        folder: FOLDER,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });
}
