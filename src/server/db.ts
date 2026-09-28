import { randomUUID } from "node:crypto";

/** Minimal dual-dialect SQL surface (SQLite ⇄ Postgres, identical DDL). */
export interface Sql {
  all<T = unknown>(query: string, params?: unknown[]): Promise<T[]>;
  get<T = unknown>(query: string, params?: unknown[]): Promise<T | undefined>;
  run(query: string, params?: unknown[]): Promise<void>;
}

export interface SqlOptions {
  driver: "sqlite" | "postgres";
  sqlitePath?: string;
  databaseUrl?: string;
}

export async function makeSql(opts: SqlOptions): Promise<Sql> {
  if (opts.driver === "postgres") {
    const postgres = (await import("postgres")).default;
    const pg = postgres(opts.databaseUrl ?? process.env.DATABASE_URL!, { max: 5 });
    const conv = (q: string): string => {
      let i = 0;
      return q.replace(/\?/g, () => `$${++i}`);
    };
    return {
      async all<T>(query: string, params: unknown[] = []) {
        return pg.unsafe(conv(query), params as never[]) as unknown as T[];
      },
      async get<T>(query: string, params: unknown[] = []) {
        const rows = await pg.unsafe(conv(query), params as never[]);
        return (rows[0] as T | undefined) ?? undefined;
      },
      async run(query: string, params: unknown[] = []) {
        await pg.unsafe(conv(query), params as never[]);
      },
    };
  }
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(opts.sqlitePath ?? "./data/app.db");
  db.pragma("journal_mode = WAL");
  return {
    async all<T>(query: string, params: unknown[] = []) {
      return db.prepare(query).all(...params) as T[];
    },
    async get<T>(query: string, params: unknown[] = []) {
      return db.prepare(query).get(...params) as T | undefined;
    },
    async run(query: string, params: unknown[] = []) {
      db.prepare(query).run(...params);
    },
  };
}

export const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  ext_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  annotations TEXT NOT NULL DEFAULT 'both',
  tts_speed REAL NOT NULL DEFAULT 1.0,
  audience TEXT,
  onboarded INTEGER NOT NULL DEFAULT 0,
  varieties TEXT NOT NULL DEFAULT '["zh-Hant"]',
  primary_variety TEXT NOT NULL DEFAULT 'zh-Hant',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  variety TEXT NOT NULL DEFAULT 'zh-Hant',
  traditional TEXT NOT NULL,
  simplified TEXT NOT NULL DEFAULT '',
  pinyin TEXT NOT NULL,
  pinyin_flat TEXT NOT NULL DEFAULT '',
  bpmf TEXT NOT NULL DEFAULT '',
  english TEXT NOT NULL DEFAULT '',
  register TEXT NOT NULL DEFAULT 'casual',
  jyutping TEXT NOT NULL DEFAULT '',
  formal_zh TEXT NOT NULL DEFAULT '',
  formal_jyut TEXT NOT NULL DEFAULT '',
  example_zh TEXT,
  example_en TEXT,
  notes TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  syllables TEXT NOT NULL DEFAULT '[]',
  srs_box INTEGER NOT NULL DEFAULT 0,
  srs_due TEXT,
  srs_streak INTEGER NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_user ON entries(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_entries_flat ON entries(pinyin_flat);
CREATE TABLE IF NOT EXISTS audio_files (
  key TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  mime TEXT NOT NULL DEFAULT 'audio/mpeg',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS asks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '{}',
  photo_path TEXT,
  photo_mime TEXT,
  photo_w INTEGER NOT NULL DEFAULT 0,
  photo_h INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asks_user ON asks(user_id, created_at);
CREATE TABLE IF NOT EXISTS dict_words (
  traditional TEXT NOT NULL,
  simplified TEXT NOT NULL,
  py_num TEXT NOT NULL,
  py_flat TEXT NOT NULL,
  english TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dict_flat ON dict_words(py_flat);
CREATE INDEX IF NOT EXISTS idx_dict_trad ON dict_words(traditional);
`;

export async function ensureSchema(sql: Sql): Promise<void> {
  for (const stmt of DDL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await sql.run(stmt);
  }
  // additive migrations for pre-existing databases (both dialects)
  for (const col of [
    "ALTER TABLE users ADD COLUMN audience TEXT",
    "ALTER TABLE users ADD COLUMN varieties TEXT NOT NULL DEFAULT '[\"zh-Hant\"]'",
    "ALTER TABLE users ADD COLUMN primary_variety TEXT NOT NULL DEFAULT 'zh-Hant'",
    "ALTER TABLE entries ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE entries ADD COLUMN jyutping TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE entries ADD COLUMN formal_zh TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE entries ADD COLUMN formal_jyut TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE entries ADD COLUMN srs_box INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE entries ADD COLUMN srs_due TEXT",
    "ALTER TABLE entries ADD COLUMN srs_streak INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE entries ADD COLUMN review_count INTEGER NOT NULL DEFAULT 0",
  ]) {
    await sql.run(col).catch(() => undefined); // column already exists
  }
}

export interface UserRow {
  id: string;
  ext_id: string;
  name: string;
  annotations: string;
  tts_speed: number;
  audience: string | null;
  onboarded: number;
  varieties: string;
  primary_variety: string;
  created_at: string;
}

export async function ensureUser(sql: Sql, extId: string, name: string): Promise<UserRow> {
  const existing = await sql.get<UserRow>("SELECT * FROM users WHERE ext_id = ?", [extId]);
  if (existing) return existing;
  const user: UserRow = {
    id: randomUUID(),
    ext_id: extId,
    name,
    annotations: "both",
    tts_speed: 1.0,
    audience: null,
    onboarded: 0,
    varieties: '["zh-Hant"]',
    primary_variety: "zh-Hant",
    created_at: new Date().toISOString(),
  };
  await sql.run(
    "INSERT INTO users (id, ext_id, name, annotations, tts_speed, audience, onboarded, varieties, primary_variety, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [user.id, user.ext_id, user.name, user.annotations, user.tts_speed, user.audience, user.onboarded, user.varieties, user.primary_variety, user.created_at],
  );
  return user;
}
