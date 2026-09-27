import { useEffect, useState } from "react";
import type { Entry } from "../../shared/api";
import { api } from "../api";
import { AnnotatedText } from "../components/AnnotatedText";
import { IconClose } from "../components/Icons";
import { useAnnotations } from "../state";
import { speak } from "../tts";
import { useToast } from "../components/Toast";

const OUTCOMES = [
  { key: "again", label: "again", cls: "bg-red-500" },
  { key: "hard", label: "hard", cls: "bg-orange-500" },
  { key: "good", label: "good", cls: "bg-emerald-500" },
  { key: "easy", label: "easy", cls: "bg-sky-500" },
] as const;

/** SRS flashcards: front = hanzi, flip for annotations + gloss. */
export function ReviewScreen(): React.JSX.Element {
  const annotations = useAnnotations();
  const show = useToast().show;
  const [queue, setQueue] = useState<Entry[]>([]);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      setQueue(await api.reviewDue());
      setIdx(0);
      setFlipped(false);
    } catch {
      show("Couldn't load review queue");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function grade(outcome: "again" | "hard" | "good" | "easy"): Promise<void> {
    const e = queue[idx];
    if (!e) return;
    try {
      await api.review(e.id, outcome);
    } catch {
      show("Save failed — grade not recorded");
    }
    setFlipped(false);
    if (idx + 1 >= queue.length) void load();
    else setIdx(idx + 1);
  }

  const card = queue[idx];

  return (
    <div className="space-y-4">
      {loading && <div className="animate-pulse text-sm text-neutral-400">Loading…</div>}
      {!loading && queue.length === 0 && (
        <div className="rounded-2xl border border-dashed border-neutral-300 dark:border-neutral-700 p-10 text-center">
          <p className="text-3xl">🎉</p>
          <p className="mt-2 text-sm text-neutral-400">Nothing due — save more words or come back later!</p>
        </div>
      )}
      {card && (
        <>
          <div className="flex items-center justify-between text-xs text-neutral-400">
            <span>{idx + 1} / {queue.length}</span>
            <span>box {card.srsBox}</span>
          </div>
          <button
            onClick={() => setFlipped(!flipped)}
            className="flex min-h-56 w-full flex-col items-center justify-center gap-4 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm active:scale-[0.99] transition"
          >
            {flipped ? (
              <>
                <AnnotatedText syllables={card.syllables} annotations={annotations} />
                <p className="text-[15px] text-neutral-600 dark:text-neutral-300">{card.english}</p>
                <button
                  onClick={(e) => { e.stopPropagation(); speak(card.traditional); }}
                  className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-4 py-2 text-xs font-semibold"
                >
                  ▶ play
                </button>
              </>
            ) : (
              <>
                <span className="hanzi text-5xl">{card.traditional}</span>
                <span className="text-xs text-neutral-400">tap to flip</span>
              </>
            )}
          </button>
          {flipped && (
            <div className="grid grid-cols-4 gap-2">
              {OUTCOMES.map((o) => (
                <button
                  key={o.key}
                  onClick={() => void grade(o.key)}
                  className={`${o.cls} rounded-xl py-3 text-sm font-semibold text-white shadow active:scale-95 transition`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => void load()}
            aria-label="Shuffle"
            className="mx-auto flex items-center gap-1 text-xs text-neutral-400"
          >
            <IconClose className="hidden" /> refresh queue
          </button>
        </>
      )}
    </div>
  );
}
