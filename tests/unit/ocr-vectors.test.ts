import { describe, expect, it } from "vitest";
import { parseOcrVectors, snapAngle } from "../../src/server/llm";
import { readFileSync } from "node:fs";

describe("snapAngle", () => {
  it("snaps near-axis bias to the axis (models report 8-23° for level text)", () => {
    expect(snapAngle(0)).toBe(0);
    expect(snapAngle(18)).toBe(0);
    expect(snapAngle(-20)).toBe(0);
    expect(snapAngle(88)).toBe(90);
    expect(snapAngle(105)).toBe(90);
  });
  it("passes true diagonals through", () => {
    expect(snapAngle(45)).toBe(45);
    expect(snapAngle(-32)).toBe(-32);
    expect(snapAngle(60)).toBe(60);
  });
});

describe("parseOcrVectors", () => {
  it("parses {items:[…]} vector items with angle + compat box", () => {
    const raw = `{"items":[{"text":"密呈太傅大人","from":[600,200],"to":[770,480]},{"text":"橫批","from":[100,50],"to":[300,52]}]}`;
    const lines = parseOcrVectors(raw, null);
    expect(lines).toHaveLength(2);
    const l0 = lines[0]!;
    expect(l0.text).toBe("密呈太傅大人");
    expect(l0.angle).toBeGreaterThan(50); // diagonal passes through
    expect(l0.from).toEqual([600, 200]);
    expect(l0.box?.[0]).toBeLessThanOrEqual(600);
    expect(l0.dir).toBe("v");
    expect(lines[1]!.angle).toBe(0); // ~level snaps
    expect(lines[1]!.dir).toBe("h");
  });

  it("accepts a bare top-level array (the model emits both shapes)", () => {
    const raw = `[\n  {"text":"床前明月光，","from":[137,395],"to":[478,190]}\n]`;
    const lines = parseOcrVectors(raw, null);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("床前明月光，");
    expect(lines[0]!.angle).toBeLessThan(0); // rising to the right = negative in screen coords
  });

  it("passes legacy box items through unchanged (no from/to)", () => {
    const raw = `{"items":[{"text":"小貓在睡覺","box":[20,30,560,110],"dir":"h"}]}`;
    const lines = parseOcrVectors(raw, null);
    expect(lines[0]).toMatchObject({ text: "小貓在睡覺", box: [20, 30, 560, 110], dir: "h" });
    expect(lines[0]!.angle).toBeUndefined();
  });

  it("keeps duplicate texts (genuine repeats — word clouds) and drops junk geometry", () => {
    const raw = JSON.stringify({ items: [
      { text: "虎符", from: [100, 100], to: [200, 110] },
      { text: "虎符", from: [500, 500], to: [600, 510] }, // legitimate second occurrence at another spot
      { text: "phantom", from: [50, 50], to: [1200, 50] }, // off-grid → dropped
      { text: "zero", from: [100, 100], to: [100, 100] }, // zero length → dropped
    ] });
    const lines = parseOcrVectors(raw, null);
    expect(lines.filter((l) => l.text === "虎符")).toHaveLength(2);
    expect(lines.find((l) => l.text === "phantom")).toBeUndefined();
  });
});

describe("OCR baseline replay (real recorded model outputs, CI-safe)", () => {
  const baseline = JSON.parse(readFileSync("bench/fixtures/baseline.json", "utf8")) as Record<string, { raw: string; blocks: number }>;

  it("baseline exists for all 8 fixtures", () => {
    expect(Object.keys(baseline).length).toBeGreaterThanOrEqual(8);
  });

  for (const [name, rec] of Object.entries(baseline)) {
    it(`${name}: recorded raw output parses to ≥70% of recorded block count`, () => {
      const lines = parseOcrVectors(rec.raw, null);
      expect(lines.length, `raw: ${rec.raw.slice(0, 120)}`).toBeGreaterThanOrEqual(Math.floor(rec.blocks * 0.7));
    });
  }
});
