/**
 * Dialect migration: dump users + entries to JSON (SQLite → Postgres or back).
 * Usage: npm run export:db -- [out.json]   (default data/export.json)
 */
import { makeSql, ensureSchema } from "../src/server/db";
import { writeFileSync } from "node:fs";

const out = process.argv[2] ?? "./data/export.json";
const driver = (process.env.DB_DRIVER === "postgres" ? "postgres" : "sqlite") as "postgres" | "sqlite";
const sql = await makeSql({ driver, sqlitePath: process.env.SQLITE_PATH ?? "./data/app.db", databaseUrl: process.env.DATABASE_URL });
await ensureSchema(sql);

const users = await sql.all("SELECT * FROM users");
const entries = await sql.all("SELECT * FROM entries");
writeFileSync(out, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), users, entries }, null, 2));
console.log(`exported ${users.length} users, ${entries.length} entries → ${out}`);
