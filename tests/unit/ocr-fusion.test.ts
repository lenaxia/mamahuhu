// Structure-fusion matcher unit tests — synthetic cases for every edge in the
// design matrix. All geometry asserts are in ORIGINAL pixel space.
import { describe, expect, it } from "vitest";
import { fuseStructure, parseStructureTokens, type ClassicalItem, type StructureLine } from "../../src/server/ocr-fusion";

const item = (text: string, box: [number, number, number, number]): ClassicalItem => ({ text, box, score: 0.9 });
const line = (n: number, text: string, dir: "h" | "v" = "h"): StructureLine => ({ n, text, dir });
const centers = (r: { lines: { chars: { char: string; box?: number[] }[] }[] }, n: number) =>
  r.lines[n - 1]!.chars.map((c) => (c.box ? [(c.box[0]! + c.box[2]!) / 2, (c.box[1]! + c.box[3]!) / 2] : null));

describe("parseStructureTokens", () => {
  it("splits chars and gap markers (fractional widths allowed)", () => {
    const t = parseStructureTokens("我愛你⟪2⟫你是我的⟪1.5⟫END");
    expect(t.filter((x) => x.char).map((x) => x.char).join("")).toBe("我愛你你是我的END");
    expect(t.filter((x) => x.gap).map((x) => x.gap)).toEqual([2, 1.5]);
  });
});

describe("anchoring basics", () => {
  it("a multi-char fragment anchors ALL its chars, uniformly inside the box", () => {
    const r = fuseStructure([item("親近自然", [0, 0, 400, 100])], [line(1, "親近自然")]);
    const l = r.lines[0]!;
    expect(l.chars.every((c) => c.anchored)).toBe(true);
    const cs = centers(r, 1) as number[][];
    expect(cs[0]![0]).toBeCloseTo(50, -1); // 4 chars over 400px → pitch 100, first center 50
    expect(cs[3]![0]).toBeCloseTo(350, -1);
    for (const c of l.chars) { expect(c.box![0]).toBeGreaterThanOrEqual(0); expect(c.box![2]).toBeLessThanOrEqual(400); }
    expect(r.unmatchedFragments).toHaveLength(0);
  });

  it("classical text simplified + LLM traditional still matches (variant normalization)", () => {
    const r = fuseStructure([item("确为真品", [0, 0, 400, 100])], [line(1, "確為真品")]);
    expect(r.lines[0]!.chars.filter((c) => c.anchored)).toHaveLength(4);
  });

  it("punctuation the classical read elided is bridged (windowed approximate match)", () => {
    const r = fuseStructure([item("倡导环保财商培养", [0, 0, 720, 90])], [line(1, "倡导环保·财商培养")]);
    const l = r.lines[0]!;
    expect(l.chars.filter((c) => c.anchored)).toHaveLength(9); // the · sits inside the anchor span
    expect(l.text).toBe("倡导环保·财商培养");
  });

  it("hallucinated classical text (grid rows) anchors NOTHING — honesty over guessing", () => {
    const r = fuseStructure([item("合個英與", [136, 67, 1792, 444])], [line(1, "則登續聞承臧", "v"), line(2, "崩遠鴻喬夔", "v")]);
    expect(r.lines.every((l) => l.angle === null && l.chars.every((c) => !c.anchored && !c.box))).toBe(true);
    expect(r.unmatchedFragments).toHaveLength(1);
  });
});

describe("repeats — text never deduplicates (the 11× lesson)", () => {
  it("identical single-char fragments anchor EVERY instance in spatial order", () => {
    const r = fuseStructure(
      [item("虎", [60, 0, 140, 80]), item("虎", [160, 0, 240, 80]), item("虎", [260, 0, 340, 80]), item("虎", [360, 0, 440, 80])],
      [line(1, "虎虎虎虎")],
    );
    const l = r.lines[0]!;
    expect(l.chars.filter((c) => c.anchored)).toHaveLength(4);
    const xs = (centers(r, 1) as number[][]).map((c) => c[0]);
    expect(xs).toEqual([100, 200, 300, 400]); // leftmost box ↔ first 虎
  });

  it("an 11× repeated fragment anchors 11 distinct positions, not one", () => {
    const items = Array.from({ length: 11 }, (_, i) => item("年職", [i * 200, 0, i * 200 + 180, 90]));
    const r = fuseStructure(items, [line(1, "年職".repeat(11))]);
    expect(r.lines[0]!.chars.filter((c) => c.anchored)).toHaveLength(22);
  });

  it("cross-line conflict: a contested fragment goes to the spatially coherent line", () => {
    // line 1 top row (y≈100): 虎符在此 ; line 2 bottom row (y≈300): 密呈虎符
    // 虎符 fragment sits in the BOTTOM row — sequential first-claim gives it to
    // line 1; the residual round must move it to line 2
    const r = fuseStructure(
      [item("虎符", [300, 290, 400, 340]), item("在", [430, 90, 480, 120]), item("此", [510, 90, 560, 120]),
       item("密", [60, 290, 110, 340]), item("呈", [160, 290, 210, 340])],
      [line(1, "虎符在此"), line(2, "密呈虎符")],
    );
    expect(r.lines[0]!.chars.filter((c) => c.anchored)).toHaveLength(2); // 在此
    expect(r.lines[1]!.chars.every((c) => c.anchored)).toBe(true); // 密呈虎符 — all four
    const y1 = (centers(r, 2) as number[][]).map((c) => c[1]!);
    expect(Math.max(...y1) - Math.min(...y1)).toBeLessThan(60); // all on the bottom row
  });
});

describe("gaps (relative char-width units)", () => {
  it("a gap between anchors is recorded and consumes offset space, both sides still anchor", () => {
    const r = fuseStructure(
      [item("我愛你", [0, 0, 120, 40]), item("你是我的", [200, 0, 320, 40])],
      [line(1, "我愛你⟪2⟫你是我的")],
    );
    const l = r.lines[0]!;
    expect(l.text).toBe("我愛你你是我的");
    expect(l.gaps).toEqual([{ atChar: 3, widths: 2 }]);
    expect(l.chars.filter((c) => c.anchored)).toHaveLength(7); // all 7 — gap carries no chars
  });

  it("a fragment whose text elides the gap still chains (letters with seals/stamps)", () => {
    const r = fuseStructure([item("我愛你你是我的", [0, 0, 320, 40])], [line(1, "我愛你⟪2⟫你是我的")]);
    const l = r.lines[0]!;
    expect(l.matchedFragments).toHaveLength(1);
    expect(l.chars.every((c) => c.anchored)).toBe(true);
  });

  it("leading/trailing gap markers are tolerated (boundary gaps)", () => {
    const r = fuseStructure([item("你是我的", [0, 0, 160, 40])], [line(1, "⟪3⟫你是我的⟪1⟫")]);
    expect(r.lines[0]!.chars.filter((c) => c.anchored)).toHaveLength(4);
  });
});

describe("interpolation & extrapolation", () => {
  it("classical missing the middle: chars between anchors interpolate on the segment", () => {
    // 甲乙丙丁戊己: anchors on 甲 and 己 only; middle 4 interpolate
    const r = fuseStructure([item("甲", [0, 0, 40, 40]), item("己", [500, 0, 540, 40])], [line(1, "甲乙丙丁戊己")]);
    const l = r.lines[0]!;
    expect(l.chars.filter((c) => c.anchored)).toHaveLength(2);
    const xs = (centers(r, 1) as number[][]).map((c) => c[0]);
    for (let i = 1; i <= 4; i++) expect(xs[i]!).toBeCloseTo(20 + i * 100, -1); // 20→520 over 5 pitches
  });

  it("single anchor: both sides extrapolate at the local pitch, flagged", () => {
    const r = fuseStructure([item("合個", [200, 0, 400, 100])], [line(1, "前合個後")]);
    const l = r.lines[0]!;
    expect(l.chars[1]!.anchored && l.chars[2]!.anchored).toBe(true);
    expect(l.chars[0]!.extrapolated && l.chars[3]!.extrapolated).toBe(true);
    expect(l.angle).not.toBeNull();
    expect(l.dirFromLLM).toBe(true); // single anchor — no spatial direction evidence
  });

  it("no anchors at all: line is honest-unanchored, no boxes, no crash", () => {
    const r = fuseStructure([], [line(1, "床前明月光")]);
    const l = r.lines[0]!;
    expect(l.angle).toBeNull();
    expect(l.chars.every((c) => !c.box)).toBe(true);
    expect(l.text).toBe("床前明月光");
  });

  it("spatially out-of-order fragment is DROPPED by the chain (order coherence)", () => {
    // 乙 sits after 丙 in space but before it in text — cannot chain
    const r = fuseStructure(
      [item("甲", [0, 0, 40, 40]), item("丙", [100, 0, 140, 40]), item("乙", [300, 0, 340, 40])],
      [line(1, "甲乙丙")],
    );
    expect(r.lines[0]!.chars.filter((c) => c.anchored)).toHaveLength(2);
    expect(r.unmatchedFragments.map((f) => f.text)).toEqual(["乙"]);
  });
});

describe("direction & curves", () => {
  it("vertical line: placement runs along y (dir v)", () => {
    const r = fuseStructure([item("甲", [0, 0, 40, 40]), item("乙", [0, 100, 40, 140]), item("丙", [0, 200, 40, 240])], [line(1, "甲乙丙", "v")]);
    const ys = (centers(r, 1) as number[][]).map((c) => c[1]);
    expect(ys).toEqual([20, 120, 220]);
  });

  it("45° diagonal: axis comes from anchor geometry, chars collinear on the diagonal", () => {
    const r = fuseStructure(
      [item("甲", [0, 0, 40, 40]), item("乙", [110, 110, 150, 150]), item("丙", [220, 220, 260, 260])],
      [line(1, "甲乙丙丁戊")],
    );
    const cs = centers(r, 1) as number[][];
    expect(cs[0]).toEqual([20, 20]);
    expect(cs[2]).toEqual([240, 240]);
    // interpolated 丁,戊 between 乙 and 丙 stay on the diagonal
    for (const c of cs.slice(1)) expect(Math.abs(c[0]! - c[1]!)).toBeLessThan(12);
  });

  it("bending line: chars between anchors follow PIECEWISE segments, not one straight axis", () => {
    // A(50,25) → B(150,125): 45° down; B → C(350,125): flat. Not collinear —
    // X (between A,B) must sit on the descending segment, Y (between B,C) flat.
    const r = fuseStructure(
      [item("甲乙", [0, 0, 100, 50]), item("丙丁", [100, 100, 200, 150]), item("戊己", [300, 100, 400, 150])],
      [line(1, "甲乙X丙丁Y戊己")],
    );
    const cs = centers(r, 1) as number[][];
    const X = cs[2]!, Y = cs[5]!;
    expect(Math.abs(X[1]! - 75)).toBeLessThan(9); // on the A→B segment
    expect(Math.abs(Y[1]! - 125)).toBeLessThan(9); // on the flat B→C segment
    expect(Math.abs(X[0]! - 100)).toBeLessThan(15); // midpoint of the descending segment
    expect(Math.abs(Y[0]! - 250)).toBeLessThan(15);
    expect(r.lines[0]!.angle).not.toBeNull();
  });

  it("LLM dir is IGNORED when anchors contradict it (curve-s: line 2 labeled v, actually h)", () => {
    const r = fuseStructure([item("低頭", [100, 0, 200, 60]), item("思故", [250, 0, 350, 60]), item("鄉", [400, 0, 450, 60])], [line(1, "低頭思故鄉", "v")]);
    const cs = centers(r, 1) as number[][];
    expect(cs.every((c) => Math.abs(c[1]! - 30) < 5)).toBe(true); // horizontal placement
    expect(r.lines[0]!.dirFromLLM).toBe(false);
  });
});

describe("robustness (pathological inputs)", () => {
  it("empty items, empty lines, gap-only lines: no crash, honest output", () => {
    const r = fuseStructure([], []);
    expect(r.lines).toEqual([]);
    const r2 = fuseStructure([item("親近自然", [0, 0, 400, 100])], []);
    expect(r2.unmatchedFragments).toHaveLength(1);
    const r3 = fuseStructure([item("親近自然", [0, 0, 400, 100])], [line(1, "⟪3⟫")]);
    expect(r3.lines[0]!.text).toBe("");
    expect(r3.unmatchedFragments).toHaveLength(1);
  });

  it("zero-area / whitespace-only fragments are ignored, not fatal", () => {
    const r = fuseStructure(
      [item("", [0, 0, 0, 0]), item("   ", [10, 10, 20, 20]), item("親近自然", [0, 100, 400, 150])],
      [line(1, "親近自然")],
    );
    expect(r.lines[0]!.chars.every((c) => c.anchored)).toBe(true);
    expect(r.unmatchedFragments).toHaveLength(0); // empty/whitespace fragments vanish entirely, not reported as misses
  });

  it("everything-identical: 100 repeats × 10 lines terminates and never collapses", () => {
    const items = Array.from({ length: 100 }, (_, i) => item("虎符", [(i % 10) * 300, Math.floor(i / 10) * 300, (i % 10) * 300 + 180, Math.floor(i / 10) * 300 + 180]));
    const lines = Array.from({ length: 10 }, (_, i) => line(i + 1, "虎符虎符虎符"));
    const t0 = Date.now();
    const r = fuseStructure(items, lines);
    expect(Date.now() - t0).toBeLessThan(5000);
    const anchoredPerLine = r.lines.map((l) => l.chars.filter((c) => c.anchored).length);
    expect(Math.max(...anchoredPerLine)).toBeGreaterThanOrEqual(3); // every line got real anchors
    expect(r.lines.filter((l) => l.chars.every((c) => !c.anchored)).length).toBeLessThan(lines.length);
  });
});

describe("variance tolerance (classical emits both granularities)", () => {
  it("overlapping double-reads: long fragment + singles of the same region coexist", () => {
    // long fragment covers the line; a stray single char re-read of char 2 is a
    // separate fragment whose window would overlap — it must NOT steal or break
    const r = fuseStructure(
      [item("密呈太傅", [0, 0, 400, 100]), item("呈", [95, 5, 140, 45])],
      [line(1, "密呈太傅")],
    );
    const l = r.lines[0]!;
    expect(l.chars.every((c) => c.anchored)).toBe(true);
    const xs = (centers(r, 1) as number[][]).map((c) => c[0]);
    expect(Math.abs(xs[1]! - 150)).toBeLessThan(20); // 呈 from the LONG fragment, correctly placed
  });

  it("a fragment SPANNING two LLM line slices anchors both (head→line 1, tail→line 2)", () => {
    // the ≤20-char prompt cap splits long columns; classical reads them whole
    const r = fuseStructure([item("明望太傅大人能依", [0, 0, 800, 100])], [line(1, "明望太傅"), line(2, "大人能依")]);
    const l1 = r.lines[0]!, l2 = r.lines[1]!;
    expect(l1.chars.every((c) => c.anchored)).toBe(true);
    expect(l2.chars.every((c) => c.anchored)).toBe(true);
    expect(l1.matchedFragments).toEqual(l2.matchedFragments); // same fragment, disjoint ranges
    const x1 = (centers(r, 1) as number[][]).map((c) => c[0]);
    const x2 = (centers(r, 2) as number[][]).map((c) => c[0]);
    const nums = (a: unknown[]) => a.filter((n): n is number => typeof n === "number");
    expect(Math.max(...nums(x1))).toBeLessThan(Math.min(...nums(x2))); // head left, tail right
    expect(Math.abs(x1[0]! - 50)).toBeLessThan(30); // 8 chars over 800px → pitch 100, first center 50
    expect(Math.abs(x2[3]! - 750)).toBeLessThan(30);
  });

  it("CTC-corrupted fragment still anchors via local alignment (clean head chunk)", () => {
    // classical 傳/经/抹 wrong, LLM correct — the clean prefix matches as a local window
    const r = fuseStructure([item("明望太傳大人经依抹此重要", [0, 0, 1200, 100])], [line(1, "明望太傅大人能依")]);
    const l = r.lines[0]!;
    expect(l.chars.filter((c) => c.anchored).length).toBeGreaterThanOrEqual(5);
  });
});
