import { useEffect, useState } from "react";
import { MeProvider, useMe } from "./state";
import { initTts } from "./tts";
import { initStt } from "./stt";
import { AskScreen } from "./screens/AskScreen";
import { WordsScreen } from "./screens/WordsScreen";
import { HistoryScreen } from "./screens/HistoryScreen";
import { ReviewScreen } from "./screens/ReviewScreen";
import { Onboarding, SettingsSheet } from "./screens/SettingsSheet";
import { ToastProvider } from "./components/Toast";
import { IconBook, IconClock, IconKeyboard } from "./components/Icons";

export default function App(): React.JSX.Element {
  return (
    <ToastProvider>
      <MeProvider>
        <Shell />
      </MeProvider>
    </ToastProvider>
  );
}

type Tab = "ask" | "words" | "review" | "history";

function Shell(): React.JSX.Element {
  const { me, loading } = useMe();
  const [tab, setTab] = useState<Tab>("ask");
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    void initTts();
    void initStt();
  }, []);

  return (
    <div className="mx-auto flex h-dvh max-w-lg flex-col">
      <header className="flex items-center justify-between px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-3">
        <div className="min-w-0">
          <h1 className="hanzi text-lg font-semibold leading-tight">馬馬虎虎</h1>
          <p className="text-[10px] uppercase tracking-widest text-neutral-400">Mamahuhu</p>
        </div>
        {me && (
          <button
            onClick={() => setSettingsOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-500/15 text-sm font-bold text-amber-600 dark:text-amber-400"
            aria-label="Settings"
          >
            {me.name.slice(0, 1).toUpperCase()}
          </button>
        )}
      </header>

      <main className="flex-1 overflow-y-auto px-4 pb-28">
        {loading ? (
          <div className="pt-16 text-center text-sm text-neutral-400">…</div>
        ) : !me ? (
          <div className="pt-16 text-center text-sm text-neutral-400">
            Can't reach the server.
            <br />
            <button onClick={() => location.reload()} className="mt-3 underline">
              retry
            </button>
          </div>
        ) : tab === "ask" ? (
          <AskScreen />
        ) : tab === "words" ? (
          <WordsScreen />
        ) : tab === "review" ? (
          <ReviewScreen />
        ) : (
          <HistoryScreen />
        )}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-neutral-200 dark:border-neutral-800 bg-white/90 dark:bg-neutral-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-lg pb-[env(safe-area-inset-bottom)]">
          <TabButton active={tab === "ask"} onClick={() => setTab("ask")} icon={<IconKeyboard className="h-5 w-5" />} label="Ask" />
          <TabButton active={tab === "words"} onClick={() => setTab("words")} icon={<IconBook className="h-5 w-5" />} label="Words" />
          <TabButton active={tab === "review"} onClick={() => setTab("review")} icon={<IconClock className="h-5 w-5" />} label="Review" />
          <TabButton active={tab === "history"} onClick={() => setTab("history")} icon={<IconClock className="h-5 w-5" />} label="History" />
        </div>
      </nav>

      {me && !me.onboarded && <Onboarding me={me} />}
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium ${
        active ? "text-amber-600 dark:text-amber-400" : "text-neutral-400"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
