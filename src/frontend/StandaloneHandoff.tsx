import { useEffect, useRef, useState } from "react";
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
import {
  parseDeepLinkConnect,
  stripDeepLinkParams,
  type DeepLinkConnectIntent,
} from "./deep-link";
import { resolveStandaloneLanding, type StandaloneLanding } from "./consumer";
import { getStandaloneApp } from "./standalone-app";

/**
 * Core 26.11.3 runs API-2 plugin frontends in sandboxed frames, the
 * standalone `?view=deep-connect` page included: the component renders
 * inside the frame, where the page URL's query string is always empty, and
 * the real query rides `props.params` (the host boots the frame with a
 * bridged `__params` string the SDK reshapes into a URLSearchParams).
 *
 * A frame has no live shell context either: core's shell callbacks stay
 * unbound and its host store stays empty on this page, so every tab-bridge
 * call dead-ends host-side and its rejection is unobservable. A session can
 * never open here — which is why this page is an HONEST consumer and NEVER
 * claims one:
 *
 *  1. A styled confirm card is rendered from `props.params` (the seven
 *     deep-link parameters only): target, connection type, credential by
 *     name, view-only. The grace timer only FOCUSES the confirm button.
 *  2. On the user's click the landing is resolved against the live surfaces
 *     (`resolveStandaloneLanding` — real list fetches and, for credentialed
 *     ad-hoc links, the consented adoption POST, verified by its response):
 *     - a saved host, or an adoption whose response verified a host id,
 *       bridges ONE `window.open` to the app root — Termix opens in a new
 *       tab with the record ready, and the card says to connect from the
 *       Hosts list there. An [Open Termix] button is the manual path when
 *       the bridged tab was blocked. This page cannot open sessions
 *       (Termix requires its shell), and the card says so.
 *     - an ad-hoc link with nothing to attach refuses in place: nothing is
 *       saved, nothing is opened, only the manual [Open Termix] button.
 *     - unresolved links (missing host, credential or type) and a failing
 *       adoption end in error cards — no navigation, no "saved" claim.
 */

/**
 * The app-root URL the landing tab opens: ROOT-RELATIVE by design — the
 * frame's shim resolves it against the frame's own origin, which is the app
 * page's origin. The confirm click is the recent interaction that satisfies
 * the host's window.open gate.
 */
const APP_ROOT_URL = "/";

const AUTO_GO_MS = 1500;

type HandoffState =
  | { phase: "confirm" }
  | { phase: "working" }
  | { phase: "cancelled" }
  | { phase: "noPlugin" }
  | { phase: "landing"; kind: "saved" | "adopted"; hostLabel: string }
  | { phase: "refused"; kind: "cannotAdopt" | "noSurface" }
  | {
      phase: "failed";
      kind:
        "hostNotFound" | "credentialNotFound" | "adoptFailed" | "unavailable";
    };

function clearDeepLinkFromUrl(search: string): void {
  // Cancelling also drops `view=`, which only this page uses; every other
  // foreign parameter survives. Best-effort: in a sandboxed frame, history
  // and URL access can throw, and nothing about the cancel depends on it
  // succeeding.
  try {
    const params = new URLSearchParams(stripDeepLinkParams(search));
    params.delete("view");
    const qs = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
    );
  } catch {
    // The cancelled card does not need the URL touch to be correct.
  }
}

export function StandaloneHandoff(props: StandaloneViewProps) {
  const { t } = useTranslation();
  const connectButtonRef = useRef<HTMLButtonElement | null>(null);
  // StrictMode double-mounts every component: the params are read once,
  // here — always from props (the frame's search string is empty).
  const [captured] = useState(() => {
    const search = props.params.toString();
    return {
      search,
      intent: parseDeepLinkConnect(search),
    };
  });
  const [state, setState] = useState<HandoffState>({ phase: "confirm" });

  /**
   * One bridged tab to the app root. Feature-detected and best-effort: the
   * bridged open may be refused or unavailable, and nothing here claims it
   * succeeded — the landing card's [Open Termix] button is the manual path.
   */
  const openAppRootTab = (): void => {
    try {
      if (typeof window !== "undefined" && typeof window.open === "function") {
        window.open(APP_ROOT_URL, "_blank");
      }
    } catch {
      // The bridge refused; the manual button below remains.
    }
  };

  /**
   * The confirm click's honest tail. The card's acceptance is the consent:
   * the landing resolves real surfaces, saves nothing but the consented
   * adoption (verified by its response), and lands the user in Termix. It
   * NEVER calls the tab bridge — on this page those bridges dead-end
   * silently, so no flow here can depend on them.
   */
  const finishConfirmedLink = (
    intent: DeepLinkConnectIntent,
    landing: StandaloneLanding,
  ): void => {
    switch (landing.kind) {
      case "saved":
      case "adopted": {
        openAppRootTab();
        setState({
          phase: "landing",
          kind: landing.kind,
          hostLabel: landing.hostLabel,
        });
        return;
      }
      case "cannotAdopt":
        setState({ phase: "refused", kind: "cannotAdopt" });
        return;
      case "adoptFailed":
        setState({ phase: "failed", kind: "adoptFailed" });
        return;
      case "unresolved":
        if (landing.reason === "typeUnknown") {
          setState({ phase: "noPlugin" });
          return;
        }
        if (
          landing.reason === "hostNotFound" ||
          landing.reason === "credentialNotFound"
        ) {
          setState({ phase: "failed", kind: landing.reason });
          return;
        }
        setState({ phase: "failed", kind: "unavailable" });
    }
  };

  const connectFromView = (intent: DeepLinkConnectIntent): void => {
    setState({ phase: "working" });
    void (async () => {
      // Without the app surface nothing can be resolved or saved here.
      // Refuse in place with the manual path — no tab opens before the
      // link's outcome is known.
      const app = getStandaloneApp();
      if (!app) {
        setState({ phase: "refused", kind: "noSurface" });
        return;
      }
      try {
        finishConfirmedLink(
          intent,
          await resolveStandaloneLanding(app, intent, {}),
        );
      } catch {
        // Defensive: the resolver returns outcomes rather than throwing; a
        // rejection here still ends in a plain error card, no navigation.
        setState({ phase: "failed", kind: "unavailable" });
      }
    })();
  };

  // The grace timer only FOCUSES the confirm button: it must never confirm,
  // and nothing connect-adjacent can run without the user's click.
  useEffect(() => {
    if (!captured.intent) return;
    const timer = setTimeout(() => {
      connectButtonRef.current?.focus();
    }, AUTO_GO_MS);
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

  if (state.phase === "cancelled") {
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

  if (state.phase === "noPlugin") {
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
                setState({ phase: "cancelled" });
              }}
            >
              {t("handoff.cancel")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state.phase === "failed") {
    const title =
      state.kind === "hostNotFound"
        ? t("deepLink.hostNotFound", {
            host: captured.intent.hostName,
          })
        : state.kind === "credentialNotFound"
          ? t("deepLink.credentialNotFound", {
              name: captured.intent.credentialName ?? "",
            })
          : state.kind === "adoptFailed"
            ? t("handoff.adoptFailedTitle")
            : t("deepLink.connectFailed");
    const description =
      state.kind === "adoptFailed"
        ? t("handoff.adoptFailed")
        : t("handoff.connectFailedHint");
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md" size="sm">
          <CardHeader>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (state.phase === "landing") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md" size="sm">
          <CardHeader>
            <CardTitle>{t("handoff.finishTitle")}</CardTitle>
            <CardDescription>
              {state.kind === "adopted"
                ? t("handoff.finishAdopted", { host: state.hostLabel })
                : t("handoff.finishSaved", { host: state.hostLabel })}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-end">
            <Button onClick={openAppRootTab}>{t("handoff.openTermix")}</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state.phase === "refused") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md" size="sm">
          <CardHeader>
            <CardTitle>
              {state.kind === "noSurface"
                ? t("handoff.noSurfaceTitle")
                : t("handoff.cannotAdoptTitle")}
            </CardTitle>
            <CardDescription>
              {state.kind === "noSurface"
                ? t("handoff.noSurface")
                : t("handoff.cannotAdopt")}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-end">
            <Button onClick={openAppRootTab}>{t("handoff.openTermix")}</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const working = state.phase === "working";
  const description = confirmDescriptionParts(t, captured.intent).join(" ");
  const title =
    captured.intent.using === "adhoc"
      ? t("deepLink.adhocTitle", { host: captured.intent.hostName })
      : t("deepLink.confirmTitle", { host: captured.intent.hostName });

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md" size="sm">
        <CardHeader>
          <CardTitle>{working ? t("handoff.opening") : title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex justify-end gap-2">
          {state.phase === "confirm" && (
            <Button
              variant="outline"
              onClick={() => {
                clearDeepLinkFromUrl(captured.search);
                setState({ phase: "cancelled" });
              }}
            >
              {t("handoff.cancel")}
            </Button>
          )}
          <Button
            ref={connectButtonRef}
            disabled={working}
            onClick={() => connectFromView(captured.intent!)}
          >
            {t("handoff.go")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The confirm card's description: what opens, as what, for whom. Names and
 * types only — a credential appears by name; secrets never ride the link.
 */
function confirmDescriptionParts(
  t: (key: string, options?: Record<string, unknown>) => string,
  intent: DeepLinkConnectIntent,
): string[] {
  const parts = [
    t("deepLink.confirmDescription", { host: intent.hostName }),
    t("handoff.typeNote", { type: (intent.type ?? "ssh").toUpperCase() }),
  ];
  if (intent.credentialName) {
    parts.push(t("deepLink.credentialNote", { name: intent.credentialName }));
    // Where the link can become a saved host, say so before the click: the
    // confirm carries the adoption consent, exactly one dialog for the whole
    // flow. An explicit using=name link is a saved-host lookup, never a
    // create.
    if (intent.using !== "name") {
      parts.push(
        t("handoff.adoptNote", {
          host: intent.hostName,
          name: intent.credentialName,
        }),
      );
    }
  }
  if (intent.viewOnly) {
    parts.push(t("deepLink.viewOnlyNote"));
  }
  return parts;
}
