export interface DictWord {
  traditional: string;
  simplified: string;
  pyNum: string; // numbered, ü as "v": "bu4 zhi dao4"
  pyFlat: string; // toneless, no spaces: "buzhidao"
  english: string;
}

/** Toneless, spaceless pinyin key. */
export const flatOf = (pyNum: string): string => pyNum.replace(/[0-9\s]/g, "");

import { createRequire } from "node:module";

const req = createRequire(import.meta.url);

let simpToTradMap: Map<string, string> | null = null;

/** Character-level simplified→traditional map derived from CEDICT 1:1 pairs. */
export function simpToTrad(ch: string): string {
  if (!simpToTradMap) {
    simpToTradMap = new Map();
    const words = loadCedict();
    for (const w of words) {
      const s = [...w.simplified];
      const t = [...w.traditional];
      if (s.length === t.length) {
        for (let i = 0; i < s.length; i++) {
          if (s[i] !== t[i] && !simpToTradMap.has(s[i]!)) simpToTradMap.set(s[i]!, t[i]!);
        }
      }
    }
  }
  return simpToTradMap.get(ch) ?? ch;
}

/** Converts any Han string to its traditional form (char-level). */
export function toTraditional(text: string): string {
  return [...text].map((c) => simpToTrad(c)).join("");
}

/** Loads CC-CEDICT from the cedict-json package (bundled data, ~122k entries). */
export function loadCedict(): DictWord[] {
  const raw = req("cedict-json") as unknown;
  const arr = (Array.isArray(raw) ? raw : ((raw as { entries?: unknown[] }).entries ?? [])) as {
    traditional: string; simplified: string; pinyin: string; english: string[];
  }[];
  const out: DictWord[] = [];
  for (const e of arr) {
    const pyNum = e.pinyin.toLowerCase().replace(/u:/g, "v").replace(/ü/g, "v");
    const english = (e.english ?? []).join(" / ");
    if (!e.traditional || !pyNum) continue;
    out.push({
      traditional: e.traditional,
      simplified: e.simplified || e.traditional,
      pyNum,
      pyFlat: flatOf(pyNum),
      english: english.length > 400 ? english.slice(0, 400) + "…" : english,
    });
  }
  return out;
}
