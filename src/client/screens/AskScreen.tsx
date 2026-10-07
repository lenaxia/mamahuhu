import { useEffect, useRef, useState } from "react";
import type { HanziRes, Interpretation, OcrRes, RenderedWord, TranslateRes } from "../../shared/api";
import { api, ApiError } from "../api";
import { CandidateCard, HanziWordCard, InterpretationCard, PhraseCard, FullTranslationCard } from "../components/Cards";
import { ResultCard } from "../components/ResultCard";
import { Segmented } from "../components/Segmented";
import { OcrView } from "../components/OcrView";
import { IconCamera, IconMic, IconSend, IconClose } from "../components/Icons";
import { useMe } from "../state";
import { BrowserRecognizer, MicRecorder, browserSttSupported, sttServerMode } from "../stt";

const hasHan = (s: string): boolean => /\p{Script=Han}/u.test(s);

/** Canonical upload geometry: height EXACTLY 1000px (width by aspect, capped 1600). */
async function downscale(file: File): Promise<{ blob: Blob; w: number; h: number }> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => createImageBitmap(file).catch(() => null));
  if (!bmp) {
    const dims = await new Promise<{ w: number; h: number }>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = URL.createObjectURL(file);
    });
    return { blob: file, ...dims };
  }
  const scale = Math.min(1000 / bmp.height, 1600 / bmp.width, 2.5);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? file), "image/jpeg", 0.85));
  bmp.close?.();
  return { blob, w: canvas.width, h: canvas.height };
}

export function AskScreen(): React.JSX.Element {
  const { me } = useMe();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<null | "lookup" | "translate">(null);
  const [error, setError] = useState<string | null>(null);
  const [translateCard, setTranslateCard] = useState<TranslateRes | null>(null);
  const [interps, setInterps] = useState<Interpretation[] | null>(null);
  const [cands, setCands] = useState<RenderedWord[] | null>(null);
  const [selectedCand, setSelectedCand] = useState<RenderedWord | null>(null);
  const [hanziWords, setHanziWords] = useState<HanziRes | null>(null);
  const [forcedTranslate, setForcedTranslate] = useState(false);
  const [savedNow, setSavedNow] = useState<Set<string>>(new Set());
  const [ocrResult, setOcrResult] = useState<OcrRes | null>(null);
  const [photo, setPhoto] = useState<{ url: string; w: number; h: number } | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [spokenText, setSpokenText] = useState<string | null>(null);
  const [spokenConfidence, setSpokenConfidence] = useState<number | null>(null);
  const [sttResult, setSttResult] = useState<import("../../shared/api").SttRes | null>(null);
  const recognizer = useRef<BrowserRecognizer | null>(null);
  const micRec = useRef<MicRecorder | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [askVariety, setAskVariety] = useState<"zh-Hant" | "zh-HK">(
    (me?.primaryVariety as "zh-Hant" | "zh-HK") ?? "zh-Hant",
  );
  const multiVariety = (me?.varieties.length ?? 1) > 1;

  useEffect(() => {
    setAskVariety((cur) => (me?.varieties.includes(cur) ? cur : ((me?.primaryVariety as "zh-Hant" | "zh-HK") ?? "zh-Hant")));
  }, [me]);

  const anythingActive =
    Boolean(translateCard || interps || cands || hanziWords || ocrResult || sttResult || listening || spokenText || ocrBusy);

  function reset(): void {
    setError(null);
    setTranslateCard(null);
    setInterps(null);
    setCands(null);
    setSelectedCand(null);
    setHanziWords(null);
    setForcedTranslate(false);
    setOcrResult(null);
    if (photo) URL.revokeObjectURL(photo.url);
    setPhoto(null);
    setSavedNow(new Set());
    setInterim("");
    setSpokenText(null);
    setSpokenConfidence(null);
    setSttResult(null);
    setListening(false);
  }

  async function runTranslate(t: string): Promise<void> {
    setBusy("translate");
    try {
      setTranslateCard(await api.translate(t, me?.audience ?? undefined, askVariety));
    } catch (e) {
      setError(e instanceof ApiError ? `Translation failed: ${e.message}` : "Translation failed");
    } finally {
      setBusy(null);
    }
  }

  /** English function/content words that can NEVER be pinyin input — their
   *  presence means translate, don't waste the ask on dictionary guesswork
   *  ("time to eat" used to match 䶑嚜哦餓啊 via fuzzy pinyin). Vetted: every
   *  token here is an invalid pinyin syllable, so real pinyin input never trips it. */
  const ENGLISH_HINT =
    /\b(the|to|is|are|am|was|be|been|for|of|on|in|at|it|its|this|that|these|those|and|or|but|not|don'?t|doesn'?t|can|will|would|should|could|please|thanks?|hello|hi|goodbye|want|needs?|likes?|time|eat|sleep|school|bath|water|milk|home|now|here|there|what|where|why|how|who|when|let'?s)\b/i;

  async function submit(): Promise<void> {
    const t = text.trim();
    if (!t || busy) return;
    reset();
    const han = hasHan(t);
    const latin = /[A-Za-z]{2,}/.test(t);
    if (han && !latin) {
      setBusy("lookup");
      try {
        setHanziWords(await api.hanzi(t));
      } catch {
        setError("Lookup failed");
      } finally {
        setBusy(null);
      }
      return;
    }
    if (!han && ENGLISH_HINT.test(t)) {
      // English words present → intent-first translation, skip dictionary guesswork
      await runTranslate(t);
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

  async function submitSpoken(t: string): Promise<void> {
    setError(null);
    const han = hasHan(t);
    const latin = /[A-Za-z]{2,}/.test(t);
    if (han && !latin) {
      setBusy("lookup");
      try {
        setHanziWords(await api.hanzi(t));
      } catch {
        setError("Lookup failed");
      } finally {
        setBusy(null);
      }
      return;
    }
    await runTranslate(t);
  }

  async function onFile(file: File | null): Promise<void> {
    if (!file || ocrBusy) return;
    reset();
    setOcrBusy(true);
    try {
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      const { blob, w, h } = isPdf ? { blob: file, w: 1000, h: 1414 } : await downscale(file);
      setPhoto({ url: isPdf ? "pdf" : URL.createObjectURL(blob), w, h });
      const res = await api.ocr(blob);
      const url = isPdf ? "pdf" : (photo?.url ?? "");
      if (isPdf) {
        // history-viewer supplies real URLs; for fresh asks use objectURL-less pdf placeholder via detail fetch
        const list = await api.entries("mine", "").catch(() => []);
        void list;
        // fetch latest history detail to get the server-side photo URL
        const hist = await api.history();
        const item = hist.find((i) => i.kind === "ocr" && i.hasPhoto);
        if (item) {
          const detail = await api.historyDetail(item.id);
          setPhoto({ url: detail.photoUrl ?? "", w: detail.photoW || w, h: detail.photoH || h });
        } else {
          setPhoto({ url: "", w, h });
        }
      } else {
        void url;
        void photo;
      }
      setOcrResult(res);
    } catch (e) {
      setError(e instanceof ApiError ? `OCR failed: ${e.message}` : "OCR failed");
    } finally {
      setOcrBusy(false);
    }
  }

  async function toggleMic(): Promise<void> {
    setError(null);
    if (listening) {
      setListening(false);
      if (micRec.current?.active) {
        try {
          const blob = await micRec.current.stop();
          setOcrBusy(false);
          setBusy("translate");
          try {
            setSttResult(await api.stt(blob));
          } catch (e) {
            setError(e instanceof ApiError ? e.message : "Transcription failed");
          } finally {
            setBusy(null);
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : "Transcription failed");
        }
        return;
      }
      recognizer.current?.stop();
      return;
    }
    reset();
    if (sttServerMode()) {
      const rec = new MicRecorder();
      micRec.current = rec;
      const ok = await rec.start((m) => setError(m));
      if (!ok) return;
      setListening(true);
      return;
    }
    if (!browserSttSupported()) {
      setError("Speech recognition is not supported in this browser");
      return;
    }
    const r = new BrowserRecognizer();
    recognizer.current = r;
    setListening(true);
    setSpokenConfidence(null);
    r.startAuto(
      (t) => setInterim(t),
      (finalText, confidence) => {
        setListening(false);
        setInterim("");
        setSpokenConfidence(confidence ?? null);
        if (!finalText) return;
        setSpokenText(finalText);
        setText(finalText);
        void submitSpoken(finalText);
      },
      (m) => {
        setListening(false);
        setError(m);
      },
      (lang) => void lang,
      askVariety === "zh-HK" ? "zh-HK" : "zh-TW",
    );
  }

  return (
    <div className="space-y-4 pb-2">
      {/* unified input bar: textarea full-width, actions on their own row */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="rounded-2xl border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-2 shadow-sm"
      >
        <div className="relative">
          <textarea
            ref={taRef}
            value={listening ? interim || "" : text}
            readOnly={listening}
            rows={2}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
          }}
          placeholder={listening ? "listening… speak now" : "English, rough pinyin, or 中文…"}
          autoCapitalize="none"
          autoCorrect="off"
          enterKeyHint="send"
            className="max-h-40 w-full resize-none rounded-xl bg-transparent px-2 py-2 outline-none"
          />
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          {multiVariety && (
            <div className="flex overflow-hidden rounded-full border border-neutral-300 dark:border-neutral-700" role="group" aria-label="Ask variety">
              {([["zh-Hant", "國"], ["zh-HK", "粵"]] as const).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setAskVariety(v)}
                  className={`h-11 px-3 text-sm font-semibold transition ${
                    askVariety === v
                      ? v === "zh-HK"
                        ? "bg-sky-500 text-white"
                        : "bg-amber-500 text-white"
                      : "bg-transparent text-neutral-500 dark:text-neutral-400"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            aria-label="Speak"
            onClick={() => void toggleMic()}
            className={`flex h-11 w-11 items-center justify-center rounded-full transition ${
              listening ? "bg-red-500 text-white" : "bg-neutral-100 dark:bg-neutral-800"
            }`}
          >
            <IconMic className="h-5 w-5" />
          </button>
          <label
            aria-label="Attach"
            className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800"
          >
            <IconCamera className="h-5 w-5" />
            <input
              type="file"
              accept="image/*,.pdf,application/pdf"
              className="hidden"
              onChange={(e) => {
                void onFile(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
            />
          </label>
          <button
            type="submit"
            disabled={!text.trim() || busy !== null}
            aria-label="Send"
            className="ml-auto flex h-11 w-11 items-center justify-center rounded-full bg-amber-500 text-white shadow disabled:opacity-40 active:scale-95 transition"
          >
            <IconSend className="h-5 w-5" />
          </button>
        </div>
      </form>
      {anythingActive && (
        <div className="flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-widest text-neutral-400">result</span>
          <button
            aria-label="Clear result"
            onClick={() => {
              reset();
              setText("");
            }}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800"
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>
      )}


      {ocrBusy && <div className="animate-pulse text-sm text-neutral-400">Reading the page…</div>}
      {busy === "lookup" && <div className="animate-pulse text-sm text-neutral-400">Looking up…</div>}
      {busy === "translate" && <div className="animate-pulse text-sm text-neutral-400">Translating…</div>}
      {error && <div className="rounded-xl bg-red-50 dark:bg-red-950/50 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</div>}

      {photo && ocrResult && photo.url && <OcrView ocrResult={ocrResult} photoUrl={photo.url} w={photo.w} h={photo.h} />}
      {photo && ocrResult && !photo.url && (
        <div className="rounded-xl bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-500">{ocrResult.pageCount ?? 1} page(s) processed — open from History for the overlay view</div>
      )}

      {spokenText && (
        <div className="text-xs text-neutral-400">
          <span className="uppercase tracking-wide">heard: “{spokenText}”</span>
          {spokenConfidence !== null && spokenConfidence < 0.7 && (
            <span className="ml-2 text-amber-600 dark:text-amber-400">low confidence — maybe retry &amp; enunciate</span>
          )}
        </div>
      )}

      {translateCard && <ResultCard card={translateCard} />}

      {hanziWords && (
        <div className="space-y-3">
          {hanziWords.fullTranslation && (
            <FullTranslationCard text={hanziWords.text} english={hanziWords.fullTranslation} words={hanziWords.words} source="hanzi" />
          )}
          {hanziWords.phrase && <PhraseCard phrase={hanziWords.phrase} words={hanziWords.words} source="hanzi" />}
          {hanziWords.phrase && <div className="text-xs uppercase tracking-wide text-neutral-400">words</div>}
          {hanziWords.words.map((w, i) => (
            <HanziWordCard key={i} word={w} />
          ))}
        </div>
      )}

      {sttResult && (
        <div className="space-y-3">
          <div className="text-xs uppercase tracking-wide text-neutral-400">heard: “{sttResult.text}”</div>
          {sttResult.route === "hanzi" && sttResult.hanzi?.fullTranslation && (
            <FullTranslationCard text={sttResult.hanzi.text} english={sttResult.hanzi.fullTranslation} words={sttResult.hanzi.words} source="stt" />
          )}
          {sttResult.route === "hanzi" && sttResult.hanzi?.phrase && (
            <PhraseCard phrase={sttResult.hanzi.phrase} words={sttResult.hanzi.words} source="stt" />
          )}
          {sttResult.route === "hanzi" &&
            sttResult.hanzi?.words.map((w, i) => (
              <HanziWordCard key={i} word={w} onSaved={(t) => setSavedNow((sv) => new Set(sv).add(t))} />
            ))}
          {sttResult.route === "translate" && sttResult.translate && <ResultCard card={sttResult.translate} />}
          {sttResult.route === "text" && <p className="text-sm text-neutral-400">transcript only — no translation available</p>}
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
    </div>
  );
}
