import type { HanziRes, Interpretation, OcrRes, OcrWordSchema, RenderedWord, TranslateRes } from "../../shared/api";
import { useState } from "react";
import type { z } from "zod";
import { api, ApiError } from "../api";
import { CandidateCard, HanziWordCard, InterpretationCard } from "../components/Cards";
import { ResultCard } from "../components/ResultCard";
import { Segmented } from "../components/Segmented";
import { IconCamera, IconClose, IconKeyboard, IconMic, IconSend } from "../components/Icons";
import { useMe } from "../state";

type Mode = "type" | "speak" | "photo";

const hasHan = (s: string): boolean => /\p{Script=Han}/u.test(s);

/** Downscale a camera photo client-side before upload (max 1280px, jpeg). Returns sent-image dims. */
async function downscale(file: File): Promise<{ blob: Blob; w: number; h: number }> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) return { blob: file, w: bmp.width, h: bmp.height };
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? file), "image/jpeg", 0.82));
    return { blob, w: canvas.width, h: canvas.height };
  } catch {
    const dims = await new Promise<{ w: number; h: number }>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = URL.createObjectURL(file);
    });
    return { blob: file, ...dims };
  }
}

export function AskScreen(): React.JSX.Element {
  const [mode, setMode] = useState<Mode>("type");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<null | "lookup" | "translate">(null);
  const [error, setError] = useState<string | null>(null);
  const [translateCard, setTranslateCard] = useState<TranslateRes | null>(null);
  const [interps, setInterps] = useState<Interpretation[] | null>(null);
  const [cands, setCands] = useState<RenderedWord[] | null>(null);
  const [selectedCand, setSelectedCand] = useState<RenderedWord | null>(null);
  const [hanziWords, setHanziWords] = useState<HanziRes["words"] | null>(null);
  const [forcedTranslate, setForcedTranslate] = useState(false);
  const [ocrResult, setOcrResult] = useState<OcrRes | null>(null);
  const [ocrWord, setOcrWord] = useState<z.infer<typeof OcrWordSchema> | null>(null);
  const [savedNow, setSavedNow] = useState<Set<string>>(new Set());
  const [ocrBusy, setOcrBusy] = useState(false);
  const [photo, setPhoto] = useState<{ url: string; w: number; h: number } | null>(null);
  const [imgScale, setImgScale] = useState(0);

  function reset(): void {
    setError(null);
    setTranslateCard(null);
    setInterps(null);
    setCands(null);
    setSelectedCand(null);
    setHanziWords(null);
    setForcedTranslate(false);
    setOcrResult(null);
    setOcrWord(null);
    setSavedNow(new Set());
    if (photo) URL.revokeObjectURL(photo.url);
    setPhoto(null);
    setImgScale(0);
  }

  async function onPhoto(file: File | null): Promise<void> {
    if (!file || ocrBusy) return;
    reset();
    setOcrBusy(true);
    try {
      const { blob, w, h } = await downscale(file);
      setPhoto({ url: URL.createObjectURL(blob), w, h });
      setOcrResult(await api.ocr(blob));
    } catch (e) {
      setError(e instanceof ApiError ? `OCR failed: ${e.message}` : "OCR failed");
    } finally {
      setOcrBusy(false);
    }
  }

  const { me } = useMe();

  async function runTranslate(t: string): Promise<void> {
    setBusy("translate");
    try {
      setTranslateCard(await api.translate(t, me?.audience ?? undefined));
    } catch (e) {
      setError(e instanceof ApiError ? `Translation failed: ${e.message}` : "Translation failed");
    } finally {
      setBusy(null);
    }
  }

  async function submit(): Promise<void> {
    const t = text.trim();
    if (!t || busy) return;
    reset();

    if (hasHan(t)) {
      setBusy("lookup");
      try {
        setHanziWords((await api.hanzi(t)).words);
      } catch {
        setError("Lookup failed");
      } finally {
        setBusy(null);
      }
      return;
    }

    setBusy("lookup");
    let pinyinOk = false;
    try {
      const p = await api.pinyin(t);
      setCands(p.candidates);
      if (p.interpretations.length > 0 && !forcedTranslate) {
        setInterps(p.interpretations);
        pinyinOk = true;
      }
    } catch {
      /* fall through to translate */
    } finally {
      setBusy(null);
    }
    if (!pinyinOk || forcedTranslate) await runTranslate(t);
  }

  return (
    <div className="space-y-4">
      <Segmented<Mode>
        className="w-full [&>button]:flex-1 flex"
        value={mode}
        onChange={setMode}
        options={[
          { value: "type", label: <span className="flex items-center justify-center gap-1.5"><IconKeyboard className="h-4 w-4" /> Type</span> },
          { value: "speak", label: <span className="flex items-center justify-center gap-1.5"><IconMic className="h-4 w-4" /> Speak</span>, disabled: true },
          { value: "photo", label: <span className="flex items-center justify-center gap-1.5"><IconCamera className="h-4 w-4" /> Photo</span> },
        ]}
      />
      <p className="-mt-2 text-center text-[11px] text-neutral-400">Speak arrives next</p>

      {mode === "photo" && (
        <div className="space-y-4">
          <label className="flex h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 active:scale-[0.99] transition">
            <IconCamera className="h-8 w-8 text-amber-500" />
            <span className="text-sm font-medium">Snap a page or choose an image</span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => void onPhoto(e.target.files?.[0] ?? null)}
            />
          </label>
          {ocrBusy && <div className="animate-pulse text-sm text-neutral-400">Reading the page…</div>}
          {error && <div className="rounded-xl bg-red-50 dark:bg-red-950/50 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</div>}
          {ocrResult && photo && (
            <div className="space-y-3">
              <div className="relative overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800 select-none">
                <img
                  src={photo.url}
                  alt="page"
                  className="block w-full"
                  onLoad={(e) => setImgScale(e.currentTarget.clientWidth / (photo.w || e.currentTarget.naturalWidth || 1))}
                />
                {ocrResult.positioned &&
                  imgScale > 0 &&
                  ocrResult.lines.flatMap((line, li) =>
                    line.words
                      .filter((w) => w.box)
                      .map((w, wi) => {
                        const [x1, y1, x2, y2] = w.box!;
                        const isSaved = w.saved || savedNow.has(w.traditional);
                        const boxH = (y2 - y1) * imgScale;
                        const boxW = (x2 - x1) * imgScale;
                        const chars = [...w.traditional].length || 1;
                        // fit the text to the box: height-bound and width-bound
                        const fontSize = Math.max(10, Math.min(boxH * 0.78, boxW / (chars * 1.2), 40));
                        return (
                          <button
                            key={`${li}-${wi}`}
                            data-ocr-word={w.traditional}
                            onClick={() => setOcrWord(ocrWord?.traditional === w.traditional ? null : w)}
                            style={{
                              left: x1 * imgScale,
                              top: y1 * imgScale,
                              width: boxW,
                              height: boxH,
                              fontSize,
                              lineHeight: 1.1,
                            }}
                            className={`hanzi absolute flex items-center justify-center overflow-hidden rounded-md border px-0.5 transition ${
                              ocrWord?.traditional === w.traditional
                                ? "border-amber-500 bg-amber-500/40 text-amber-900 dark:text-amber-100"
                                : "border-white/70 bg-white/70 text-neutral-900 backdrop-blur-[1px] dark:bg-black/50 dark:text-white"
                            } ${w.known ? "" : "opacity-50"}`}
                          >
                            {w.traditional}
                            {isSaved && (
                              <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-emerald-500" />
                            )}
                          </button>
                        );
                      }),
                  )}

                {/* definition popover anchored under the selected box */}
                {ocrResult.positioned &&
                  imgScale > 0 &&
                  ocrWord?.box &&
                  photo &&
                  (() => {
                    const containerW = photo.w * imgScale;
                    const containerH = photo.h * imgScale;
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

              {/* fallback chips for words without boxes */}
              {!ocrResult.positioned && (
                <div className="flex flex-wrap gap-2">
                  {ocrResult.lines.flatMap((line, li) =>
                    line.words.map((w, wi) => {
                      const isSaved = w.saved || savedNow.has(w.traditional);
                      return (
                        <button
                          key={`${li}-${wi}`}
                          data-ocr-word={w.traditional}
                          onClick={() => setOcrWord(ocrWord?.traditional === w.traditional ? null : w)}
                          className={`hanzi relative rounded-xl border px-3 py-2 text-xl transition ${
                            ocrWord?.traditional === w.traditional
                              ? "border-amber-500 bg-amber-50 dark:bg-amber-950/50"
                              : "border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900"
                          } ${w.known ? "" : "opacity-50"}`}
                        >
                          {w.traditional}
                          {isSaved && <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-emerald-500 border-2 border-white dark:border-neutral-900" />}
                        </button>
                      );
                    }),
                  )}
                </div>
              )}

              <div className="text-center text-[11px] text-neutral-400">tap a word on the page</div>
              {ocrWord && !ocrResult.positioned && (
                <HanziWordCard
                  word={ocrWord}
                  onSaved={(t) => setSavedNow((s) => new Set(s).add(t))}
                />
              )}
            </div>
          )}
        </div>
      )}

      {mode === "type" && (
        <>
          <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="English or rough pinyin — “time for a bath”, “gai shui jiao le”"
            autoCapitalize="none"
            autoCorrect="off"
            enterKeyHint="send"
            className="min-w-0 flex-1 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3.5 py-3 outline-none focus:border-amber-500"
          />
          <button
            type="submit"
            disabled={!text.trim() || busy !== null}
            aria-label="Send"
            className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-xl bg-amber-500 text-white shadow disabled:opacity-40 active:scale-95 transition"
          >
            <IconSend className="h-5 w-5" />
          </button>
        </div>
      </form>

      {busy === "lookup" && <div className="animate-pulse text-sm text-neutral-400">Looking up…</div>}
      {busy === "translate" && <div className="animate-pulse text-sm text-neutral-400">Translating…</div>}
      {error && <div className="rounded-xl bg-red-50 dark:bg-red-950/50 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</div>}

      {translateCard && <ResultCard card={translateCard} />}

      {hanziWords && (
        <div className="space-y-3">
          {hanziWords.map((w, i) => (
            <HanziWordCard key={i} word={w} />
          ))}
        </div>
      )}

      {interps && interps.length > 0 && (
        <div className="space-y-3">
          {!forcedTranslate && (
            <button
              onClick={() => {
                setInterps(null);
                setForcedTranslate(true);
                void runTranslate(text.trim());
              }}
              className="text-xs text-sky-600 dark:text-sky-400 underline underline-offset-2"
            >
              Translate as English instead →
            </button>
          )}
          {interps.map((it, i) => (
            <InterpretationCard key={i} interp={it} rank={i + 1} />
          ))}
        </div>
      )}

      {cands && cands.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-neutral-400">might match</div>
          <div className="flex flex-wrap gap-2">
            {cands.map((w) => (
              <button
                key={w.traditional + w.pinyin}
                onClick={() => setSelectedCand(selectedCand === w ? null : w)}
                className={`hanzi rounded-full border px-3 py-1.5 text-lg transition ${
                  selectedCand === w
                    ? "border-amber-500 bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300"
                    : "border-neutral-300 dark:border-neutral-700"
                }`}
              >
                {w.traditional}
              </button>
            ))}
          </div>
          {selectedCand && <CandidateCard word={selectedCand} />}
        </div>
      )}
        </>
      )}
    </div>
  );
}
