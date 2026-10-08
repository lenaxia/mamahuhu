// STRUCTURE FUSION v2 — fragment-inventory architecture.
// Classical fragments ARE the line inventory (deterministic — duplicates,
// merges and missing columns cannot exist by construction); the structure
// LLM improves text and supplies columns classical can't read. All geometry
// asserts in ORIGINAL pixel space.
import { describe, expect, it } from "vitest";
import { fuseStructure, parseStructureTokens, parseStructureLines, localAlign, type ClassicalItem, type StructureLine } from "../../src/server/ocr-fusion";

const item = (text: string, box: [number, number, number, number]): ClassicalItem => ({ text, box, score: 0.9 });
const line = (n: number, text: string, dir: "h" | "v" = "h"): StructureLine => ({ n, text, dir });
const centers = (r: { lines: { chars: { box?: number[] }[] }[] }, n: number) =>
  r.lines[n - 1]!.chars.map((c) => (c.box ? [(c.box[0]! + c.box[2]!) / 2, (c.box[1]! + c.box[3]!) / 2] : null));

describe("parseStructureTokens / parseStructureLines", () => {
  it("splits chars and gap markers; tolerates fences, drops gap-only lines", () => {
    const t = parseStructureTokens("我愛你⟪2⟫你是我的⟪1.5⟫");
    expect(t.filter((x) => x.char).map((x) => x.char).join("")).toBe("我愛你你是我的");
    expect(t.filter((x) => x.gap).map((x) => x.gap)).toEqual([2, 1.5]);
    const fenced = '```json\n{"lines":[{"n":1,"text":"親近自然","dir":"h"},{"n":2,"text":"⟪3⟫","dir":"v"}]}\n```';
    expect(parseStructureLines(fenced)).toEqual([{ n: 1, text: "親近自然", dir: "h" }]);
    expect(parseStructureLines("no json")).toEqual([]);
  });
});

describe("localAlign", () => {
  it("finds the clean chunk of a CTC-corrupted fragment; variant-tolerant", () => {
    const w = localAlign([..."明望太傳大人经依抹此"], [..."明望太傅大人能依据此"]);
    expect(w).not.toBeNull();
    expect(w?.matched ?? 0).toBeGreaterThanOrEqual(5);
  });
});

describe("fragment inventory (the anti-duplicate invariant)", () => {
  it("one line per fragment — duplicate LLM readings cannot multiply lines", () => {
    // three variant readings of the same column + one other column
    const r = fuseStructure(
      [item("确為真品現此调", [385, 657, 558, 1052]), item("者手中卑職深知此事干", [308, 677, 528, 1238])],
      [line(1, "確為真品現此調兵虎符", "v"), line(2, "确为真品现此调兵虎符", "v"), line(3, "澄证据确为真品现此调", "v"), line(4, "者手中卑職深知此事干", "v")],
    );
    expect(r.lines).toHaveLength(2); // the inventory size, not the LLM's line count
    expect(r.lines.every((l) => l.chars.every((c) => c.anchored && c.box))).toBe(true);
  });

  it("LLM text replaces CTC text when a reading covers ≥90% of the fragment", () => {
    const r = fuseStructure([item("亲近自然", [0, 0, 400, 100])], [line(1, "親近自然")]);
    expect(r.lines[0]!.text).toBe("親近自然");
    expect(r.lines[0]!.improved).toBe(true);
    // no covering reading → classical text stands
    const r2 = fuseStructure([item("亲近自然", [0, 0, 400, 100])], [line(1, "完全不同的文字")]);
    expect(r2.lines[0]!.text).toBe("亲近自然");
    expect(r2.lines[0]!.improved).toBeUndefined();
  });

  it("simplified classical vs traditional LLM still matches (variant normalization)", () => {
    const r = fuseStructure([item("确为真品", [0, 0, 400, 100])], [line(1, "確為真品")]);
    expect(r.lines[0]!.text).toBe("確為真品");
  });

  it("reading order: rows T→B L→R; vertical columns R→L; junk fragments dropped", () => {
    const r = fuseStructure(
      [item("M", [1084, 75, 1123, 113]), item("左列文字", [100, 100, 150, 300]), item("右列文字", [300, 100, 350, 300]), item("+", [1063, 1541, 1092, 1572])],
      [],
    );
    expect(r.lines.map((l) => l.text)).toEqual(["右列文字", "左列文字"]); // v columns R→L; M/+ dropped
  });

  it("fragment chars placed evenly along the box axis, in-bounds", () => {
    const r = fuseStructure([item("親近自然", [0, 0, 400, 100])], []);
    const cs = centers(r, 1) as number[][];
    expect(Math.abs((cs[0] ?? [0])[0]! - 50)).toBeLessThan(2);
    expect(Math.abs((cs[3] ?? [0])[0]! - 350)).toBeLessThan(2);
    for (const c of r.lines[0]!.chars) { expect(c.box![0]).toBeGreaterThanOrEqual(0); expect(c.box![2]).toBeLessThanOrEqual(400); }
  });

  it("leaning diagonal columns place chars along the lean (not straight down)", () => {
    // 273×497 box for 9 chars — the axisFromBox lean model ≈65°
    const r = fuseStructure([item("一二三四五六七八九", [693, 561, 964, 1058])], []);
    const l = r.lines[0]!;
    expect(l.angle).toBeGreaterThan(50);
    expect(l.angle).toBeLessThan(85);
    const xs = l.chars.map((c) => (c.box![0] + c.box![2]) / 2);
    expect(xs[8]! - xs[0]!).toBeGreaterThan(100); // chars track the lean across the box
  });

  it("genuine repeats survive: each occurrence is its own fragment", () => {
    const items = Array.from({ length: 11 }, (_, i) => item("年職", [i * 200, 0, i * 200 + 180, 300]));
    const r = fuseStructure(items, [line(1, "年職".repeat(11), "v")]);
    expect(r.lines).toHaveLength(11);
    expect(r.lines.every((l) => l.chars.every((c) => c.anchored))).toBe(true);
  });
});

describe("LLM-only columns (classical missed them)", () => {
  it("placed into a free lattice slot; duplicate readings dropped, not duplicated", () => {
    // two real columns (fragments) 300px apart + three variant readings of a
    // missing middle column → ONE inferred line, two dropped
    const r = fuseStructure(
      [item("甲乙", [760, 100, 840, 300]), item("戊己", [360, 100, 440, 300])],
      [line(1, "甲乙", "v"), line(2, "子丑寅卯", "v"), line(3, "子丑寅卯辰", "v"), line(4, "寅卯子丑", "v"), line(5, "戊己", "v")],
    );
    const inferred = r.lines.filter((l) => l.inferred);
    expect(inferred.length).toBe(1); // one column between the fragments
    expect(r.droppedLines.length).toBe(2); // the other variants
    expect(r.lines).toHaveLength(3);
    const x = (inferred[0]!.chars[0]!.box![0]! + inferred[0]!.chars[0]!.box![2]!) / 2;
    expect(x).toBeGreaterThan(460);
    expect(x).toBeLessThan(740); // between the two fragment columns
  });

  it("distinct LLM-only columns all get slots (supply scales to demand, image-clamped)", () => {
    const r = fuseStructure(
      [item("甲乙", [760, 100, 840, 300])],
      [line(1, "甲乙", "v"), line(2, "子丑", "v"), line(3, "寅卯", "v"), line(4, "辰巳", "v"), line(5, "午未", "v")],
      { w: 1000, h: 1000 },
    );
    const inferred = r.lines.filter((l) => l.inferred);
    expect(inferred.length).toBe(4); // every distinct column serves
    for (const l of inferred) {
      const b = l.chars[0]!.box!;
      expect(b[0]).toBeGreaterThan(-60); // clamped to image bounds
      expect(b[2]).toBeLessThan(1100);
    }
  });

  it("no fragments at all → no inference (vector rung's job)", () => {
    const r = fuseStructure([], [line(1, "日夜奔波", "v")]);
    expect(r.lines).toHaveLength(0);
  });
});

describe("hallucination safety", () => {
  it("fragment text is never replaced by unrelated LLM text (coverage ≥90% required)", () => {
    const r = fuseStructure([item("虎符虎符", [0, 0, 100, 320])], [line(1, "調兵虎符在長信王之子隨元", "v")]);
    // 虎符 (2 of 4 chars) is only 50% coverage → classical text stands
    expect(r.lines[0]!.text).toBe("虎符虎符");
  });
});
