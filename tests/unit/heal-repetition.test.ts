import { describe, expect, it } from "vitest";
import { healRepetition } from "../../src/server/llm";
import type { OcrLine } from "../../src/server/ports";

const line = (text: string, box?: [number, number, number, number]): OcrLine => ({ text, box });

describe("healRepetition (geometric clone detection)", () => {
  it("kills a marching clone chain (degenerate loop: constant box step)", () => {
    const lines: OcrLine[] = [
      line("密呈太傅大人", [100, 100, 300, 150]),
      line("年職多方查證該虎符", [500, 400, 660, 700]),
      line("年職多方查證該虎符", [530, 460, 690, 760]), // +30/+60
      line("年職多方查證該虎符", [560, 520, 720, 820]), // +30/+60
      line("年職多方查證該虎符", [590, 580, 750, 880]), // +30/+60
      line("望太傅大人", [200, 800, 400, 850]),
    ];
    const out = healRepetition(lines);
    expect(out.map((l) => l.text)).toEqual(["密呈太傅大人", "年職多方查證該虎符", "望太傅大人"]);
  });

  it("keeps GENUINE repeats — same text at unrelated page positions", () => {
    const lines: OcrLine[] = [
      line("明月", [100, 100, 160, 150]),
      line("床前明月光", [100, 200, 400, 250]),
      line("明月", [700, 500, 760, 550]), // different line of the poem, scattered
      line("舉頭望明月", [100, 600, 400, 650]),
      line("明月", [120, 900, 180, 950]), // another distinct position
    ];
    const out = healRepetition(lines);
    expect(out).toHaveLength(5); // nothing dropped: no constant step
  });

  it("drops phantom boxes escaping the 0-1000 grid", () => {
    const lines: OcrLine[] = [
      line("在長", [300, 300, 360, 350]),
      line("在長", [560, 1060, 620, 1470]), // off-grid clone
    ];
    const out = healRepetition(lines);
    expect(out).toHaveLength(1);
    expect(out[0]!.box).toEqual([300, 300, 360, 350]);
  });

  it("caps boxless duplicate floods but keeps up to three", () => {
    const lines: OcrLine[] = [
      line("虎符"), line("虎符"), line("虎符"), line("虎符"), line("虎符"), line("調兵"),
    ];
    const out = healRepetition(lines);
    expect(out.map((l) => l.text)).toEqual(["虎符", "虎符", "虎符", "調兵"]);
  });
});

describe("scrapeOcrItems (truncated-JSON salvage)", () => {
  it("recovers complete items from a cut-off response and drops the partial tail", async () => {
    const { scrapeOcrItems } = await import("../../src/server/llm");
    const raw = `{"skew":12,"items":[{"text":"密呈太傅大人","box":[100,100,300,150],"dir":"h"},{"text":"卑職日夜奔波","box":[100,200,400,250],"dir":"h"},{"text":"虎符在長信","box":[100,3`;
    const items = scrapeOcrItems(raw);
    expect(items).toHaveLength(2); // third item truncated mid-box — dropped
    expect(items[0]).toMatchObject({ text: "密呈太傅大人", dir: "h" });
  });
});
