import { useState } from "react";
import type { EntrySource, HanziPhrase, Interpretation, RenderedWord, Syllables } from "../../shared/api";
import { stripToneMarks } from "../../shared/bpmf";
import { wordChars } from "../../shared/fuzzy";
import { api } from "../api";
import { useAnnotations } from "../state";
import { speak } from "../tts";
import { AnnotatedText } from "./AnnotatedText";
import { IconCheck, IconPlay } from "./Icons";
import { useToast } from "./Toast";

function useSaver(
  source: EntrySource,
  onSaved?: (traditional: string) => void,
): { saved: boolean; save: (w: RenderedWord, syllables: Syllables, register?: "casual" | "formal") => Promise<void> } {
  const show = useToast().show;
  const [saved, setSaved] = useState(false);
  async function save(w: RenderedWord, syllables: Syllables, register: "casual" | "formal" = "casual"): Promise<void> {
    try {
      const res = await api.createEntry({
        traditional: w.traditional,
        simplified: w.simplified,
        pinyin: w.pinyin,
        pinyinFlat: stripToneMarks(w.pinyin).replace(/\s+/g, ""),
        bpmf: w.bpmf,
        jyutping: "",
        formalZh: "",
        formalJyut: "",
        english: w.english.split(" / ")[0] ?? w.english,
        register,
        source,
        syllables,
        variety: "zh-Hant",
      });
      setSaved(true);
      onSaved?.(w.traditional);
      show(res.duplicate ? "Already saved" : "Saved");
    } catch {
      show("Save failed");
    }
  }
  return { saved, save };
}

function ActionRow({
  text,
  saved,
  onSave,
}: {
  text: string;
  saved: boolean;
  onSave: () => void;
}) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <button
        aria-label="Play audio"
        onClick={() => speak(text)}
        className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800 active:scale-95 transition"
      >
        <IconPlay className="h-4 w-5" />
      </button>
      <button
        aria-label="Play slowly"
        onClick={() => speak(text, { slow: true })}
        className="flex h-10 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800 px-3 text-xs font-semibold text-neutral-500 active:scale-95 transition"
      >
        0.6×
      </button>
      <button
        onClick={onSave}
        disabled={saved}
        className={`ml-auto flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-semibold active:scale-95 transition ${
          saved
            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300"
            : "bg-amber-500 text-white shadow"
        }`}
      >
        {saved ? <IconCheck className="h-4 w-4" /> : null}
        {saved ? "Saved" : "Save"}
      </button>
    </div>
  );
}

/** Full phrase interpretation from garbled pinyin. */
export function InterpretationCard({ interp, rank }: { interp: Interpretation; rank: number }) {
  const annotations = useAnnotations();
  const { saved, save } = useSaver("pinyin");
  const syllables: Syllables = interp.words.map(wordChars);

  return (
    <div data-traditional={interp.traditional} className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-neutral-400">
          {interp.exactEntry ? "dictionary match" : rank > 1 ? `guess ${rank}` : "best guess"}
        </div>
      </div>
      <AnnotatedText syllables={syllables} annotations={annotations} />
      <p className="text-[15px] text-neutral-700 dark:text-neutral-300">{interp.english}</p>
      <div className="space-y-1 border-t border-neutral-100 dark:border-neutral-800 pt-2">
        {interp.words.map((w, i) => (
          <div key={i} className="flex items-baseline gap-2 text-sm">
            <span className="hanzi min-w-10">{w.traditional}</span>
            <span className="text-sky-700 dark:text-sky-400 text-xs">{w.pinyin}</span>
            <span className="text-neutral-500 dark:text-neutral-400 truncate">{w.english.split(" / ")[0]}</span>
          </div>
        ))}
      </div>
      <ActionRow text={interp.traditional} saved={saved} onSave={() => void save(interp, syllables)} />
    </div>
  );
}

/** Expanded "might match" candidate. */
export function CandidateCard({ word }: { word: RenderedWord }) {
  const annotations = useAnnotations();
  const { saved, save } = useSaver("pinyin");
  const syllables: Syllables = [wordChars(word)];
  return (
    <div className="rounded-2xl border border-dashed border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-4 shadow-sm space-y-3">
      <div className="text-xs uppercase tracking-wide text-neutral-400">might match</div>
      <AnnotatedText syllables={syllables} annotations={annotations} />
      <p className="text-[15px] text-neutral-700 dark:text-neutral-300">{word.english.split(" / ").slice(0, 3).join("; ")}</p>
      <ActionRow text={word.traditional} saved={saved} onSave={() => void save(word, syllables)} />
    </div>
  );
}

/** Inline follow-up Q&A about the card above it. */
export function FollowUpBox({ hanzi, gloss, askId, variety = "zh-Hant" }: { hanzi?: string; gloss?: string; askId?: string; variety?: "zh-Hant" | "zh-HK" }): React.JSX.Element {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<{ answer: string; answerWritten?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask(): Promise<void> {
    if (!q.trim() || busy) return;
    setBusy(true);
    try {
      const res = await api.followUp({ question: q.trim(), hanzi, gloss, ...(askId ? { askId } : {}), variety });
      setAnswer({ answer: res.answer, answerWritten: res.answerWritten });
      setQ("");
    } catch {
      setAnswer({ answer: "Couldn't answer that — try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      {answer && (
        <div className="rounded-xl bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-300 space-y-1.5">
          {variety === "zh-HK" ? (
            <>
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 rounded bg-sky-100 dark:bg-sky-900/60 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">口語</span>
                <p className="min-w-0 flex-1" lang="zh-HK">{answer.answer}</p>
                <button aria-label="Play spoken answer" onClick={() => speak(answer.answer, { variety: "zh-HK" })} className="mt-0.5 shrink-0 text-neutral-400 active:text-neutral-600">▶</button>
              </div>
              {answer.answerWritten && (
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0 rounded bg-neutral-200 dark:bg-neutral-700 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600 dark:text-neutral-300">書面</span>
                  <p className="min-w-0 flex-1">{answer.answerWritten}</p>
                  <button aria-label="Play written answer" onClick={() => speak(answer.answerWritten ?? "", { variety: "zh-HK" })} className="mt-0.5 shrink-0 text-neutral-400 active:text-neutral-600">▶</button>
                </div>
              )}
            </>
          ) : (
            <p>{answer.answer}</p>
          )}
        </div>
      )}
      <div className="flex gap-1.5">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void ask()}
          placeholder={variety === "zh-HK" ? "問多啲… (ask more)" : "ask more…"}
          className="min-w-0 flex-1 rounded-full border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm outline-none focus:border-amber-500"
        />
        <button
          onClick={() => void ask()}
          disabled={!q.trim() || busy}
          className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-3 text-xs font-semibold text-neutral-500 disabled:opacity-40"
        >
          {busy ? "…" : "ask"}
        </button>
      </div>
    </div>
  );
}

/** Whole-utterance card for multi-word hanzi (spoken phrases, pasted text). */
export function PhraseCard({
  phrase,
  words,
  source,
}: {
  phrase: HanziPhrase;
  words: RenderedWord[];
  source: EntrySource;
}): React.JSX.Element {
  const annotations = useAnnotations();
  const { saved, save } = useSaver(source);
  const syllables: Syllables = [words.flatMap(wordChars)];
  const asWord: RenderedWord = {
    traditional: phrase.traditional,
    simplified: phrase.simplified,
    pinyin: phrase.pinyin,
    bpmf: phrase.bpmf,
    english: phrase.english,
  };
  return (
    <div data-traditional={phrase.traditional} className="rounded-2xl border-2 border-amber-300 dark:border-amber-800 bg-white dark:bg-neutral-900 p-4 shadow-sm space-y-3">
      <div className="text-xs uppercase tracking-wide text-amber-600 dark:text-amber-400">{phrase.answer ? "answer" : "whole phrase"}</div>
      <AnnotatedText syllables={syllables} annotations={annotations} />
      <p className="text-[15px] text-neutral-700 dark:text-neutral-300">{phrase.english}</p>
      <ActionRow text={phrase.traditional} saved={saved} onSave={() => void save(asWord, syllables)} />
    </div>
  );
}

/** Hanzi-input / OCR word card. */
export function HanziWordCard({ word, onSaved }: { word: RenderedWord & { known: boolean }; onSaved?: (t: string) => void }) {
  const annotations = useAnnotations();
  const { saved, save } = useSaver("hanzi", onSaved);
  const syllables: Syllables = [wordChars(word)];
  return (
    <div data-traditional={word.traditional} className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 shadow-sm space-y-3">
      <div className="text-xs uppercase tracking-wide text-neutral-400">{word.known ? "word" : "not in dictionary"}</div>
      <AnnotatedText syllables={syllables} annotations={annotations} />
      <p className="text-[15px] text-neutral-700 dark:text-neutral-300">
        {word.known ? word.english.split(" / ").slice(0, 3).join("; ") : "—"}
      </p>
      {word.known && <ActionRow text={word.traditional} saved={saved} onSave={() => void save(word, syllables)} />}
    </div>
  );
}
