/**
 * Cantonese jyutping annotation. Data is curated from words.hk 粵典數據
 * (public domain) + rime-cantonese (CC BY 4.0) via scripts/curate-canto.mjs.
 * LLM jyutping measured ~42% syllable error (bench/canto-report.md) —
 * annotations always come from these tables, never the model.
 */
import raw from "./canto-data.json";

export interface JyutPart {
  /** matched word (multi-char dictionary hit or single char) */
  word: string;
  /** syllables space-aligned with the word's chars; null when unknown */
  jyut: string | null;
}

interface CantoData {
  chars: Record<string, string[]>;
  words: Record<string, string>;
  freq: Record<string, number>;
}
const data = raw as unknown as CantoData;

const HAN = /[\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{2ffff}]/u;

/** Longest dictionary word starting at s (max 4 chars), frequency-ranked. */
function bestWord(s: string): string | null {
  for (let l = Math.min(4, [...s].length); l >= 2; l--) {
    const w = [...s].slice(0, l).join("");
    if (data.words[w]) return w;
  }
  return null;
}

/** Per-character best reading. */
export function jyutForChar(c: string): string | null {
  return data.chars[c]?.[0] ?? null;
}

/** Full reading of a known word, else null. */
export function jyutForWord(w: string): string | null {
  return data.words[w] ?? null;
}

/**
 * Segments Han text into dictionary words with jyutping; non-Han runs
 * (punctuation, latin, whitespace) pass through with jyut = null.
 */
export function segmentJyut(text: string): JyutPart[] {
  const parts: JyutPart[] = [];
  let buf = ""; // pending non-Han run
  const flush = () => {
    if (buf) {
      parts.push({ word: buf, jyut: null });
      buf = "";
    }
  };
  let s = text;
  while (s.length) {
    const c = s[0]!;
    if (!HAN.test(c)) {
      buf += c;
      s = s.slice(1);
      continue;
    }
    flush();
    const w = bestWord(s);
    if (w && data.words[w]) {
      parts.push({ word: w, jyut: data.words[w]! });
      s = s.slice(w.length);
    } else {
      parts.push({ word: c, jyut: jyutForChar(c) });
      s = s.slice(1);
    }
  }
  flush();
  return parts;
}

/** Space-joined jyutping for Han text only (punctuation dropped), "" if none. */
export function annotateJyut(text: string): string {
  return segmentJyut(text)
    .filter((p) => p.jyut)
    .map((p) => p.jyut)
    .join(" ");
}

/** Per-char readings aligned with [...text] (null where unknown/non-Han). */
export function jyutPerChar(text: string): (string | null)[] {
  const out: (string | null)[] = [];
  for (const p of segmentJyut(text)) {
    const chars = [...p.word];
    const sylls = p.jyut?.split(" ") ?? [];
    if (p.jyut && sylls.length === chars.length) {
      chars.forEach((_, i) => out.push(sylls[i] ?? null));
    } else {
      chars.forEach(() => out.push(null));
    }
  }
  return out;
}
