import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import HanziWriter from "hanzi-writer";
import { Segmented } from "./Segmented";
import { IconClose, IconCheck } from "./Icons";
import { useAnnotations } from "../state";

/** Writing practice — a row/grid of up to 4 田-character boxes, one per char.
 *  Modes: Animate (watch), Trace (copy the ghost, stroke-validated), Drill
 *  (write all boxes, auto-clear, loop), Write (from memory, pinyin cues).
 *  Stroke validation via hanzi-writer quizzes against MakeMeAHanzi medians;
 *  chars without data fall back to free-draw with a manual ✓. */

type WriteMode = "animate" | "trace" | "drill" | "write";

const strokeData = new Map<string, Promise<HanziWriterData | "missing"> | "missing">();
export type HanziWriterData = { strokes: string[]; medians: number[][][] };

function loadStrokes(ch: string): Promise<HanziWriterData | "missing"> | "missing" {
  let p = strokeData.get(ch);
  if (!p) {
    p = fetch(`/api/strokes/${encodeURIComponent(ch)}`)
      .then((r) => (r.ok ? (r.json() as Promise<HanziWriterData>) : Promise.reject(new Error("no data"))))
      .catch(() => {
        strokeData.set(ch, "missing");
        return "missing" as const;
      });
    strokeData.set(ch, p);
  }
  return p;
}

const MODE_HINT: Record<WriteMode, string> = {
  animate: "watch the stroke order — boxes play in sequence",
  trace: "copy the ghost strokes in order",
  drill: "write all the boxes — then it clears and goes again",
  write: "from memory — the sound above each box is your cue",
};

export type WriteWord = { traditional: string; pinyin?: string; bpmf?: string; english?: string };

export function WritingSheet({
  open,
  onClose,
  word,
  deck,
  startAt = 0,
}: {
  open: boolean;
  onClose: () => void;
  word: WriteWord;
  /** whole list to move through with ‹ › (defaults to just this word) */
  deck?: WriteWord[];
  startAt?: number;
}): React.JSX.Element | null {
  const annotations = useAnnotations();
  const list = deck && deck.length > 0 ? deck : [word];
  const [di, setDi] = useState(startAt);
  const cur = list[Math.min(di, list.length - 1)] ?? word;
  const chars = [...cur.traditional].filter((c) => /\p{Script=Han}/u.test(c));
  const pinyins = cur.pinyin?.trim().split(/\s+/) ?? [];
  const bpmfs = cur.bpmf?.trim().split(/\s+/) ?? [];
  // respect the annotation pref (bpmf-only users never see pinyin)
  const rom = (i?: number): string => {
    const py = i === undefined ? cur.pinyin : pinyins[i];
    const bp = i === undefined ? cur.bpmf : bpmfs[i];
    if (annotations === "bpmf") return bp || py || "";
    if (annotations === "pinyin") return py || bp || "";
    return [py, bp].filter(Boolean).join(" · ");
  };
  // >4 chars (long phrases): practice in pages of 4
  const groups: string[][] = [];
  for (let i = 0; i < chars.length; i += 4) groups.push(chars.slice(i, i + 4));
  const [gi, setGi] = useState(0);
  const group = groups[Math.min(gi, groups.length - 1)] ?? [];

  const [mode, setMode] = useState<WriteMode>("trace");
  const [ghost, setGhost] = useState(true);
  const [tally, setTally] = useState({ ok: 0, miss: 0, rounds: 0 });
  const [done, setDone] = useState<boolean[]>([]);
  const [animateIdx, setAnimateIdx] = useState(0);
  const [resetKey, setResetKey] = useState(0);
  const resetRef = useRef<() => void>(() => {});

  useEffect(() => {
    setGi(0);
    setDone([]);
    setTally({ ok: 0, miss: 0, rounds: 0 });
    setAnimateIdx(0);
    setResetKey((k) => k + 1);
  }, [cur.traditional]);

  // (re)opened from a list: start at the tapped word, not the deck head
  useEffect(() => {
    if (open) setDi(startAt);
  }, [open, startAt]);

  if (!open || group.length === 0) return null;

  const allDone = done.filter(Boolean).length >= group.length;

  function resetWord(): void {
    setDone([]);
    setAnimateIdx(0);
    setResetKey((k) => k + 1); // remount boxes → clear ink, restart quizzes
  }
  resetRef.current = () => {
    resetWord();
    setTally((t) => ({ ...t, rounds: t.rounds + 1 }));
  };

  function boxDone(i: number): void {
    setDone((d) => {
      const nd = [...d];
      nd[i] = true;
      // drill: whole word finished → brief beat, clear, go again
      if (nd.filter(Boolean).length >= group.length && mode === "drill") {
        setTimeout(() => resetRef.current(), 800);
      }
      return nd;
    });
  }


  return (
    <div
      role="dialog"
      aria-modal="true"
      data-write-sheet
      className="fixed inset-0 z-50 flex flex-col bg-neutral-50 dark:bg-neutral-950"
    >
      <div className="flex items-start justify-between gap-3 px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {list.length > 1 && (
            <button
              aria-label="Previous word"
              disabled={di === 0}
              onClick={() => setDi(di - 1)}
              className="shrink-0 rounded-full px-2.5 py-1.5 text-lg text-neutral-400 disabled:opacity-25"
            >
              ‹
            </button>
          )}
          <div className="min-w-0 flex-1 text-center">
            <p lang="zh-Hant" className="hanzi truncate text-lg font-semibold">
              {cur.traditional}
            </p>
            <p className="truncate text-xs text-sky-700 dark:text-sky-400">{rom()}</p>
            {cur.english && <p className="truncate text-xs text-neutral-400">{cur.english.split(" / ")[0]}</p>}
          </div>
          {list.length > 1 && (
            <button
              aria-label="Next word"
              disabled={di >= list.length - 1}
              onClick={() => setDi(di + 1)}
              className="shrink-0 rounded-full px-2.5 py-1.5 text-lg text-neutral-400 disabled:opacity-25"
            >
              ›
            </button>
          )}
        </div>
        <button aria-label="Close" onClick={onClose} className="rounded-full p-2 text-neutral-500">
          <IconClose className="h-5 w-5" />
        </button>
      </div>
      {list.length > 1 && (
        <div className="px-4 pb-1 text-center text-[11px] tabular-nums text-neutral-400">
          {di + 1} / {list.length}
        </div>
      )}

      <div className="px-4">
        <Segmented<WriteMode>
          className="w-full [&>button]:flex-1"
          value={mode}
          onChange={(m) => {
            setMode(m);
            resetWord();
          }}
          options={[
            { value: "animate", label: "Animate" },
            { value: "trace", label: "Trace" },
            { value: "drill", label: "Drill" },
            { value: "write", label: "Write" },
          ]}
        />
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-4 py-4">
        <div className="flex w-full flex-col items-center gap-2">
          {group.map((ch, i) => (
            <WriterBox
              key={`${ch}-${gi}-${i}-${resetKey}`}
              ch={ch}
              mode={mode}
              ghost={ghost}
              active={mode !== "animate" || i === animateIdx}
              label={mode === "write" ? rom(i) || ch : ch}
              done={!!done[i]}
              onDone={() => boxDone(i)}
              onAnimateDone={() => setAnimateIdx((a) => (a + 1) % group.length)}
              onStroke={(ok) => setTally((t) => ({ ...t, ok: t.ok + (ok ? 1 : 0), miss: t.miss + (ok ? 0 : 1) }))}
            />
          ))}
        </div>

        {groups.length > 1 && (
          <div className="flex items-center gap-3 text-sm text-neutral-400">
            <button
              disabled={gi === 0}
              onClick={() => {
                setGi(gi - 1);
                setDone([]);
              }}
              className="rounded-full px-3 py-1.5 disabled:opacity-30"
            >
              ‹
            </button>
            <span>
              chars {gi * 4 + 1}–{Math.min((gi + 1) * 4, chars.length)} of {chars.length}
            </span>
            <button
              disabled={gi >= groups.length - 1}
              onClick={() => {
                setGi(gi + 1);
                setDone([]);
              }}
              className="rounded-full px-3 py-1.5 disabled:opacity-30"
            >
              ›
            </button>
          </div>
        )}
      </div>

      <div className="space-y-3 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <p data-write-status className="text-center text-xs text-neutral-400">
          {MODE_HINT[mode]}
          {tally.ok + tally.miss > 0 && (
            <span className="ml-2 tabular-nums">
              ✓{tally.ok} ✗{tally.miss}
              {tally.rounds > 0 && ` · round ${tally.rounds + 1}`}
            </span>
          )}
        </p>
        <div className="flex items-center justify-center gap-2">
          {(mode === "drill" || mode === "write") && (
            <button
              onClick={() => setGhost(!ghost)}
              className={`rounded-full px-4 py-2.5 text-sm font-semibold transition ${
                ghost ? "bg-neutral-200 dark:bg-neutral-800" : "bg-neutral-100 dark:bg-neutral-900 text-neutral-400"
              }`}
            >
              ghost {ghost ? "on" : "off"}
            </button>
          )}
          <button
            onClick={resetWord}
            className="rounded-full bg-neutral-100 dark:bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-neutral-500"
          >
            {allDone ? "Again" : "Reset"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One 田-grid box: hanzi-writer quiz/animate, or free-draw canvas when the
 *  char has no stroke data (manual ✓ then). */
function WriterBox({
  ch,
  mode,
  ghost,
  active,
  label,
  done,
  onDone,
  onAnimateDone,
  onStroke,
}: {
  ch: string;
  mode: WriteMode;
  ghost: boolean;
  active: boolean;
  label: string;
  done: boolean;
  onDone: () => void;
  onAnimateDone: () => void;
  onStroke: (ok: boolean) => void;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(0);
  const [missing, setMissing] = useState(false);
  const [writer, setWriter] = useState<HanziWriter | null>(null);
  // hanzi-writer's animate/quiz stall if started before char data lands —
  // our loader tells us when it's safe
  const [dataReady, setDataReady] = useState(false);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize(Math.floor(el.clientWidth)));
    ro.observe(el);
    setSize(Math.floor(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || size < 40 || missing) return;
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    setDataReady(false);
    const w = HanziWriter.create(host, ch, {
      charDataLoader: (character: string, onComplete: (data: HanziWriterData) => void) => {
        const p = loadStrokes(character);
        if (p === "missing") {
          setMissing(true);
          return;
        }
        void p.then((d) => {
          if (d === "missing") setMissing(true);
          else {
            onComplete(d);
            setDataReady(true);
          }
        });
      },
      width: size,
      height: size,
      padding: 8,
      strokeColor: dark ? "#fafafa" : "#171717",
      outlineColor: dark ? "rgba(250,250,250,0.16)" : "rgba(23,23,23,0.13)",
      drawingColor: "#f59e0b",
      drawingWidth: 6,
      highlightColor: "#0ea5e9",
      showCharacter: mode === "animate",
      showOutline: mode === "trace" || ((mode === "drill" || mode === "write") && ghost),
      leniency: 1.15,
      showHintAfterMisses: 3,
    });
    setWriter(w);
    return () => {
      try {
        w.cancelQuiz();
      } catch {
        /* not quizzing */
      }
      host.replaceChildren();
      setWriter(null);
    };
  }, [ch, mode, ghost, size, missing]);

  // quiz/animate lifecycle once the writer AND its char data exist
  useEffect(() => {
    if (!writer || !dataReady) return;
    if (mode === "animate") {
      if (active) writer.animateCharacter({ onComplete: () => onAnimateDone() });
      return;
    }
    if (active) {
      writer.quiz({
        onCorrectStroke: () => onStroke(true),
        onMistake: () => onStroke(false),
        onComplete: () => onDone(),
      });
    }
  }, [writer, dataReady, active, mode]);

  return (
    <div className="flex w-full max-w-[min(72vw,150px)] flex-col items-center gap-1">
      <span className={`text-xs ${done ? "text-emerald-500" : "text-neutral-400"} tabular-nums`}>{label}</span>
      <div
        data-write-box={ch}
        className={`relative aspect-square w-full overflow-hidden rounded-xl border-2 bg-white dark:bg-neutral-900 ${
          done
            ? "border-emerald-400 dark:border-emerald-600"
            : active
              ? "border-amber-400 dark:border-amber-500"
              : "border-neutral-200 dark:border-neutral-800"
        }`}
      >
        {/* 田 grid guides */}
        <div className="pointer-events-none absolute inset-x-2 top-1/2 h-px bg-neutral-100 dark:bg-neutral-800" />
        <div className="pointer-events-none absolute inset-y-2 left-1/2 w-px bg-neutral-100 dark:bg-neutral-800" />
        <div ref={hostRef} className="absolute inset-0" />
        {done && (
          <span className="absolute right-1 top-1 rounded-full bg-emerald-100 dark:bg-emerald-900/60 p-0.5">
            <IconCheck className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
          </span>
        )}
        {missing && <FreeDrawBox ch={ch} onDone={onDone} ghost={mode === "trace" || ghost} />}
      </div>
    </div>
  );
}

/** Fallback for chars with no stroke data: draw freely, ✓ when satisfied. */
function FreeDrawBox({ ch, onDone, ghost }: { ch: string; onDone: () => void; ghost: boolean }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(r.width));
    c.height = Math.max(1, Math.round(r.height));
  }, []);

  function pos(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const r = e.currentTarget.getBoundingClientRect();
    const c = canvasRef.current!;
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  }

  const style: CSSProperties = { touchAction: "none", cursor: "crosshair" };

  return (
    <div className="absolute inset-0">
      {ghost && (
        <span
          lang="zh-Hant"
          className="hanzi pointer-events-none absolute inset-0 flex items-center justify-center text-6xl text-neutral-200 dark:text-neutral-700 select-none"
        >
          {ch}
        </span>
      )}
      <canvas
        ref={canvasRef}
        data-free-draw
        className="absolute inset-0 h-full w-full"
        style={style}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const ctx = canvasRef.current!.getContext("2d")!;
          const { x, y } = pos(e);
          ctx.lineWidth = 5;
          ctx.lineCap = "round";
          ctx.strokeStyle = "#f59e0b";
          ctx.beginPath();
          ctx.moveTo(x, y);
          drawing.current = true;
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = canvasRef.current!.getContext("2d")!;
          const { x, y } = pos(e);
          ctx.lineTo(x, y);
          ctx.stroke();
        }}
        onPointerUp={() => (drawing.current = false)}
      />
      <button
        onClick={onDone}
        aria-label="Mark done"
        className="absolute bottom-1 right-1 rounded-full bg-emerald-500 px-2.5 py-1 text-xs font-semibold text-white shadow"
      >
        ✓
      </button>
    </div>
  );
}
