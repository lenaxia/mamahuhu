/**
 * One-shot retag CLI (runs inside the app image): `node dist/retag.js`
 * Re-tags EVERY entry — all users — with the current tagger prompt.
 * FORCE=0 only fills entries with no tags. Exits when done; meant for a
 * Kubernetes Job against the mamahuhu-data PVC.
 */
import { makeApp } from "./app";

async function main(): Promise<void> {
  const force = process.env.FORCE !== "0";
  const { deps } = await makeApp({ sqlitePath: process.env.SQLITE_PATH ?? `${process.env.DATA_DIR ?? "./data"}/app.db` });
  // direct SQL: every user's entries — identity headers don't apply to a job
  const rows = await deps.sql.all<{ id: string; traditional: string; english: string; tags: string }>(
    "SELECT id, traditional, english, tags FROM entries",
  );
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  for (const e of rows) {
    const has = (JSON.parse(e.tags ?? "[]") as string[]).length > 0;
    if (!force && has) {
      skipped++;
      continue;
    }
    const t = await deps.tagger.tagsFor({ traditional: e.traditional, english: e.english });
    if (t.ok) {
      await deps.sql.run("UPDATE entries SET tags = ? WHERE id = ?", [JSON.stringify(t.value), e.id]);
      ok++;
      console.log(e.traditional, "→", t.value.join(", "));
    } else {
      failed++;
      console.log(e.traditional, "→ FAILED:", t.error);
    }
  }
  console.log(`retag complete: ${ok} ok, ${failed} failed, ${skipped} skipped, ${rows.length} total`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((e: unknown) => {
  console.error("retag failed:", e);
  process.exit(1);
});
