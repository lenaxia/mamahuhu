import type { DictWord } from "./cedict";
import { numberedToBpmf, numberedToMarks, phraseToBpmf, phraseToMarks, UNMARK } from "./bpmf";
import { isCommon, isFrequent } from "./common";
import type { Interpretation, RenderedWord, SyllableChar } from "./types";

export interface DictIndex {
  byFlat: Map<string, DictWord[]>; // toneless pinyin → entries (word lookup)
  bySyl: Map<string, DictWord[]>; // single-syllable → single-char entries (candidates)
  syllables: Set<string>; // valid toneless syllables, derived from the dictionary
}

const MAX_SYL = 8; // longest word (in syllables) the DP considers
const K = 3; // k-best interpretations
const IDIOM_TAG = /\(idiom\)/i; // CEDICT gloss marker for 成語 entries

export function buildIndex(words: DictWord[]): DictIndex {
  const byFlat = new Map<string, DictWord[]>();
  const bySyl = new Map<string, DictWord[]>();
  const syllables = new Set<string>();
  // common words first, so bucket caps keep the useful entries
  const sorted = [...words].sort((a, b) => Number(isFrequent(b.traditional)) - Number(isFrequent(a.traditional)));
  for (const w of sorted) {
    const cur = byFlat.get(w.pyFlat);
    if (cur) { if (cur.length < 8) cur.push(w); } else byFlat.set(w.pyFlat, [w]);
    for (const tok of w.pyNum.split(/\s+/)) {
      const flat = tok.replace(/[0-9]/g, "");
      if (!flat) continue;
      syllables.add(flat);
      if (w.traditional.length === 1) {
        const c = bySyl.get(flat);
        if (c) { if (c.length < 10) c.push(w); } else bySyl.set(flat, [w]);
      }
    }
  }
  return { byFlat, bySyl, syllables };
}

/** Lowercase, strip tones/junk, canonicalize ü→v, apply common misspelling repairs. */
export function normalizePinyinInput(text: string): string[] {
  return normalizePinyinTokened(text).map((t) => t.flat);
}

/** Token with per-syllable TONES preserved from the typed digits (gan3 → {gan,[3]}).
 *  Tones are the strongest signal the user gives — the interpreter scores them. */
export interface PinyinToken { flat: string; tones: number[] }

export function normalizePinyinTokened(text: string): PinyinToken[] {
  // strip accents FIRST (ü→v inside stripToneMarks), then capture digit-tone
  // boundaries: "zhong1wen2" → [zhong(1), wen(2)]
  // keep tone DIGITS (stripToneMarks removes them); accents→plain via per-char map
  const lowered = text.toLowerCase();
  const deaccented = [...lowered].map((c) => { const u = UNMARK[c]; return u ? u[0] : c; }).join("").replace(/ü/g, "v");
  const raw = deaccented.split(/[^a-z0-9v]+/).filter(Boolean);
  const repair = (t: string) =>
    t
      .replace(/^ts/, "c")
      .replace(/^tz/, "z")
      .replace(/ee/g, "i")
      .replace(/oo/g, "u")
      .replace(/ung/g, "ong")
      .replace(/au/g, "ao")
      .replace(/ih$/, "i")
      .replace(/ow$/, "ou");
  const out: PinyinToken[] = [];
  for (const tok of raw) {
    const flat = tok.replace(/[^a-zv]/g, "");
    // tones: digits that follow letters, in order — aligned to syllables in order
    const tones: number[] = [];
    const m = tok.match(/[a-zv]+([1-5])/g);
    if (m) for (const part of m) tones.push(Number(part.replace(/[a-zv]/g, "")));
    if (flat) out.push({ flat: repair(flat), tones });
  }
  return out;
}

/** entry tone per syllable from pyNum ("gan3 fu4" → [3,4]; 5 = neutral/wild) */
function entryTones(pyNum: string): number[] {
  return pyNum.split(/\s+/).filter(Boolean).map((syl) => Number(syl.replace(/[^1-5]/g, "")) || 0);
}

/** Split a token into valid syllables (min-segment DP). Returns null if impossible. */
export function splitToken(token: string, syllables: Set<string>): string[] | null {
  if (syllables.has(token)) return [token];
  const n = token.length;
  const back: number[] = new Array(n + 1).fill(0);
  const cnt: number[] = new Array(n + 1).fill(Infinity);
  cnt[0] = 0;
  for (let i = 0; i < n; i++) {
    if ((cnt[i] ?? Infinity) === Infinity) continue;
    for (let L = Math.min(MAX_SYL, n - i); L >= 1; L--) {
      const piece = token.slice(i, i + L);
      if (!syllables.has(piece)) continue;
      if (cnt[i]! + 1 < (cnt[i + L] ?? Infinity)) { cnt[i + L] = cnt[i]! + 1; back[i + L] = L; }
    }
  }
  if (cnt[n] === Infinity) return null;
  const out: string[] = [];
  let i = n;
  while (i > 0) {
    const L = back[i] ?? 1;
    out.push(token.slice(i - L, i));
    i -= L;
  }
  return out.reverse();
}

export function renderWord(w: DictWord): RenderedWord {
  return {
    traditional: w.traditional,
    simplified: w.simplified,
    pinyin: phraseToMarks(w.pyNum),
    bpmf: phraseToBpmf(w.pyNum),
    english: w.english,
  };
}

/** Per-character annotation cells for a rendered word (for AnnotatedText). */
export function wordChars(w: RenderedWord): SyllableChar[] {
  const han = [...w.traditional];
  const py = w.pinyin.split(/\s+/).filter(Boolean);
  const bmf = w.bpmf.split(/\s+/).filter(Boolean);
  return han.map((h, i) => ({ h, py: py[i] ?? "", bpmf: bmf[i] ?? "" }));
}

interface PathNode { score: number; words: DictWord[]; }

/** k-best phrase interpretations of normalized pinyin syllables. */
export function interpret(input: string[], index: DictIndex, inputTones?: number[]): Interpretation[] {
  const tokens = input.map((t) => ({ token: t, syls: splitToken(t, index.syllables) }));
  if (tokens.some((t) => t.syls === null)) return []; // unmatched → candidates only
  const syls = tokens.flatMap((t) => t.syls ?? []);
  // per-syllable input tones (aligned by position; undefined = user gave none)
  const tones: (number | undefined)[] = new Array(syls.length).fill(undefined);
  if (inputTones) for (let i = 0; i < Math.min(inputTones.length, syls.length); i++) tones[i] = inputTones[i];
  const n = syls.length;
  if (n === 0 || n > 24) return [];
  const dp: PathNode[][] = Array.from({ length: n + 1 }, () => []);
  dp[0] = [{ score: 0, words: [] }];
  for (let i = 0; i < n; i++) {
    for (const path of dp[i] ?? []) {
      for (let L = 1; L <= Math.min(MAX_SYL, n - i); L++) {
        const flat = syls.slice(i, i + L).join("");
        const entries = index.byFlat.get(flat);
        if (!entries) continue;
        for (const e of entries) {
          // common-word boost only applies to multi-char words: it disambiguates
          // alternatives (知道 vs 制導), it must not make single-char soup win
          // tiered: curated parenting list > generic subtitle frequency > rest
          // (tones break real ties; toneless input needs deterministic order)
          let boost = 0;
          if (e.traditional.length > 1) boost = isCommon(e.traditional) ? 0.75 : isFrequent(e.traditional) ? 0.6 : 0;
          else if (isCommon(e.traditional)) boost = 0.1;
          // rare single chars (Unihan variants: 㘵, 佈…) are legitimate LAST-resort
          // interpretations but must not pollute phrase alternatives
          const rareSingle = [...e.traditional].length === 1 && !isFrequent(e.traditional) ? 0.45 : 0;
          // TONE SCORING: the user's typed tones are the strongest signal —
          // 乹 (gān) must lose to 趕 (gǎn) for input gan3. Neutral tone (5)
          // entries are wild (sandhi); toneless input is unaffected.
          let tonePenalty = 0;
          const eT = entryTones(e.pyNum);
          for (let k = 0; k < L; k++) {
            const want = tones[i + k], got = eT[k] ?? 0;
            if (want && got && got !== 5 && want !== got) tonePenalty += 2.0; // hard tier: no boost combination may outrank a tone-exact match
          }
          const score = path.score + L - 0.35 + (e.traditional.length === L ? 0.05 : 0) + boost - tonePenalty - rareSingle;
          const node = { score, words: [...path.words, e] };
          const bucket = dp[i + L];
          if (!bucket) continue;
          bucket.push(node);
          bucket.sort((a, b) => b.score - a.score);
          if (bucket.length > K) bucket.length = K;
        }
      }
    }
  }
  // collect paths first: all-single-char compositions (乹+㳇 char soup) are
  // only legitimate when NO real-word path exists — a soup that merely chains
  // per-syllable characters is not a dictionary result
  const paths = dp[n] ?? [];
  const hasRealWordPath = paths.some((p) => p.words.some((w) => [...w.traditional].length > 1));
  // TONE TIERS: every tone-exact interpretation precedes every wrong-tone one
  // (typed tones outrank frequency; wrong tones still surface AFTER — typo
  // forgiveness). Neutral tone (5) entries are wild. Toneless input: one tier.
  const pathToneMismatch = (p: { words: DictWord[] }): number => {
    if (!inputTones) return 0;
    let i = 0, mismatch = 0;
    for (const w of p.words) {
      const eT = entryTones(w.pyNum);
      for (let k = 0; k < eT.length; k++) {
        const want = tones[i + k], got = eT[k] ?? 0;
        if (want && got && got !== 5 && want !== got) mismatch++;
      }
      i += eT.length;
    }
    return mismatch;
  };
  paths.sort((a, b) => pathToneMismatch(a) - pathToneMismatch(b) || b.score - a.score);
  const seen = new Set<string>();
  const out: Interpretation[] = [];
  for (const p of paths) {
    if (hasRealWordPath && p.words.every((w) => [...w.traditional].length === 1)) continue;
    const key = p.words.map((w) => w.traditional).join("|") + "#" + p.words.map((w) => w.pyNum).join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    const words = p.words.map(renderWord);
    const fullFlat = syls.join("");
    // exact-English override ONLY for a single-word path that IS the entry —
    // a soup must never borrow a real word's gloss (the 乹㳇 "to hurry" bug)
    const exact = p.words.length === 1
      ? index.byFlat.get(fullFlat)?.find((e) => e.traditional === p.words[0]!.traditional)
      : undefined;
    out.push({
      traditional: words.map((w) => w.traditional).join(""),
      simplified: words.map((w) => w.simplified).join(""),
      pinyin: p.words.map((w) => phraseToMarks(w.pyNum)).join(" "),
      bpmf: p.words.map((w) => phraseToBpmf(w.pyNum)).join(" "),
      english: exact
        ? exact.english
        : words.map((w) => w.english.split(" / ")[0]).join("; "),
      words,
      exactEntry: Boolean(exact),
      // CEDICT tags idioms in the gloss ("… (idiom) / …") — any exact entry
      // match that carries the tag is an idiom, wherever it renders
      idiom: Boolean(exact) && IDIOM_TAG.test(exact!.english),
    });
    if (out.length >= K) break;
  }
  return out;
}

/** Per-syllable character candidates ("words that might match"). */
export function candidates(input: string[], index: DictIndex, limit = 8): RenderedWord[] {
  const out: RenderedWord[] = [];
  const seen = new Set<string>();
  const push = (w: DictWord) => {
    if (seen.has(w.traditional)) return;
    seen.add(w.traditional);
    out.push(renderWord(w));
  };
  for (const t of input) {
    const syls = splitToken(t, index.syllables) ?? [t];
    for (const s of syls) {
      const direct = index.bySyl.get(s);
      if (direct) for (const w of direct) push(w);
      if (out.length >= limit) return out;
      if (!direct) {
        // edit distance ≤ 1 against the valid syllable set
        for (const syl of index.syllables) {
          if (lev(s, syl) <= 1) {
            for (const w of index.bySyl.get(syl) ?? []) push(w);
            if (out.length >= limit) return out;
          }
        }
      }
    }
  }
  return out;
}

export function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const m = a.length, n = b.length;
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[n] ?? 0;
}

/** Segments hanzi text into words using Intl.Segmenter (zh-Hant). */
export function segmentHanzi(text: string): string[] {
  const seg = new Intl.Segmenter("zh-Hant", { granularity: "word" });
  const out: string[] = [];
  for (const s of seg.segment(text)) {
    if (/\p{Script=Han}/u.test(s.segment)) out.push(s.segment);
  }
  return out;
}

export { numberedToBpmf, numberedToMarks };
