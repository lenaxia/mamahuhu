/**
 * Dialect migration: import a JSON dump (idempotent — skips existing ids).
 * Usage: npm run import:db -- [in.json]
 */
import { makeSql, ensureSchema } from "../src/server/db";
import { readFileSync, existsSync } from "node:fs";

const file = process.argv[2] ?? "./data/export.json";
if (!existsSync(file)) {
  console.error(`no such file: ${file}`);
  process.exit(1);
}
const driver = (process.env.DB_DRIVER === "postgres" ? "postgres" : "sqlite") as "postgres" | "sqlite";
const sql = await makeSql({ driver, sqlitePath: process.env.SQLITE_PATH ?? "./data/app.db", databaseUrl: process.env.DATABASE_URL });
await ensureSchema(sql);

const dump = JSON.parse(readFileSync(file, "utf8")) as {
  users: { id: string; ext_id: string; name: string; annotations: string; tts_speed: number; onboarded: number; created_at: string }[];
  entries: Record<string, string | null>[];
};

for (const u of dump.users ?? []) {
  await sql.run(
    "INSERT INTO users (id, ext_id, name, annotations, tts_speed, onboarded, created_at) VALUES (?,?,?,?,?,?,?) " +
      "ON CONFLICT(id) DO NOTHING",
    [u.id, u.ext_id, u.name, u.annotations, u.tts_speed, u.onboarded, u.created_at],
  ).catch(() => {});
}
for (const e of dump.entries ?? []) {
  await sql.run(
    `INSERT INTO entries (id, user_id, variety, traditional, simplified, pinyin, pinyin_flat, bpmf, english, register,
      example_zh, example_en, notes, source, syllables, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
    [e.id, e.user_id, e.variety, e.traditional, e.simplified, e.pinyin, e.pinyin_flat, e.bpmf, e.english, e.register,
     e.example_zh, e.example_en, e.notes, e.source, e.syllables, e.created_at],
  ).catch(() => {});
}
console.log(`imported from ${file} (skips existing ids)`);
