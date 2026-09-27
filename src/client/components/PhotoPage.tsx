import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import type { OcrPage, OcrWordSchema } from "../../shared/api";
import { HanziWordCard } from "./Cards";
import { IconClose } from "./Icons";

/**
 * Photo with OCR overlay. Gestures: pinch-zoom, one-finger pan (when zoomed),
 * double-tap zoom, +/− buttons, wheel on desktop. Word chips scale to their
 * boxes; the definition popover anchors in place. Used by Ask and History.
 */
export function PhotoPage({
  photoUrl,
  w,
  h,
  page,
}: {
  photoUrl: string;
  w: number;
  h: number;
  page: OcrPage;
}): React.JSX.Element {
  const [ocrWord, setOcrWord] = useState<z.infer<typeof OcrWordSchema> | null>(null);
  const [savedNow, setSavedNow] = useState<Set<string>>(new Set());
  const [imgScale, setImgScale] = useState(0);
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const lastTap = useRef(0);

  // compute rendered scale robustly: covers cached/already-complete images
  useEffect(() => {
    const compute = () => {
      const img = imgRef.current;
      if (img?.clientWidth) setImgScale(img.clientWidth / (w || img.naturalWidth || 1));
    };
    compute();
    const t = setTimeout(compute, 50);
    window.addEventListener("resize", compute);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", compute);
    };
  }, [photoUrl, w]);

  const clamp = (v: { s: number; x: number; y: number }) => {
    const W = (w * imgScale) || 1;
    const H = (h * imgScale) || 1;
    const maxX = Math.min(0, W * (1 - v.s));
    const maxY = Math.min(0, H * (1 - v.s));
    return { s: v.s, x: Math.min(0, Math.max(maxX, v.x)), y: Math.min(0, Math.max(maxY, v.y)) };
  };

  /** zoom keeping container-point (px,py) fixed */
  const zoomTo = (s2: number, px = -1, py = -1) => {
    setView((v) => {
      const W = w * imgScale || 1;
      const H = h * imgScale || 1;
      const fx = px < 0 ? W / 2 : px;
      const fy = py < 0 ? H / 2 : py;
      const ratio = s2 / v.s;
      return clamp({ s: s2, x: fx - (fx - v.x) * ratio, y: fy - (fy - v.y) * ratio });
    });
  };

  const gesture = useRef<{
    mode: "pan" | "pinch" | null;
    startX: number; startY: number; vx: number; vy: number;
    d: number; s: number; cx: number; cy: number;
  }>({ mode: null, startX: 0, startY: 0, vx: 0, vy: 0, d: 0, s: 1, cx: 0, cy: 0 });

  function onTouchStart(e: React.TouchEvent) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0]!, e.touches[1]!];
      gesture.current = {
        mode: "pinch",
        d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        s: view.s,
        cx: (a.clientX + b.clientX) / 2 - rect.left,
        cy: (a.clientY + b.clientY) / 2 - rect.top,
        vx: view.x, vy: view.y,
        startX: 0, startY: 0,
      };
    } else if (e.touches.length === 1 && view.s > 1.01) {
      const t = e.touches[0]!;
      gesture.current = {
        mode: "pan",
        startX: t.clientX, startY: t.clientY,
        vx: view.x, vy: view.y,
        d: 0, s: view.s, cx: 0, cy: 0,
      };
    }
  }

  function onTouchMove(e: React.TouchEvent) {
    const g = gesture.current;
    if (!g.mode) return;
    if (g.mode === "pinch" && e.touches.length === 2) {
      const [a, b] = [e.touches[0]!, e.touches[1]!];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const s = Math.min(6, Math.max(1, g.s * (dist / (g.d || 1))));
      const rect = e.currentTarget.getBoundingClientRect();
      const cx = (a.clientX + b.clientX) / 2 - rect.left;
      const cy = (a.clientY + b.clientY) / 2 - rect.top;
      // keep the pinch center stable + follow its movement
      const ratio = s / g.s;
      setView(clamp({
        s,
        x: cx - (g.cx - g.vx) * ratio,
        y: cy - (g.cy - g.vy) * ratio,
      }));
    } else if (g.mode === "pan" && e.touches.length === 1) {
      const t = e.touches[0]!;
      setView(clamp({ s: view.s, x: g.vx + (t.clientX - g.startX), y: g.vy + (t.clientY - g.startY) }));
    }
  }

  function onTouchEnd(e: React.TouchEvent) {
    const g = gesture.current;
    if (e.touches.length === 0 && g.mode === null) {
      // possible (double-)tap: chip clicks handle taps themselves via onClick
      const t = e.changedTouches[0];
      const rect = e.currentTarget.getBoundingClientRect();
      if (t) {
        const now = Date.now();
        if (now - lastTap.current < 320) {
          lastTap.current = 0;
          zoomTo(view.s > 1.01 ? 1 : 2.5, t.clientX - rect.left, t.clientY - rect.top);
          return;
        }
        lastTap.current = now;
      }
    }
    if (e.touches.length === 0) gesture.current = { ...g, mode: null };
    if (e.touches.length === 1 && g.mode === "pinch") gesture.current = { ...g, mode: null };
  }

  return (
    <div className="space-y-3">
      <div
        className="relative overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800 select-none"
        style={{ touchAction: view.s > 1.01 ? "none" : "pan-y" }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onDoubleClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          zoomTo(view.s > 1.01 ? 1 : 2.5, e.clientX - rect.left, e.clientY - rect.top);
        }}
        onWheel={(e) => {
          if (!e.ctrlKey) return;
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          zoomTo(Math.min(6, Math.max(1, view.s * (e.deltaY < 0 ? 1.15 : 0.87))), e.clientX - rect.left, e.clientY - rect.top);
        }}
      >
        <div
          className="relative"
          style={{
            width: "100%",
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
            transformOrigin: "0 0",
          }}
        >
          <img
            ref={imgRef}
            src={photoUrl}
            alt="page"
            className="block w-full"
            onLoad={() => { if (imgRef.current) setImgScale(imgRef.current.clientWidth / (w || imgRef.current.naturalWidth || 1)); }}
          />

          {page.positioned &&
            imgScale > 0 &&
            page.lines.flatMap((line, li) =>
              line.words
                .filter((wd) => wd.box)
                .map((wd, wi) => {
                  const [x1, y1, x2, y2] = wd.box!;
                  const isSaved = wd.saved || savedNow.has(wd.traditional);
                  const boxH = (y2 - y1) * imgScale;
                  const boxW = (x2 - x1) * imgScale;
                  const chars = [...wd.traditional];
                  const n = chars.length || 1;
                  // direction from the model; aspect fallback when absent.
                  // text must FIT the box: tall boxes stack chars vertically.
                  const tall = wd.dir === "v" || (wd.dir !== "h" && boxH > boxW * 1.25 && n > 1);
                  const fontSize = tall
                    ? Math.max(9, Math.min(boxW * 0.85, (boxH / n) * 0.9, 40))
                    : Math.max(10, Math.min(boxH * 0.78, boxW / (n * 1.2), 40));
                  return (
                    <button
                      key={`${li}-${wi}`}
                      data-ocr-word={wd.traditional}
                      onClick={() => setOcrWord(ocrWord?.traditional === wd.traditional ? null : wd)}
                      style={{ left: x1 * imgScale, top: y1 * imgScale, width: boxW, height: boxH, fontSize, lineHeight: 1.1 }}
                      className={`hanzi absolute flex ${tall ? "flex-col" : "flex-row"} items-center justify-center overflow-hidden rounded-md border px-0.5 ${
                        ocrWord?.traditional === wd.traditional
                          ? "border-amber-500 bg-amber-500/40 text-amber-900 dark:text-amber-100"
                          : "border-white/70 bg-white/70 text-neutral-900 backdrop-blur-[1px] dark:bg-black/50 dark:text-white"
                      } ${wd.known ? "" : "opacity-50"}`}
                    >
                      {chars.map((ch, ci) => (
                        <span key={ci}>{ch}</span>
                      ))}
                      {isSaved && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-emerald-500" />}
                    </button>
                  );
                }),
            )}

          {page.positioned && imgScale > 0 && ocrWord?.box &&
            (() => {
              const containerW = w * imgScale;
              const containerH = h * imgScale;
              const [x1, y1, , y2] = ocrWord.box;
              const panelW = Math.min(containerW - 16, 320);
              const panelH = 200;
              const left = Math.min(Math.max(8, x1 * imgScale), Math.max(8, containerW - panelW - 8));
              let top = y2 * imgScale + 8;
              if (top + panelH > containerH - 8) top = Math.max(8, y1 * imgScale - panelH - 8);
              return (
                <div className="absolute z-20 drop-shadow-xl" style={{ left, top, width: panelW }}>
                  <div className="relative">
                    <button
                      aria-label="Close"
                      onClick={() => setOcrWord(null)}
                      className="absolute -right-2 -top-2 z-30 flex h-8 w-8 items-center justify-center rounded-full bg-neutral-900 text-white shadow-lg dark:bg-white dark:text-neutral-900"
                    >
                      <IconClose className="h-4 w-4" />
                    </button>
                    <HanziWordCard word={ocrWord} onSaved={(t) => setSavedNow((s) => new Set(s).add(t))} />
                  </div>
                </div>
              );
            })()}
        </div>

        {/* zoom controls */}
        {imgScale > 0 && (
          <div className="absolute bottom-2 right-2 z-30 flex flex-col gap-1.5">
            <button
              aria-label="Zoom in"
              onClick={() => zoomTo(Math.min(6, view.s * 1.6))}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-lg font-bold text-white backdrop-blur"
            >
              +
            </button>
            <button
              aria-label="Zoom out"
              onClick={() => zoomTo(Math.max(1, view.s / 1.6))}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-lg font-bold text-white backdrop-blur"
            >
              −
            </button>
            {view.s > 1.01 && (
              <button
                aria-label="Reset zoom"
                onClick={() => setView({ s: 1, x: 0, y: 0 })}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-[10px] font-bold text-white backdrop-blur"
              >
                1×
              </button>
            )}
          </div>
        )}
      </div>

      <div className="text-center text-[11px] text-neutral-400">
        pinch / double-tap / + to zoom · tap a word for its meaning
      </div>

      {!page.positioned && (
        <>
          <div className="text-xs uppercase tracking-wide text-neutral-400">words (no positions detected)</div>
          <div className="flex flex-wrap gap-2">
            {page.lines.flatMap((line, li) =>
              line.words.map((wd, wi) => {
                const isSaved = wd.saved || savedNow.has(wd.traditional);
                return (
                  <button
                    key={`f${li}-${wi}`}
                    data-ocr-word={wd.traditional}
                    onClick={() => setOcrWord(ocrWord?.traditional === wd.traditional ? null : wd)}
                    className={`hanzi relative rounded-xl border px-3 py-2 text-xl ${
                      ocrWord?.traditional === wd.traditional
                        ? "border-amber-500 bg-amber-50 dark:bg-amber-950/50"
                        : "border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900"
                    } ${wd.known ? "" : "opacity-50"}`}
                  >
                    {wd.traditional}
                    {isSaved && <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-emerald-500 border-2 border-white dark:border-neutral-900" />}
                  </button>
                );
              }),
            )}
          </div>
          {ocrWord && <HanziWordCard word={ocrWord} onSaved={(t) => setSavedNow((s) => new Set(s).add(t))} />}
        </>
      )}
    </div>
  );
}
