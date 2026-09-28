import { describe, expect, it } from "vitest";
import { annotateJyut, jyutForChar, jyutForWord, jyutPerChar, segmentJyut } from "../../src/shared/jyutping";

describe("jyutping dictionary", () => {
  it("annotates core colloquial words", () => {
    expect(jyutForWord("唔係")).toBe("m4 hai6");
    expect(jyutForWord("沖涼")).toBe("cung1 loeng4");
    expect(annotateJyut("沖涼喇")).toBe("cung1 loeng4 laa3");
  });

  it("falls back to per-char readings for unknown words", () => {
    expect(jyutForWord("攀岩點")).toBeNull();
    const parts = segmentJyut("攀岩點");
    expect(parts.map((p) => p.word).join("")).toBe("攀岩點");
    expect(parts.every((p) => p.jyut !== null)).toBe(true); // chars are all known
  });

  it("aligns per-char readings with text positions", () => {
    const per = jyutPerChar("唔係");
    expect(per).toEqual(["m4", "hai6"]);
    expect(jyutPerChar("A")).toEqual([null]);
  });

  it("passes punctuation through without readings", () => {
    const parts = segmentJyut("小心啲！");
    expect(parts.at(-1)).toEqual({ word: "！", jyut: null });
    expect(annotateJyut("小心啲！")).toBe("siu2 sam1 di1");
  });

  it("prefers dictionary words over char soup", () => {
    // 小心 is a word: siu2 sam1, not e.g. a wrong-frequency char split
    expect(segmentJyut("小心")[0]).toEqual({ word: "小心", jyut: "siu2 sam1" });
  });

  it("char readings exist for canto-specific chars", () => {
    for (const c of ["唔", "嘅", "咗", "喺", "哋", "冇", "佢"]) expect(jyutForChar(c)).toBeTruthy();
  });
});
