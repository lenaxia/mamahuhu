import { z } from "zod";

/**
 * THE API contract. Server routes validate incoming bodies with these schemas
 * and shape responses as the inferred types; the client imports the same types
 * — drift is a compile error, not a runtime surprise.
 */

export const AnnotationsSchema = z.enum(["both", "bpmf", "pinyin"]);
export type Annotations = z.infer<typeof AnnotationsSchema>;

/** Language variety: Mandarin (default) or spoken-first Cantonese. */
export const VarietySchema = z.enum(["zh-Hant", "zh-HK"]);
export type Variety = z.infer<typeof VarietySchema>;

export const RegisterSchema = z.enum(["casual", "formal"]);
export type Register = z.infer<typeof RegisterSchema>;

export const EntrySourceSchema = z.enum(["en-translate", "pinyin", "hanzi", "stt", "ocr", "manual"]);
export type EntrySource = z.infer<typeof EntrySourceSchema>;

export const SyllableCharSchema = z.object({
  h: z.string().min(1).max(2),
  py: z.string().default(""),
  bpmf: z.string().default(""),
});
export type SyllableChar = z.infer<typeof SyllableCharSchema>;
export const SyllablesSchema = z.array(z.array(SyllableCharSchema));
export type Syllables = z.infer<typeof SyllablesSchema>;

// ---- users ----

export const MeSchema = z.object({
  id: z.string(),
  name: z.string(),
  annotations: AnnotationsSchema,
  ttsSpeed: z.number(),
  /** optional audience hint that fine-tunes translations, e.g. "talking to my 3-year-old" */
  audience: z.string().nullable(),
  onboarded: z.boolean(),
  nameFromProxy: z.boolean(),
  /** varieties this user asks in; the ask screen shows a toggle when >1 */
  varieties: z.array(VarietySchema).min(1).default(["zh-Hant"]),
  /** default variety for asks */
  primaryVariety: VarietySchema.default("zh-Hant"),
});
export type Me = z.infer<typeof MeSchema>;

export const PatchMeReqSchema = z.object({
  /** ignored by the server when nameFromProxy is true */
  name: z.string().trim().min(1).max(60).optional(),
  annotations: AnnotationsSchema.optional(),
  ttsSpeed: z.number().min(0.5).max(1.5).optional(),
  audience: z.string().trim().max(120).nullable().optional(),
  onboarded: z.boolean().optional(),
  varieties: z.array(VarietySchema).min(1).optional(),
  primaryVariety: VarietySchema.optional(),
});
export type PatchMeReq = z.infer<typeof PatchMeReqSchema>;

// ---- translation (LLM-backed) ----

export const CardVariantSchema = z.object({
  traditional: z.string().min(1),
  simplified: z.string().default(""),
  pinyin: z.string().min(1),
  bpmf: z.string().default(""),
  /** jyutping for zh-HK cards — dictionary-derived, never LLM */
  jyutping: z.string().default(""),
  gloss: z.string().default(""),
  note: z.string().optional(),
});
export type CardVariant = z.infer<typeof CardVariantSchema>;

export const TranslateReqSchema = z.object({
  text: z.string().trim().min(1).max(300),
  audience: z.string().trim().max(120).optional(),
  /** variety to translate into; defaults to the user's primary */
  variety: VarietySchema.optional(),
});
export type TranslateReq = z.infer<typeof TranslateReqSchema>;

export const TranslateResSchema = z.object({
  source: z.string(),
  /** history id of this ask — passed back on save to link the entry to its photo */
  askId: z.string().optional(),
  understood: z.string().optional(),
  variety: VarietySchema.optional(),
  register: RegisterSchema,
  casual: CardVariantSchema.optional(),
  formal: CardVariantSchema.optional(),
  syllables: SyllablesSchema,
  formalSyllables: SyllablesSchema.optional(),
  /** other senses of the ambiguous input — each with its own casual/formal pair */
  alternatives: z
    .array(
      z.object({
        casual: z.object({ variant: CardVariantSchema, syllables: SyllablesSchema }),
        formal: z.object({ variant: CardVariantSchema, syllables: SyllablesSchema }),
      }),
    )
    .max(3)
    .optional(),
  lowConfidence: z.boolean().optional(),
});
export type TranslateRes = z.infer<typeof TranslateResSchema>;

/** Raw shape the LLM must produce (validated before trusting it). */
export const LlmTranslateSchema = z.object({
  casual: z.object({
    traditional: z.string().min(1),
    simplified: z.string(),
    pinyin: z.string(),
    gloss: z.string(),
    note: z.string().optional(),
  }),
  formal: z.object({
    traditional: z.string().min(1),
    simplified: z.string(),
    pinyin: z.string(),
    gloss: z.string(),
    note: z.string().optional(),
  }),
  alternatives: z
    .array(
      z.object({
        casual: z.object({
          traditional: z.string().min(1),
          simplified: z.string(),
          pinyin: z.string(),
          gloss: z.string(),
          note: z.string().optional(),
        }),
        formal: z.object({
          traditional: z.string().min(1),
          simplified: z.string(),
          pinyin: z.string(),
          gloss: z.string(),
          note: z.string().optional(),
        }),
      }),
    )
    .max(3)
    .optional(),
  /** for meta-questions: the extracted phrase/situation the user actually means; "" otherwise */
  understood: z.string().default(""),
});
export type LlmTranslate = z.infer<typeof LlmTranslateSchema>;

// ---- pinyin interpreter (local dictionary) ----

export const RenderedWordSchema = z.object({
  traditional: z.string(),
  simplified: z.string(),
  pinyin: z.string(),
  bpmf: z.string(),
  english: z.string(),
});
export type RenderedWord = z.infer<typeof RenderedWordSchema>;

export const InterpretationSchema = z.object({
  traditional: z.string(),
  simplified: z.string(),
  pinyin: z.string(),
  bpmf: z.string(),
  english: z.string(),
  words: z.array(RenderedWordSchema),
  exactEntry: z.boolean(),
});
export type Interpretation = z.infer<typeof InterpretationSchema>;

export const PinyinReqSchema = z.object({ text: z.string().trim().min(1).max(200) });
export const PinyinResSchema = z.object({
  interpretations: z.array(InterpretationSchema),
  candidates: z.array(RenderedWordSchema),
});
export type PinyinRes = z.infer<typeof PinyinResSchema>;

export const HanziReqSchema = z.object({ text: z.string().trim().min(1).max(200) });
export const HanziWordSchema = RenderedWordSchema.extend({ known: z.boolean() });
export const HanziPhraseSchema = z.object({
  traditional: z.string(),
  simplified: z.string(),
  pinyin: z.string(),
  bpmf: z.string(),
  english: z.string(),
  /** true when english is the ANSWER to a zh meta-question, not a translation */
  answer: z.boolean().default(false),
});
export type HanziPhrase = z.infer<typeof HanziPhraseSchema>;
export const HanziResSchema = z.object({
  /** the original input text (line breaks intact) — powers the transcription block */
  text: z.string().default(""),
  words: z.array(HanziWordSchema),
  /** meta-question answer card (how-do-I-say / what-does-it-mean) */
  phrase: HanziPhraseSchema.optional(),
  /** complete English translation of multi-phrase text — LLM decides (omitted for single words/short phrases) */
  fullTranslation: z.string().optional(),
});
export type HanziRes = z.infer<typeof HanziResSchema>;

export const BoxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Box = z.infer<typeof BoxSchema>;

export const OcrWordSchema = RenderedWordSchema.extend({
  known: z.boolean(),
  saved: z.boolean(),
  /** absolute pixel box on the UPLOADED image (x1,y1,x2,y2); absent in fallback mode */
  box: BoxSchema.optional(),
  /** reading direction from the model: h = horizontal line, v = vertical column */
  dir: z.enum(["h", "v"]).optional(),
  /** text axis in degrees (0 = horizontal, 90 = vertical) — chips render rotated to it */
  angle: z.number().optional(),
});
export const IdentifySchema = z.object({
  traditional: z.string(),
  simplified: z.string(),
  pinyin: z.string(),
  bpmf: z.string(),
  gloss: z.string(),
  note: z.string().optional(),
});
export type Identify = z.infer<typeof IdentifySchema>;

export const OcrPageSchema = z.object({
  lines: z.array(z.object({ words: z.array(OcrWordSchema) })),
  fullText: z.string(),
  positioned: z.boolean(),
});
export type OcrPage = z.infer<typeof OcrPageSchema>;
export const OcrResSchema = z.object({
  /** image dimensions the boxes refer to */
  width: z.number().optional(),
  height: z.number().optional(),
  lines: z.array(z.object({ words: z.array(OcrWordSchema) })),
  fullText: z.string(),
  /** true when boxes are present (overlay mode) */
  positioned: z.boolean(),
  /** textless photo → ranked Mandarin name tags for everything visible */
  tags: z.array(IdentifySchema).max(6).optional(),
  /** first tag, kept for convenience/back-compat */
  identify: IdentifySchema.optional(),
  /** multi-page (PDF) input: per-page OCR; `lines` mirrors page 0 */
  pages: z.array(OcrPageSchema).optional(),
  pageCount: z.number().optional(),
  /** history id of this ask — powers photo-context follow-ups */
  askId: z.string().optional(),
  /** complete English translation of the full text (multi-phrase input only) */
  fullTranslation: z.string().optional(),
});
export type OcrRes = z.infer<typeof OcrResSchema>;

export const FollowUpReqSchema = z.object({
  question: z.string().trim().min(1).max(300),
  hanzi: z.string().max(200).optional(),
  gloss: z.string().max(300).optional(),
  askId: z.string().optional(),
  /** variety of the card being asked about; shapes the answer language */
  variety: VarietySchema.optional(),
  /** earlier turns in this card's conversation (client-threaded, most recent last) */
  history: z.array(z.object({ q: z.string().max(300), a: z.string().max(600) })).max(8).optional(),
});
export const FollowUpResSchema = z.object({
  /** zh-Hant: the answer. zh-HK: the 口語 (spoken) answer. */
  answer: z.string(),
  /** zh-HK only: the same answer in standard written Chinese (書面語) */
  answerWritten: z.string().optional(),
  variety: VarietySchema.optional(),
});
export type FollowUpRes = z.infer<typeof FollowUpResSchema>;

/** POST /api/ask/stt — transcript + auto-routed payload */
export const SttResSchema = z.object({
  text: z.string(),
  language: z.string(),
  route: z.enum(["hanzi", "translate", "text"]),
  hanzi: HanziResSchema.optional(),
  translate: TranslateResSchema.optional(),
});
export type SttRes = z.infer<typeof SttResSchema>;

// ---- entries ----

export const CreateEntryReqSchema = z.object({
  traditional: z.string().trim().min(1).max(200),
  simplified: z.string().default(""),
  pinyin: z.string().default(""),
  pinyinFlat: z.string().default(""),
  bpmf: z.string().default(""),
  /** zh-HK entries: dictionary jyutping of `traditional` */
  jyutping: z.string().default(""),
  /** zh-HK entries: the 書面語 pair (formal variant text + its jyutping) */
  formalZh: z.string().default(""),
  formalJyut: z.string().default(""),
  english: z.string().default(""),
  register: RegisterSchema.default("casual"),
  exampleZh: z.string().max(500).optional(),
  exampleEn: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
  source: EntrySourceSchema,
  syllables: SyllablesSchema,
  variety: VarietySchema.default("zh-Hant"),
  /** source ask (history) — links the entry to its photo context for follow-ups */
  askId: z.string().optional(),
});
export type CreateEntryReq = z.infer<typeof CreateEntryReqSchema>;

export const EntrySchema = z.object({
  id: z.string(),
  userId: z.string(),
  userName: z.string(),
  variety: z.string(),
  traditional: z.string(),
  simplified: z.string(),
  pinyin: z.string(),
  pinyinFlat: z.string(),
  bpmf: z.string(),
  jyutping: z.string().default(""),
  formalZh: z.string().default(""),
  formalJyut: z.string().default(""),
  english: z.string(),
  register: RegisterSchema,
  exampleZh: z.string().nullable(),
  exampleEn: z.string().nullable(),
  notes: z.string().nullable(),
  tags: z.array(z.string()).default([]),
  source: EntrySourceSchema,
  syllables: SyllablesSchema,
  createdAt: z.string(),
  /** SRS (Leitner box system) */
  srsBox: z.number().int().min(0).max(5).default(0),
  srsDue: z.string().nullable(),
  srsStreak: z.number().int().default(0),
  askId: z.string().nullable().default(null),
});
export type Entry = z.infer<typeof EntrySchema>;

export const ReviewReqSchema = z.object({ id: z.string(), outcome: z.enum(["again", "hard", "good", "easy"]) });
export const ReviewResSchema = z.object({
  id: z.string(),
  srsBox: z.number(),
  srsDue: z.string(),
  reviewed: z.number(),
});
export type ReviewRes = z.infer<typeof ReviewResSchema>;

export const PatchEntryReqSchema = z.object({
  english: z.string().max(500).optional(),
  notes: z.string().max(2000).nullable().optional(),
  register: RegisterSchema.optional(),
  exampleZh: z.string().max(500).nullable().optional(),
  exampleEn: z.string().max(500).nullable().optional(),
});
export type PatchEntryReq = z.infer<typeof PatchEntryReqSchema>;

export const ListEntriesResSchema = z.array(EntrySchema);
export type ListEntriesRes = z.infer<typeof ListEntriesResSchema>;

// ---- history (every ask, saved or not) ----

export const AskKindSchema = z.enum(["translate", "pinyin", "hanzi", "ocr", "stt"]);
export type AskKind = z.infer<typeof AskKindSchema>;

export const HistoryItemSchema = z.object({
  id: z.string(),
  kind: AskKindSchema,
  input: z.string(),
  hasPhoto: z.boolean(),
  createdAt: z.string(),
});
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

export const HistoryDetailSchema = z.object({
  id: z.string(),
  kind: AskKindSchema,
  input: z.string(),
  createdAt: z.string(),
  photoUrl: z.string().nullable(),
  photoW: z.number(),
  photoH: z.number(),
  result: z.unknown(),
});
export type HistoryDetail = z.infer<typeof HistoryDetailSchema>;

// ---- errors ----

export const ErrorSchema = z.object({ error: z.string() });
export type ApiError = z.infer<typeof ErrorSchema>;
