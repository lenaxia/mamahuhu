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
