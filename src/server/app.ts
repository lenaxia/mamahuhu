import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  AnnotationsSchema,
  CreateEntryReqSchema,
  EntrySchema,
  HanziReqSchema,
  HanziResSchema,
  HanziWordSchema,
  HanziPhraseSchema,
  ListEntriesResSchema,
  MeSchema,
  OcrResSchema,
  OcrWordSchema,
  AskKindSchema,
  HistoryDetailSchema,
  HistoryItemSchema,
  PatchEntryReqSchema,
  PatchMeReqSchema,
  PinyinReqSchema,
  PinyinResSchema,
  RegisterSchema,
  SttResSchema,
  IdentifySchema,
  FollowUpReqSchema,
  FollowUpResSchema,
  TranslateReqSchema,
  TranslateResSchema,
  type Annotations,
  type Entry,
  type RenderedWord,
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
  GatewaySttService,
  GatewayTtsService,
  GatewayDescribeService,
  LlmTranslationService,
  MockOcrService,
  MockDescribeService,
  MockTaggingService,
  LlmTaggingService,
  MockFollowUpService,
  LlmFollowUpService,
  MockSttService,
  MockTranslationService,
  UnavailableStt,
  UnavailableTts,
} from "./llm";
import { candidates, interpret, normalizePinyinInput, renderWord, segmentHanzi } from "../shared/fuzzy";
import { marksToNumbered, numberedToBpmf, numberedToMarks, stripToneMarks } from "../shared/bpmf";
import { parseImageDims } from "./imageinfo";
import type { AskKind } from "../shared/api";
import type { AppDeps, Result, TranslationService, TtsService, SttService, OcrService, DescribeService, TaggingService, FollowUpService } from "./ports";

export type { AppDeps } from "./ports";

export interface AppOptions {
  sqlitePath?: string;
  postgresUrl?: string;
  llmMock?: boolean;
}

const isHan = (ch: string): boolean => /\p{Script=Han}/u.test(ch);

// ---- history ----

interface AskRow {
  id: string; user_id: string; kind: string; input: string; result: string;
  photo_path: string | null; photo_mime: string | null; photo_w: number; photo_h: number; created_at: string;
}

async function recordAsk(
  sql: Sql,
  userId: string,
  kind: AskKind,
  input: string,
  result: unknown,
  photo?: { path: string; mime: string; w: number; h: number },
): Promise<string> {
  const id = randomUUID();
  await sql.run(
    `INSERT INTO asks (id, user_id, kind, input, result, photo_path, photo_mime, photo_w, photo_h, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, userId, kind, input.slice(0, 500), JSON.stringify(result), photo?.path ?? null, photo?.mime ?? null,
     photo?.w ?? 0, photo?.h ?? 0, new Date().toISOString()],
  ).catch(() => undefined);
  return id;
}

/** Single storage root: mount a Docker volume / PVC here (photos, sqlite, audio cache). */
export const dataDir = (): string => process.env.DATA_DIR ?? "./data";

async function storePhoto(bytes: Uint8Array): Promise<{ path: string; mime: string; w: number; h: number }> {
  mkdirSync(`${dataDir()}/photos`, { recursive: true });
  const dims = parseImageDims(bytes);
  const id = randomUUID();
  try {
    const sharp = (await import("sharp")).default;
    const buf = await sharp(Buffer.from(bytes)).webp({ quality: 80 }).toBuffer();
    const meta = await sharp(buf).metadata();
    const path = `${dataDir()}/photos/${id}.webp`;
    await writeFile(path, buf);
    return { path, mime: "image/webp", w: meta.width ?? dims?.w ?? 0, h: meta.height ?? dims?.h ?? 0 };
  } catch {
    // not a decodable image (e.g. test fixtures): store as-is
    const path = `${dataDir()}/photos/${id}.bin`;
    await writeFile(path, bytes);
    return { path, mime: "application/octet-stream", w: dims?.w ?? 0, h: dims?.h ?? 0 };
  }
}

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
  tags: string; source: string; syllables: string; created_at: string; user_name?: string;
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
    tags: JSON.parse(row.tags ?? "[]") as string[],
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
    sqlitePath: opts.sqlitePath ?? process.env.SQLITE_PATH ?? `${process.env.DATA_DIR ?? "./data"}/app.db`,
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
  const sttModel = process.env.MODEL_STT ?? "";
  const sttMode = (process.env.STT_MODE ?? "auto") as "auto" | "server" | "browser";
  const stt: SttService =
    mock
      ? new MockSttService()
      : sttModel && sttMode !== "browser"
        ? new GatewaySttService({ base, key, model: sttModel })
        : new UnavailableStt();
  const visionModel = process.env.MODEL_VISION ?? "default";
  const ocr: OcrService = mock ? new MockOcrService() : new GatewayOcrService({ base, key, model: visionModel });
  const describe: DescribeService = mock
    ? new MockDescribeService()
    : new GatewayDescribeService({ base, key, model: visionModel });
  const fastModel = process.env.MODEL_FAST ?? "default";
  const tagger: TaggingService = mock
    ? new MockTaggingService()
    : new LlmTaggingService(new GatewayChatClient({ base, key, defaultModel: fastModel }), fastModel);

  const followUp: FollowUpService = mock
    ? new MockFollowUpService()
    : new LlmFollowUpService({ base, key, model: chatModel });

  const deps: AppDeps = { sql, dictionary, translations, tts, stt, ocr, describe, tagger, followUp, sources: new Set() };

/** whole-utterance card for multi-word hanzi input: per-word pinyin + LLM phrase gloss */
async function buildPhrase(
  text: string,
  words: z.infer<typeof HanziWordSchema>[],
): Promise<z.infer<typeof HanziPhraseSchema> | undefined> {
  if (words.length < 2) return undefined;
  const han = words.map((w) => w.traditional).join("");
  // zh meta-question (how-to-say-in-English / what-does-it-mean) → answer, don't translate
  const META = /(英文|english|怎麼說|怎麼講|什麼意思|甚麼意思|意思是|怎麼寫)/i;
  if (META.test(text) || META.test(han)) {
    const answer = await deps.translations.answerZh(text);
    if (answer.ok) {
      return {
        traditional: han,
        simplified: words.map((w) => w.simplified).join(""),
        pinyin: words.map((w) => w.pinyin).filter(Boolean).join(" "),
        bpmf: words.map((w) => w.bpmf).filter(Boolean).join(" "),
        english: answer.value,
        answer: true,
      };
    }
  }
  const gloss = await deps.translations.glossZh(text);
  if (!gloss.ok) return undefined;
  return {
    traditional: han,
    simplified: words.map((w) => w.simplified).join(""),
    pinyin: words.map((w) => w.pinyin).filter(Boolean).join(" "),
    bpmf: words.map((w) => w.bpmf).filter(Boolean).join(" "),
    english: gloss.value,
    answer: false,
  };
}

  const app: App = new Hono<{ Variables: { user: UserRow } }>();

  /** first dictionary sense that isn't a surname/variant note (坐 = "sit", not "surname Zuo") */
  const pickSense = (trad: string): RenderedWord | null => {
    const entries = dictionary.byTrad.get(trad);
    if (!entries?.length) return null;
    const hit = entries.find((e) => !/^(surname|variant of|old variant|see )/i.test(e.english)) ?? entries[0]!;
    return renderWord(hit);
  };

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
    await recordAsk(sql, c.get("user").id, "pinyin", parsed.data.text, res);
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
    const payload = TranslateResSchema.parse({
      source: parsed.data.text,
      understood: res.value.understood,
      register: "casual",
      casual: res.value.casual,
      formal: res.value.formal,
      syllables: casual.syllables,
      formalSyllables: res.value.formal.pinyin !== res.value.casual.pinyin ? formal.syllables : undefined,
      alternatives: alternatives.length ? alternatives : undefined,
      lowConfidence: casual.lowConfidence || formal.lowConfidence || undefined,
    });
    await recordAsk(sql, c.get("user").id, "translate", parsed.data.text, payload);
    return c.json(payload);
  });

  // ---- ask: hanzi input (local dictionary) ----
  app.post("/api/ask/hanzi", async (c) => {
    const parsed = HanziReqSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    const lookup = (seg: string): z.infer<typeof HanziWordSchema> | null => {
      const hit = pickSense(seg);
      return hit && hit.traditional === seg ? { ...hit, known: true } : null;
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
    const payload = HanziResSchema.parse({
      words,
      phrase: words.length > 1 ? await buildPhrase(parsed.data.text, words) : undefined,
    });
    await recordAsk(sql, c.get("user").id, "hanzi", parsed.data.text, payload);
    return c.json(payload);
  });

  // ---- ask: photo OCR (vision) → segmented tappable words ----
  app.post("/api/ask/ocr", async (c) => {
    const user = c.get("user");
    const body = await c.req.parseBody().catch(() => null);
    const image = body && "image" in body ? (body.image as File) : null;
    if (!image || image.size < 10 || image.size > 12 * 1024 * 1024) {
      return c.json({ error: "image required (max 12MB)" }, 400);
    }
    const bytes = new Uint8Array(await image.arrayBuffer());
    const savedRows = await sql.all<{ traditional: string }>(
      "SELECT traditional FROM entries WHERE user_id = ?", [user.id],
    );
    const savedSet = new Set(savedRows.map((r) => r.traditional));
    const lookup = (seg: string) => {
      const hit = pickSense(seg);
      return hit && hit.traditional === seg ? hit : null;
    };
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
      // PDF: render pages to images → same vision-OCR pipeline per page
      try {
        const { pdf } = await import("pdf-to-img");
        const pages: { lines: { words: z.infer<typeof OcrWordSchema>[] }[]; fullText: string; positioned: boolean }[] = [];
        const storedPages: { path: string; mime: string; w: number; h: number }[] = [];
        const pageTexts: string[] = [];
        let count = 0;
        for await (const pageImage of await pdf(new Uint8Array(bytes), { scale: 2 })) {
          if (count >= 6) break;
          const buf = new Uint8Array(pageImage);
          const extracted = await deps.ocr.extract(new File([buf], `page${count}.png`, { type: "image/png" }));
          const storedPage = await storePhoto(buf);
          if (count === 0) {
            // first page doubles as the ask's stored photo
            storedPages.push(storedPage);
          } else {
            const { randomUUID: ru } = await import("node:crypto");
            const fsExtra = await import("node:fs/promises");
            const extraPath = storedPages[0]!.path.replace(/\.(webp|bin)$/, `-p${count + 1}.${{ webp: "webp", bin: "bin" }[storedPages[0]!.path.split(".").pop() as string] ?? "webp"}`);
            void ru; void fsExtra;
            // store extra page images beside the first (same base name, -pN suffix)
            const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
            await wf(extraPath, await rf(storedPage.path));
            storedPages.push({ ...storedPage, path: extraPath });
          }
          const lineOut: { words: z.infer<typeof OcrWordSchema>[] }[] = [];
          const texts: string[] = [];
          let positionedAny = false;
          if (extracted.ok) {
            for (const line of extracted.value.lines) {
              const words: z.infer<typeof OcrWordSchema>[] = [];
              for (const seg of segmentHanzi(line.text)) {
                const hit = lookup(seg);
                if (hit) { words.push({ ...hit, known: true, saved: savedSet.has(seg), box: undefined }); continue; }
                for (const ch of [...seg]) {
                  const chHit = lookup(ch);
                  words.push(chHit ? { ...chHit, known: true, saved: savedSet.has(ch) } : { traditional: ch, simplified: ch, pinyin: "", bpmf: "", english: "", known: false, saved: false });
                }
              }
              if (words.length) { lineOut.push({ words }); texts.push(line.text); }
            }
          }
          void positionedAny;
          pages.push({ lines: lineOut, fullText: texts.join("\n"), positioned: false });
          pageTexts.push(texts.join(" "));
          count++;
        }
        if (count === 0) return c.json({ error: "pdf rendered no pages" }, 502);
        const payload = OcrResSchema.parse({
          lines: pages[0]!.lines, fullText: pageTexts.join("\n\n"), positioned: false,
          pages, pageCount: count,
        });
        await recordAsk(sql, user.id, "ocr", pageTexts.join(" ").slice(0, 200) || `pdf (${count} pages)`, payload, storedPages[0]);
        // stash per-page paths for the ?page= endpoint via naming convention (-pN suffix)
        (payload as { __pagePaths?: string[] }).__pagePaths = storedPages.map((sp) => sp.path);
        await sql.run("UPDATE asks SET result = ? WHERE user_id = ? AND created_at = (SELECT MAX(created_at) FROM asks WHERE user_id = ?)",
          [JSON.stringify({ ...payload, __pagePaths: storedPages.map((sp) => sp.path) }), user.id, user.id]).catch(() => undefined);
        return c.json(payload);
      } catch (e) {
        return c.json({ error: `pdf failed: ${String(e).slice(0, 200)}` }, 502);
      }
    }
    const res = await deps.ocr.extract(new File([bytes], image.name || "page.jpg", { type: image.type || "image/jpeg" }));
    if (!res.ok) return c.json({ error: res.error }, 502);
    const stored = await storePhoto(new Uint8Array(bytes));


    const lines: { words: z.infer<typeof OcrWordSchema>[] }[] = [];
    const lineTexts: string[] = [];
    let positioned = false;
    for (const line of res.value.lines) {
      lineTexts.push(line.text);
      const words: z.infer<typeof OcrWordSchema>[] = [];
      const segments = segmentHanzi(line.text);
      const totalChars = segments.reduce((s, seg) => s + [...seg].length, 0) || 1;
      let xCursor = line.box?.[0];
      for (const seg of segments) {
        const hit = lookup(seg);
        const segLen = [...seg].length;
        let box: [number, number, number, number] | undefined;
        if (line.box && xCursor !== undefined) {
          const w = ((line.box[2] - line.box[0]) * segLen) / totalChars;
          box = [Math.round(xCursor), line.box[1], Math.round(xCursor + w), line.box[3]];
          xCursor += w;
          positioned = true;
        }
        if (hit) {
          words.push({ ...hit, known: true, saved: savedSet.has(seg), box });
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
    if (lines.length === 0) {
      // textless photo → tag every subject; client offers circle-to-refine
      const tags = await identifyTags(bytes);
      const payload = OcrResSchema.parse({
        lines: [], fullText: "", positioned: false,
        tags: tags.length ? tags : [{ traditional: "？", simplified: "?", pinyin: "?", bpmf: "", gloss: "could not identify" }],
        identify: tags[0],
      });
      payload.askId = await recordAsk(sql, user.id, "ocr", tags[0]?.gloss ?? "photo", payload, stored);
      return c.json(payload);
    }
    // text photo: overlay + ALSO tag visible subjects (sign + plant case)
    const objTags = await identifyTags(bytes);
    const payload = OcrResSchema.parse({
      lines, fullText: lineTexts.join("\n"), positioned,
      tags: objTags.length ? objTags : undefined,
      identify: objTags[0],
    });
    payload.askId = await recordAsk(sql, user.id, "ocr", lineTexts.join(" ").slice(0, 200), payload, stored);
    return c.json(payload);
  });

  const identifyTags = async (rawBytes: Uint8Array | Buffer): Promise<(z.infer<typeof IdentifySchema> & { bpmf: string })[]> => {
    const res = await deps.describe.identify(new Blob([new Uint8Array(rawBytes)], { type: "image/jpeg" }));
    if (!res.ok) return [];
    return res.value.tags
      .map((t) => ({ ...t, bpmf: t.pinyin.trim().split(/\s+/).map((sy) => numberedToBpmf(marksToNumbered(sy))).join(" ") }))
      .filter((t) => t.bpmf.trim().length > 0);
  };

  // ---- ask: subject identification (circle-refined crops or explicit calls) ----
  app.post("/api/ask/identify", async (c) => {
    const user = c.get("user");
    const body = await c.req.parseBody().catch(() => null);
    const image = body && "image" in body ? (body.image as File) : null;
    if (!image || image.size < 10 || image.size > 12 * 1024 * 1024) {
      return c.json({ error: "image required (max 12MB)" }, 400);
    }
    const bytes = new Uint8Array(await image.arrayBuffer());
    const tags = await identifyTags(new Uint8Array(await image.arrayBuffer()));
    if (!tags.length) return c.json({ error: "could not identify subject" }, 502);
    const stored = await storePhoto(new Uint8Array(await image.arrayBuffer()));
    const payload = { tags, identify: tags[0] };
    await recordAsk(sql, user.id, "ocr", tags[0]!.gloss, payload, stored);
    return c.json(payload);
  });

  // ---- ask: speak (STT) with auto-routing ----
  app.get("/api/stt/status", (c) => c.json({ available: stt.available(), mode: stt.available() ? "server" : "browser" }));

  app.post("/api/ask/stt", async (c) => {
    const user = c.get("user");
    const body = await c.req.parseBody().catch(() => null);
    const audio = body && "audio" in body ? (body.audio as File) : null;
    if (!audio || audio.size < 10 || audio.size > 25 * 1024 * 1024) {
      return c.json({ error: "audio required (max 25MB)" }, 400);
    }
    const res = await deps.stt.transcribe(audio);
    if (!res.ok) return c.json({ error: res.error }, 502);
    const { text, language } = res.value;

    const hanziLookup = (seg: string): z.infer<typeof HanziWordSchema> | null => {
      const hit = pickSense(seg);
      return hit && hit.traditional === seg ? { ...hit, known: true } : null;
    };
    const hanziFor = (t: string) => {
      const words: z.infer<typeof HanziWordSchema>[] = [];
      for (const seg of segmentHanzi(t)) {
        const direct = hanziLookup(seg);
        if (direct) { words.push({ ...direct, known: true }); continue; }
        for (const ch of [...seg]) {
          words.push(hanziLookup(ch) ?? { traditional: ch, simplified: ch, pinyin: "", bpmf: "", english: "", known: false });
        }
      }
      return HanziResSchema.parse({ words });
    };

    if (isHan(text)) {
      const words = hanziFor(text).words;
      const phrase = words.length > 1 ? await buildPhrase(text, words) : undefined;
      const hanzi = HanziResSchema.parse({ words, phrase });
      const payload = SttResSchema.parse({ text, language, route: "hanzi", hanzi });
      await recordAsk(sql, user.id, "stt", text, payload);
      return c.json(payload);
    }
    const tr = await deps.translations.translate(text);
    if (tr.ok) {
      const casual = buildSyllables(tr.value.casual, dictionary);
      const formal = buildSyllables(tr.value.formal, dictionary);
      const translate = TranslateResSchema.parse({
        source: text,
        register: "casual",
        casual: tr.value.casual,
        formal: tr.value.formal,
        syllables: casual.syllables,
        formalSyllables: tr.value.formal.pinyin !== tr.value.casual.pinyin ? formal.syllables : undefined,
        lowConfidence: casual.lowConfidence || formal.lowConfidence || undefined,
      });
      const payload = SttResSchema.parse({ text, language, route: "translate", translate });
      await recordAsk(sql, user.id, "stt", text, payload);
      return c.json(payload);
    }
    // transcript only — no routing possible
    const payload = SttResSchema.parse({ text, language, route: "text" });
    await recordAsk(sql, user.id, "stt", text, payload);
    return c.json(payload);
  });

  // ---- ask: follow-up Q&A on any card ----
  app.post("/api/ask/followup", async (c) => {
    const user = c.get("user");
    const parsed = FollowUpReqSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    const { question, hanzi, gloss, askId } = parsed.data;
    let photoBytes: Uint8Array | undefined;
    if (askId) {
      const row = await sql.get<AskRow>("SELECT * FROM asks WHERE id = ? AND user_id = ?", [askId, user.id]);
      if (row?.photo_path) {
        try {
          photoBytes = new Uint8Array(await readFile(row.photo_path));
        } catch { /* photo missing — answer without image */ }
      }
    }
    const res = await deps.followUp.ask({ question, hanzi, gloss, photoBytes });
    if (!res.ok) return c.json({ error: res.error }, 502);
    return c.json(FollowUpResSchema.parse(res.value));
  });

  // ---- history ----
  app.get("/api/history", async (c) => {
    const user = c.get("user");
    const rows = await sql.all<AskRow>(
      "SELECT * FROM asks WHERE user_id = ? ORDER BY created_at DESC LIMIT 100", [user.id],
    );
    return c.json(rows.map((r) =>
      HistoryItemSchema.parse({
        id: r.id,
        kind: AskKindSchema.parse(r.kind),
        input: r.input,
        hasPhoto: r.photo_path !== null,
        createdAt: r.created_at,
      }),
    ));
  });

  app.get("/api/history/:id", async (c) => {
    const user = c.get("user");
    const row = await sql.get<AskRow>("SELECT * FROM asks WHERE id = ? AND user_id = ?", [c.req.param("id"), user.id]);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(HistoryDetailSchema.parse({
      id: row.id,
      kind: AskKindSchema.parse(row.kind),
      input: row.input,
      createdAt: row.created_at,
      photoUrl: row.photo_path ? `/api/photo/${row.id}` : null,
      photoW: row.photo_w,
      photoH: row.photo_h,
      result: JSON.parse(row.result),
    }));
  });

  app.delete("/api/history", async (c) => {
    const user = c.get("user");
    const rows = await sql.all<AskRow>("SELECT * FROM asks WHERE user_id = ?", [user.id]);
    for (const r of rows) {
      if (r.photo_path) await unlink(r.photo_path).catch(() => undefined);
    }
    await sql.run("DELETE FROM asks WHERE user_id = ?", [user.id]);
    return c.body(null, 204);
  });

  app.delete("/api/history/:id", async (c) => {
    const user = c.get("user");
    const row = await sql.get<AskRow>("SELECT * FROM asks WHERE id = ? AND user_id = ?", [c.req.param("id"), user.id]);
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.photo_path) await unlink(row.photo_path).catch(() => undefined);
    await sql.run("DELETE FROM asks WHERE id = ?", [row.id]);
    return c.body(null, 204);
  });

  app.get("/api/photo/:id", async (c) => {
    const user = c.get("user");
    const row = await sql.get<AskRow>("SELECT * FROM asks WHERE id = ? AND user_id = ?", [c.req.param("id"), user.id]);
    if (!row?.photo_path) return c.json({ error: "not found" }, 404);
    let path = row.photo_path;
    const page = Number(c.req.query("page") ?? "1");
    if (page > 1) {
      const stored = JSON.parse(row.result) as { __pagePaths?: string[] };
      path = stored.__pagePaths?.[page - 1] ?? path;
    }
    try {
      const buf = await readFile(path);
      return c.body(new Uint8Array(buf), 200, {
        "content-type": row.photo_mime ?? "application/octet-stream",
        "cache-control": "private, max-age=31536000, immutable",
      });
    } catch {
      return c.json({ error: "photo missing" }, 404);
    }
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
    // topical tags via the fast model — indexed for search (never blocks save on failure)
    const tagged = await deps.tagger.tagsFor({ traditional: e.traditional, english: e.english }).catch(() => null);
    const tags = tagged?.ok ? tagged.value : [];
    await sql.run(
      `INSERT INTO entries (id, user_id, variety, traditional, simplified, pinyin, pinyin_flat, bpmf, english, register, example_zh, example_en, notes, tags, source, syllables, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, user.id, "zh-Hant", e.traditional, e.simplified, e.pinyin, flat, e.bpmf, e.english, e.register,
       e.exampleZh ?? null, e.exampleEn ?? null, e.notes ?? null, JSON.stringify(tags), e.source, JSON.stringify(e.syllables), new Date().toISOString()],
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
      where.push("(LOWER(e.traditional) LIKE ? OR LOWER(e.simplified) LIKE ? OR e.pinyin_flat LIKE ? OR LOWER(e.english) LIKE ? OR LOWER(e.tags) LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
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
      "created_at,tradtional,simplified,pinyin,bopomofo,english,register,source,tags,notes",
      ...rows.map((r) =>
        [r.created_at, r.traditional, r.simplified, r.pinyin, r.bpmf, r.english, r.register, r.source, JSON.parse(r.tags ?? "[]").join(" "), r.notes].map(esc).join(","),
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
