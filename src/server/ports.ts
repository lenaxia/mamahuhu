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
}

/** Text-to-speech. Implementations: gateway model, or unavailable (client falls back to browser). */
export interface TtsService {
  available(): boolean;
  synthesize(text: string, opts?: { speed?: number }): Promise<Result<{ data: Uint8Array<ArrayBuffer>; mime: string }>>;
}

/** Speech-to-text (P2). */
export interface SttService {
  available(): boolean;
  transcribe(audio: Blob, opts?: { language?: "zh" | "en" | "auto" }): Promise<Result<{ text: string; language: string }>>;
}

export type OcrLine = { text: string; box?: [number, number, number, number] };

/** Image OCR. Implementations may return absolute pixel boxes for overlay UI. */
export interface OcrService {
  available(): boolean;
  extract(image: Blob): Promise<Result<{ lines: OcrLine[] }>>;
}

/** Word/phrase lookup against the local dictionary. */
export interface DictionaryLookup {
  byTraditional(word: string): RenderedWord[];
  interpretPinyin(text: string): { interpretations: Interpretation[]; candidates: RenderedWord[] };
}

export interface AppDeps {
  sql: Sql;
  dictionary: Dictionary;
  translations: TranslationService;
  tts: TtsService;
  stt: SttService;
  ocr: OcrService;
  sources: ReadonlySet<EntrySource>;
}
