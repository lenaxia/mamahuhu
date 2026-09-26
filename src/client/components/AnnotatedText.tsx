import type { Annotations, Syllables } from "../../shared/api";

const SPOKEN_TONES = new Set(["ˊ", "ˇ", "ˋ"]);

/**
 * Zhuyin beside a character, Taiwan textbook layout: initial/medial/final
 * stacked VERTICALLY, spoken-tone mark (ˊˇˋ) to the RIGHT of the column,
 * neutral-tone dot (˙) at the TOP of the column.
 */
export function BpmfColumn({ bpmf, cls }: { bpmf: string; cls: string }) {
  const chars = [...bpmf];
  const dot = chars[0] === "˙" ? chars.shift() : undefined;
  const tone = SPOKEN_TONES.has(chars[chars.length - 1] ?? "") ? chars.pop() : undefined;
  const symbols = (dot ? [dot, ...chars] : chars).join("");
  return (
    <span className={`hanzi inline-flex items-start ${cls}`} aria-label={bpmf}>
      <span className="bpmf-col">{symbols}</span>
      {tone && <span className="bpmf-tone">{tone}</span>}
    </span>
  );
}

/**
 * The annotation renderer: bopomofo stacked VERTICALLY to the right of each
 * character (Taiwan textbook style), pinyin BELOW, per the user's remembered
 * preference. Words wrap as units; a char and its annotations never split.
 */
export function AnnotatedText({
  syllables,
  annotations,
  size = "lg",
  className = "",
}: {
  syllables: Syllables;
  annotations: Annotations;
  size?: "lg" | "sm";
  className?: string;
}) {
  const showBpmf = annotations === "both" || annotations === "bpmf";
  const showPy = annotations === "both" || annotations === "pinyin";
  const hanziCls = size === "lg" ? "text-[2rem] leading-[1.15]" : "text-[1.35rem] leading-[1.15]";
  const bpmfCls = size === "lg" ? "text-[0.58rem]" : "text-[0.48rem]";
  const pyCls = size === "lg" ? "text-[0.7rem]" : "text-[0.6rem]";

  return (
    <span lang="zh-Hant" className={`inline-flex flex-wrap items-start gap-x-[0.4em] gap-y-1 max-w-full ${className}`}>
      {syllables.map((word, wi) => (
        <span key={wi} className="inline-flex">
          {word.map((c, ci) => (
            <span key={ci} className="inline-flex flex-col items-center">
              <span className="inline-flex items-start">
                <span className={`hanzi ${hanziCls}`}>{c.h}</span>
                {showBpmf && c.bpmf && <BpmfColumn bpmf={c.bpmf} cls={`${bpmfCls} ml-[0.15em] mt-[0.2em] text-amber-600 dark:text-amber-400`} />}
              </span>
              {showPy && (
                <span className={`text-sky-700 dark:text-sky-400 ${pyCls} mt-0.5 whitespace-nowrap tabular-nums`}>{c.py}</span>
              )}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}
