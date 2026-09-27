import type { HanziRes, Interpretation, OcrRes, RenderedWord, TranslateRes } from "../../shared/api";
import { useRef, useState } from "react";
import { api, ApiError } from "../api";
import { CandidateCard, HanziWordCard, InterpretationCard, PhraseCard } from "../components/Cards";
import { PhotoPage } from "../components/PhotoPage";
import { ResultCard } from "../components/ResultCard";
import { Segmented } from "../components/Segmented";
import { IconCamera, IconClose, IconKeyboard, IconMic, IconSend } from "../components/Icons";
import { useMe } from "../state";
import { BrowserRecognizer, MicRecorder, browserSttSupported, sttServerMode } from "../stt";
import type { SttRes } from "../../shared/api";

type Mode = "type" | "speak" | "photo";

const hasHan = (s: string): boolean => /\p{Script=Han}/u.test(s);

/**
 * Canonical upload geometry: height EXACTLY 1000px (width by aspect, capped
 * 1600, never >2.5× upscale). The vision model's Y coordinates use a 1000-grid
 * internally, so at this size normalized-Y and absolute-Y coincide and the
 * overlay aligns by construction. Server-side heuristics remain as backstop.
 */
async function downscale(file: File): Promise<{ blob: Blob; w: number; h: number }> {
  const getBitmap = () => createImageBitmap(file).catch(() => null);
  let bmp = await getBitmap();
  if (!bmp) {
    // bitmap decode failed: fall back to <img> for dimensions, send original
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
  const [mode, setMode] = useState<Mode>("type");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<null | "lookup" | "translate">(null);
  const [error, setError] = useState<string | null>(null);
  const [translateCard, setTranslateCard] = useState<TranslateRes | null>(null);
  const [interps, setInterps] = useState<Interpretation[] | null>(null);
  const [cands, setCands] = useState<RenderedWord[] | null>(null);
  const [selectedCand, setSelectedCand] = useState<RenderedWord | null>(null);
  const [hanziWords, setHanziWords] = useState<HanziRes | null>(null);
  const [forcedTranslate, setForcedTranslate] = useState(false);
  const [ocrResult, setOcrResult] = useState<OcrRes | null>(null);
  const [savedNow, setSavedNow] = useState<Set<string>>(new Set());
  const [ocrBusy, setOcrBusy] = useState(false);
  const [photo, setPhoto] = useState<{ url: string; w: number; h: number } | null>(null);
  const [sttLang, setSttLang] = useState<"auto">("auto"); // detected language display
  const [listening, setListening] = useState(false);
  const [detectedLang, setDetectedLang] = useState<string>("");
  const [interim, setInterim] = useState("");
  const [spokenText, setSpokenText] = useState<string | null>(null);
  const [spokenConfidence, setSpokenConfidence] = useState<number | null>(null);
  const [sttBusy, setSttBusy] = useState(false);
  const [sttResult, setSttResult] = useState<SttRes | null>(null);
  const recognizer = useRef<BrowserRecognizer | null>(null);
  const micRec = useRef<MicRecorder | null>(null);

  function reset(): void {
    setError(null);
    setTranslateCard(null);
    setInterps(null);
    setCands(null);
    setSelectedCand(null);
    setHanziWords(null);
    setForcedTranslate(false);
    setOcrResult(null);
    setSavedNow(new Set());
    if (photo) URL.revokeObjectURL(photo.url);
    setPhoto(null);
    setInterim("");
    setSpokenText(null);
    setSttResult(null);
    setListening(false);
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
        setHanziWords(await api.hanzi(t));
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

  async function handleSttRes(res: SttRes): Promise<void> {
    setSttResult(res);
    if (res.route === "text") return;
    // nothing else: response already carries the routed payload
  }

  async function toggleMic(): Promise<void> {
    setError(null);
    if (listening) {
      setListening(false);
      if (micRec.current?.active) {
        try {
          const blob = await micRec.current.stop();
          setSttBusy(true);
          await handleSttRes(await api.stt(blob));
        } catch (e) {
          setError(e instanceof ApiError ? e.message : "Transcription failed");
        } finally {
          setSttBusy(false);
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
      if (ok) setListening(true);
      return;
    }
    if (!browserSttSupported()) {
      setError("Speech recognition is not supported in this browser");
      return;
    }
    const r = new BrowserRecognizer();
    recognizer.current = r;
    setListening(true);
    setDetectedLang("");
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
      (lang) => setDetectedLang(lang),
    );
  }

  async function submitSpoken(t: string): Promise<void> {
    setError(null);
    const han = /\p{Script=Han}/u.test(t);
    const latin = /[A-Za-z]{2,}/.test(t);
    // mixed scripts (e.g. "what is 吃飯?") go to the translator — it handles
    // meta-questions and mixed language; pure hanzi goes to the word pipeline
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

  return (
    <div className="space-y-4">
      <Segmented<Mode>
        className="w-full [&>button]:flex-1 flex"
        value={mode}
        onChange={setMode}
        options={[
          { value: "type", label: <span className="flex items-center justify-center gap-1.5"><IconKeyboard className="h-4 w-4" /> Type</span> },
          { value: "speak", label: <span className="flex items-center justify-center gap-1.5"><IconMic className="h-4 w-4" /> Speak</span> },
          { value: "photo", label: <span className="flex items-center justify-center gap-1.5"><IconCamera className="h-4 w-4" /> Photo</span> },
        ]}
      />


      {mode === "speak" && (
        <div className="space-y-4">
          <div className="flex flex-col items-center gap-3 py-6">
            <button
              aria-label={listening ? "Stop" : "Record"}
              onClick={() => void toggleMic()}
              className={`flex h-24 w-24 items-center justify-center rounded-full text-white shadow-lg transition ${
                listening ? "bg-red-500 scale-105 animate-pulse" : "bg-amber-500 active:scale-95"
              }`}
            >
              <IconMic className="h-10 w-10" />
            </button>
            <p className="text-sm text-neutral-400">
              {sttBusy
                ? "Transcribing…"
                : listening
                  ? `listening${detectedLang ? ` (${detectedLang === "zh-TW" ? "中文" : "English"})` : ""}… tap to stop`
                  : sttServerMode()
                    ? "tap to record — any language"
                    : browserSttSupported()
                      ? "tap and speak — language is detected automatically"
                      : "not supported in this browser"}
            </p>
            {interim && <p className="hanzi text-lg">{interim}</p>}
          </div>
          {sttResult && (
            <div className="space-y-3">
              <div className="text-xs uppercase tracking-wide text-neutral-400">heard: “{sttResult.text}”</div>
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
        </div>
      )}

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
          {ocrResult && photo && (
            <PhotoPage photoUrl={photo.url} w={photo.w} h={photo.h} ocrResult={ocrResult} />
          )}
          {ocrResult && !photo && (
            <div className="flex flex-wrap gap-2">
              {ocrResult.lines.flatMap((line, li) =>
                line.words.map((w, wi) => (
                  <HanziWordCard key={`${li}-${wi}`} word={w} onSaved={(t) => setSavedNow((s2) => new Set(s2).add(t))} />
                )),
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
        </>
      )}

      {/* results render for every mode (speak routes here too) */}
      {spokenText && mode === "speak" && (
        <div className="text-xs text-neutral-400">
          <span className="uppercase tracking-wide">heard: “{spokenText}”</span>
          {spokenConfidence !== null && spokenConfidence < 0.7 && (
            <span className="ml-2 text-amber-600 dark:text-amber-400">low confidence — maybe retry &amp; enunciate</span>
          )}
        </div>
      )}
      {busy === "lookup" && <div className="animate-pulse text-sm text-neutral-400">Looking up…</div>}
      {busy === "translate" && <div className="animate-pulse text-sm text-neutral-400">Translating…</div>}
      {error && <div className="rounded-xl bg-red-50 dark:bg-red-950/50 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</div>}

      {translateCard && <ResultCard card={translateCard} />}

      {hanziWords && (
        <div className="space-y-3">
          {hanziWords.phrase && <PhraseCard phrase={hanziWords.phrase} words={hanziWords.words} source="hanzi" />}
          {hanziWords.phrase && <div className="text-xs uppercase tracking-wide text-neutral-400">words</div>}
          {hanziWords.words.map((w, i) => (
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
    </div>
  );
}
