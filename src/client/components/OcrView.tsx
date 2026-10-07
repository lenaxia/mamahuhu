import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import type { Identify, OcrPage, OcrRes } from "../../shared/api";
import { marksToNumbered, numberedToBpmf } from "../../shared/bpmf";
import { api, ApiError } from "../api";
import { HanziWordCard, FollowUpBox, FullTranslationCard } from "./Cards";
import { CopyButton } from "./CopyButton";
import { PhotoPage } from "./PhotoPage";
import { IconClose } from "./Icons";
import { useToast } from "./Toast";
import { useAnnotations } from "../state";
import { speak } from "../tts";
import { AnnotatedText } from "./AnnotatedText";

/** Textless-photo result: the identified subject as a Mandarin name card. */
function IdentifyCard({ identify, onRefine, askId }: { identify: Identify; onRefine: () => void; askId?: string }): React.JSX.Element {
  const annotations = useAnnotations();
  const [saved, setSaved] = useState(false);
  const show = useToast().show;
  const pyTokens = identify.pinyin.split(/\s+/).filter(Boolean);
  const syllables = [[...identify.traditional].map((h, i) => ({
    h,
    py: pyTokens[i] ?? "",
    bpmf: pyTokens[i] ? numberedToBpmf(marksToNumbered(pyTokens[i]!)) : "",
  }))];

  async function save(): Promise<void> {
    try {
      const res = await api.createEntry({
        traditional: identify.traditional,
        simplified: identify.simplified,
        pinyin: identify.pinyin,
        pinyinFlat: identify.pinyin.replace(/[^a-zü ]/gi, "").replace(/\s+/g, ""),
        bpmf: syllables[0]!.map((c) => c.bpmf).filter(Boolean).join(" "),
        jyutping: "",
        formalZh: "",
        formalJyut: "",
        english: identify.gloss,
        register: "casual",
        source: "ocr",
        syllables,
        variety: "zh-Hant",
        ...(askId ? { askId } : {}),
      });
      setSaved(true);
      show(res.duplicate ? "Already saved" : "Saved");
    } catch {
      show("Save failed");
    }
  }

  return (
    <div data-traditional={identify.traditional} className="rounded-2xl border-2 border-emerald-300 dark:border-emerald-800 bg-white dark:bg-neutral-900 p-4 shadow-sm space-y-3">
      <div className="text-xs uppercase tracking-wide text-emerald-600 dark:text-emerald-400">this looks like</div>
      <AnnotatedText syllables={syllables} annotations={annotations} />
      <p className="text-[15px] text-neutral-700 dark:text-neutral-300">{identify.gloss}</p>
      {identify.note && <p className="text-xs text-neutral-400">{identify.note}</p>}
      <div className="flex items-center gap-2 pt-1">
        <button
          aria-label="Play audio"
          onClick={() => speak(identify.traditional)}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800 active:scale-95 transition"
        >
          ▶
        </button>
        <button
          onClick={onRefine}
          className="flex h-10 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800 px-3 text-xs font-semibold text-neutral-500 active:scale-95 transition"
        >
          ✎ circle to refine
        </button>
        <button
          onClick={() => void save()}
          disabled={saved}
          className={`ml-auto flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-semibold active:scale-95 transition ${
            saved
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300"
              : "bg-amber-500 text-white shadow"
          }`}
        >
          {saved ? "Saved" : "Save"}
        </button>
      </div>
      <FollowUpBox hanzi={identify.traditional} gloss={identify.gloss} askId={askId} />
    </div>
  );
}

/** Circle-to-refine: draw over the photo, the bbox crop is re-identified. */
function WordList({
  words,
  askId,
  onSaved,
}: {
  words: z.infer<typeof OcrWordSchema>[];
  askId?: string;
  onSaved: (t: string) => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  // dense prose (letters, chapters) re-reads columns and repeats phrases —
  // dedupe to one card per word; the overlay chips keep per-occurrence
  const seen = new Set<string>();
  const unique = words.filter((w) => {
    const key = w.traditional + "|" + w.english;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const LIMIT = 6;
  const shown = expanded ? unique : unique.slice(0, LIMIT);
  return (
    <div className="space-y-2">
      <span className="text-xs uppercase tracking-wide text-neutral-400">words{unique.length < words.length ? ` · ${unique.length} unique` : ""}</span>
      <div className="space-y-2">
        {shown.map((wd, i) => (
          <HanziWordCard key={wd.traditional + i} word={wd} askId={askId} onSaved={onSaved} />
        ))}
      </div>
      {unique.length > LIMIT && (
        <button onClick={() => setExpanded(!expanded)} className="w-full rounded-xl border border-neutral-200 dark:border-neutral-800 py-2.5 text-xs font-semibold text-neutral-500">
          {expanded ? "show fewer" : `show all ${unique.length} words`}
        </button>
      )}
    </div>
  );
}

function MarkOverlay({ photoUrl, onCancel, onCrop }: { photoUrl: string; onCancel: () => void; onCrop: (blob: Blob) => void }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const pts = useRef<{ x: number; y: number }[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    const draw = () => {
      canvas.width = img.clientWidth;
      canvas.height = img.clientHeight;
      setReady(true);
    };
    if (img.complete) draw();
    else img.onload = draw;
  }, []);

  function pos(e: React.PointerEvent): { x: number; y: number } {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onDown(e: React.PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pts.current = [pos(e)];
  }

  function onMove(e: React.PointerEvent) {
    if (!pts.current.length) return;
    pts.current.push(pos(e));
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasRef.current!.width, canvasRef.current!.height);
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.beginPath();
    pts.current.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
  }

  async function onUp(): Promise<void> {
    const ps = pts.current;
    pts.current = [];
    if (ps.length < 8) return; // tap, not a circle
    const xs = ps.map((p) => p.x);
    const ys = ps.map((p) => p.y);
    const pad = 12;
    const x1 = Math.max(0, Math.min(...xs) - pad);
    const y1 = Math.max(0, Math.min(...ys) - pad);
    const x2 = Math.min(canvasRef.current!.width, Math.max(...xs) + pad);
    const y2 = Math.min(canvasRef.current!.height, Math.max(...ys) + pad);
    if (x2 - x1 < 16 || y2 - y1 < 16) return;
    const img = imgRef.current!;
    const sx = img.naturalWidth / img.clientWidth;
    const sy = img.naturalHeight / img.clientHeight;
    const bmp = await createImageBitmap(img);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round((x2 - x1) * sx);
    canvas.height = Math.round((y2 - y1) * sy);
    canvas.getContext("2d")!.drawImage(bmp, x1 * sx, y1 * sy, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((b) => b && onCrop(b), "image/jpeg", 0.9);
  }

  return (
    <div className="fixed inset-0 z-50 bg-neutral-950">
      <div className="flex items-center justify-between px-3 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2">
        <span className="px-2 text-[11px] uppercase tracking-widest text-neutral-500">circle the subject</span>
        <div className="flex gap-1.5">
          <button aria-label="Close" onClick={onCancel} className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white">
            <IconClose className="h-5 w-5" />
          </button>
        </div>
      </div>
      <div className="px-2">
        <div className="relative inline-block w-full touch-none">
          <img ref={imgRef} src={photoUrl} alt="refine" className="block w-full rounded-xl" />
          <canvas
            ref={canvasRef}
            className={`absolute inset-0 h-full w-full cursor-crosshair ${ready ? "" : "pointer-events-none"}`}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={() => void onUp()}
          />
        </div>
        <p className="mt-3 text-center text-xs text-neutral-400">draw a loop around what you want named</p>
      </div>
    </div>
  );
}

/** OCR/identify result view: multi-page switcher, overlay photo, identify card + refine. */
export function OcrView({ ocrResult, photoUrl, w, h }: { ocrResult: OcrRes; photoUrl: string; w: number; h: number }): React.JSX.Element {
  const [pageIndex, setPageIndex] = useState(0);
  const [markMode, setMarkMode] = useState(false);
  const [savedWords, setSavedWords] = useState<Set<string>>(new Set());
  const [tags, setTags] = useState<Identify[] | undefined>(ocrResult.tags);
  const [openTag, setOpenTag] = useState<number | null>(null);
  const show = useToast().show;
  const pageCount = ocrResult.pageCount ?? 1;
  const page: OcrPage = ocrResult.pages?.[pageIndex] ?? { lines: ocrResult.lines, fullText: ocrResult.fullText, positioned: ocrResult.positioned };
  const pageUrl = pageIndex > 0 ? `${photoUrl}?page=${pageIndex + 1}` : photoUrl;

  async function refineCrop(blob: Blob): Promise<void> {
    setMarkMode(false);
    try {
      const res = await api.identify(blob);
      setTags(res.tags);
      setOpenTag(0);
    } catch (e) {
      show(e instanceof ApiError ? e.message : "Couldn't identify");
    }
  }

  return (
    <div className="space-y-3">
      {pageCount > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button
            disabled={pageIndex === 0}
            onClick={() => setPageIndex((i) => i - 1)}
            className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-4 py-1.5 font-medium disabled:opacity-30"
          >
            ←
          </button>
          <span className="tabular-nums text-neutral-400">page {pageIndex + 1} / {pageCount}</span>
          <button
            disabled={pageIndex >= pageCount - 1}
            onClick={() => setPageIndex((i) => i + 1)}
            className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-4 py-1.5 font-medium disabled:opacity-30"
          >
            →
          </button>
        </div>
      )}

      {/* image always displays — with or without detected text */}
      <PhotoPage photoUrl={pageUrl} w={w} h={h} page={page} askId={ocrResult.askId} />

      {tags && tags.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-emerald-600 dark:text-emerald-400">in this photo</span>
            <button onClick={() => setMarkMode(true)} className="text-[11px] text-neutral-400 underline underline-offset-2">
              ✎ circle to refine
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {tags.map((t, i) => (
              <button
                key={t.traditional + i}
                data-tag={t.traditional}
                onClick={() => setOpenTag(openTag === i ? null : i)}
                className={`hanzi rounded-full border px-3 py-1.5 text-lg transition ${
                  openTag === i
                    ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300"
                    : "border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900"
                }`}
              >
                {t.traditional}
              </button>
            ))}
          </div>
          {openTag !== null && tags[openTag] && (
            <IdentifyCard identify={tags[openTag]!} onRefine={() => setMarkMode(true)} askId={ocrResult.askId} />
          )}
        </div>
      )}

      {ocrResult.fullTranslation && (
        <FullTranslationCard
          text={ocrResult.fullText}
          english={ocrResult.fullTranslation}
          source="ocr"
          askId={ocrResult.askId}
        />
      )}

      {page.lines.length > 0 && (
        <WordList
          words={page.lines.flatMap((l) => l.words)}
          askId={ocrResult.askId}
          onSaved={(t) => setSavedWords((s) => new Set(s).add(t))}
        />
      )}

      {page.lines.length === 0 && !tags?.length && (
        <div className="rounded-2xl border border-dashed border-neutral-300 dark:border-neutral-700 p-4 text-center text-xs text-neutral-400">
          no readable text on this page
        </div>
      )}
      {page.lines.length === 0 && tags?.length ? (
        <p className="text-center text-[11px] text-neutral-400">no readable text — tap a tag, or ✎ circle to refine</p>
      ) : null}

      {markMode && <MarkOverlay photoUrl={pageUrl} onCancel={() => setMarkMode(false)} onCrop={(b) => void refineCrop(b)} />}
    </div>
  );
}
