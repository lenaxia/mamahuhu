import type { EntrySource, HanziRes, Interpretation, RenderedWord, TranslateRes } from "../../shared/api";
import { useState } from "react";
import { api, ApiError } from "../api";
import { CandidateCard, HanziWordCard, InterpretationCard } from "../components/Cards";
import { ResultCard } from "../components/ResultCard";
import { Segmented } from "../components/Segmented";
import { IconCamera, IconKeyboard, IconMic, IconSend } from "../components/Icons";
import { useMe } from "../state";

type Mode = "type" | "speak" | "photo";

const hasHan = (s: string): boolean => /\p{Script=Han}/u.test(s);

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

  function reset(): void {
    setError(null);
    setTranslateCard(null);
    setInterps(null);
    setCands(null);
    setSelectedCand(null);
    setHanziWords(null);
    setForcedTranslate(false);
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
          { value: "photo", label: <span className="flex items-center justify-center gap-1.5"><IconCamera className="h-4 w-4" /> Photo</span>, disabled: true },
        ]}
      />
      <p className="-mt-2 text-center text-[11px] text-neutral-400">Speak &amp; Photo arrive in Phase 2</p>

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
    </div>
  );
}
