import { useEffect, useState } from "react";
import type { Entry } from "../../shared/api";
import { api } from "../api";
import { AnnotatedText } from "../components/AnnotatedText";
import { Segmented } from "../components/Segmented";
import { useAnnotations } from "../state";
import { speak } from "../tts";
import { useToast } from "../components/Toast";

type Front = "en" | "zh";

/** Review = the simplest possible loop — two directions:
 *  EN→中文 (recall what to SAY) or 中文→EN (read & recognize).
 *  Tap to check, then Got it / Missed it. Got it spaces the card out;
 *  Missed it brings it back soon. */
export function ReviewScreen({ active = true }: { active?: boolean }): React.JSX.Element {
  const annotations = useAnnotations();
  const show = useToast().show;
  const [queue, setQueue] = useState<Entry[]>([]);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [front, setFront] = useState<Front>(
    () => (localStorage.getItem("reviewFront") === "zh" ? "zh" : "en"),
  );

  function switchFront(f: Front): void {
    setFront(f);
    setFlipped(false);
    localStorage.setItem("reviewFront", f);
  }

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

  async function grade(gotIt: boolean): Promise<void> {
    const e = queue[idx];
    if (!e) return;
    try {
      await api.review(e.id, gotIt ? "good" : "again");
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
      <Segmented<Front>
        className="w-full [&>button]:flex-1 flex"
        value={front}
        onChange={switchFront}
        options={[
          { value: "en", label: "EN → 中文" },
          { value: "zh", label: "中文 → EN" },
        ]}
      />
      {loading && <div className="animate-pulse text-sm text-neutral-400">Loading…</div>}
      {!loading && queue.length === 0 && (
        <div className="rounded-2xl border border-dashed border-neutral-300 dark:border-neutral-700 p-10 text-center">
          <p className="text-3xl">🎉</p>
          <p className="mt-2 text-sm text-neutral-400">All caught up — new words show up here right away.</p>
        </div>
      )}
      {card && (
        <>
          <div className="text-center text-xs text-neutral-400">{idx + 1} / {queue.length}</div>
          <button
            onClick={() => setFlipped(!flipped)}
            className="flex min-h-64 w-full flex-col items-center justify-center gap-5 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm active:scale-[0.99] transition"
          >
            {flipped ? (
              <>
                <AnnotatedText syllables={card.syllables} annotations={annotations} variety={variety} />
                <p className="text-[15px] text-neutral-600 dark:text-neutral-300">{card.english}</p>
                <div className="flex items-center gap-2">
                  <span
                    role="button"
                    aria-label="Play"
                    onClick={(e) => { e.stopPropagation(); speak(card.traditional, { variety }); }}
                    className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-5 py-2.5 text-sm font-semibold"
                  >
                    ▶
                  </span>
                  <span
                    role="button"
                    aria-label="Play slowly"
                    onClick={(e) => { e.stopPropagation(); speak(card.traditional, { variety, slow: true }); }}
                    className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-4 py-2.5 text-xs font-semibold text-neutral-500"
                  >
                    0.6×
                  </span>
                </div>
              </>
            ) : front === "en" ? (
              <>
                <p className="text-center text-2xl font-medium text-neutral-800 dark:text-neutral-100">{card.english}</p>
                <span className="text-xs text-neutral-400">say it, then tap to check</span>
              </>
            ) : (
              <>
                <span lang={variety === "zh-HK" ? "zh-HK" : "zh-Hant"} className="hanzi text-4xl">{card.traditional}</span>
                <span className="text-xs text-neutral-400">what does it mean? tap to check</span>
              </>
            )}
          </button>
          {flipped && (
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => void grade(false)}
                className="rounded-xl bg-red-500 py-4 text-base font-semibold text-white shadow active:scale-95 transition"
              >
                Missed it
              </button>
              <button
                onClick={() => void grade(true)}
                className="rounded-xl bg-emerald-500 py-4 text-base font-semibold text-white shadow active:scale-95 transition"
              >
                Got it
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
