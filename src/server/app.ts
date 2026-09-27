import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  AnnotationsSchema,
  CreateEntryReqSchema,
  EntrySchema,
  HanziReqSchema,
  HanziResSchema,
  HanziWordSchema,
  ListEntriesResSchema,
  MeSchema,
  OcrResSchema,
  OcrWordSchema,
  PatchEntryReqSchema,
  PatchMeReqSchema,
  PinyinReqSchema,
  PinyinResSchema,
  RegisterSchema,
  TranslateReqSchema,
  TranslateResSchema,
  type Annotations,
  type Entry,
  type CardVariant,
  type Syllables,
} from "../shared/api";
import { z } from "zod";
import { makeSql, ensureSchema, type Sql, type UserRow } from "./db";
import { loadDictionary, type Dictionary } from "./dict";
import { identityMiddleware, isProxyAuth } from "./auth";
import {
  GatewayChatClient,
  GatewayOcrService,
  GatewayTtsService,
  LlmTranslationService,
  MockOcrService,
  MockTranslationService,
  UnavailableStt,
  UnavailableTts,
} from "./llm";
import { candidates, interpret, normalizePinyinInput, renderWord, segmentHanzi } from "../shared/fuzzy";
import { marksToNumbered, numberedToBpmf, numberedToMarks, stripToneMarks } from "../shared/bpmf";
import type { AppDeps, Result, TranslationService, TtsService, SttService, OcrService } from "./ports";

export type { AppDeps } from "./ports";

export interface AppOptions {
  sqlitePath?: string;
  postgresUrl?: string;
  llmMock?: boolean;
}

const isHan = (ch: string): boolean => /\p{Script=Han}/u.test(ch);

function meDTO(row: UserRow) {
  return MeSchema.parse({
    id: row.id,
    name: row.name,
    annotations: AnnotationsSchema.parse(row.annotations),
    ttsSpeed: row.tts_speed,
    audience: row.audience ?? null,
    onboarded: Boolean(row.onboarded),
    nameFromProxy: isProxyAuth(),
  });
}

interface EntryRow {
  id: string; user_id: string; variety: string; traditional: string; simplified: string;
  pinyin: string; pinyin_flat: string; bpmf: string; english: string; register: string;
  example_zh: string | null; example_en: string | null; notes: string | null;
  source: string; syllables: string; created_at: string; user_name?: string;
}

function entryDTO(row: EntryRow): Entry {
  return EntrySchema.parse({
    id: row.id,
    userId: row.user_id,
    userName: row.user_name ?? "",
    variety: row.variety,
    traditional: row.traditional,
    simplified: row.simplified,
    pinyin: row.pinyin,
    pinyinFlat: row.pinyin_flat,
    bpmf: row.bpmf,
    english: row.english,
    register: RegisterSchema.parse(row.register),
    exampleZh: row.example_zh,
    exampleEn: row.example_en,
    notes: row.notes,
    source: row.source,
    syllables: JSON.parse(row.syllables) as Syllables,
    createdAt: row.created_at,
  });
}

/** Splits a variant into words→chars with CEDICT-preferred pinyin where known. */
function buildSyllables(variant: CardVariant, dict: Dictionary): { syllables: Syllables; lowConfidence: boolean } {
  const syls = variant.pinyin.trim().split(/\s+/).filter(Boolean);
  const out: Syllables = [];
  let i = 0;
  let low = false;
  for (const word of segmentHanzi(variant.traditional)) {
    const chars = [...word].filter(isHan);
    const chunk: Syllables[number] = [];
    for (const h of chars) {
      const raw = syls[i++];
      if (!raw) { low = true; chunk.push({ h, py: "", bpmf: "" }); continue; }
      const num = marksToNumbered(raw);
      const bmf = numberedToBpmf(num);
      if (!bmf) low = true;
      chunk.push({ h, py: numberedToMarks(num), bpmf: bmf });
    }
    const match = dict.byTrad.get(word)?.find((e) => e.pyNum.split(/\s+/).length === chars.length);
    if (match && match.traditional === word) {
      const nums = match.pyNum.split(/\s+/);
      chunk.forEach((c, j) => {
        const n = nums[j];
        if (!n) return;
        c.py = numberedToMarks(n);
        c.bpmf = numberedToBpmf(n);
      });
    }
    out.push(chunk);
  }
  if (i !== syls.length) low = true;
  return { syllables: out, lowConfidence: low };
}

export type App = Hono<{ Variables: { user: UserRow } }>;

export async function makeApp(opts: AppOptions = {}): Promise<{ app: App; deps: AppDeps }> {
  const driver = process.env.DB_DRIVER === "postgres" || opts.postgresUrl ? "postgres" : "sqlite";
  const sql: Sql = await makeSql({
    driver,
    sqlitePath: opts.sqlitePath ?? process.env.SQLITE_PATH ?? "./data/app.db",
    databaseUrl: opts.postgresUrl ?? process.env.DATABASE_URL,
  });
  await ensureSchema(sql);
  const dictionary = await loadDictionary(sql);

  const mock = opts.llmMock || process.env.LLM_MOCK === "1";
  const base = process.env.OPENAI_API_BASE ?? "https://api.openai.com/v1";
  const key = process.env.OPENAI_API_KEY ?? "";
  const chatModel = process.env.MODEL_CHAT ?? "default";
  // TTS_MODE: auto (default) = server model when configured, else browser;
  // server = force gateway TTS; browser = force browser speechSynthesis.
  const ttsMode = (process.env.TTS_MODE ?? "auto") as "auto" | "server" | "browser";
  const ttsModel = process.env.MODEL_TTS ?? "";

  const translations: TranslationService = mock
    ? new MockTranslationService()
    : new LlmTranslationService(new GatewayChatClient({ base, key, defaultModel: chatModel }), chatModel);

  const useServerTts = !mock && ttsModel && ttsMode !== "browser";
  const tts: TtsService = useServerTts
    ? new GatewayTtsService({ base, key, model: ttsModel, voice: process.env.TTS_VOICE ?? "zf_xiaoxiao" })
    : new UnavailableTts();
  const stt: SttService = new UnavailableStt();
  const visionModel = process.env.MODEL_VISION ?? "default";
  const ocr: OcrService = mock ? new MockOcrService() : new GatewayOcrService({ base, key, model: visionModel });

  const deps: AppDeps = { sql, dictionary, translations, tts, stt, ocr, sources: new Set() };

  const app: App = new Hono<{ Variables: { user: UserRow } }>();

  app.get("/healthz", (c) => c.json({ ok: true, dictEntries: dictionary.count }));
  app.use("/api/*", identityMiddleware(sql));

  // ---- me ----
  app.get("/api/me", (c) => c.json(meDTO(c.get("user"))));

  app.patch("/api/me", async (c) => {
    const parsed = PatchMeReqSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    const user = c.get("user");
    const sets: string[] = [];
    const params: unknown[] = [];
    // default name comes from the proxy; the user may override it here
    if (parsed.data.name !== undefined) { sets.push("name = ?"); params.push(parsed.data.name); }
    if (parsed.data.annotations !== undefined) { sets.push("annotations = ?"); params.push(parsed.data.annotations); }
    if (parsed.data.ttsSpeed !== undefined) { sets.push("tts_speed = ?"); params.push(parsed.data.ttsSpeed); }
    if (parsed.data.audience !== undefined) { sets.push("audience = ?"); params.push(parsed.data.audience); }
    if (parsed.data.onboarded !== undefined) { sets.push("onboarded = ?"); params.push(parsed.data.onboarded ? 1 : 0); }
    if (sets.length) {
      params.push(user.id);
      await sql.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, params);
    }
    const fresh = await sql.get<UserRow>("SELECT * FROM users WHERE id = ?", [user.id]);
    return c.json(meDTO(fresh!));
  });

  // ---- ask: pinyin interpreter (local) ----
  app.post("/api/ask/pinyin", async (c) => {
    const parsed = PinyinReqSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    const norm = normalizePinyinInput(parsed.data.text);
    const res = PinyinResSchema.parse({
      interpretations: interpret(norm, dictionary.index),
      candidates: candidates(norm, dictionary.index),
    });
    return c.json(res);
  });

  // ---- ask: translate (LLM) ----
  app.post("/api/ask/translate", async (c) => {
    const parsed = TranslateReqSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    const res = await deps.translations.translate(parsed.data.text, { audience: c.get("user").audience ?? parsed.data.audience });
    if (!res.ok) return c.json({ error: res.error }, 502);
    const casual = buildSyllables(res.value.casual, dictionary);
    const formal = buildSyllables(res.value.formal, dictionary);
    const alternatives = res.value.alternatives
      .map((alt) => {
        const cs = buildSyllables(alt.casual, dictionary);
        const fs = buildSyllables(alt.formal, dictionary);
        return { casual: { variant: alt.casual, syllables: cs.syllables }, formal: { variant: alt.formal, syllables: fs.syllables }, ok: !cs.lowConfidence && !fs.lowConfidence };
      })
      .filter((a) => a.ok)
      .map(({ casual, formal }) => ({ casual, formal }));
    return c.json(TranslateResSchema.parse({
      source: parsed.data.text,
      register: "casual",
      casual: res.value.casual,
      formal: res.value.formal,
      syllables: casual.syllables,
      formalSyllables: res.value.formal.pinyin !== res.value.casual.pinyin ? formal.syllables : undefined,
      alternatives: alternatives.length ? alternatives : undefined,
      lowConfidence: casual.lowConfidence || formal.lowConfidence || undefined,
    }));
  });

  // ---- ask: hanzi input (local dictionary) ----
  app.post("/api/ask/hanzi", async (c) => {
    const parsed = HanziReqSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    const lookup = (seg: string): z.infer<typeof HanziWordSchema> | null => {
      const hit = dictionary.byTrad.get(seg)?.[0];
      if (hit && hit.traditional === seg) return { ...renderWord(hit), known: true };
      return null;
    };
    const words: z.infer<typeof HanziWordSchema>[] = [];
    for (const seg of segmentHanzi(parsed.data.text)) {
      const direct = lookup(seg);
      if (direct) { words.push(direct); continue; }
      // decompose multi-char segments into dictionary-known characters
      for (const ch of [...seg]) {
        words.push(lookup(ch) ?? { traditional: ch, simplified: ch, pinyin: "", bpmf: "", english: "", known: false });
      }
    }
    return c.json(HanziResSchema.parse({ words }));
  });

  // ---- ask: photo OCR (vision) → segmented tappable words ----
  app.post("/api/ask/ocr", async (c) => {
    const user = c.get("user");
    const body = await c.req.parseBody().catch(() => null);
    const image = body && "image" in body ? (body.image as File) : null;
    if (!image || image.size < 10 || image.size > 12 * 1024 * 1024) {
      return c.json({ error: "image required (max 12MB)" }, 400);
    }
    const res = await deps.ocr.extract(image);
    if (!res.ok) return c.json({ error: res.error }, 502);

    const savedRows = await sql.all<{ traditional: string }>(
      "SELECT traditional FROM entries WHERE user_id = ?", [user.id],
    );
    const savedSet = new Set(savedRows.map((r) => r.traditional));

    const lookup = (seg: string) => {
      const hit = dictionary.byTrad.get(seg)?.[0];
      return hit && hit.traditional === seg ? renderWord(hit) : null;
    };
    const lines: { words: z.infer<typeof OcrWordSchema>[] }[] = [];
    const lineTexts: string[] = [];
    for (const line of res.value.lines) {
      lineTexts.push(line.text);
      const words: z.infer<typeof OcrWordSchema>[] = [];
      for (const seg of segmentHanzi(line.text)) {
        const direct = lookup(seg);
        if (direct) {
          words.push({ ...direct, known: true, saved: savedSet.has(seg) });
          continue;
        }
        for (const ch of [...seg]) {
          const charHit = lookup(ch);
          if (charHit) words.push({ ...charHit, known: true, saved: savedSet.has(ch) });
          else words.push({ traditional: ch, simplified: ch, pinyin: "", bpmf: "", english: "", known: false, saved: false });
        }
      }
      if (words.length) lines.push({ words });
    }
    return c.json(OcrResSchema.parse({ lines, fullText: lineTexts.join("\n") }));
  });

  // ---- entries ----
  app.post("/api/entries", async (c) => {
    const parsed = CreateEntryReqSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    const user = c.get("user");
    const e = parsed.data;
    const dup = await sql.get<EntryRow>(
      "SELECT e.*, u.name AS user_name FROM entries e JOIN users u ON u.id = e.user_id WHERE e.user_id = ? AND e.traditional = ? AND e.pinyin = ?",
      [user.id, e.traditional, e.pinyin],
    );
    if (dup) return c.json({ ...entryDTO(dup), duplicate: true });
    const id = randomUUID();
    const flat = e.pinyinFlat || stripToneMarks(e.pinyin).replace(/\s+/g, "");
    await sql.run(
      `INSERT INTO entries (id, user_id, variety, traditional, simplified, pinyin, pinyin_flat, bpmf, english, register, example_zh, example_en, notes, source, syllables, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, user.id, "zh-Hant", e.traditional, e.simplified, e.pinyin, flat, e.bpmf, e.english, e.register,
       e.exampleZh ?? null, e.exampleEn ?? null, e.notes ?? null, e.source, JSON.stringify(e.syllables), new Date().toISOString()],
    );
    const row = await sql.get<EntryRow>(
      "SELECT e.*, u.name AS user_name FROM entries e JOIN users u ON u.id = e.user_id WHERE e.id = ?", [id],
    );
    return c.json(entryDTO(row!), 201);
  });

  app.get("/api/entries", async (c) => {
    const user = c.get("user");
    const scope = c.req.query("scope") === "all" ? "all" : "mine";
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const where: string[] = [];
    const params: unknown[] = [];
    if (scope === "mine") { where.push("e.user_id = ?"); params.push(user.id); }
    if (q) {
      where.push("(LOWER(e.traditional) LIKE ? OR LOWER(e.simplified) LIKE ? OR e.pinyin_flat LIKE ? OR LOWER(e.english) LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    const rows = await sql.all<EntryRow>(
      `SELECT e.*, u.name AS user_name FROM entries e JOIN users u ON u.id = e.user_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY e.created_at DESC LIMIT 200`,
      params,
    );
    return c.json(ListEntriesResSchema.parse(rows.map(entryDTO)));
  });

  app.patch("/api/entries/:id", async (c) => {
    const parsed = PatchEntryReqSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    const user = c.get("user");
    const row = await sql.get<EntryRow>("SELECT * FROM entries WHERE id = ?", [c.req.param("id")]);
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.user_id !== user.id) return c.json({ error: "forbidden" }, 403);
    const sets: string[] = [];
    const params: unknown[] = [];
    const d = parsed.data;
    if (d.english !== undefined) { sets.push("english = ?"); params.push(d.english); }
    if (d.notes !== undefined) { sets.push("notes = ?"); params.push(d.notes); }
    if (d.register !== undefined) { sets.push("register = ?"); params.push(d.register); }
    if (d.exampleZh !== undefined) { sets.push("example_zh = ?"); params.push(d.exampleZh); }
    if (d.exampleEn !== undefined) { sets.push("example_en = ?"); params.push(d.exampleEn); }
    if (sets.length) {
      params.push(row.id);
      await sql.run(`UPDATE entries SET ${sets.join(", ")} WHERE id = ?`, params);
    }
    const fresh = await sql.get<EntryRow>(
      "SELECT e.*, u.name AS user_name FROM entries e JOIN users u ON u.id = e.user_id WHERE e.id = ?", [row.id],
    );
    return c.json(entryDTO(fresh!));
  });

  app.delete("/api/entries/:id", async (c) => {
    const user = c.get("user");
    const row = await sql.get<EntryRow>("SELECT * FROM entries WHERE id = ?", [c.req.param("id")]);
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.user_id !== user.id) return c.json({ error: "forbidden" }, 403);
    await sql.run("DELETE FROM entries WHERE id = ?", [row.id]);
    return c.body(null, 204);
  });

  // ---- tts ----
  app.get("/api/tts/status", (c) => c.json({ available: tts.available(), mode: tts.available() ? "server" : "browser" }));
  app.get("/api/tts", async (c) => {
    const text = (c.req.query("text") ?? "").trim();
    const speed = Number(c.req.query("speed") ?? "1");
    if (!text) return c.json({ error: "text required" }, 400);
    const res = await tts.synthesize(text, { speed: Number.isFinite(speed) ? speed : 1 });
    if (!res.ok) return c.json({ error: res.error }, 503);
    return c.body(res.value.data, 200, { "content-type": res.value.mime, "cache-control": "public, max-age=86400" });
  });

  // ---- export ----
  app.get("/api/export.csv", async (c) => {
    const user = c.get("user");
    const rows = await sql.all<EntryRow>(
      "SELECT * FROM entries WHERE user_id = ? ORDER BY created_at DESC", [user.id],
    );
    const esc = (s: string | null) => `"${(s ?? "").replace(/"/g, '""')}"`;
    const csv = [
      "created_at,tradtional,simplified,pinyin,bopomofo,english,register,source,notes",
      ...rows.map((r) =>
        [r.created_at, r.traditional, r.simplified, r.pinyin, r.bpmf, r.english, r.register, r.source, r.notes].map(esc).join(","),
      ),
    ].join("\n");
    return c.body(csv, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="mamahuhu-export.csv"',
    });
  });

  // ---- static SPA (production; in dev vite serves the client) ----
  if (existsSync("./dist/web")) {
    type Env = { Variables: { user: UserRow } };
    app.use("*", serveStatic<Env>({ root: "./dist/web" }));
    app.get("*", serveStatic<Env>({ root: "./dist/web", path: "/index.html" }));
  }

  return { app, deps };
}
