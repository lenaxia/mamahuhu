import { useRef, useState } from "react";
import type { z } from "zod";
import type { OcrRes, OcrWordSchema } from "../../shared/api";
import { HanziWordCard } from "./Cards";
import { IconClose } from "./Icons";

/**
 * Photo with OCR overlay: pinch-zoom / double-tap-zoom, word chips scaled to
 * their boxes, in-place definition popover. Used by Ask (fresh upload) and
 * History (stored photo).
 */
export function PhotoPage({
  photoUrl,
  w,
  h,
  ocrResult,
}: {
  photoUrl: string;
  w: number;
  h: number;
  ocrResult: OcrRes;
}): React.JSX.Element {
  const [ocrWord, setOcrWord] = useState<z.infer<typeof OcrWordSchema> | null>(null);
  const [savedNow, setSavedNow] = useState<Set<string>>(new Set());
  const [imgScale, setImgScale] = useState(0);
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const pinch = useRef<{ d: number; s: number; cx: number; cy: number; vx: number; vy: number } | null>(null);

  const clamp = (v: { s: number; x: number; y: number }) => {
    const W = (w * imgScale) || 1;
    const H = (h * imgScale) || 1;
    const maxX = Math.min(0, W * (1 - v.s));
    const maxY = Math.min(0, H * (1 - v.s));
    return { s: v.s, x: Math.min(0, Math.max(maxX, v.x)), y: Math.min(0, Math.max(maxY, v.y)) };
  };

  function onTouchStart(e: React.TouchEvent) {
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0]!, e.touches[1]!];
      pinch.current = {
        d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        s: view.s,
        cx: (a.clientX + b.clientX) / 2,
        cy: (a.clientY + b.clientY) / 2,
        vx: view.x,
        vy: view.y,
      };
    }
  }

  function onTouchMove(e: React.TouchEvent) {
    if (e.touches.length === 2 && pinch.current) {
      const [a, b] = [e.touches[0]!, e.touches[1]!];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const s = Math.min(5, Math.max(1, pinch.current.s * (dist / (pinch.current.d || 1))));
      const dx = (a.clientX + b.clientX) / 2 - pinch.current.cx;
      const dy = (a.clientY + b.clientY) / 2 - pinch.current.cy;
      setView(clamp({ s, x: pinch.current.vx + dx, y: pinch.current.vy + dy }));
    }
  }

  return (
    <div className="space-y-3">
      <div
        className="relative overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800 select-none"
        style={{ touchAction: "none" }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={() => (pinch.current = null)}
        onDoubleClick={(e) => {
          if (view.s > 1) setView({ s: 1, x: 0, y: 0 });
          else setView({ s: 2.5, x: clamp({ s: 2.5, x: view.x, y: view.y }).x, y: clamp({ s: 2.5, x: view.x, y: view.y }).y });
          void e;
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
            src={photoUrl}
            alt="page"
            className="block w-full"
            onLoad={(e) => setImgScale(e.currentTarget.clientWidth / (w || e.currentTarget.naturalWidth || 1))}
          />

          {ocrResult.positioned &&
            imgScale > 0 &&
            ocrResult.lines.flatMap((line, li) =>
              line.words
                .filter((wd) => wd.box)
                .map((wd, wi) => {
                  const [x1, y1, x2, y2] = wd.box!;
                  const isSaved = wd.saved || savedNow.has(wd.traditional);
                  const boxH = (y2 - y1) * imgScale;
                  const boxW = (x2 - x1) * imgScale;
                  const chars = [...wd.traditional].length || 1;
                  const fontSize = Math.max(10, Math.min(boxH * 0.78, boxW / (chars * 1.2), 40));
                  return (
                    <button
                      key={`${li}-${wi}`}
                      data-ocr-word={wd.traditional}
                      onClick={() => setOcrWord(ocrWord?.traditional === wd.traditional ? null : wd)}
                      style={{
                        left: x1 * imgScale,
                        top: y1 * imgScale,
                        width: boxW,
                        height: boxH,
                        fontSize,
                        lineHeight: 1.1,
                      }}
                      className={`hanzi absolute flex items-center justify-center overflow-hidden rounded-md border px-0.5 transition ${
                        ocrWord?.traditional === wd.traditional
                          ? "border-amber-500 bg-amber-500/40 text-amber-900 dark:text-amber-100"
                          : "border-white/70 bg-white/70 text-neutral-900 backdrop-blur-[1px] dark:bg-black/50 dark:text-white"
                      } ${wd.known ? "" : "opacity-50"}`}
                    >
                      {wd.traditional}
                      {isSaved && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-emerald-500" />}
                    </button>
                  );
                }),
            )}

          {/* definition popover anchored under the selected box */}
          {ocrResult.positioned &&
            imgScale > 0 &&
            ocrWord?.box &&
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

        {view.s > 1 && (
          <button
            onClick={() => setView({ s: 1, x: 0, y: 0 })}
            className="absolute right-2 top-2 z-30 rounded-full bg-black/60 px-3 py-1.5 text-xs font-semibold text-white"
          >
            reset zoom
          </button>
        )}
      </div>

      <div className="text-center text-[11px] text-neutral-400">
        pinch or double-tap to zoom · tap a word on the page
      </div>

      {/* fallback chips when the model gave no boxes */}
      {!ocrResult.positioned && (
        <>
          <div className="flex flex-wrap gap-2">
            {ocrResult.lines.flatMap((line, li) =>
              line.words.map((wd, wi) => {
                const isSaved = wd.saved || savedNow.has(wd.traditional);
                return (
                  <button
                    key={`f${li}-${wi}`}
                    data-ocr-word={wd.traditional}
                    onClick={() => setOcrWord(ocrWord?.traditional === wd.traditional ? null : wd)}
                    className={`hanzi relative rounded-xl border px-3 py-2 text-xl transition ${
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
