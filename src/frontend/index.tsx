import {
  useTranslation,
  type TabProps,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { startDeepLinkConsumer } from "./consumer";
import { StandaloneHandoff } from "./StandaloneHandoff";

const TAB_ID = "deep-connect";

/**
 * The palette-opened tab is deliberately a stub: the real entry points are
 * the standalone `?view=deep-connect` page and the activate-time
 * consumer, neither of which needs an interactive tab. If the shell ever
 * opens the type as a plain tab, it still shows a sensible empty state.
 */
function createStubTab() {
  return function StubTab(_props: TabProps) {
    const { t } = useTranslation();
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <MonitorIcon className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("tab.empty")}</p>
      </div>
    );
  };
}

function MonitorIcon(props: { className?: string }) {
  return (
    <svg
      className={props.className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="20" height="14" x="2" y="3" rx="2" ry="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </svg>
  );
}

export function activate(app: TermixApp): void {
  app.registerTab(TAB_ID, createStubTab(), {
    icon: MonitorIcon,
    titleKey: "tab.title",
    singleton: true,
    hostless: true,
    persistent: false,
    standalone: StandaloneHandoff,
  });
  startDeepLinkConsumer(app);
}
