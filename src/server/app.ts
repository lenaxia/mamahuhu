import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync as readFileSyncSync } from "node:fs";
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
  ReviewReqSchema,
  ReviewResSchema,
  PinyinReqSchema,
  PinyinResSchema,
  RegisterSchema,
  SttResSchema,
  IdentifySchema,
  FollowUpReqSchema,
  FollowUpResSchema,
  TranslateReqSchema,
  TranslateResSchema,
  VarietySchema,
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
  FallbackChatClient,
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
import { toTraditional } from "../shared/cedict";
import { annotateJyut, segmentJyut } from "../shared/jyutping";
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

/** Normalizes uploads: applies EXIF orientation, re-encodes to a decodable
 *  jpeg. Returns null when the bytes are not a usable image at all. */
async function normalizeImage(bytes: Uint8Array): Promise<{ data: Uint8Array; w: number; h: number } | null> {
  const sharp = (await import("sharp")).default;
  try {
    const buf = await sharp(Buffer.from(bytes)).rotate().jpeg({ quality: 88 }).toBuffer();
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return null;
    return { data: new Uint8Array(buf), w: meta.width, h: meta.height };
  } catch {
    return null;
  }
}

async function storePhoto(bytes: Uint8Array): Promise<{ path: string; mime: string; w: number; h: number }> {
  mkdirSync(`${dataDir()}/photos`, { recursive: true });
  const dims = parseImageDims(bytes);
  const id = randomUUID();
  try {
    const sharp = (await import("sharp")).default;
    const buf = await sharp(Buffer.from(bytes)).rotate().webp({ quality: 80 }).toBuffer();
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
    varieties: JSON.parse(row.varieties ?? '["zh-Hant"]') as string[],
    primaryVariety: row.primary_variety ?? "zh-Hant",
  });
}

interface EntryRow {
  id: string; user_id: string; variety: string; traditional: string; simplified: string;
  pinyin: string; pinyin_flat: string; bpmf: string; jyutping: string; formal_zh: string; formal_jyut: string;
  english: string; register: string;
  example_zh: string | null; example_en: string | null; notes: string | null;
  tags: string; source: string; syllables: string; created_at: string; ask_id?: string | null; user_name?: string;
  srs_box: number; srs_due: string | null; srs_streak: number; review_count: number;
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
    jyutping: row.jyutping ?? "",
    formalZh: row.formal_zh ?? "",
    formalJyut: row.formal_jyut ?? "",
    english: row.english,
    register: RegisterSchema.parse(row.register),
    exampleZh: row.example_zh,
    exampleEn: row.example_en,
    notes: row.notes,
    tags: JSON.parse(row.tags ?? "[]") as string[],
    source: row.source,
    syllables: JSON.parse(row.syllables) as Syllables,
    createdAt: row.created_at,
    srsBox: row.srs_box ?? 0,
    srsDue: row.srs_due ?? null,
    srsStreak: row.srs_streak ?? 0,
    askId: row.ask_id ?? null,
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

/** zh-HK: dictionary-derived jyutping syllables (word groups → per-char readings).
 *  The LLM never supplies romanization for canto (bench/canto-report.md). */
function buildCantoSyllables(text: string): Syllables {
  const out: Syllables = [];
  for (const part of segmentJyut(text)) {
    const chars = [...part.word];
    if (!chars.some(isHan)) continue; // punctuation passes through silently
    const sylls = part.jyut?.split(" ") ?? [];
    const chunk: Syllables[number] = chars.map((h) => ({ h, py: "", bpmf: "" }));
    if (sylls.length === chars.length) {
      chars.forEach((_, i) => {
        chunk[i]!.py = sylls[i] ?? "";
      });
    }
    out.push(chunk);
  }
  return out;
}

/** Decorates a canto variant with dictionary jyutping (in place + returned). */
function decorateCanto(variant: CardVariant): CardVariant {
  variant.jyutping = annotateJyut(variant.traditional);
  variant.pinyin = variant.jyutping; // single romanization column; flat search works on jyutping too
  return variant;
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
  // optional: retry chat calls on this model when the primary fails (unset = graceful, no retry)
  const chatFallback = process.env.MODEL_CHAT_FALLBACK?.trim() || undefined;
  // TTS_MODE: auto (default) = server model when configured, else browser;
  // server = force gateway TTS; browser = force browser speechSynthesis.
  const ttsMode = (process.env.TTS_MODE ?? "auto") as "auto" | "server" | "browser";
  const ttsModel = process.env.MODEL_TTS ?? "";

  const translations: TranslationService = mock
    ? new MockTranslationService()
    : new LlmTranslationService(new FallbackChatClient(new GatewayChatClient({ base, key, defaultModel: chatModel }), chatFallback), chatModel);

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
  let ocr: OcrService = mock ? new MockOcrService() : new GatewayOcrService({ base, key, model: visionModel });
  // OCR_LADDER=1: deterministic classical OCR first, LLM fallback (bench/ocr-ladder.ts)
  if (!mock && process.env.OCR_LADDER === "1") {
    const { LadderOcrService, RapidOcrService } = await import("./ocr-ladder");
    ocr = new LadderOcrService(
      new RapidOcrService({
        python: process.env.OCR_PYTHON ?? "/tmp/opencode/ocrvenv/bin/python",
        script: process.env.OCR_SCRIPT ?? "scripts/rapid-json.py",
      }),
      ocr,
      { base, key, model: visionModel },
    );
  }
  const describe: DescribeService = mock
    ? new MockDescribeService()
    : new GatewayDescribeService({ base, key, model: visionModel });
  const fastModel = process.env.MODEL_FAST ?? "default";
  const tagger: TaggingService = mock
    ? new MockTaggingService()
    : new LlmTaggingService(new FallbackChatClient(new GatewayChatClient({ base, key, defaultModel: fastModel }), chatFallback), fastModel);

  const followUp: FollowUpService = mock
    ? new MockFollowUpService()
    : new LlmFollowUpService({ base, key, model: chatModel });

  const deps: AppDeps = { sql, dictionary, translations, tts, stt, ocr, describe, tagger, followUp, sources: new Set() };

/** whole-utterance card for multi-word hanzi input: per-word pinyin + LLM phrase gloss */
async function buildPhrase(
  text: string,
  words: z.infer<typeof HanziWordSchema>[],
): Promise<{ phrase?: z.infer<typeof HanziPhraseSchema>; fullTranslation?: string } | undefined> {
  if (words.length < 2) return undefined;
  const han = words.map((w) => w.traditional).join("");
  // zh meta-question (how-to-say-in-English / what-does-it-mean) → answer, don't translate
  const META = /(英文|english|怎麼說|怎麼講|什麼意思|甚麼意思|意思是|怎麼寫)/i;
  if (META.test(text) || META.test(han)) {
    const answer = await deps.translations.answerZh(text);
    if (answer.ok) {
      return {
        phrase: {
          traditional: han,
          simplified: words.map((w) => w.simplified).join(""),
          pinyin: words.map((w) => w.pinyin).filter(Boolean).join(" "),
          bpmf: words.map((w) => w.bpmf).filter(Boolean).join(" "),
          english: answer.value,
          answer: true,
        },
      };
    }
  }
  // normal multi-word text: the LLM decides via fullZh whether a complete
  // translation adds anything beyond the word cards ("" = omit)
  const full = await deps.translations.fullZh(text);
  return full.ok && full.value ? { fullTranslation: full.value } : undefined;
}

  const app: App = new Hono<{ Variables: { user: UserRow } }>();

  /** first dictionary sense that isn't a surname/variant note (坐 = "sit", not "surname Zuo").
   *  Looks up traditional first, then simplified — mainland print is 简体. */
  const pickSense = (trad: string): RenderedWord | null => {
    const entries = dictionary.byTrad.get(trad) ?? dictionary.bySimp.get(trad);
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
    if (parsed.data.varieties !== undefined) { sets.push("varieties = ?"); params.push(JSON.stringify(parsed.data.varieties)); }
    if (parsed.data.primaryVariety !== undefined) { sets.push("primary_variety = ?"); params.push(parsed.data.primaryVariety); }
    if (sets.length) {
      params.push(user.id);
      await sql.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, params);
    }
    const fresh = await sql.get<UserRow>("SELECT * FROM users WHERE id = ?", [user.id]);
    // invariant: primary must be one of the enabled varieties
    const me = meDTO(fresh!);
    return c.json(me.primaryVariety && !me.varieties.includes(me.primaryVariety)
      ? MeSchema.parse({ ...me, primaryVariety: me.varieties[0] })
      : me);
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
    const user = c.get("user");
    const variety: "zh-Hant" | "zh-HK" = parsed.data.variety
      ?? (VarietySchema.safeParse(user.primary_variety).success ? (user.primary_variety as "zh-Hant" | "zh-HK") : "zh-Hant");
    const res = await deps.translations.translate(parsed.data.text, { audience: user.audience ?? parsed.data.audience, variety });
    if (!res.ok) return c.json({ error: res.error }, 502);
    const canto = variety === "zh-HK";
    if (canto) {
      decorateCanto(res.value.casual);
      decorateCanto(res.value.formal);
      for (const alt of res.value.alternatives) {
        decorateCanto(alt.casual);
        decorateCanto(alt.formal);
      }
    }
    const casual = canto
      ? { syllables: buildCantoSyllables(res.value.casual.traditional), lowConfidence: false }
      : buildSyllables(res.value.casual, dictionary);
    const formal = canto
      ? { syllables: buildCantoSyllables(res.value.formal.traditional), lowConfidence: false }
      : buildSyllables(res.value.formal, dictionary);
    const alternatives = res.value.alternatives
      .map((alt) => {
        const cs = canto ? { syllables: buildCantoSyllables(alt.casual.traditional), lowConfidence: false } : buildSyllables(alt.casual, dictionary);
        const fs = canto ? { syllables: buildCantoSyllables(alt.formal.traditional), lowConfidence: false } : buildSyllables(alt.formal, dictionary);
        return { casual: { variant: alt.casual, syllables: cs.syllables }, formal: { variant: alt.formal, syllables: fs.syllables }, ok: !cs.lowConfidence && !fs.lowConfidence };
      })
      .filter((a) => a.ok)
      .map(({ casual, formal }) => ({ casual, formal }));
    const payload = TranslateResSchema.parse({
      source: parsed.data.text,
      understood: res.value.understood,
      register: "casual",
      variety,
      casual: res.value.casual,
      formal: res.value.formal,
      syllables: casual.syllables,
      formalSyllables: res.value.formal.pinyin !== res.value.casual.pinyin ? formal.syllables : undefined,
      alternatives: alternatives.length ? alternatives : undefined,
      lowConfidence: casual.lowConfidence || formal.lowConfidence || undefined,
    });
    const askId = await recordAsk(sql, user.id, "translate", parsed.data.text, payload);
    payload.askId = askId;
    // keep the stored copy in sync so history replay also carries the link
    await sql.run("UPDATE asks SET result = ? WHERE id = ?", [JSON.stringify(payload), askId]).catch(() => undefined);
    return c.json(payload);
  });

  // ---- ask: hanzi input (local dictionary) ----
  app.post("/api/ask/hanzi", async (c) => {
    const parsed = HanziReqSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    const lookup = (seg: string): z.infer<typeof HanziWordSchema> | null => {
      const hit = pickSense(seg);
      return hit && (hit.traditional === seg || hit.simplified === seg) ? { ...hit, known: true } : null;
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
    const built = words.length > 1 ? await buildPhrase(parsed.data.text, words) : undefined;
    const payload = HanziResSchema.parse({
      text: parsed.data.text,
      words,
      phrase: built?.phrase,
      fullTranslation: built?.fullTranslation,
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
    const normalized = await normalizeImage(bytes);
    if (!normalized) return c.json({ error: "couldn't read that image — try retaking or picking a different file" }, 400);
    const nBytes = normalized.data;
    const savedRows = await sql.all<{ traditional: string }>(
      "SELECT traditional FROM entries WHERE user_id = ?", [user.id],
    );
    const savedSet = new Set(savedRows.map((r) => r.traditional));
    const lookup = (seg: string) => {
      const hit = pickSense(seg);
      return hit && (hit.traditional === seg || hit.simplified === seg) ? hit : null;
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
        const pdfFull = await fullTranslation(pageTexts.join("\n"));
        const payload = OcrResSchema.parse({
          lines: pages[0]!.lines, fullText: pageTexts.join("\n\n"), positioned: false,
          pages, pageCount: count,
          fullTranslation: pdfFull,
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
    const res = await deps.ocr.extract(new File([new Uint8Array(nBytes)], image.name || "page.jpg", { type: "image/jpeg" }));
    if (!res.ok) return c.json({ error: res.error }, 502);
    const stored = await storePhoto(new Uint8Array(nBytes));


    const lines: { words: z.infer<typeof OcrWordSchema>[] }[] = [];
    const lineTexts: string[] = [];
    let positioned = false;
    // model dir labels are noisy (measured: a horizontal poster fully tagged "v");
    // box geometry is reliable — when they disagree, trust geometry
    const lineDir = (
      dir: "h" | "v" | undefined,
      box: [number, number, number, number] | undefined,
      chars: number,
    ): "h" | "v" | undefined => {
      if (!box) return dir;
      const bw = box[2] - box[0];
      const bh = box[3] - box[1];
      if (bw > bh) return dir === "v" ? "h" : (dir ?? "h"); // wide box can't be a column
      if (bh > bw && chars > 1) return dir === "h" ? "v" : (dir ?? "v"); // tall box can't be a row
      return dir;
    };
    /** char cell along the line VECTOR at fraction [s,e) of its length — square-ish
     *  cell centered on the axis so rotated chips render true at any angle */
    const cellAlong = (
      f: [number, number], to: [number, number], len: number, s: number, e: number, chars: number,
    ): [number, number, number, number] => {
      const ux = (to[0] - f[0]) / len;
      const uy = (to[1] - f[1]) / len;
      const cx = f[0] + ux * (s + (e - s) / 2) * len;
      const cy = f[1] + uy * (s + (e - s) / 2) * len;
      const half = ((e - s) * len) / 2;
      void chars;
      // SQUARE char cell (side = span along the axis) — axis-projecting a
      // 60° cell halves its width and shrink-to-fit crushes the font
      return [Math.round(cx - half), Math.round(cy - half), Math.round(cx + half), Math.round(cy + half)];
    };
    // median char pitch across vector lines — handwriting has uniform glyph
    // size; lines whose own pitch is within 30% of the median snap to it, so
    // chips render one consistent size (genuine outliers like word clouds keep theirs)
    const vecPitches = res.value.lines
      .filter((l) => l.from && l.to)
      .map((l) => Math.hypot(l.to![0]! - l.from![0]!, l.to![1]! - l.from![1]!) / Math.max(1, [...l.text].length))
      .sort((a, b) => a - b);
    const medianPitch = vecPitches.length ? vecPitches[Math.floor(vecPitches.length / 2)]! : 0;

    for (const line of res.value.lines) {
      const dir = lineDir(line.dir, line.box, [...line.text].length);
      lineTexts.push(line.text);
      const words: z.infer<typeof OcrWordSchema>[] = [];
      const segments = segmentHanzi(line.text);
      const totalChars = segments.reduce((s, seg) => s + [...seg].length, 0) || 1;
      let xCursor = line.box?.[0];
      let yCursor = line.box?.[1];
      // VECTOR lines: distribute word cells along the from→to axis; each word
      // carries the line angle so the overlay renders rotated to the text
      let charCursor = 0;
      const lineAngle = line.angle;
      let along: undefined | ((s: number, e: number) => [number, number, number, number]);
      if (line.from && line.to) {
        const rawLen = Math.hypot(line.to[0]! - line.from[0]!, line.to[1]! - line.from[1]!);
        const ownPitch = rawLen / Math.max(1, totalChars);
        // snap to median when close: uniform glyphs AND extends undershot vectors
        const len = medianPitch > 0 && Math.abs(ownPitch - medianPitch) / medianPitch <= 0.3
          ? medianPitch * totalChars
          : rawLen;
        const ux = (line.to[0]! - line.from[0]!) / rawLen;
        const uy = (line.to[1]! - line.from[1]!) / rawLen;
        const to: [number, number] = [line.from[0]! + ux * len, line.from[1]! + uy * len];
        along = (s: number, e: number) => cellAlong(line.from!, to, len, s, e, totalChars);
      }
      for (const seg of segments) {
        const hit = lookup(seg);
        const segLen = [...seg].length;
        let box: [number, number, number, number] | undefined;
        if (along) {
          box = along(charCursor / totalChars, (charCursor + segLen) / totalChars);
          positioned = true;
        } else if (line.box) {
          if (dir === "v" && yCursor !== undefined) {
            // vertical column: split the line box along Y by char count
            const hStep = ((line.box[3] - line.box[1]) * segLen) / totalChars;
            box = [line.box[0], Math.round(yCursor), line.box[2], Math.round(yCursor + hStep)];
            yCursor += hStep;
          } else if (xCursor !== undefined) {
            const w = ((line.box[2] - line.box[0]) * segLen) / totalChars;
            box = [Math.round(xCursor), line.box[1], Math.round(xCursor + w), line.box[3]];
            xCursor += w;
          }
          if (box) positioned = true;
        }
        if (hit) {
          words.push({ ...hit, known: true, saved: savedSet.has(hit.traditional), box, dir, ...(lineAngle !== undefined ? { angle: lineAngle } : {}) });
          charCursor += segLen;
          continue;
        }
        // char decomposition: split the segment box across its chars so no
        // word loses its position (was: box dropped → chip invisible)
        const chs = [...seg];
        chs.forEach((ch, ci) => {
          let chBox: [number, number, number, number] | undefined;
          if (along) {
            chBox = along((charCursor + ci) / totalChars, (charCursor + ci + 1) / totalChars);
          } else if (box) {
            const cw = (box[2] - box[0]) / chs.length;
            chBox = [
              Math.round(box[0] + cw * ci),
              box[1],
              Math.round(box[0] + cw * (ci + 1)),
              box[3],
            ];
          }
          const charHit = lookup(ch);
          if (charHit) words.push({ ...charHit, known: true, saved: savedSet.has(charHit.traditional), box: chBox, dir, ...(lineAngle !== undefined ? { angle: lineAngle } : {}) });
          else words.push({ traditional: toTraditional(ch), simplified: ch, pinyin: "", bpmf: "", english: "", known: false, saved: false, box: chBox, dir, ...(lineAngle !== undefined ? { angle: lineAngle } : {}) });
        });
        charCursor += segLen;
      }
      if (words.length) lines.push({ words });
    }
    if (lines.length === 0) {
      // textless photo → tag every subject; client offers circle-to-refine
      const tags = await identifyTags(nBytes);
      const payload = OcrResSchema.parse({
        lines: [], fullText: "", positioned: false,
        tags: tags.length ? tags : [{ traditional: "？", simplified: "?", pinyin: "?", bpmf: "", gloss: "could not identify" }],
        identify: tags[0],
      });
      payload.askId = await recordAsk(sql, user.id, "ocr", tags[0]?.gloss ?? "photo", payload, stored);
      return c.json(payload);
    }
    // text photo: overlay + ALSO tag visible subjects (sign + plant case)
    const [objTags, fullTranslationText] = await Promise.all([
      identifyTags(nBytes),
      fullTranslation(lineTexts.join("\n")),
    ]);
    const payload = OcrResSchema.parse({
      lines, fullText: lineTexts.join("\n"), positioned,
      tags: objTags.length ? objTags : undefined,
      identify: objTags[0],
      fullTranslation: fullTranslationText,
    });
    payload.askId = await recordAsk(sql, user.id, "ocr", lineTexts.join(" ").slice(0, 200), payload, stored);
    return c.json(payload);
  });

  /** full English translation for photos/PDFs — the LLM decides when it adds
   *  anything beyond the word chips ("" = omit) */
  const fullTranslation = async (fullText: string): Promise<string | undefined> => {
    const res = await deps.translations.fullZh(fullText.trim());
    return res.ok && res.value ? res.value : undefined;
  };

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
    const normalized = await normalizeImage(bytes);
    if (!normalized) return c.json({ error: "couldn't read that image — try retaking" }, 400);
    const tags = await identifyTags(normalized.data);
    if (!tags.length) return c.json({ error: "could not identify subject" }, 502);
    const stored = await storePhoto(normalized.data);
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
      return hit && (hit.traditional === seg || hit.simplified === seg) ? { ...hit, known: true } : null;
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
      const built = words.length > 1 ? await buildPhrase(text, words) : undefined;
      const hanzi = HanziResSchema.parse({ text, words, phrase: built?.phrase, fullTranslation: built?.fullTranslation });
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
    const { question, hanzi, gloss, askId, variety, history } = parsed.data;
    let photoBytes: Uint8Array | undefined;
    if (askId) {
      const row = await sql.get<AskRow>("SELECT * FROM asks WHERE id = ? AND user_id = ?", [askId, user.id]);
      if (row?.photo_path) {
        try {
          photoBytes = new Uint8Array(await readFile(row.photo_path));
        } catch { /* photo missing — answer without image */ }
      }
    }
    const res = await deps.followUp.ask({ question, hanzi, gloss, photoBytes, variety, history });
    if (!res.ok) return c.json({ error: res.error }, 502);
    return c.json(FollowUpResSchema.parse({ answer: res.value.answer, answerWritten: res.value.answerWritten, variety }));
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
      "SELECT e.*, u.name AS user_name FROM entries e JOIN users u ON u.id = e.user_id WHERE e.user_id = ? AND e.traditional = ? AND e.pinyin = ? AND e.variety = ?",
      [user.id, e.traditional, e.pinyin, e.variety],
    );
    if (dup) return c.json({ ...entryDTO(dup), duplicate: true });
    const id = randomUUID();
    const flat = e.pinyinFlat || stripToneMarks(e.pinyin).replace(/\s+/g, "");
    // topical tags via the fast model — indexed for search (never blocks save on failure)
    const tagged = await deps.tagger.tagsFor({ traditional: e.traditional, english: e.english }).catch(() => null);
    const tags = tagged?.ok ? tagged.value : [];
    await sql.run(
      `INSERT INTO entries (id, user_id, variety, traditional, simplified, pinyin, pinyin_flat, bpmf, jyutping, formal_zh, formal_jyut, english, register, example_zh, example_en, notes, tags, source, syllables, ask_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, user.id, e.variety, e.traditional, e.simplified, e.pinyin, flat, e.bpmf, e.jyutping, e.formalZh, e.formalJyut, e.english, e.register,
       e.exampleZh ?? null, e.exampleEn ?? null, e.notes ?? null, JSON.stringify(tags), e.source, JSON.stringify(e.syllables), e.askId ?? null, new Date().toISOString()],
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
      // multi-token AND search: every word must hit some field (substring),
      // so "airport terminal", "airp", or "sleep bed" all work
      const tokens = q.split(/\s+/).filter(Boolean);
      for (const tok of tokens) {
        where.push("(LOWER(e.traditional) LIKE ? OR LOWER(e.simplified) LIKE ? OR e.pinyin_flat LIKE ? OR LOWER(e.english) LIKE ? OR LOWER(e.tags) LIKE ?)");
        const like = `%${tok}%`;
        params.push(like, like, like, like, like);
      }
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
  // canto voice: separate gateway model (e.g. edge-tts sidecar) + HK voice; falls
  // back to unavailable → client uses browser speechSynthesis zh-HK
  const ttsCaModel = process.env.MODEL_TTS_CA ?? "";
  const ttsCa: TtsService = !mock && ttsCaModel && ttsMode !== "browser"
    ? new GatewayTtsService({ base, key, model: ttsCaModel, voice: process.env.TTS_VOICE_CA ?? "zh-HK-HiuMaanNeural" })
    : new UnavailableTts();
  app.get("/api/tts/status", (c) => c.json({
    available: tts.available(), mode: tts.available() ? "server" : "browser",
    cantoAvailable: ttsCa.available(), cantoMode: ttsCa.available() ? "server" : "browser",
  }));
  app.get("/api/tts", async (c) => {
    const text = (c.req.query("text") ?? "").trim();
    const speed = Number(c.req.query("speed") ?? "1");
    const variety = c.req.query("variety") === "zh-HK" ? "zh-HK" : "zh-Hant";
    if (!text) return c.json({ error: "text required" }, 400);
    const sp = Number.isFinite(speed) ? speed : 1;
    const engine = variety === "zh-HK" ? ttsCa : tts;
    const voice = variety === "zh-HK" ? (process.env.TTS_VOICE_CA ?? "zh-HK-HiuMaanNeural") : (process.env.TTS_VOICE ?? "zf_xiaoxiao");
    // disk cache under DATA_DIR/audio — synthesize once, replay forever (keyed by voice:
    // mandarin and canto readings of the same hanzi must never collide)
    const { createHash } = await import("node:crypto");
    const key = createHash("sha256").update(`${text}|${sp}|${voice}`).digest("hex").slice(0, 40);
    const dir = `${dataDir()}/audio`;
    const path = `${dir}/${key}.mp3`;
    try {
      const buf = await readFile(path);
      return c.body(new Uint8Array(buf), 200, { "content-type": "audio/mpeg", "cache-control": "public, max-age=31536000, immutable", "x-tts-cache": "hit" });
    } catch {
      /* miss */
    }
    const res = await engine.synthesize(text, { speed: sp });
    if (!res.ok) return c.json({ error: res.error }, 503);
    try {
      const { mkdir: mk, writeFile: wf } = await import("node:fs/promises");
      await mk(dir, { recursive: true });
      await wf(path, res.value.data);
      await sql.run(
        "INSERT INTO audio_files (key, path, bytes, mime, created_at) VALUES (?,?,?,?,?) ON CONFLICT(key) DO NOTHING",
        [key, path, res.value.data.byteLength, "audio/mpeg", new Date().toISOString()],
      ).catch(() => undefined);
    } catch {
      /* cache write is best-effort */
    }
    return c.body(res.value.data, 200, { "content-type": res.value.mime, "cache-control": "public, max-age=31536000, immutable", "x-tts-cache": "miss" });
  });

  // ---- SRS review (Leitner: box 0-5, intervals 10m/1h/8h/1d/3d/7d) ----
  const SRS_INTERVALS = [10 * 60e3, 60 * 60e3, 8 * 60 * 60e3, 24 * 60 * 60e3, 3 * 24 * 60 * 60e3, 7 * 24 * 60 * 60e3];

  app.get("/api/review/due", async (c) => {
    const user = c.get("user");
    const now = new Date().toISOString();
    const rows = await sql.all<EntryRow>(
      `SELECT e.*, u.name AS user_name FROM entries e JOIN users u ON u.id = e.user_id
       WHERE e.user_id = ? AND (e.srs_due IS NULL OR e.srs_due <= ?)
       ORDER BY e.srs_due IS NULL DESC, e.created_at DESC LIMIT 50`,
      [user.id, now],
    );
    return c.json(ListEntriesResSchema.parse(rows.map(entryDTO)));
  });

  app.post("/api/review", async (c) => {
    const user = c.get("user");
    const parsed = ReviewReqSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    const { id, outcome } = parsed.data;
    const row = await sql.get<EntryRow>("SELECT * FROM entries WHERE id = ? AND user_id = ?", [id, user.id]);
    if (!row) return c.json({ error: "not found" }, 404);
    let box = row.srs_box ?? 0;
    if (outcome === "again") box = 0;
    else if (outcome === "hard") box = Math.max(0, box - 1);
    else if (outcome === "good") box = Math.min(5, box + 1);
    else box = Math.min(5, box + 2); // easy
    const due = new Date(Date.now() + SRS_INTERVALS[box]!).toISOString();
    await sql.run(
      "UPDATE entries SET srs_box = ?, srs_due = ?, srs_streak = ?, review_count = review_count + 1 WHERE id = ?",
      [box, due, outcome === "again" ? 0 : (row.srs_streak ?? 0) + 1, id],
    );
    return c.json(ReviewResSchema.parse({ id, srsBox: box, srsDue: due, reviewed: (row.review_count ?? 0) + 1 }));
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
    app.get("/", (c) => c.html(readFileSyncSync("./dist/web/index.html", "utf8"), 200, { "cache-control": "no-store" }));
    app.use("*", serveStatic<Env>({ root: "./dist/web" }));
    app.get("*", (c) => c.html(readFileSyncSync("./dist/web/index.html", "utf8"), 200, { "cache-control": "no-store" }));
  }

  return { app, deps };
}
