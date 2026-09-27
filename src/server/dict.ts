import { loadCedict, type DictWord } from "../shared/cedict";
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
