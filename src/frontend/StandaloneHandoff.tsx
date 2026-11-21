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
import { listHostProtocols } from "@termix-ssh/plugin-sdk/ui";
import {
  DEEP_LINK_PARAMS,
  STANDALONE_VIEW_ID,
  parseDeepLinkConnect,
  stripDeepLinkParams,
  type DeepLinkConnectIntent,
} from "./deep-link";
import { runConnectIntentSilently } from "./consumer";
import type { ViewConnectOutcome } from "./consumer";
import { getStandaloneApp } from "./standalone-app";
import type { DeepLinkProtocol } from "./connect-plan";

/**
 * Core 26.11.3 runs API-2 plugin frontends in sandboxed frames, the
 * standalone `?view=deep-connect` page included: the component renders
 * inside the frame, where the page URL's query string is always empty, and
 * the real query rides `props.params` (the host boots the frame with a
 * bridged `__params` string the SDK reshapes into a URLSearchParams). Top-level
 * navigation is also gone from the frame's sandbox — `location.replace`
 * would reload only the frame — so the v1.2 relaunch cannot exist here.
 *
 * The page therefore is its own confirm-first consumer:
 *  1. A styled confirm card is rendered from `props.params` (the seven
 *     deep-link parameters only): target, connection type, credential by
 *     name, view-only.
 *  2. On the user's click, the IN-VIEW connect runs (`app.tabs.connectHost`
 *     for saved hosts, the adopt route + openTab for credentialed ad-hoc
 *     links — every access feature-detected, a missing surface being
 *     expected). Success shows a "Session opened" state pointing at the
 *     shell's session tabs.
 *  3. When the app surface cannot act, the hand-off falls back — once — to
 *     the bridge's new-tab escape (`window.open`, which the frame runtime
 *     maps to the shell's `openUrl`) targeting THIS page again with `go=1`
 *     and an armed one-shot marker. That go=1 tab auto-consumes: the
 *     confirm already happened in the originating view, and it never opens
 *     another window; a connect failure there is an error card, not a loop.
 */
const AUTO_GO_MS = 1500;

type HandoffStatus =
  "ready" | "opening" | "opened" | "failed" | "cancelled" | "noPlugin";

/** The link parameters, in their original order and encoding. */
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
 * The root-relative URL the fallback opens in a NEW browser tab: the shell's
 * `?view=` entry again, with the link's grammar and the auto-consume marker.
 * The frame's runtime resolves it against the shell page, and the bridged
 * `window.open` delivers it as a top-level page.
 */
export function goTarget(search: string): string {
  const kept = keepDeepLinkParams(search);
  const pairs = [`/?view=${STANDALONE_VIEW_ID}`];
  if (kept) pairs.push(kept);
  pairs.push("go=1");
  return pairs.join("&");
}

/**
 * One-shot arming marker for the go=1 fallback: written by the view that
 * dispatched the new tab (its window storage is kept by the shell), read
 * once by the go=1 view. A go=1 link without the marker shows the regular
 * confirm card — a crafted URL cannot skip the confirm.
 */
const GO_ARM_KEY = "deep-connect.go-armed";

function readGoArm(): boolean {
  try {
    return window.localStorage.getItem(GO_ARM_KEY) === "1";
  } catch {
    return false;
  }
}

function clearGoArm(): void {
  try {
    window.localStorage.removeItem(GO_ARM_KEY);
  } catch {
    // Storage unavailable: the run-once module marker still caps the flow.
  }
}

/**
 * Module-scoped go=1 execution marker: the auto-consume runs at most once
 * per module life — StrictMode remounts and second deliveries share the
 * first run's promise instead of re-running it, so no view ever executes
 * the connect twice and no fallback can loop.
 */
let goRun: Promise<ViewConnectOutcome> | undefined;

/** Test seam: forget the module-scoped go=1 execution state. */
export function resetGoStateForTests(): void {
  goRun = undefined;
}

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
      go: props.params.get("go") === "1" && readGoArm(),
    };
  });
  const [status, setStatus] = useState<HandoffStatus>("ready");
  const [fallbackDispatched, setFallbackDispatched] = useState(false);

  /** The fallback: one bridged new tab on this page again, with go=1. */
  const fallBackToNewTab = () => {
    try {
      window.localStorage.setItem(GO_ARM_KEY, "1");
    } catch {
      // Without the marker the next view still shows the confirm card.
    }
    try {
      window.open(goTarget(captured.search), "_blank");
      setFallbackDispatched(true);
      setStatus("opening");
    } catch {
      setStatus("failed");
    }
  };

  const connectFromView = (intent: DeepLinkConnectIntent) => {
    // Best-effort early refusal: an explicitly ad-hoc link asking for a type
    // no plugin provides cannot succeed once handed off. Non-ad-hoc links
    // always proceed — a saved host of that kind may still exist.
    if (intent.using === "adhoc" && intent.type && intent.type !== "ssh") {
      const settled = listHostProtocols() as unknown as DeepLinkProtocol[];
      const known = settled.some((p) => p.id === intent.type);
      if (!known) {
        setStatus("noPlugin");
        return;
      }
    }
    setStatus("opening");
    const app = getStandaloneApp();
    if (!app) {
      fallBackToNewTab();
      return;
    }
    void runConnectIntentSilently(app, intent, {}).then((outcome) => {
      if (outcome === "opened") setStatus("opened");
      else if (outcome === "failed") setStatus("failed");
      else fallBackToNewTab();
    });
  };

  function setStatusFromOutcome(outcome: ViewConnectOutcome): void {
    setStatus(outcome === "opened" ? "opened" : "failed");
  }

  useEffect(() => {
    if (!captured.go || !captured.intent) return;
    clearGoArm();
    if (goRun) {
      // A second arm (StrictMode remount, a replayed link) shares the first
      // run's outcome instead of re-executing anything.
      void goRun.then(setStatusFromOutcome);
      return;
    }
    const run = (async (): Promise<ViewConnectOutcome> => {
      setStatus("opening");
      const app = getStandaloneApp();
      const outcome = app
        ? await runConnectIntentSilently(app, captured.intent, {})
        : "unavailable";
      // A go=1 view never opens another window: an unusable surface here is
      // the error card, not a new fallback cycle.
      return outcome === "unavailable" ? "failed" : outcome;
    })();
    goRun = run;
    void run.then(setStatusFromOutcome);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captured]);

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

  if (status === "opened") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md" size="sm">
          <CardHeader>
            <CardTitle>{t("handoff.sessionOpened")}</CardTitle>
            <CardDescription>{t("handoff.sessionOpenedHint")}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md" size="sm">
          <CardHeader>
            <CardTitle>{t("deepLink.connectFailed")}</CardTitle>
            <CardDescription>{t("handoff.connectFailedHint")}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const description =
    status === "opening" && fallbackDispatched
      ? t("handoff.fallbackNote")
      : status === "opening"
        ? t("deepLink.confirmDescription", { host: captured.intent.hostName })
        : confirmDescriptionParts(t, captured.intent).join(" ");

  const title =
    status === "opening"
      ? t("handoff.opening")
      : captured.intent.using === "adhoc"
        ? t("deepLink.adhocTitle", { host: captured.intent.hostName })
        : t("deepLink.confirmTitle", { host: captured.intent.hostName });

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md" size="sm">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
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
          <Button
            ref={connectButtonRef}
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
