import { useEffect, useState } from "react";
import type { Entry } from "../../shared/api";
import { api } from "../api";
import { AnnotatedText } from "../components/AnnotatedText";
import { IconClose } from "../components/Icons";
import { useAnnotations } from "../state";
import { speak } from "../tts";
import { useToast } from "../components/Toast";

/** mirrors SRS_INTERVALS on the server (app.ts) — 6 Leitner boxes */
const INTERVALS = [10 * 60e3, 60 * 60e3, 8 * 60 * 60e3, 24 * 60 * 60e3, 3 * 24 * 60 * 60e3, 7 * 24 * 60 * 60e3];

const fmtInterval = (ms: number): string => {
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
};

/** the interval a grading outcome sends this card to */
function outcomeInterval(box: number, outcome: "again" | "hard" | "good" | "easy"): string {
  const target =
    outcome === "again" ? 0
    : outcome === "hard" ? Math.max(0, box - 1)
    : outcome === "good" ? Math.min(5, box + 1)
    : Math.min(5, box + 2);
  return fmtInterval(INTERVALS[target]!);
}

const OUTCOME_KEYS = ["again", "hard", "good", "easy"] as const;
const OUTCOME_CLS: Record<(typeof OUTCOME_KEYS)[number], string> = {
  again: "bg-red-500",
  hard: "bg-orange-500",
  good: "bg-emerald-500",
  easy: "bg-sky-500",
};

/** SRS flashcards: front = the English you're trying to SAY, flip for the
 *  Chinese + annotations + audio, then grade yourself honestly — the grade
 *  sets when the card comes back (labels show the interval). */
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

  async function grade(outcome: (typeof OUTCOME_KEYS)[number]): Promise<void> {
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
  const variety = card?.variety === "zh-HK" ? "zh-HK" : "zh-Hant";

  return (
    <div className="space-y-4">
      {loading && <div className="animate-pulse text-sm text-neutral-400">Loading…</div>}
      {!loading && queue.length === 0 && (
        <div className="rounded-2xl border border-dashed border-neutral-300 dark:border-neutral-700 p-10 text-center">
          <p className="text-3xl">🎉</p>
          <p className="mt-2 text-sm text-neutral-400">Nothing due right now.</p>
          <p className="mt-1 text-xs text-neutral-400">
            New words show up here immediately; graded ones come back on schedule — 10m → 1h → 8h → 1d → 3d → 7d.
          </p>
        </div>
      )}
      {card && (
        <>
          <div className="flex items-center justify-between text-xs text-neutral-400">
            <span>{idx + 1} / {queue.length}</span>
            <span>reviewed {card.srsStreak}×</span>
          </div>
          <button
            onClick={() => setFlipped(!flipped)}
            className="flex min-h-56 w-full flex-col items-center justify-center gap-4 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm active:scale-[0.99] transition"
          >
            {flipped ? (
              <>
                <AnnotatedText syllables={card.syllables} annotations={annotations} variety={variety} />
                <p className="text-[15px] text-neutral-600 dark:text-neutral-300">{card.english}</p>
                {variety === "zh-HK" && card.formalZh && (
                  <p className="text-xs text-neutral-400">書面 {card.formalZh}</p>
                )}
                <div className="flex items-center gap-2">
                  <span
                    role="button"
                    onClick={(e) => { e.stopPropagation(); speak(card.traditional, { variety }); }}
                    className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-4 py-2 text-xs font-semibold"
                  >
                    ▶ play
                  </span>
                  <span
                    role="button"
                    onClick={(e) => { e.stopPropagation(); speak(card.traditional, { variety, slow: true }); }}
                    className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-4 py-2 text-xs font-semibold"
                  >
                    ▶ 0.6×
                  </span>
                </div>
              </>
            ) : (
              <>
                <span className="text-[11px] uppercase tracking-widest text-neutral-400">say it in</span>
                <span className="text-2xl font-semibold">
                  {variety === "zh-HK" ? "廣東話" : "國語"}
                </span>
                <p className="mt-2 text-center text-xl font-medium text-neutral-800 dark:text-neutral-100">{card.english}</p>
                <span className="text-xs text-neutral-400">recall it, then tap to check</span>
              </>
            )}
          </button>
          {flipped ? (
            <div className="grid grid-cols-4 gap-2">
              {OUTCOME_KEYS.map((k) => (
                <button
                  key={k}
                  onClick={() => void grade(k)}
                  className={`${OUTCOME_CLS[k]} rounded-xl py-3 shadow active:scale-95 transition`}
                >
                  <span className="block text-sm font-semibold text-white">{k}</span>
                  <span className="block text-[10px] text-white/80">{outcomeInterval(card.srsBox, k)}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-center text-xs text-neutral-400">flip the card, then grade how you did</p>
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
