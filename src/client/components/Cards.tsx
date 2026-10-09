import { useState } from "react";
import type { EntrySource, HanziPhrase, Interpretation, RenderedWord, Syllables } from "../../shared/api";
import { stripToneMarks } from "../../shared/bpmf";
import { wordChars } from "../../shared/fuzzy";
import { api } from "../api";
import { useAnnotations } from "../state";
import { speak } from "../tts";
import { AnnotatedText } from "./AnnotatedText";
import { CopyButton } from "./CopyButton";
import { IconCheck, IconPlay } from "./Icons";
import { useToast } from "./Toast";

function useSaver(
  source: EntrySource,
  onSaved?: (traditional: string) => void,
  askId?: string,
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
        ...(askId ? { askId } : {}),
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
      <CopyButton text={text} />
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
          {interp.idiom ? "idiom" : interp.exactEntry ? "dictionary match" : rank > 1 ? `guess ${rank}` : "best guess"}
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

/** Dictionary-verified chengyu the translation model proposed (成語 card). */
export function ChengyuCard({ word }: { word: RenderedWord }) {
  const annotations = useAnnotations();
  const { saved, save } = useSaver("en-translate");
  const syllables: Syllables = [wordChars(word)];
  return (
    <div data-chengyu={word.traditional} className="rounded-2xl border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 p-4 shadow-sm space-y-3">
      <div className="text-xs uppercase tracking-widest text-amber-600 dark:text-amber-400">成語 · idiom</div>
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
  // this card's conversation, threaded into each ask so "this/it" resolves (capped server-side at 8)
  const [turns, setTurns] = useState<{ q: string; a: string }[]>([]);

  async function ask(): Promise<void> {
    if (!q.trim() || busy) return;
    setBusy(true);
    try {
      const res = await api.followUp({ question: q.trim(), hanzi, gloss, ...(askId ? { askId } : {}), variety, history: turns.slice(-6) });
      setAnswer({ answer: res.answer, answerWritten: res.answerWritten });
      setTurns((t) => [...t.slice(-7), { q: q.trim(), a: res.answer }]);
      setQ("");
    } catch {
      setAnswer({ answer: "Couldn't answer that — try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      {turns.length > 1 && (
        <details className="rounded-xl px-3 py-1.5 text-xs text-neutral-400 dark:text-neutral-500">
          <summary className="cursor-pointer select-none">{turns.length - 1} earlier answer{turns.length > 2 ? "s" : ""}</summary>
          <div className="mt-1 space-y-1.5">
            {turns.slice(0, -1).map((t, i) => (
              <div key={i} className="space-y-0.5">
                <p className="truncate">Q: {t.q}</p>
                <p className="line-clamp-2">A: {t.a}</p>
              </div>
            ))}
          </div>
        </details>
      )}
      {answer && (
        <div className="rounded-xl bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-300 space-y-1.5">
          {variety === "zh-HK" && answer.answerWritten ? (
            <>
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 rounded bg-sky-100 dark:bg-sky-900/60 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">口語</span>
                <p className="min-w-0 flex-1" lang="zh-HK">{answer.answer}</p>
                <span className="flex shrink-0 items-center gap-1"><button aria-label="Play spoken answer" onClick={() => speak(answer.answer, { variety: "zh-HK" })} className="text-neutral-400 active:text-neutral-600">▶</button><CopyButton text={answer.answer} className="h-7 w-7" /></span>
              </div>
              {answer.answerWritten && (
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0 rounded bg-neutral-200 dark:bg-neutral-700 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600 dark:text-neutral-300">書面</span>
                  <p className="min-w-0 flex-1">{answer.answerWritten}</p>
                  <span className="flex shrink-0 items-center gap-1"><button aria-label="Play written answer" onClick={() => speak(answer.answerWritten ?? "", { variety: "zh-HK" })} className="text-neutral-400 active:text-neutral-600">▶</button><CopyButton text={answer.answerWritten ?? ""} className="h-7 w-7" /></span>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1">{answer.answer}</p>
              <CopyButton text={answer.answer} className="h-8 w-8 shrink-0" />
            </div>
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

/** Complete-text card — THE unified element for Chinese input (typed, spoken,
 *  photo): full transcription (original line breaks intact) above the complete
 *  English translation. Identical rendering on every surface; photos add the
 *  overlay + tags above it and a words list below. */
export function FullTranslationCard({
  text,
  english,
  words,
  source,
  askId,
}: {
  text: string;
  english: string;
  words?: RenderedWord[];
  source: EntrySource;
  askId?: string;
}): React.JSX.Element {
  const { saved, save } = useSaver(source, undefined, askId);
  const asWord: RenderedWord = {
    traditional: text,
    simplified: text,
    pinyin: words?.map((w) => w.pinyin).filter(Boolean).join(" ") ?? "",
    bpmf: "",
    english,
  };
  const plainSyllables: Syllables = [[...text].filter(isHanChar).map((h) => ({ h, py: "", bpmf: "" }))];
  return (
    <div className="rounded-2xl border-2 border-sky-300 dark:border-sky-800 bg-white dark:bg-neutral-900 p-4 shadow-sm space-y-3">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wide text-neutral-400">full transcription</span>
          <span className="flex items-center gap-1">
            <CopyButton text={text} className="h-7 w-7" />
            <span
              role="button"
              aria-label="Play transcription"
              onClick={() => speak(text)}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800 text-xs"
            >▶</span>
          </span>
        </div>
        <p lang="zh-Hant" className="hanzi whitespace-pre-line rounded-xl bg-neutral-50 dark:bg-neutral-800/50 px-3 py-2 text-base leading-relaxed">{text}</p>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wide text-sky-600 dark:text-sky-400">full translation</span>
          <CopyButton text={english} className="h-7 w-7" />
        </div>
        <p className="whitespace-pre-line rounded-xl bg-sky-50 dark:bg-sky-950/40 px-3 py-2 text-[15px] leading-relaxed text-neutral-700 dark:text-neutral-200">{english}</p>
      </div>
      <ActionRow text={text} saved={saved} onSave={() => void save(asWord, plainSyllables)} />
    </div>
  );
}

function isHanChar(c: string): boolean {
  return /\p{Script=Han}/u.test(c);
}

/** Hanzi-input / OCR word card. */
export function HanziWordCard({ word, onSaved, askId }: { word: RenderedWord & { known: boolean }; onSaved?: (t: string) => void; askId?: string }) {
  const annotations = useAnnotations();
  const { saved, save } = useSaver("hanzi", onSaved, askId);
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
