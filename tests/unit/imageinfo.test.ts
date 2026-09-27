import { describe, expect, it } from "vitest";
import { normalizeBoxes, parseImageDims } from "../../src/server/imageinfo";

const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/9k7JAAAAAElFTkSuQmCC",
  "base64",
);

describe("parseImageDims", () => {
  it("reads PNG IHDR", () => {
    expect(parseImageDims(new Uint8Array(png1x1))).toEqual({ w: 1, h: 1 });
  });
  it("returns null for junk", () => {
    expect(parseImageDims(new Uint8Array(1024).fill(1))).toBeNull();
  });
});

describe("normalizeBoxes (0-1000 convention heal)", () => {
  const line = (box?: [number, number, number, number]) => ({ text: "睡覺", box });

  it("rescales when all coords ≤1000 but image is larger", () => {
    const out = normalizeBoxes([line([250, 500, 562, 586])], 1920, 1280);
    expect(out[0]!.box).toEqual([Math.round(250 * 1.92), Math.round(500 * 1.28), Math.round(562 * 1.92), Math.round(586 * 1.28)]);
  });

  it("leaves absolute coords untouched on big images", () => {
    const box: [number, number, number, number] = [240, 640, 1080, 750];
    expect(normalizeBoxes([line(box)], 1920, 1280)[0]!.box).toEqual(box);
  });

  it("leaves small images untouched", () => {
    const box: [number, number, number, number] = [20, 30, 560, 110];
    expect(normalizeBoxes([line(box)], 900, 700)[0]!.box).toEqual(box);
  });
});
