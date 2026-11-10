/** Han character utilities — segmentation + detection. */

const HAN = /\p{Script=Han}/u;

export function isHanChar(c: string): boolean {
  return HAN.test(c);
}

export function hasHan(text: string): boolean {
  return HAN.test(text);
}

/** Count han characters in a string. */
export function countHanzi(text: string): number {
  return [...text].filter((c) => HAN.test(c)).length;
}

/** Segment a run of hanzi into dictionary-shaped words using Intl.Segmenter. */
export function segmentHanzi(text: string): string[] {
  const segmenter = new Intl.Segmenter("zh-Hant", { granularity: "word" });
  return [...segmenter.segment(text)]
    .map((s) => s.segment)
    .filter((s) => s.trim().length > 0 && HAN.test(s));
}
