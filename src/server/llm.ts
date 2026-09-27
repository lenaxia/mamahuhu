import { LlmTranslateSchema, type CardVariant } from "../shared/api";
import { marksToNumbered, numberedToBpmf, numberedToMarks } from "../shared/bpmf";
import { normalizeBoxes, parseImageDims } from "./imageinfo";
import type { ChatClient, ChatMessage, ChatOptions, Result, TranslationService, TtsService, SttService, OcrService, OcrLine } from "./ports";

const isHan = (ch: string): boolean => /\p{Script=Han}/u.test(ch);
const countHanzi = (s: string): number => [...s].filter(isHan).length;

function completeVariant(v: {
  traditional: string;
  simplified: string;
  pinyin: string;
  gloss: string;
  note?: string;
}): CardVariant {
  const marks = v.pinyin.trim().split(/\s+/).filter(Boolean).map((s) => numberedToMarks(marksToNumbered(s)));
  const bpmf = v.pinyin.trim().split(/\s+/).filter(Boolean).map((s) => numberedToBpmf(marksToNumbered(s)));
  return {
    traditional: v.traditional,
    simplified: v.simplified || v.traditional,
    pinyin: marks.join(" "),
    bpmf: bpmf.join(" "),
    gloss: v.gloss,
    note: v.note,
  };
}

function variantValid(v: CardVariant): boolean {
  const syls = v.pinyin.trim().split(/\s+/).filter(Boolean);
  if (syls.length !== countHanzi(v.traditional)) return false;
  return syls.every((s) => numberedToBpmf(marksToNumbered(s)) !== "");
}

/** Pulls the first balanced JSON object out of LLM text (handles code fences). */
export function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, "").replace(/```/g, "");
  const start = stripped.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(stripped.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export class GatewayChatClient implements ChatClient {
  constructor(
    private cfg: { base: string; key: string; defaultModel: string },
  ) {}

  async complete(messages: ChatMessage[], opts?: ChatOptions): Promise<Result<string>> {
    const model = opts?.model ?? this.cfg.defaultModel;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 45000);
    try {
      const res = await fetch(`${this.cfg.base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.key}` },
        body: JSON.stringify({
          model,
          messages,
          temperature: opts?.temperature ?? 0.3,
          ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        return { ok: false, error: `gateway ${res.status}: ${body}`, retryable: res.status >= 500 || res.status === 429 };
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (!content) return { ok: false, error: "empty completion" };
      return { ok: true, value: content };
    } catch (e) {
      return { ok: false, error: `chat failed: ${String(e)}`, retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }
}

const TRANSLATE_SYSTEM = `You translate English into natural, Taiwan-style Traditional Chinese Mandarin.
Return ONLY valid JSON, no prose, matching exactly:
{"casual":{"traditional":"…","simplified":"…","pinyin":"…","gloss":"…","note":"…"},
 "formal":{"traditional":"…","simplified":"…","pinyin":"…","gloss":"…","note":"…"},
 "alternatives":[{"casual":{…},"formal":{…}}]}
Rules:
- Translate MEANING AND INTENT, never word-for-word. Ask: what would a Taiwanese speaker
  actually say here? If the literal rendering sounds foreign or awkward in Mandarin,
  discard it and use the natural equivalent.
  e.g. "time for a bath" → 該洗澡了 (never 該洗澡的時間了); "good job!" → 好棒/好厲害 (never 好工作);
  "hold my hand" → 牽我的手; "watch out!" → 小心 (never 觀看).
- "casual" is colloquial, everyday spoken Mandarin; "formal" is standard, polite, written/official register.
  If an audience hint is provided, tune BOTH registers to that audience — but never mention the audience in notes.
- Honor inline disambiguation in the input (e.g. "not the plane itself" → the service/booking, not the vehicle).
- If the English is ambiguous or has other common senses, list 2-3 "alternatives" (most likely first)
  covering those other senses. EACH alternative is its own {"casual":…,"formal":…} pair under the same rules.
  Empty/omit alternatives when unambiguous.
- Pinyin: Hanyu Pinyin with tone marks, syllables space-separated, one syllable per Han character,
  no punctuation, no capitalization (e.g. "nǐ yào shuì jiào").
- gloss: short natural English meaning of the MANDARIN (what it conveys), not a literal back-translation.
  note (optional): usage nuance in under 15 words.
- Traditional characters first; simplified must match character-for-character length.`;

export class LlmTranslationService implements TranslationService {
  constructor(private chat: ChatClient, private model: string) {}

  async translate(text: string, opts?: { audience?: string }): Promise<Result<{ casual: CardVariant; formal: CardVariant; alternatives: { casual: CardVariant; formal: CardVariant }[] }>> {
    const messages: ChatMessage[] = [
      { role: "system", content: TRANSLATE_SYSTEM },
      {
        role: "user",
        content: opts?.audience?.trim()
          ? `${text}\n\n(Audience hint: ${opts.audience.trim()})`
          : text,
      },
    ];
    let raw = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.chat.complete(messages, { model: this.model, temperature: 0.3, maxTokens: 1000 });
      if (!res.ok) return res;
      raw = res.value;
      const parsed = LlmTranslateSchema.safeParse(extractJson(raw));
      if (parsed.success) {
        const casual = completeVariant(parsed.data.casual);
        const formalRaw = completeVariant(parsed.data.formal);
        if (!variantValid(casual)) break; // repair retry below
        const formal = variantValid(formalRaw) ? formalRaw : casual;
        const alternatives = (parsed.data.alternatives ?? [])
          .map((alt) => {
            const altCasual = completeVariant(alt.casual);
            const altFormalRaw = completeVariant(alt.formal);
            if (!variantValid(altCasual)) return null;
            return { casual: altCasual, formal: variantValid(altFormalRaw) ? altFormalRaw : altCasual };
          })
          .filter((a): a is { casual: CardVariant; formal: CardVariant } => a !== null)
          .slice(0, 3);
        return { ok: true, value: { casual, formal, alternatives } };
      }
      messages.push({ role: "assistant", content: raw.slice(0, 2000) });
      messages.push({ role: "user", content: "That did not match the JSON schema. Return ONLY the corrected JSON object." });
    }
    return { ok: false, error: "translation model returned an unusable response (syllable/character mismatch)" };
  }
}

export class MockTranslationService implements TranslationService {
  async translate(text: string): Promise<Result<{ casual: CardVariant; formal: CardVariant; alternatives: { casual: CardVariant; formal: CardVariant }[] }>> {
    const t = text.toLowerCase();
    if (t.includes("flight") || t.includes("airline")) {
      return {
        ok: true,
        value: {
          casual: completeVariant({
            traditional: "航班", simplified: "航班", pinyin: "háng bān",
            gloss: "a flight (the scheduled service/booking)", note: "the flight itself, not the aircraft",
          }),
          formal: completeVariant({
            traditional: "班機", simplified: "班机", pinyin: "bān jī",
            gloss: "flight (scheduled service)", note: "news/airport register",
          }),
          alternatives: [
            {
              casual: completeVariant({
                traditional: "飛機票", simplified: "飞机票", pinyin: "fēi jī piào",
                gloss: "plane ticket", note: "the booking document",
              }),
              formal: completeVariant({
                traditional: "機票", simplified: "机票", pinyin: "jī piào",
                gloss: "air ticket", note: "standard term",
              }),
            },
            {
              casual: completeVariant({
                traditional: "搭飛機", simplified: "搭飞机", pinyin: "dā fēi jī",
                gloss: "to fly / take a plane", note: "the act, toddler-friendly",
              }),
              formal: completeVariant({
                traditional: "搭乘飛機", simplified: "搭乘飞机", pinyin: "dā chéng fēi jī",
                gloss: "to travel by plane", note: "announcement register",
              }),
            },
          ],
        },
      };
    }
    if (t.includes("love")) {
      return {
        ok: true,
        value: {
          alternatives: [],
          casual: completeVariant({
            traditional: "我愛你", simplified: "我爱你", pinyin: "wǒ ài nǐ",
            gloss: "I love you", note: "doting, parent-to-child",
          }),
          formal: completeVariant({
            traditional: "我愛你", simplified: "我爱你", pinyin: "wǒ ài nǐ",
            gloss: "I love you", note: "neutral register",
          }),
        },
      };
    }
    if (t.includes("sleep")) {
      return {
        ok: true,
        value: {
          alternatives: [],
          casual: completeVariant({
            traditional: "你要睡覺嗎？", simplified: "你要睡觉吗？", pinyin: "nǐ yào shuì jiào ma",
            gloss: "Do you want to sleep?", note: "gentle bedtime question",
          }),
          formal: completeVariant({
            traditional: "該睡覺了", simplified: "该睡觉了", pinyin: "gāi shuì jiào le",
            gloss: "It's time to sleep.", note: "statement, no question",
          }),
        },
      };
    }
    return {
      ok: true,
      value: {
        alternatives: [],
        casual: completeVariant({
          traditional: "你好", simplified: "你好", pinyin: "nǐ hǎo",
          gloss: "hello", note: "mock fixture",
        }),
        formal: completeVariant({
          traditional: "你好", simplified: "你好", pinyin: "nǐ hǎo",
          gloss: "hello", note: "mock fixture",
        }),
      },
    };
  }
}

export class UnavailableTts implements TtsService {
  available(): boolean { return false; }
  async synthesize(): Promise<Result<{ data: Uint8Array<ArrayBuffer>; mime: string }>> {
    return { ok: false, error: "tts unavailable" };
  }
}

export class GatewayTtsService implements TtsService {
  constructor(private cfg: { base: string; key: string; model: string; voice: string }) {}
  available(): boolean { return true; }
  async synthesize(text: string, opts?: { speed?: number }): Promise<Result<{ data: Uint8Array<ArrayBuffer>; mime: string }>> {
    try {
      const res = await fetch(`${this.cfg.base}/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.key}` },
        body: JSON.stringify({
          model: this.cfg.model,
          voice: this.cfg.voice,
          input: text,
          speed: opts?.speed ?? 1,
          response_format: "mp3",
        }),
      });
      if (!res.ok) return { ok: false, error: `tts gateway ${res.status}: ${(await res.text()).slice(0, 200)}` };
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength < 100) return { ok: false, error: "tts returned empty audio" };
      return { ok: true, value: { data: buf, mime: "audio/mpeg" } };
    } catch (e) {
      return { ok: false, error: `tts failed: ${String(e)}` };
    }
  }
}

export class UnavailableStt implements SttService {
  available(): boolean { return false; }
  async transcribe(): Promise<Result<{ text: string; language: string }>> {
    return { ok: false, error: "stt unavailable" };
  }
}

export class GatewayOcrService implements OcrService {
  constructor(private cfg: { base: string; key: string; model: string }) {}
  available(): boolean { return true; }
  async extract(image: Blob): Promise<Result<{ lines: OcrLine[] }>> {
    try {
      const bytes = new Uint8Array(await image.arrayBuffer());
      const b64 = Buffer.from(bytes).toString("base64");
      const dims = parseImageDims(bytes);
      const system =
        `You are an OCR engine for photos of Chinese text (Taiwan children's books included). Transcribe EVERY line of Han character text. Ignore bopomofo/zhuyin annotation symbols. Return ONLY valid JSON: {"items":[{"text":"…","box":[x1,y1,x2,y2]}]}. ${
          dims ? `The image is EXACTLY ${dims.w}×${dims.h} pixels. ` : ""
        }box coordinates are numbers in a 0-1000 grid relative to the image (0,0 = top-left, 1000 = bottom-right corner on each axis). Box ONLY the Han characters, not adjacent zhuyin. Omit box if truly unsure — never invent coordinates.`;
      const user = [
        { type: "text", text: "Transcribe the Chinese text, one item per line, with boxes." },
        { type: "image_url", image_url: { url: `data:${image.type || "image/jpeg"};base64,${b64}` } },
      ];

      let raw = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(`${this.cfg.base}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.key}` },
          body: JSON.stringify({
            model: this.cfg.model,
            temperature: 0,
            max_tokens: 3000,
            messages: attempt === 0
              ? [{ role: "system", content: system }, { role: "user", content: user }]
              : [
                  { role: "system", content: system },
                  { role: "user", content: user },
                  { role: "assistant", content: raw.slice(0, 3000) },
                  { role: "user", content: "That was not the JSON format requested. Return ONLY the JSON object {\"items\":[…]} — no prose, no code fences." },
                ],
          }),
        });
        if (!res.ok) return { ok: false, error: `ocr gateway ${res.status}: ${(await res.text()).slice(0, 200)}` };
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        raw = data.choices?.[0]?.message?.content ?? "";
        if (!raw.trim()) return { ok: false, error: "ocr returned no text" };

        const lines: OcrLine[] = [];
        const parsed = extractJson(raw) as { items?: { text?: string; box?: unknown }[] } | null;
        if (parsed?.items?.length) {
          for (const it of parsed.items) {
            if (typeof it.text !== "string" || !it.text.trim()) continue;
            const b = Array.isArray(it.box) ? it.box.map(Number) : undefined;
            const box =
              b && b.length === 4 && b.every((n) => Number.isFinite(n)) && b[0]! < b[2]! && b[1]! < b[3]!
                ? ([b[0]!, b[1]!, b[2]!, b[3]!] as [number, number, number, number])
                : undefined;
            lines.push({ text: it.text.trim(), box });
          }
          if (lines.length) {
            const healed = dims ? normalizeBoxes(lines, dims.w, dims.h) : lines;
            return { ok: true, value: { lines: healed } };
          }
        }
      }

      // final fallback: plain-text lines, no boxes
      const plain = raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((t) => ({ text: t }));
      return plain.length ? { ok: true, value: { lines: plain } } : { ok: false, error: "ocr returned no text" };
    } catch (e) {
      return { ok: false, error: `ocr failed: ${String(e)}` };
    }
  }
}

export class MockOcrService implements OcrService {
  available(): boolean { return true; }
  async extract(): Promise<Result<{ lines: OcrLine[] }>> {
    return { ok: true, value: { lines: [{ text: "小貓在睡覺", box: [20, 30, 560, 110] }] } };
  }
}

export class UnavailableOcr implements OcrService {
  available(): boolean { return false; }
  async extract(): Promise<Result<{ lines: { text: string }[] }>> {
    return { ok: false, error: "ocr unavailable" };
  }
}
