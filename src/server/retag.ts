/**
 * One-shot retag CLI (runs inside the app image): `node dist/retag.js`
 * Re-tags every entry with the current tagger prompt. FORCE=1 (default here)
 * re-tags all; FORCE=0 only fills entries with no tags. Exits when done —
 * meant for a Kubernetes Job against the mamahuhu-data PVC.
 */
import { makeApp } from "./app";

async function main(): Promise<void> {
  const force = process.env.FORCE !== "0";
  const { app, deps } = await makeApp({ sqlitePath: process.env.SQLITE_PATH ?? `${process.env.DATA_DIR ?? "./data"}/app.db` });
  const res = await app.request("/api/entries", { headers: { "x-dev-user": process.env.BACKFILL_USER ?? "dad" } });
  if (!res.ok) throw new Error(`entries list failed: ${res.status}`);
  const entries = (await res.json()) as { id: string; traditional: string; english: string; tags: string[] }[];
  let ok = 0;
  let failed = 0;
  for (const e of entries) {
    if (!force && e.tags.length) continue;
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
  console.log(`retag complete: ${ok} ok, ${failed} failed, ${entries.length} total`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((e: unknown) => {
  console.error("retag failed:", e);
  process.exit(1);
});
