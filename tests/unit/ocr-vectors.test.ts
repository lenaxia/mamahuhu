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
    it(`${name}: recorded raw conserves ≥95% of characters (chaining merges blocks, never text)`, () => {
      const lines = parseOcrVectors(rec.raw, null);
      if (rec.blocks === 0) {
        // recorded corpse (truncated/unparseable) — parser must fail gracefully, not emit junk
        expect(lines.length).toBe(0);
        return;
      }
      const chars = lines.reduce((s, l) => s + [...l.text].length, 0);
      const rawChars = (JSON.stringify(rec.raw).match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
      expect(chars, `raw: ${rec.raw.slice(0, 120)}`).toBeGreaterThanOrEqual(Math.floor(rawChars * 0.95));
    });
  }
});

describe("truncation salvage", () => {
  it("recovers every complete item from a token-budget-truncated list (the dense word-cloud failure)", () => {
    // third item cut mid-object — the partial tail must be dropped, not fatal
    const raw = '{"items":[{"text":"我們","from":[100,100],"to":[300,110]},{"text":"喜歡","from":[400,200],"to":[560,210]},{"text":"你';
    const lines = parseOcrVectors(raw, null);
    expect(lines.map((l) => l.text)).toEqual(["我們", "喜歡"]);
  });
});

describe("chaining (continuation fragments)", () => {
  it("merges a tail fragment whose from == the parent line's to (the diagonal-letter failure)", () => {
    const raw = JSON.stringify({ items: [
      { text: "十七年前魏嚴家將魏祁林", from: [482, 233], to: [691, 658] },
      { text: "調兵虎符一事如", from: [691, 658], to: [839, 851] },
      { text: "密呈太傅大人", from: [618, 201], to: [776, 484] },
    ] });
    const lines = parseOcrVectors(raw, null);
    expect(lines).toHaveLength(2);
    const joined = lines.find((l) => l.text.includes("十七年前"));
    expect(joined?.text).toBe("十七年前魏嚴家將魏祁林調兵虎符一事如");
    expect(joined?.to).toEqual([839, 851]);
  });

  it("does not chain unrelated parallel lines", () => {
    const raw = JSON.stringify({ items: [
      { text: "床前明月光", from: [100, 100], to: [500, 100] },
      { text: "疑是地上霜", from: [100, 220], to: [500, 220] }, // parallel line, 120px away
    ] });
    const lines = parseOcrVectors(raw, null);
    expect(lines).toHaveLength(2);
  });
});
