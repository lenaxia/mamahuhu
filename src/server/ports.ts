import type { Dictionary } from "./dict";
import type { Sql } from "./db";
import type { CardVariant, EntrySource, Register, RenderedWord, Interpretation } from "../shared/api";

/**
 * Ports — the seams between components. Routes and app wiring depend on these
 * interfaces only; implementations (gateway, mock, browser-fallback, sqlite,
 * postgres) are swapped behind them.
 */

/** A result that never throws across a seam. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string; retryable?: boolean };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/** Raw chat completions against an OpenAI-compatible endpoint. */
export interface ChatClient {
  complete(messages: ChatMessage[], opts?: ChatOptions): Promise<Result<string>>;
}

export interface AltSense {
  casual: CardVariant;
  formal: CardVariant;
}

export interface TranslateOptions {
  /** free-form audience/context hint, e.g. "talking to my 3-year-old" */
  audience?: string;
  /** output variety; zh-HK = colloquial spoken Cantonese (口語) casual + 書面語 formal */
  variety?: "zh-Hant" | "zh-HK";
}

export interface TranslateOutcome {
  casual: CardVariant;
  formal: CardVariant;
  alternatives: AltSense[];
  /** for meta-questions: the extracted phrase/situation the user actually means */
  understood?: string;
}

/** EN → ZH translation with both registers + alternative senses (each with registers). Deterministic under mock. */
export interface TranslationService {
  translate(text: string, opts?: TranslateOptions): Promise<Result<TranslateOutcome>>;
  /** natural one-line English gloss of a Mandarin phrase (zh→en) */
  glossZh(text: string): Promise<Result<string>>;
  /** complete English translation of multi-phrase Chinese text (zh→en),
   *  context-aware: the model groups lines by meaning, not layout */
  fullZh(text: string, opts?: { force?: boolean }): Promise<Result<string>>;
  /** answer a zh meta-question about language (how-to-say / what-does-it-mean) in one English line */
  answerZh(text: string): Promise<Result<string>>;
}

/** Text-to-speech. Implementations: gateway model, or unavailable (client falls back to browser). */
export interface TtsService {
  available(): boolean;
  synthesize(text: string, opts?: { speed?: number; voice?: string }): Promise<Result<{ data: Uint8Array<ArrayBuffer>; mime: string }>>;
}

/** Speech-to-text (P2). */
export interface SttService {
  available(): boolean;
  transcribe(audio: Blob, opts?: { language?: "zh" | "en" | "auto" }): Promise<Result<{ text: string; language: string }>>;
}

export type OcrLine = {
  text: string;
  box?: [number, number, number, number];
  dir?: "h" | "v";
  /** vector contract: baseline endpoints on the 0-1000 grid */
  from?: [number, number];
  to?: [number, number];
  /** text axis in degrees (0 = horizontal L→R, 90 = vertical T→B); snapped to axes when near */
  angle?: number;
  /** structure-fusion contract: per-char pixel boxes (all-or-nothing per line;
   *  absent for unanchored lines — words then render in the loose-words list) */
  charBoxes?: ([number, number, number, number] | null)[];
};

/** Subject identification for textless photos → ranked Mandarin name tags for everything visible. */
export interface DescribeTag {
  traditional: string;
  simplified: string;
  pinyin: string;
  gloss: string;
  note?: string;
}
export interface DescribeService {
  identify(image: Blob): Promise<Result<{ tags: DescribeTag[] }>>;
}

/** Image OCR. Implementations may return absolute pixel boxes for overlay UI. */
export interface OcrService {
  available(): boolean;
  /** skew: degrees the image should be rotated CLOCKWISE to make text lines
   *  horizontal (diagonal over-the-shoulder shots); absent when upright */
  extract(image: Blob): Promise<Result<{ lines: OcrLine[]; skew?: number }>>;
}

/** Word/phrase lookup against the local dictionary. */
export interface DictionaryLookup {
  byTraditional(word: string): RenderedWord[];
  interpretPinyin(text: string): { interpretations: Interpretation[]; candidates: RenderedWord[] };
}

/** Topical tags for a saved phrase (cheap fast model; e.g. 飛機 → airport, travel). */
export interface TaggingService {
  tagsFor(input: { traditional: string; english: string }): Promise<Result<string[]>>;
}

/** Conversational follow-up about a result card; photo context when the ask stored an image.
 *  zh-HK answers come as a 口語/書面 pair (answer/answerWritten). `history` carries the
 *  card's earlier turns (client-threaded) so follow-ups resolve "this/it" references. */
export interface FollowUpService {
  ask(input: { question: string; hanzi?: string; gloss?: string; photoBytes?: Uint8Array; variety?: "zh-Hant" | "zh-HK"; history?: { q: string; a: string }[] }): Promise<Result<{ answer: string; answerWritten?: string }>>;
}

export interface AppDeps {
  sql: Sql;
  dictionary: Dictionary;
  translations: TranslationService;
  tts: TtsService;
  stt: SttService;
  ocr: OcrService;
  describe: DescribeService;
  tagger: TaggingService;
  followUp: FollowUpService;
  sources: ReadonlySet<EntrySource>;
}
