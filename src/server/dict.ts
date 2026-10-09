import { flatOf, loadCedict, type DictWord } from "../shared/cedict";
import { buildIndex, type DictIndex } from "../shared/fuzzy";
import type { Sql } from "./db";

export interface Dictionary {
  index: DictIndex;
  byTrad: Map<string, DictWord[]>;
  /** simplified-script lookup — posters/print from mainland China are 简体 */
  bySimp: Map<string, DictWord[]>;
  count: number;
}

let cached: Dictionary | null = null;

/** Loads CC-CEDICT, seeds dict_words on first boot, builds in-memory indices. */
export async function loadDictionary(sql: Sql): Promise<Dictionary> {
  if (cached) return cached;
  const t0 = Date.now();
  const words = loadCedict();
  const row = await sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM dict_words");
  if (!row || row.n < words.length / 2) {
    await seedDict(sql, words);
  }
  const index = buildIndex(words);
  const byTrad = new Map<string, DictWord[]>();
  const bySimp = new Map<string, DictWord[]>();
  for (const w of words) {
    if (w.simplified && w.simplified !== w.traditional) {
      const curS = bySimp.get(w.simplified);
      if (curS) { if (curS.length < 4) curS.push(w); } else bySimp.set(w.simplified, [w]);
    }
    const cur = byTrad.get(w.traditional);
    if (cur) { if (cur.length < 4) cur.push(w); } else byTrad.set(w.traditional, [w]);
  }
  cached = { index, byTrad, bySimp, count: words.length };
  console.log(`[dict] ${words.length} entries, index built in ${Date.now() - t0}ms`);
  return cached;
}

async function seedDict(sql: Sql, words: DictWord[]): Promise<void> {
  console.log(`[dict] seeding ${words.length} entries…`);
  await sql.run("BEGIN");
  try {
    const stmt = "INSERT INTO dict_words (traditional, simplified, py_num, py_flat, english) VALUES (?,?,?,?,?)";
    for (const w of words) {
      await sql.run(stmt, [w.traditional, w.simplified, w.pyNum, w.pyFlat, w.english]);
    }
    await sql.run("COMMIT");
  } catch (e) {
    await sql.run("ROLLBACK");
    throw e;
  }
}


/** AI-definition candidate as returned by the gateway (strict shape). */
export interface LlmDefinition { traditional: string; simplified: string; pinyin: string; english: string }

/** Strict validation of an LLM-proposed definition — rejects anything that
 *  doesn't exactly describe the queried word (same chars, matching syllable
 *  count, sane gloss). Pure; unit-tested. */
export function validateDefinition(word: string, d: unknown): LlmDefinition | null {
  if (!d || typeof d !== "object") return null;
  const { traditional, simplified, pinyin, english } = d as Record<string, unknown>;
  if (typeof traditional !== "string" || typeof simplified !== "string" || typeof pinyin !== "string" || typeof english !== "string") return null;
  const chars = [...word];
  // the definition must be OF the queried word (same chars, either script)
  const sameChars = (a: string) => a.length === chars.length && chars.every((c, i) => a[i] === c);
  if (!sameChars(traditional) && !sameChars(simplified)) return null;
  const syllables = pinyin.trim().split(/\s+/).filter(Boolean);
  if (syllables.length !== chars.length) return null;
  if (!/^[a-züv]+[1-5](\s+[a-züv]+[1-5])*$/i.test(pinyin.trim())) return null;
  const gloss = english.trim();
  if (gloss.length < 5 || gloss.length > 250) return null;
  return { traditional, simplified, pinyin: pinyin.trim().toLowerCase(), english: gloss };
}

/** Tier 3: LLM-define unknown words on miss — cached permanently in dict_words
 *  (marked "AI-defined"), memoized in the in-memory maps. The dictionary grows
 *  with what the family actually reads; CEDICT+Unihan answer everything else. */
export function makeDefiner(
  cfg: { base: string; key: string; model: string },
  sql: Sql,
  dictionary: Dictionary,
): (word: string) => Promise<DictWord | null> {
  const inflight = new Map<string, Promise<DictWord | null>>();
  return async (word: string) => {
    if (dictionary.byTrad.has(word) || dictionary.bySimp.has(word)) return null;
    const running = inflight.get(word);
    if (running) return running;
    const p = (async (): Promise<DictWord | null> => {
      try {
        const body = JSON.stringify({
          model: cfg.model, temperature: 0, max_tokens: 300,
          messages: [{ role: "user", content: `Define the Chinese word "${word}" for a learner dictionary. Return ONLY JSON: {"traditional":"…","simplified":"…","pinyin":"numbered pinyin (tone digits, e.g. tai4 fu4)","english":"concise English gloss (5-40 words)"}. The traditional/simplified fields must contain exactly the same characters as "${word}" in the appropriate script.` }],
        });
        const res = await fetch(`${cfg.base}/chat/completions`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.key}` },
          body, signal: AbortSignal.timeout(45_000),
        });
        if (!res.ok) return null;
        const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const txt = (j.choices?.[0]?.message?.content ?? "").replace(/```[a-z]*\n?/g, "").trim();
        const start = txt.indexOf("{");
        if (start < 0) return null;
        const def = validateDefinition(word, JSON.parse(txt.slice(start, txt.lastIndexOf("}") + 1)));
        if (!def) { console.log(`[dict] AI definition rejected for ${word}`); return null; }
        const entry: DictWord = {
          traditional: def.traditional, simplified: def.simplified,
          pyNum: def.pinyin, pyFlat: flatOf(def.pinyin),
          english: `${def.english} (AI-defined)`,
        };
        await sql.run(
          "INSERT OR IGNORE INTO dict_words (traditional, simplified, py_num, py_flat, english) VALUES (?,?,?,?,?)",
          [entry.traditional, entry.simplified, entry.pyNum, entry.pyFlat, entry.english],
        );
        dictionary.byTrad.set(entry.traditional, [entry]);
        if (!dictionary.bySimp.has(entry.simplified)) dictionary.bySimp.set(entry.simplified, [entry]);
        console.log(`[dict] AI-defined ${word}: ${def.english.slice(0, 40)}`);
        return entry;
      } catch (e) {
        console.warn(`[dict] AI definition failed for ${word}: ${String(e)}`);
        return null;
      } finally {
        inflight.delete(word);
      }
    })();
    inflight.set(word, p);
    return p;
  };
}
