/**
 * Pinyin ⇄ Bopomofo (zhuyin). Deterministic, dependency-free.
 * Input contract: numbered pinyin syllables — "zhong1", "bu4", "men5",
 * ü as "v", "ü" or "u:" (nv3 / nü3 / nu:3 all fine).
 */

const INITIALS: [string, string][] = [
  ["zh", "ㄓ"], ["ch", "ㄔ"], ["sh", "ㄕ"],
  ["b", "ㄅ"], ["p", "ㄆ"], ["m", "ㄇ"], ["f", "ㄈ"], ["d", "ㄉ"], ["t", "ㄊ"],
  ["n", "ㄋ"], ["l", "ㄌ"], ["g", "ㄍ"], ["k", "ㄎ"], ["h", "ㄏ"], ["j", "ㄐ"],
  ["q", "ㄑ"], ["x", "ㄒ"], ["r", "ㄖ"], ["z", "ㄗ"], ["c", "ㄘ"], ["s", "ㄙ"],
];

const FINALS: Record<string, string> = {
  a: "ㄚ", o: "ㄛ", e: "ㄜ", ai: "ㄞ", ei: "ㄟ", ao: "ㄠ", ou: "ㄡ",
  an: "ㄢ", en: "ㄣ", ang: "ㄤ", eng: "ㄥ", er: "ㄦ", "ê": "ㄝ",
  i: "ㄧ", ia: "ㄧㄚ", ie: "ㄧㄝ", iao: "ㄧㄠ", iu: "ㄧㄡ", ian: "ㄧㄢ",
  in: "ㄧㄣ", iang: "ㄧㄤ", ing: "ㄧㄥ",
  u: "ㄨ", ua: "ㄨㄚ", uo: "ㄨㄛ", uai: "ㄨㄞ", ui: "ㄨㄟ", uan: "ㄨㄢ",
  un: "ㄨㄣ", uang: "ㄨㄤ", ueng: "ㄨㄥ", ong: "ㄨㄥ",
  v: "ㄩ", ve: "ㄩㄝ", van: "ㄩㄢ", vn: "ㄩㄣ", iong: "ㄩㄥ",
};

const STANDALONE: Record<string, string> = {
  a: "ㄚ", o: "ㄛ", e: "ㄜ", ai: "ㄞ", ei: "ㄟ", ao: "ㄠ", ou: "ㄡ",
  an: "ㄢ", en: "ㄣ", ang: "ㄤ", eng: "ㄥ", er: "ㄦ", "ê": "ㄝ",
  yi: "ㄧ", ya: "ㄧㄚ", yo: "ㄧㄛ", ye: "ㄧㄝ", yai: "ㄧㄞ", yao: "ㄧㄠ",
  you: "ㄧㄡ", yan: "ㄧㄢ", yin: "ㄧㄣ", yang: "ㄧㄤ", ying: "ㄧㄥ", yong: "ㄩㄥ",
  wu: "ㄨ", wa: "ㄨㄚ", wo: "ㄨㄛ", wai: "ㄨㄞ", wei: "ㄨㄟ", wan: "ㄨㄢ",
  wen: "ㄨㄣ", wang: "ㄨㄤ", weng: "ㄨㄥ",
  yu: "ㄩ", yue: "ㄩㄝ", yuan: "ㄩㄢ", yun: "ㄩㄣ",
};

const TONE_SUFFIX = ["", "", "ˊ", "ˇ", "ˋ"]; // tone 1: unmarked; tone 5: prefix ˙

export interface ParsedSyllable {
  base: string; // toneless, ü canonicalized to "v"
  tone: number; // 1..5
}

export function parseNumbered(syl: string): ParsedSyllable {
  let s = syl.trim().toLowerCase().replace(/u:/g, "v").replace(/ü/g, "v");
  const m = s.match(/([1-5])$/);
  const tone = m ? Number(m[1]) : 1;
  if (m) s = s.slice(0, -1);
  return { base: s, tone };
}

/** "bu4" → "ㄅㄨˋ"; "men5" → "˙ㄇㄣ"; tone 1 unmarked. Returns "" if unconvertible. */
export function numberedToBpmf(syl: string): string {
  const { base, tone } = parseNumbered(syl);
  if (!base) return "";
  let out: string | undefined;
  if (STANDALONE[base]) {
    out = STANDALONE[base];
  } else {
    for (const [pin, bmf] of INITIALS) {
      if (base.startsWith(pin)) {
        let final = base.slice(pin.length);
        if ("jqx".includes(pin) && final.startsWith("u")) final = "v" + final.slice(1);
        if (["zh", "ch", "sh", "r", "z", "c", "s"].includes(pin) && final === "i") {
          out = bmf; // empty rime: 知=ㄓ, 吃=ㄔ, 日=ㄖ, 資=ㄗ
        } else {
          const fbmf = FINALS[final];
          if (fbmf) out = bmf + fbmf;
        }
        break;
      }
    }
    if (out === undefined && FINALS[base]) out = FINALS[base];
  }
  if (!out) return "";
  if (tone === 5) return "˙" + out;
  return out + TONE_SUFFIX[tone];
}

const MARKED: Record<string, string[]> = {
  a: ["ā", "á", "ǎ", "à"], e: ["ē", "é", "ě", "è"], i: ["ī", "í", "ǐ", "ì"],
  o: ["ō", "ó", "ǒ", "ò"], u: ["ū", "ú", "ǔ", "ù"], v: ["ǖ", "ǘ", "ǚ", "ǜ"],
};
export const UNMARK: Record<string, [string, number]> = {};
for (const [b, arr] of Object.entries(MARKED)) {
  arr.forEach((mk, i) => { UNMARK[mk] = [b, i + 1]; });
}

/** "zhong1" → "zhōng"; tone 5 and missing tone are unmarked. */
export function numberedToMarks(syl: string): string {
  const { base, tone } = parseNumbered(syl);
  if (!base) return syl;
  const idx = tone >= 1 && tone <= 4 ? tone - 1 : -1;
  const chars = base.split("");
  let markAt = -1;
  if (idx >= 0) {
    if (base.includes("v")) {
      markAt = base.indexOf("v");
    } else {
      for (const v of ["a", "o", "e"]) {
        const i = base.indexOf(v);
        if (i >= 0) { markAt = i; break; }
      }
      if (markAt < 0) {
        // only i/u left: mark the last one ("iu"→u, "ui"→i)
        const vs = [...base.matchAll(/[iu]/g)].map((m) => m.index!);
        const last = vs.at(-1);
        if (last !== undefined) markAt = last;
      }
    }
  }
  if (markAt >= 0) {
    const raw = chars[markAt];
    if (raw !== undefined) {
      const marked = MARKED[raw]?.[idx];
      if (marked) chars[markAt] = marked;
    }
  }
  return chars.join("").replace(/v/g, "ü");
}

/** "nǐ" → "ni3". Unmarked vowels are treated as tone 1. */
export function marksToNumbered(syl: string): string {
  let tone = 0;
  const out = [...syl.trim().toLowerCase()].map((c) => {
    const u = UNMARK[c];
    if (u) { tone = u[1]; return u[0]; }
    return c.replace("ü", "v");
  }).join("");
  return out + (tone || 1);
}

/** "nǐ hǎo3" → "ni hao" (tone marks and tone digits removed, ü→v). */
export function stripToneMarks(s: string): string {
  return [...s.toLowerCase()]
    .map((c) => {
      const u = UNMARK[c];
      if (u) return u[0];
      return c;
    })
    .join("")
    .replace(/ü/g, "v")
    .replace(/u:/g, "v")
    .replace(/[0-9]/g, "");
}

export function phraseToBpmf(pyNum: string): string {
  return pyNum.trim().split(/\s+/).map(numberedToBpmf).filter(Boolean).join(" ");
}

export function phraseToMarks(pyNum: string): string {
  return pyNum.trim().split(/\s+/).map(numberedToMarks).join(" ");
}
