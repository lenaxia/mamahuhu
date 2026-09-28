// One-off: backfill tags for entries saved while extractJson couldn't parse
// the tagger's top-level arrays. Usage: npx tsx scripts/backfill-tags.ts
import { makeApp } from "../src/server/app";

async function main(): Promise<void> {
  const { app, deps } = await makeApp({ sqlitePath: process.env.SQLITE_PATH ?? "data/dev.db" });
  const res = await app.request("/api/entries", { headers: { "x-dev-user": process.env.BACKFILL_USER ?? "dad" } });
  const entries = (await res.json()) as { id: string; traditional: string; english: string; tags: string[] }[];
  for (const e of entries) {
    if (e.tags.length) continue;
    const t = await deps.tagger.tagsFor({ traditional: e.traditional, english: e.english });
    if (t.ok) {
      await deps.sql.run("UPDATE entries SET tags = ? WHERE id = ?", [JSON.stringify(t.value), e.id]);
      console.log(e.traditional, "→", t.value.join(", "));
    } else {
      console.log(e.traditional, "→ FAILED:", t.error);
    }
  }
}
void main();
