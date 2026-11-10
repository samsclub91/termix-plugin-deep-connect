import { useEffect, useState } from "react";
import type { StandaloneViewProps } from "@termix-ssh/plugin-sdk/frontend";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@termix-ssh/plugin-sdk/ui";
import { listHostProtocols } from "@termix-ssh/plugin-sdk/ui";
import {
  DEEP_LINK_PARAMS,
  parseDeepLinkConnect,
  stripDeepLinkParams,
  type DeepLinkConnectIntent,
} from "./deep-link";
import type { DeepLinkProtocol } from "./connect-plan";

/**
 * A browser `?view=deep-connect` page mounts ONLY this component, with
 * no app shell: the shell's own callbacks are unbound there, so a plugin
 * cannot drive a styled confirm or connectHost from the standalone page at
 * all. The view is therefore a full-page hand-off: it keeps the deep-link
 * parameters, drops `view=` and anything unknown, and relaunches the app at
 * its root, where the activate-time consumer picks the link up with the real
 * shell confirm + connect. Signed-out browsers get the login page first and
 * come back to the same URL.
 */
const AUTO_GO_MS = 1500;

type HandoffStatus = "ready" | "opening" | "cancelled" | "noPlugin";

/**
 * The link parameters, in their original order and encoding, without `view=`
 * and every foreign parameter.
 */
function keepDeepLinkParams(search: string): string {
  const kept: string[] = [];
  const original = new URLSearchParams(search);
  const seen = new Set<string>();
  for (const key of original.keys()) {
    if (seen.has(key)) continue;
    seen.add(key);
    if ((DEEP_LINK_PARAMS as readonly string[]).includes(key)) {
      for (const value of original.getAll(key)) {
        kept.push([key, value].map(encodeURIComponent).join("="));
      }
    }
  }
  return kept.join("&");
}

/**
 * The app-root URL the hand-off relaunches to: only the deep-link parameters,
 * in their original order, without `view=` and any foreign parameter.
 */
export function handoffTarget(
  search: string,
  origin: string,
  pathname: string,
): string {
  return `${origin}${pathname}?${keepDeepLinkParams(search)}`;
}

function clearDeepLinkFromUrl(search: string): void {
  // Cancelling the standalone page also drops `view=`, which only this page
  // uses; every other foreign parameter survives.
  const params = new URLSearchParams(stripDeepLinkParams(search));
  params.delete("view");
  const qs = params.toString();
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
  );
}

export function StandaloneHandoff(_props: StandaloneViewProps) {
  const { t } = useTranslation();
  // StrictMode double-mounts every component: the URL is read once, here.
  const [captured] = useState(() => {
    const search = window.location.search;
    return { search, intent: parseDeepLinkConnect(search) };
  });
  const [status, setStatus] = useState<HandoffStatus>("ready");

  const go = (intent: DeepLinkConnectIntent) => {
    // Best-effort early refusal: an explicitly ad-hoc link asking for a type
    // no plugin provides cannot succeed once handed off. Non-ad-hoc links
    // always hand off — a saved host of that kind may still exist.
    if (intent.using === "adhoc" && intent.type && intent.type !== "ssh") {
      const settled = listHostProtocols() as unknown as DeepLinkProtocol[];
      const known = settled.some((p) => p.id === intent.type);
      if (!known) {
        setStatus("noPlugin");
        return;
      }
    }
    setStatus("opening");
    window.location.replace(
      handoffTarget(
        captured.search,
        window.location.origin,
        window.location.pathname,
      ),
    );
  };

  useEffect(() => {
    if (!captured.intent) return;
    const timer = setTimeout(() => go(captured.intent!), AUTO_GO_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captured]);

  if (!captured.intent) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md" size="sm">
          <CardHeader>
            <CardTitle>{t("handoff.noPayload")}</CardTitle>
            <CardDescription>{t("tab.empty")}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (status === "cancelled") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md" size="sm">
          <CardHeader>
            <CardDescription>{t("handoff.cancelled")}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (status === "noPlugin") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md" size="sm">
          <CardHeader>
            <CardTitle>{t("handoff.noPayload")}</CardTitle>
            <CardDescription>{t("handoff.noPlugin")}</CardDescription>
          </CardHeader>
          <CardContent className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                clearDeepLinkFromUrl(captured.search);
                setStatus("cancelled");
              }}
            >
              {t("handoff.cancel")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md" size="sm">
        <CardHeader>
          <CardTitle>
            {status === "opening" ? t("handoff.opening") : t("plugin.name")}
          </CardTitle>
          <CardDescription>
            {t("deepLink.confirmDescription", {
              host: captured.intent.hostName,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-end gap-2">
          {status !== "opening" && (
            <Button
              variant="outline"
              onClick={() => {
                clearDeepLinkFromUrl(captured.search);
                setStatus("cancelled");
              }}
            >
              {t("handoff.cancel")}
            </Button>
          )}
          <Button onClick={() => go(captured.intent!)}>
            {t("handoff.go")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
