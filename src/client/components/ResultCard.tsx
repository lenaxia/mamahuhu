import { useState } from "react";
import type { CardVariant, Register, Syllables, TranslateRes } from "../../shared/api";
import { stripToneMarks } from "../../shared/bpmf";
import { api } from "../api";
import { useAnnotations } from "../state";
import { speak } from "../tts";
import { AnnotatedText } from "./AnnotatedText";
import { Segmented } from "./Segmented";
import { IconCheck, IconPlay } from "./Icons";
import { useToast } from "./Toast";

interface Sense {
  casual: { variant: CardVariant; syllables: Syllables };
  formal: { variant: CardVariant; syllables: Syllables };
}

/** Result card for EN→ZH translation — sense chips, register chips (on every sense), play, save. */
export function ResultCard({ card }: { card: TranslateRes }) {
  const annotations = useAnnotations();
  const show = useToast().show;
  const [register, setRegister] = useState<Register>(card.register);
  const [altIdx, setAltIdx] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);

  const primary: Sense = {
    casual: { variant: card.casual!, syllables: card.syllables },
    formal: { variant: card.formal ?? card.casual!, syllables: card.formalSyllables ?? card.syllables },
  };
  const sense: Sense = altIdx === null ? primary : card.alternatives![altIdx]!;
  const selected = (register === "formal" ? sense.formal : sense.casual) ?? sense.casual;
  const { variant, syllables } = selected;

  async function save(): Promise<void> {
    try {
      const res = await api.createEntry({
        traditional: variant.traditional,
        simplified: variant.simplified,
        pinyin: variant.pinyin,
        pinyinFlat: stripToneMarks(variant.pinyin).replace(/\s+/g, ""),
        bpmf: variant.bpmf,
        english: variant.gloss,
        register,
        source: "en-translate",
        syllables,
      });
      setSaved(true);
      show(res.duplicate ? "Already saved" : "Saved");
    } catch {
      show("Save failed");
    }
  }

  return (
    <div data-traditional={variant.traditional} className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 shadow-sm space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-neutral-400">“{card.source}”</div>
          {card.lowConfidence && (
            <div className="text-[11px] text-amber-600 dark:text-amber-400">check annotations</div>
          )}
        </div>
        {sense.formal && (
          <Segmented<Register>
            size="sm"
            value={register}
            onChange={setRegister}
            options={[
              { value: "casual", label: "casual" },
              { value: "formal", label: "formal" },
            ]}
          />
        )}
      </div>

      <AnnotatedText syllables={syllables} annotations={annotations} />

      <p className="text-[15px] text-neutral-700 dark:text-neutral-300">{variant.gloss}</p>
      {variant.note && <p className="text-xs text-neutral-400">{variant.note}</p>}

      {card.alternatives && card.alternatives.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-neutral-400">senses</span>
          <button
            onClick={() => setAltIdx(null)}
            className={`hanzi rounded-full border px-3 py-1 text-base transition ${
              altIdx === null
                ? "border-amber-500 bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300"
                : "border-neutral-300 dark:border-neutral-700"
            }`}
          >
            {(register === "formal" ? primary.formal.variant.traditional : primary.casual.variant.traditional) ?? primary.casual.variant.traditional}
          </button>
          {card.alternatives.map((a, i) => (
            <button
              key={a.casual.variant.traditional}
              onClick={() => setAltIdx(i)}
              className={`hanzi rounded-full border px-3 py-1 text-base transition ${
                altIdx === i
                  ? "border-amber-500 bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300"
                  : "border-neutral-300 dark:border-neutral-700"
              }`}
            >
              {(register === "formal" ? a.formal.variant.traditional : a.casual.variant.traditional) ?? a.casual.variant.traditional}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          aria-label="Play audio"
          onClick={() => speak(variant.traditional)}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800 active:scale-95 transition"
        >
          <IconPlay className="h-5 w-5" />
        </button>
        <button
          aria-label="Play slowly"
          onClick={() => speak(variant.traditional, { slow: true })}
          className="flex h-11 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800 px-3 text-xs font-semibold text-neutral-500 active:scale-95 transition"
        >
          0.6×
        </button>
        <button
          onClick={save}
          disabled={saved}
          className={`ml-auto flex h-11 items-center gap-1.5 rounded-full px-5 text-sm font-semibold active:scale-95 transition ${
            saved
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300"
              : "bg-amber-500 text-white shadow"
          }`}
        >
          {saved ? <IconCheck className="h-4 w-4" /> : null}
          {saved ? "Saved" : "Save"}
        </button>
      </div>
    </div>
  );
}
