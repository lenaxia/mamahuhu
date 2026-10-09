export type Annotations = "both" | "bpmf" | "pinyin";
export type Register = "casual" | "formal";

/** One hanzi character with its render-ready annotations. */
export interface SyllableChar {
  h: string;
  py: string; // pinyin with tone marks, e.g. "shuì"
  bpmf: string; // e.g. "ㄕㄨㄟˋ" ("" if conversion failed)
}

/** words → chars, render-ready. */
export type Syllables = SyllableChar[][];

export interface RenderedWord {
  traditional: string;
  simplified: string;
  pinyin: string;
  bpmf: string;
  english: string;
}

export interface CardVariant {
  traditional: string;
  simplified: string;
  pinyin: string;
  bpmf: string;
  gloss: string;
  note?: string;
}

export interface TranslateCard {
  source: string; // original input
  register: Register;
  casual?: CardVariant;
  formal?: CardVariant;
  syllables: Syllables;
  lowConfidence?: boolean;
}

export interface Interpretation {
  traditional: string;
  simplified: string;
  pinyin: string;
  bpmf: string;
  english: string;
  words: RenderedWord[];
  exactEntry: boolean; // whole phrase exists in the dictionary
  idiom: boolean; // exact entry is a CEDICT idiom (成語)
}

export interface Entry {
  id: string;
  userId: string;
  userName?: string;
  variety: string;
  traditional: string;
  simplified: string;
  pinyin: string;
  pinyinFlat: string;
  bpmf: string;
  english: string;
  register: Register;
  exampleZh?: string | null;
  exampleEn?: string | null;
  notes?: string | null;
  source: string;
  syllables: Syllables;
  createdAt: string;
}

export interface Me {
  id: string;
  name: string;
  annotations: Annotations;
  ttsSpeed: number;
  onboarded: boolean;
}
