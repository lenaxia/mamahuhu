import type { Entry, Variety } from "../../shared/api";
import { api } from "../api";
import { useAnnotations } from "../state";
import { speak } from "../tts";
import { AnnotatedText } from "./AnnotatedText";
import { IconPlay } from "./Icons";

function varietyOf(entry: Entry): Variety {
  return entry.variety === "zh-HK" ? "zh-HK" : "zh-Hant";
}

export function EntryCard({ entry, onOpen }: { entry: Entry; onOpen: () => void }) {
  const annotations = useAnnotations();
  const variety = varietyOf(entry);
  return (
    <button
      onClick={onOpen}
      data-traditional={entry.traditional}
      className="w-full rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3.5 text-left shadow-sm active:scale-[0.99] transition"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {entry.syllables.length > 0 ? (
              <AnnotatedText syllables={entry.syllables} annotations={annotations} variety={variety} size="sm" />
            ) : (
              <span className="hanzi text-xl">{entry.traditional}</span>
            )}
          </div>
          {variety === "zh-HK" && entry.formalZh && (
            <p className="mt-1 truncate text-xs text-neutral-400">書面 {entry.formalZh}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {variety === "zh-HK" && <span className="rounded bg-sky-100 dark:bg-sky-900/60 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">粵</span>}
          <span
            role="button"
            aria-label="Play"
            onClick={(e) => {
              e.stopPropagation();
              speak(entry.traditional, { variety });
            }}
            className="mt-1 flex h-9 w-9 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800"
          >
            <IconPlay className="h-4 w-4" />
          </span>
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <p className="truncate text-sm text-neutral-500 dark:text-neutral-400">{entry.english || "—"}</p>
      </div>
    </button>
  );
}

export function entrySpeaker(text: string, variety: Variety = "zh-Hant"): void {
  speak(text, { variety });
}

export const entryApi = api;
