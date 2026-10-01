import { LlmTranslateSchema, type CardVariant } from "../shared/api";
import { z } from "zod";
import { marksToNumbered, numberedToBpmf, numberedToMarks } from "../shared/bpmf";
import { normalizeBoxes, parseImageDims } from "./imageinfo";
import type { ChatClient, ChatMessage, ChatOptions, Result, TranslationService, TtsService, SttService, OcrService, OcrLine, DescribeService, DescribeTag, TaggingService, FollowUpService } from "./ports";

const isHan = (ch: string): boolean => /\p{Script=Han}/u.test(ch);
const countHanzi = (s: string): number => [...s].filter(isHan).length;

function completeVariant(v: {
  traditional: string;
  simplified: string;
  pinyin: string;
  gloss: string;
  note?: string;
}, variety?: "zh-Hant" | "zh-HK"): CardVariant {
  if (variety === "zh-HK") {
    // romanization is recomputed from dictionary tables server-side;
    // the model's own jyutping measured ~42% syllable error (bench/canto-report.md)
    return {
      traditional: v.traditional,
      simplified: v.simplified || v.traditional,
      pinyin: v.pinyin,
      bpmf: "",
      jyutping: "",
      gloss: v.gloss,
      note: v.note,
    };
  }
  const marks = v.pinyin.trim().split(/\s+/).filter(Boolean).map((s) => numberedToMarks(marksToNumbered(s)));
  const bpmf = v.pinyin.trim().split(/\s+/).filter(Boolean).map((s) => numberedToBpmf(marksToNumbered(s)));
  return {
    traditional: v.traditional,
    simplified: v.simplified || v.traditional,
    pinyin: marks.join(" "),
    bpmf: bpmf.join(" "),
    jyutping: "",
    gloss: v.gloss,
    note: v.note,
  };
}

function variantValid(v: CardVariant, variety?: "zh-Hant" | "zh-HK"): boolean {
  if (variety === "zh-HK") return countHanzi(v.traditional) > 0; // romanization comes from tables
  const syls = v.pinyin.trim().split(/\s+/).filter(Boolean);
  if (syls.length !== countHanzi(v.traditional)) return false;
  return syls.every((s) => numberedToBpmf(marksToNumbered(s)) !== "");
}

/** Pulls the first balanced JSON object out of LLM text (handles code fences). */
export function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, "").replace(/```/g, "");
  // first STRUCTURE start — an object or a top-level array (the tagger
  // returns `["airport", …]`, which contains no `{` anywhere)
  const objStart = stripped.indexOf("{");
  const arrStart = stripped.indexOf("[");
  if (objStart < 0 && arrStart < 0) return null;
  const start = objStart < 0 ? arrStart : arrStart < 0 ? objStart : Math.min(objStart, arrStart);
  const pairs: Record<string, string> = { "{": "}", "[": "]" };
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      const open = stack.pop();
      if (open !== undefined && pairs[open] === ch && stack.length === 0) {
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

/** Retries a failed chat call once on the fallback model (MODEL_CHAT_FALLBACK).
 *  Transport-level failures only (HTTP errors, timeouts, empty completions);
 *  unset fallback = pure pass-through. */
export class FallbackChatClient implements ChatClient {
  constructor(private primary: ChatClient, private fallbackModel: string | undefined) {}

  async complete(messages: ChatMessage[], opts?: ChatOptions): Promise<Result<string>> {
    const first = await this.primary.complete(messages, opts);
    if (first.ok || !this.fallbackModel || opts?.model === this.fallbackModel) return first;
    return this.primary.complete(messages, { ...opts, model: this.fallbackModel });
  }
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
 "alternatives":[{"casual":{…},"formal":{…}}],"understood":"…"}
Rules:
- "understood" is REQUIRED in the JSON: empty string "" for a direct phrase. If the input
  is a QUESTION ABOUT Mandarin (meta-question), fill it with the phrase/situation the user
  actually means, in a few English words — then translate THAT in the normal fields.
  NEVER translate the question itself.
  Examples:
  "how do you say airplane?" → understood "airplane", casual/formal = 飛機
  "what's the word for grandma?" → understood "grandma (maternal)", fields = 外婆/阿嬤 as senses
  "what do kids say to elders at Chinese New Year?" → understood "New Year greeting kids say to elders",
    fields = the greetings Taiwanese kids actually use (恭喜發財！ etc.)
  Direct phrase "time for a bath" → understood "", fields = 該洗澡了.
- Translate MEANING AND INTENT, never word-for-word. Ask: what would a Taiwanese speaker
  actually say here? If the literal rendering sounds foreign or awkward in Mandarin,
  discard it and use the natural equivalent.
  e.g. "time for a bath" → 該洗澡了 (never 該洗澡的時間了); "good job!" → 好棒/好厲害 (never 好工作);
  "hold my hand" → 牽我的手; "watch out!" → 小心 (never 觀看).
- "casual" is colloquial, everyday spoken Mandarin; "formal" is standard, polite, written/official register.
  If an audience hint is provided, tune BOTH registers to that audience — but never mention the audience in notes.
- Honor inline disambiguation in the input (e.g. "not the plane itself" → the service/booking, not the vehicle).
- CONTEXT HINTS: the input may include parenthetical or trailing context about where/how it was heard
  ("(kid's teacher said this at pickup)", "— heard at bedtime", "this was shouted by a 3-year-old").
  USE that context to pick the right sense and register, but NEVER translate or mention the context itself.
- If the English is ambiguous or has other common senses, list 2-3 "alternatives" (most likely first)
  covering those other senses. EACH alternative is its own {"casual":…,"formal":…} pair under the same rules.
  Empty/omit alternatives when unambiguous.
- Pinyin: Hanyu Pinyin with tone marks, syllables space-separated, one syllable per Han character,
  no punctuation, no capitalization (e.g. "nǐ yào shuì jiào").
- gloss: short natural English meaning of the MANDARIN (what it conveys), not a literal back-translation.
  note (optional): usage nuance in under 15 words.
- Traditional characters first; simplified must match character-for-character length.`;

const TRANSLATE_SYSTEM_CANTO = `You translate English into Cantonese for a Hong Kong parent talking to a child.
Return ONLY valid JSON, no prose, matching exactly:
{"casual":{"traditional":"…","simplified":"…","pinyin":"…","gloss":"…","note":"…"},
 "formal":{"traditional":"…","simplified":"…","pinyin":"…","gloss":"…","note":"…"},
 "alternatives":[{"casual":{…},"formal":{…}}],"understood":"…"}
Rules:
- "casual" is COLLOQUIAL SPOKEN Cantonese (口語) written in Hong Kong characters — exactly what a
  parent says aloud: 唔係 (not 不是), 冇 (not 沒有), 嘅/咗/喺/佢/哋/啲, sentence particles 呀/啦/囉/㗎/嘛.
  It is spoken far more than read: sound natural aloud, keep it short.
- Translate DIRECTLY into Cantonese. NEVER translate into Mandarin and convert the readings.
  When the everyday word differs, it is ALWAYS the Cantonese one: 睇/看, 諗/想(think), 瞓覺/睡覺,
  食/吃, 飲/喝, 畀/給, 嚟/來, 而家/現在, 邊度/哪裡, 點解/為什麼, 幾時/什麼時候, 屋企/家,
  落雨/下雨, 返學/上學, 做緊乜/在做什麼, 知唔知/知不知道. A HK reader must never see Mandarin
  wording in the casual field.
- "formal" is standard written Chinese (書面語) for reading/writing contexts (school notes, signs):
  no Cantonese-specific characters at all.
- "understood" is REQUIRED in the JSON: empty string "" for a direct phrase. If the input is a QUESTION
  ABOUT Cantonese (meta-question), fill it with the phrase/situation the user actually means in a few
  English words — then translate THAT in the normal fields. NEVER translate the question itself.
- Translate MEANING AND INTENT, never word-for-word: "time for a bath" → casual 沖涼喇 / formal 該洗澡了.
- PARTING/ROUTINE FORMULAS must use the idiomatic Cantonese, not the Mandarin calque:
  "good night" → casual 早唞 (what a parent says at bedtime), formal 晚安 — NEVER 晚安喇.
  Prefer what a HK speaker says aloud over the dictionary equivalent whenever they differ.
- If an audience hint is provided, tune BOTH registers to that audience — never mention it in notes.
- Honor inline disambiguation and parenthetical context hints; use them for sense, never translate them.
- If the English is ambiguous, list 2-3 "alternatives" (most likely first), each its own pair.
- "pinyin": best-effort jyutping is fine here — it is ignored downstream (readings come from a dictionary).
- "simplified": copy "traditional" verbatim (Cantonese-specific characters have no simplified form).
- gloss: short natural English meaning of the Cantonese; note (optional): usage nuance under 15 words.`;

export class LlmTranslationService implements TranslationService {
  constructor(private chat: ChatClient, private model: string) {}

  async translate(text: string, opts?: { audience?: string; variety?: "zh-Hant" | "zh-HK" }): Promise<Result<{ casual: CardVariant; formal: CardVariant; alternatives: { casual: CardVariant; formal: CardVariant }[]; understood?: string }>> {
    const variety = opts?.variety ?? "zh-Hant";
    const messages: ChatMessage[] = [
      { role: "system", content: variety === "zh-HK" ? TRANSLATE_SYSTEM_CANTO : TRANSLATE_SYSTEM },
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
        const casual = completeVariant(parsed.data.casual, variety);
        const formalRaw = completeVariant(parsed.data.formal, variety);
        if (!variantValid(casual, variety)) break; // repair retry below
        const formal = variantValid(formalRaw, variety) ? formalRaw : casual;
        const alternatives = (parsed.data.alternatives ?? [])
          .map((alt) => {
            const altCasual = completeVariant(alt.casual, variety);
            const altFormalRaw = completeVariant(alt.formal, variety);
            if (!variantValid(altCasual, variety)) return null;
            return { casual: altCasual, formal: variantValid(altFormalRaw, variety) ? altFormalRaw : altCasual };
          })
          .filter((a): a is { casual: CardVariant; formal: CardVariant } => a !== null)
          .slice(0, 3);
        return { ok: true, value: { casual, formal, alternatives, understood: parsed.data.understood || undefined } };
      }
      messages.push({ role: "assistant", content: raw.slice(0, 2000) });
      messages.push({ role: "user", content: "That did not match the JSON schema. Return ONLY the corrected JSON object." });
    }
    return { ok: false, error: "translation model returned an unusable response (syllable/character mismatch)" };
  }

  async glossZh(text: string): Promise<Result<string>> {
    const res = await this.chat.complete(
      [
        { role: "system", content: "Translate this Mandarin phrase into natural English. Reply with ONLY the translation on one line — no pinyin, no notes, no quotes." },
        { role: "user", content: text },
      ],
      { model: this.model, temperature: 0.2, maxTokens: 120 },
    );
    if (!res.ok) return res;
    const gloss = res.value.trim().replace(/^["'「」]+|["'「」]+$/g, "");
    return gloss ? { ok: true, value: gloss } : { ok: false, error: "empty gloss" };
  }

  async answerZh(text: string): Promise<Result<string>> {
    const res = await this.chat.complete(
      [
        { role: "system", content: "The user asks a question in Mandarin about language — how to say something in English, what something means, or how to write something. Reply with ONLY the answer itself in one short line of English (the English word/phrase requested, or the meaning). No pinyin, no Chinese, no explanation." },
        { role: "user", content: text },
      ],
      { model: this.model, temperature: 0.2, maxTokens: 120 },
    );
    if (!res.ok) return res;
    const answer = res.value.trim().replace(/^["'「」]+|["'「」]+$/g, "");
    return answer ? { ok: true, value: answer } : { ok: false, error: "empty answer" };
  }
}

export class MockTranslationService implements TranslationService {
  async translate(text: string, opts?: { audience?: string; variety?: "zh-Hant" | "zh-HK" }): Promise<Result<{ casual: CardVariant; formal: CardVariant; alternatives: { casual: CardVariant; formal: CardVariant }[]; understood?: string }>> {
    const t = text.toLowerCase();
    if (opts?.variety === "zh-HK") {
      // bedtime formula regression fixture (register trap): the idiomatic 早唞,
      // never the Mandarin calque 晚安喇 (wife-reported, 2026-09-28)
      if (t.includes("good night")) {
        return {
          ok: true,
          value: {
            casual: completeVariant({
              traditional: "早唞", simplified: "早唞", pinyin: "zou2 tau2",
              gloss: "good night (spoken Cantonese)", note: "bedtime parting",
            }, "zh-HK"),
            formal: completeVariant({
              traditional: "晚安", simplified: "晚安", pinyin: "maan5 on1",
              gloss: "good night (written standard)", note: "書面語",
            }, "zh-HK"),
            alternatives: [],
          },
        };
      }
      return {
        ok: true,
        value: {
          casual: completeVariant({
            traditional: "沖涼喇", simplified: "沖涼喇", pinyin: "cung1 loeng4 laa3",
            gloss: "time for a bath (spoken Cantonese)", note: "mock canto fixture",
          }, "zh-HK"),
          formal: completeVariant({
            traditional: "該洗澡了", simplified: "该洗澡了", pinyin: "gāi xǐ zǎo le",
            gloss: "time for a bath (written standard)", note: "書面語",
          }, "zh-HK"),
          alternatives: [],
        },
      };
    }
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
    if (t.includes("how do you say") && t.includes("airplane")) {
      return {
        ok: true,
        value: {
          understood: "airplane",
          alternatives: [],
          casual: completeVariant({
            traditional: "飛機", simplified: "飞机", pinyin: "fēi jī",
            gloss: "airplane", note: "mock meta fixture",
          }),
          formal: completeVariant({
            traditional: "飛機", simplified: "飞机", pinyin: "fēi jī",
            gloss: "airplane", note: "mock meta fixture",
          }),
        },
      };
    }
    if (t.includes("new year") && t.includes("greeting")) {
      return {
        ok: true,
        value: {
          understood: "New Year greeting kids say to elders",
          alternatives: [],
          casual: completeVariant({
            traditional: "恭喜發財！", simplified: "恭喜发财！", pinyin: "gōng xǐ fā cái",
            gloss: "Wishing you prosperity! (the classic kids' greeting)", note: "kids expect a red packet after this",
          }),
          formal: completeVariant({
            traditional: "祝您新年快樂", simplified: "祝您新年快乐", pinyin: "zhù nín xīn nián kuài lè",
            gloss: "Wishing you a happy New Year", note: "polite, to elders",
          }),
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

  async glossZh(text: string): Promise<Result<string>> {
    return { ok: true, value: text.includes("睡覺") ? "I want to sleep." : "mock phrase gloss" };
  }

  async answerZh(text: string): Promise<Result<string>> {
    return { ok: true, value: text.includes("飛機") ? "airplane" : "mock answer" };
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
  async synthesize(text: string, opts?: { speed?: number; voice?: string }): Promise<Result<{ data: Uint8Array<ArrayBuffer>; mime: string }>> {
    try {
      const res = await fetch(`${this.cfg.base}/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.key}` },
        body: JSON.stringify({
          model: this.cfg.model,
          voice: opts?.voice ?? this.cfg.voice,
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

export class GatewaySttService implements SttService {
  constructor(private cfg: { base: string; key: string; model: string }) {}
  available(): boolean { return true; }
  async transcribe(audio: Blob, opts?: { language?: "zh" | "en" | "auto" }): Promise<Result<{ text: string; language: string }>> {
    try {
      const form = new FormData();
      form.append("file", audio, "clip.webm");
      form.append("model", this.cfg.model);
      if (opts?.language && opts.language !== "auto") form.append("language", opts.language);
      const res = await fetch(`${this.cfg.base}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.key}` },
        body: form,
      });
      if (!res.ok) return { ok: false, error: `stt gateway ${res.status}: ${(await res.text()).slice(0, 200)}` };
      const data = (await res.json()) as { text?: string; language?: string };
      if (!data.text?.trim()) return { ok: false, error: "stt returned no text" };
      return { ok: true, value: { text: data.text.trim(), language: data.language ?? "zh" } };
    } catch (e) {
      return { ok: false, error: `stt failed: ${String(e)}` };
    }
  }
}

export class MockSttService implements SttService {
  available(): boolean { return true; }
  async transcribe(): Promise<Result<{ text: string; language: string }>> {
    return { ok: true, value: { text: "我要睡覺", language: "zh" } };
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
        `You are an OCR engine for photos of Chinese text (Taiwan children's books included). Transcribe EVERY line of Han character text. Ignore bopomofo/zhuyin annotation symbols. Return ONLY valid JSON: {"items":[{"text":"…","box":[x1,y1,x2,y2],"dir":"h|v"}]}. dir = the line's reading direction: "h" for horizontal left-to-right lines, "v" for vertical top-to-bottom columns (Taiwan/Japan style).
CRITICAL — dir and box SHAPE must agree with the ACTUAL print layout, not the poster's orientation:
- A horizontal line of N characters has a WIDE-SHORT box (width ≈ N × char height) and dir "h".
- A vertical column of N characters has a TALL-NARROW box (height ≈ N × char width) and dir "v".
- On a VERTICAL roll-up banner, header pills and speech-bubble body text are usually HORIZONTAL lines
  (wide-short, dir "h") even though the banner itself is tall. Do not label horizontal lines "v".
- Only text physically printed as top-to-bottom columns (right side of traditional signs, 竖排) gets dir "v" with a tall-narrow box. ${
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
        const parsed = extractJson(raw) as { items?: { text?: string; box?: unknown; dir?: unknown }[] } | null;
        if (parsed?.items?.length) {
          for (const it of parsed.items) {
            if (typeof it.text !== "string" || !it.text.trim()) continue;
            const b = Array.isArray(it.box) ? it.box.map(Number) : undefined;
            const box =
              b && b.length === 4 && b.every((n) => Number.isFinite(n)) && b[0]! < b[2]! && b[1]! < b[3]!
                ? ([b[0]!, b[1]!, b[2]!, b[3]!] as [number, number, number, number])
                : undefined;
            const dir = it.dir === "v" ? "v" : it.dir === "h" ? "h" : undefined;
            lines.push({ text: it.text.trim(), box, dir });
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

export class GatewayDescribeService implements DescribeService {
  constructor(private cfg: { base: string; key: string; model: string }) {}
  async identify(image: Blob): Promise<Result<{ tags: DescribeTag[] }>> {
    try {
      const b64 = Buffer.from(await image.arrayBuffer()).toString("base64");
      const res = await fetch(`${this.cfg.base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.key}` },
        body: JSON.stringify({
          model: this.cfg.model,
          temperature: 0.2,
          max_tokens: 400,
          messages: [
            {
              role: "system",
              content: 'You tag the subjects in a photo for a Mandarin learner. Return ONLY valid JSON: {"tags":[{"traditional":"…","simplified":"…","pinyin":"…","gloss":"…","note":"…"}]}. List EVERY distinct identifiable subject (plant, animal, food, object, vehicle, place type — not specific people/brands), MOST PROMINENT FIRST, max 6. traditional = common Taiwan Mandarin name. pinyin: Hanyu Pinyin with tone marks, one syllable per Han character, space-separated. gloss: the English name. note (optional): under 10 words. Return {"tags":[]} if nothing is identifiable.',
            },
            { role: "user", content: [
              { type: "text", text: "Tag everything in this photo with its Mandarin name." },
              { type: "image_url", image_url: { url: `data:${image.type || "image/jpeg"};base64,${b64}` } },
            ] },
          ],
        }),
      });
      if (!res.ok) return { ok: false, error: `identify gateway ${res.status}` };
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const parsed = (extractJson(data.choices?.[0]?.message?.content ?? "") ?? {}) as {
        tags?: { traditional?: string; simplified?: string; pinyin?: string; gloss?: string; note?: string }[];
      };
      const tags = (parsed.tags ?? [])
        .filter((t) => t.traditional && t.pinyin)
        .filter((t) => t.pinyin!.trim().split(/\s+/).length === [...t.traditional!].length)
        .slice(0, 6)
        .map((t) => ({
          traditional: t.traditional!,
          simplified: t.simplified || t.traditional!,
          pinyin: t.pinyin!,
          gloss: t.gloss || "",
          note: t.note,
        }));
      if (!tags.length) return { ok: false, error: "identify returned no tags" };
      return { ok: true, value: { tags } };
    } catch (e) {
      return { ok: false, error: `identify failed: ${String(e)}` };
    }
  }
}

export class MockDescribeService implements DescribeService {
  async identify(): Promise<Result<{ tags: DescribeTag[] }>> {
    return {
      ok: true,
      value: {
        tags: [
          { traditional: "盆栽", simplified: "盆栽", pinyin: "pén zāi", gloss: "potted plant", note: "mock fixture" },
          { traditional: "花盆", simplified: "花盆", pinyin: "huā pén", gloss: "flower pot" },
        ],
      },
    };
  }
}

const TAGGING_SYSTEM = `Tag this vocabulary item from a family's Chinese phrasebook so they can FIND it later by typing related words.
Return ONLY a JSON array of 6-12 short lowercase English tags, covering EVERY category below that applies:
- topic: the domain (food, travel, school, bedtime, animals, weather, vehicles, sports, music, art, holidays…)
- situation: when it would be said (mealtime, bath time, car ride, playground, supermarket, school pickup, doctor visit, cleanup, bedtime routine…)
- function: what the phrase DOES (request, command, praise, comfort, warning, question, refusal, greeting, farewell, apology, thanks, negotiation, reminder…)
- people: roles involved when relevant (mom, dad, kid, baby, teacher, doctor, friend, grandparents…)
- things: concrete objects/beings mentioned (shoes, milk, backpack, tree, cat, plane…)
- related: ideas a person might type instead of the literal meaning (for 攀岩: climbing, safety, heights)
Rules: tags are PLAIN lowercase words with NO category prefix; one word or short two-word tags; no duplicates; no Chinese; plain words beat fancy ones (vehicle not conveyance). Cover the meaning, not just the surface words.`;

export class LlmTaggingService implements TaggingService {
  constructor(private chat: ChatClient, private model: string) {}
  async tagsFor(input: { traditional: string; english: string }): Promise<Result<string[]>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.chat.complete(
        [
          { role: "system", content: TAGGING_SYSTEM },
          { role: "user", content: `${input.traditional} — ${input.english}` },
        ],
        { model: this.model, temperature: 0, maxTokens: 250 },
      );
      if (!res.ok) return res;
      // JSON array, or the model's occasional UNQUOTED array ([climbing, rock, …])
      let parsed: unknown = extractJson(res.value);
      if (!Array.isArray(parsed)) {
        const m = res.value.match(/\[([\s\S]*?)\]/);
        if (m) {
          parsed = m[1]!.split(",").map((s) => s.trim().replace(/^["']+|["']+$/g, ""));
        }
      }
      if (Array.isArray(parsed)) {
        // the model sometimes prefixes category labels ("situation: playground") — strip them
        const tags = [...new Set(parsed
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim().toLowerCase().replace(/^(topic|situation|function|people|things|related):\s*/, ""))
          .filter((t) => /^[a-z][a-z -]{1,24}$/.test(t)))]
          .slice(0, 12);
        if (tags.length) return { ok: true, value: tags };
      }
      // retry on non-array / all-invalid output
    }
    return { ok: false, error: "tagger returned no usable tags" };
  }
}

export class MockTaggingService implements TaggingService {
  async tagsFor(input: { traditional: string; english: string }): Promise<Result<string[]>> {
    const t = `${input.traditional} ${input.english}`.toLowerCase();
    const tags: string[] = [];
    if (/飛機|飞机|airplane|plane|airport|航班/.test(t)) tags.push("airport", "travel", "vehicles");
    if (/睡|sleep|bed/.test(t)) tags.push("bedtime");
    if (/吃|飯|饭|food|eat/.test(t)) tags.push("food");
    if (/謝|谢|thank|hello|你好/.test(t)) tags.push("greetings", "manners");
    return { ok: true, value: tags.length ? tags : ["family"] };
  }
}

const FOLLOWUP_SYSTEM_MANDARIN =
  "Answer a Mandarin learner's follow-up question about a vocabulary item or photo. Plain text, under 80 words. Include hanzi + pinyin for any Mandarin terms you introduce. If a photo is provided, look at it again before answering.";

/** A question is "Chinese" when Han characters dominate it — questions about
 *  canto phrases often embed a word or two of hanzi ("instead of 晚安?") while
 *  still being English questions. */
function questionIsChinese(q: string): boolean {
  const han = [...q].filter((c) => /\p{Script=Han}/u.test(c)).length;
  const latin = (q.match(/[A-Za-z]/g) ?? []).length;
  return han > 0 && han >= latin;
}

const FOLLOWUP_SYSTEM_CANTO_ZH = `Answer a Hong Kong Cantonese user's follow-up question (asked in Chinese) about 口語 vocabulary or a photo.
Return ONLY valid JSON, no prose: {"spoken":"…","written":"…"}
- "spoken": the answer in COLLOQUIAL SPOKEN Cantonese (口語) with Hong Kong characters — native
  wording (唔/嘅/咗/喺/佢/哋), never Mandarin calques (是/的/什麼/現在), under 60 words.
- "written": the same content in standard written Chinese (書面語), no Cantonese-specific characters.
- NO romanization anywhere (readings are provided by the app's dictionary, never you).
- If a photo is provided, look at it again before answering.`;

const FOLLOWUP_SYSTEM_CANTO_EN =
  "Answer a Hong Kong Cantonese learner's follow-up question, IN ENGLISH, about vocabulary or a photo. Plain text, under 80 words. Include Traditional Hong Kong-style hanzi for any Cantonese terms you introduce — but NO romanization (the app provides readings). If a photo is provided, look at it again before answering.";

export class LlmFollowUpService implements FollowUpService {
  constructor(private cfg: { base: string; key: string; model: string }) {}
  async ask(input: { question: string; hanzi?: string; gloss?: string; photoBytes?: Uint8Array; variety?: "zh-Hant" | "zh-HK"; history?: { q: string; a: string }[] }): Promise<Result<{ answer: string; answerWritten?: string }>> {
    try {
      const context = input.hanzi ? `The user is asking about: ${input.hanzi}${input.gloss ? ` (${input.gloss})` : ""}.` : "";
      const textPart = { type: "text", text: `${context}\n${input.question}`.trim() };
      const content: unknown[] = [textPart];
      if (input.photoBytes) {
        content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from(input.photoBytes).toString("base64")}` } });
      }
      // prior turns from this card's conversation — resolve "this/it" references
      const priorMessages = (input.history ?? []).slice(-8).flatMap((h) => [
        { role: "user", content: h.q },
        { role: "assistant", content: h.a },
      ]);
      const res = await fetch(`${this.cfg.base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.key}` },
        body: JSON.stringify({
          model: this.cfg.model,
          temperature: 0.3,
          max_tokens: 400,
          messages: [
            {
              role: "system",
              // answer in the language of the question: Han → 口語/書面 pair, English → English
              content: input.variety === "zh-HK"
                ? (questionIsChinese(input.question) ? FOLLOWUP_SYSTEM_CANTO_ZH : FOLLOWUP_SYSTEM_CANTO_EN)
                : FOLLOWUP_SYSTEM_MANDARIN,
            },
            ...priorMessages,
            { role: "user", content },
          ],
        }),
      });
      if (!res.ok) return { ok: false, error: `followup gateway ${res.status}` };
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const raw = data.choices?.[0]?.message?.content?.trim();
      if (!raw) return { ok: false, error: "empty answer" };
      if (input.variety === "zh-HK" && questionIsChinese(input.question)) {
        const parsed = z.object({ spoken: z.string().min(1), written: z.string().min(1) }).safeParse(extractJson(raw));
        if (!parsed.success) return { ok: false, error: "followup model returned unusable JSON" };
        return { ok: true, value: { answer: parsed.data.spoken, answerWritten: parsed.data.written } };
      }
      return { ok: true, value: { answer: raw } };
    } catch (e) {
      return { ok: false, error: `followup failed: ${String(e)}` };
    }
  }
}

export class MockFollowUpService implements FollowUpService {
  async ask(input: { question: string; variety?: "zh-Hant" | "zh-HK" }): Promise<Result<{ answer: string; answerWritten?: string }>> {
    if (input.variety === "zh-HK") {
      // language follows the question: Han → 口語/書面 pair, English → English
      if (questionIsChinese(input.question)) {
        return { ok: true, value: { answer: "你好叻呀！mock 口語 answer", answerWritten: "你很棒！mock 書面 answer" } };
      }
      return { ok: true, value: { answer: "Mock English answer — 早唞 is the bedtime parting." } };
    }
    if (/tree|樹/i.test(input.question)) {
      return { ok: true, value: { answer: "It looks like a banyan tree — 榕樹 (róng shù), the classic shade tree in Taiwanese parks." } };
    }
    return { ok: true, value: { answer: "mock follow-up answer" } };
  }
}

export class MockOcrService implements OcrService {
  available(): boolean { return true; }
  async extract(image: Blob): Promise<Result<{ lines: OcrLine[] }>> {
    // mock convention: uploads named plant*/blank* are textless (subject photos)
    const name = (image as File).name ?? "";
    if (/plant|blank|textless/i.test(name)) return { ok: true, value: { lines: [] } };
    // vertical: uploads named vertical* contain a top-to-bottom column
    if (/vertical/i.test(name)) {
      return { ok: true, value: { lines: [{ text: "親近自然", box: [880, 100, 950, 420], dir: "v" }] } };
    }
    return { ok: true, value: { lines: [{ text: "小貓在睡覺", box: [20, 30, 560, 110], dir: "h" }] } };
  }
}

export class UnavailableOcr implements OcrService {
  available(): boolean { return false; }
  async extract(): Promise<Result<{ lines: { text: string }[] }>> {
    return { ok: false, error: "ocr unavailable" };
  }
}
