import type { Entry } from "../../shared/api";
import { api } from "../api";
import { useAnnotations } from "../state";
import { speak } from "../tts";
import { AnnotatedText } from "./AnnotatedText";
import { IconPlay } from "./Icons";

export function EntryCard({ entry, onOpen }: { entry: Entry; onOpen: () => void }) {
  const annotations = useAnnotations();
  return (
    <button
      onClick={onOpen}
      data-traditional={entry.traditional}
      className="w-full rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3.5 text-left shadow-sm active:scale-[0.99] transition"
    >
      <div className="flex items-start justify-between gap-2">
        {entry.syllables.length > 0 ? (
          <AnnotatedText syllables={entry.syllables} annotations={annotations} size="sm" />
        ) : (
          <span className="hanzi text-xl">{entry.traditional}</span>
        )}
        <span
          role="button"
          aria-label="Play"
          onClick={(e) => {
            e.stopPropagation();
            speak(entry.traditional);
          }}
          className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800"
        >
          <IconPlay className="h-4 w-4" />
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <p className="truncate text-sm text-neutral-500 dark:text-neutral-400">{entry.english || "—"}</p>
      </div>
    </button>
  );
}

export function entrySpeaker(text: string): void {
  speak(text);
}

export const entryApi = api;
