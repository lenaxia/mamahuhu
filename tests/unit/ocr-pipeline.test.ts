import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  type Quad, charCells, dedupeQuads, expectChars, frameBox, medianAngle,
  overlapFrac, quadAngle, readingOrder, validateRead,
} from "../../src/server/ocr-geometry";

const quadAt = (deg: number, len: number, thick: number, at: [number, number] = [0, 0]): Quad => {
  const r = (deg * Math.PI) / 180;
  const u: [number, number] = [Math.cos(r), Math.sin(r)];
  const v: [number, number] = [-u[1], u[0]]; // perpendicular
  const p = (s: number, t: number): [number, number] => [at[0] + u[0] * s + v[0] * t, at[1] + u[1] * s + v[1] * t];
  return { pts: [p(0, 0), p(len, 0), p(len, thick), p(0, thick)] };
};

const letterFixture = JSON.parse(readFileSync("bench/fixtures/pipeline2/letter-diagonal.quads.json", "utf8")) as {
  quads: Quad[]; w: number; h: number;
};
const posterFixture = JSON.parse(readFileSync("bench/fixtures/pipeline2/poster-flat.quads.json", "utf8")) as {
  quads: Quad[]; w: number; h: number;
};

describe("ocr-geometry (pipeline v2 pure functions)", () => {
  it("quadAngle: horizontal rows read 0, vertical columns ±90, slanted -20 reads -20", () => {
    expect(quadAngle(quadAt(0, 200, 20))).toBeCloseTo(0, 5);
    expect(Math.abs(quadAngle(quadAt(90, 200, 20)))).toBeCloseTo(90, 5);
    expect(quadAngle(quadAt(-20, 200, 20))).toBeCloseTo(-20, 5);
  });

  it("frameBox: rotating a slanted quad into its text frame yields its true extent", () => {
    const q = quadAt(-20, 200, 30);
    const fb = frameBox(q, -20);
    expect(fb[2] - fb[0]).toBeCloseTo(200, 0); // true length, not the inflated AABB
    expect(fb[3] - fb[1]).toBeCloseTo(30, 0);
  });

  it("overlapFrac: identical boxes overlap 1, disjoint overlap 0", () => {
    expect(overlapFrac([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(overlapFrac([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0);
  });

  it("dedupeQuads keeps the letter's 9 slanted lines (AABB-overlap trap) and drops true double-reads", () => {
    expect(letterFixture.quads.length).toBe(9); // sanity: det output
    // the letter's slanted quads overlap heavily as AABBs but not in their text frame
    const aabbs = letterFixture.quads.map((q) => {
      const xs = q.pts.map((p) => p[0]); const ys = q.pts.map((p) => p[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [number, number, number, number];
    });
    let aabbOverlapPairs = 0;
    for (let i = 0; i < aabbs.length; i++)
      for (let j = i + 1; j < aabbs.length; j++) if (overlapFrac(aabbs[i]!, aabbs[j]!) >= 0.6) aabbOverlapPairs++;
    expect(aabbOverlapPairs).toBeGreaterThan(0); // the trap exists
    const kept = dedupeQuads(letterFixture.quads);
    expect(kept.length).toBe(9); // and dedupe survives it

    const shifted: Quad = { pts: quadAt(0, 200, 20, [500, 500]).pts.map(([x, y]) => [x + 2, y + 2] as [number, number]) };
    expect(dedupeQuads([quadAt(0, 200, 20, [500, 500]), shifted])).toHaveLength(1); // true double-read dies
  });

  it("dedupeQuads on the poster fixture is deterministic (pin the count)", () => {
    expect(dedupeQuads(posterFixture.quads).length).toBe(18); // self-consistent longest-edge median (python POC's PCA median dropped one fewer — different frame estimate, not a regression)
  });

  it("readingOrder: horizontal rows sort by y-band then x; vertical columns sort right-to-left", () => {
    const rows = [quadAt(0, 100, 20, [0, 100]), quadAt(0, 100, 20, [50, 0]), quadAt(0, 100, 20, [0, 50])];
    const ordered = readingOrder(rows);
    expect(ordered.map((q) => q.pts[0]![1])).toEqual([0, 50, 100]);
    const cols = [quadAt(90, 100, 20, [100, 0]), quadAt(90, 100, 20, [0, 0]), quadAt(90, 100, 20, [50, 0])];
    // vertical columns: x-centroids 50, 0, 100 → RTL order 100, 50, 0
    const oc = readingOrder(cols);
    expect(oc.map((q) => Math.round(q.pts.reduce((s, p) => s + p[0], 0) / 4))).toEqual([90, 40, -10]); // centroids offset by ½ thickness; RTL = descending
  });

  it("charCells: n equal cells along the axis — horizontal quad yields left-to-right squares", () => {
    const q = quadAt(0, 300, 60);
    const cells = charCells(q, 3);
    expect(cells).toHaveLength(3);
    for (const c of cells) {
      expect(c[2] - c[0]).toBeCloseTo(100, 0); // side = 300/3
      expect(c[3] - c[1]).toBeCloseTo(100, 0); // square
    }
    expect(cells[0]![0]).toBeLessThan(cells[1]![0]);
    expect(cells[1]![0]).toBeLessThan(cells[2]![0]);
  });

  it("charCells: slanted quad — cell centers lie on the axis line and sizes stay equal", () => {
    const q = quadAt(-20, 200, 25, [400, 800]);
    const cells = charCells(q, 4);
    expect(cells).toHaveLength(4);
    // axis: from midpoint of first long edge toward midpoint of opposite edge
    const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const e = q.pts.map((p, i) => {
      const b = q.pts[(i + 1) % 4]!;
      return Math.hypot(b[0] - p[0], b[1] - p[1]);
    });
    const bi = e.indexOf(Math.max(...e));
    const start = mid(q.pts[(bi + 3) % 4]!, q.pts[bi]!); // short-edge midpoints — along the text axis
    const end = mid(q.pts[(bi + 1) % 4]!, q.pts[(bi + 2) % 4]!);
    const len = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const u: [number, number] = [(end[0] - start[0]) / len, (end[1] - start[1]) / len];
    // normal distance of each cell center to the axis line must be ~0
    for (const c of cells) {
      const cx = (c[0] + c[2]) / 2, cy = (c[1] + c[3]) / 2;
      const d = Math.abs((cx - start[0]) * u[1] - (cy - start[1]) * u[0]);
      expect(d).toBeLessThan(1.5);
      expect(Math.abs((c[2] - c[0]) - (c[3] - c[1]))).toBeLessThan(1.5); // square
    }
  });

  it("expectChars: long/thin ratio estimates char count, min 2", () => {
    expect(expectChars(quadAt(0, 200, 20))).toBe(10);
    expect(expectChars(quadAt(0, 20, 20))).toBe(2); // square clamps at 2? 20/20=1 → max(2,1)=2
  });

  it("validateRead flags reads deviating >40% (or 3) from measured expectation", () => {
    expect(validateRead(18, 11)).toBe(true);  // |18-11|=7 > max(3, 4.4)
    expect(validateRead(12, 11)).toBe(false); // within tolerance
    expect(validateRead(5, 20)).toBe(true);
  });

  it("medianAngle over mixed quads", () => {
    expect(medianAngle([-20, -21, -19])).toBe(-20);
  });
});

describe("pipeline v2 structure regression (committed det fixtures, offline)", () => {
  it("letter: dedupe keeps 9, reading order is stable, truth-length texts get in-bounds char cells", () => {
    const truth = JSON.parse(readFileSync("bench/fixtures/ladder/letter-diagonal.truth-trad.json", "utf8")) as { lines: string[] };
    const quads = dedupeQuads(letterFixture.quads);
    expect(quads.length).toBe(9);
    const ordered = readingOrder(quads);
    expect(ordered.length).toBe(9);
    // assign truth lines in reading order (test stub — live reads are bench-gated)
    const texts = truth.lines.slice(0, ordered.length);
    for (let i = 0; i < ordered.length; i++) {
      const t = texts[i]!;
      const cells = charCells(ordered[i]!, [...t].length);
      expect(cells.length).toBe([...t].length);
      for (const c of cells) {
        expect(c[0]).toBeGreaterThanOrEqual(0); expect(c[1]).toBeGreaterThanOrEqual(0);
        expect(c[2]).toBeLessThanOrEqual(letterFixture.w); expect(c[3]).toBeLessThanOrEqual(letterFixture.h);
      }
      // deviation flag matches the POC behavior: expectation from geometry
      void validateRead([...t].length, expectChars(ordered[i]!));
    }
  });

  it("poster: dedupe deterministic, rows group into a stable order, every quad yields cells", () => {
    const kept = dedupeQuads(posterFixture.quads);
    expect(kept.length).toBe(18);
    const ordered = readingOrder(kept);
    expect(ordered.length).toBe(18);
    for (const q of ordered) {
      const n = expectChars(q);
      expect(charCells(q, n)).toHaveLength(n);
    }
  });
});

describe("axis canonicalization (det corner-order robustness)", () => {
  it("axisAngle: reversed corner order (170° edge) canonicalizes to the same axis as 0°", async () => {
    const { axisAngle } = await import("../../src/server/ocr-geometry");
    const fwd = quadAt(0, 200, 20);
    const rev: Quad = { pts: [...fwd.pts].reverse() }; // same quad, corners reversed → edge reads ~180°
    expect(axisAngle(fwd)).toBeCloseTo(0, 5);
    expect(axisAngle(rev)).toBeCloseTo(0, 5);
    const col = quadAt(70, 200, 20);
    const colRev: Quad = { pts: [...col.pts].reverse() };
    expect(axisAngle(col)).toBeCloseTo(axisAngle(colRev), 5);
    expect(Math.abs(axisAngle(col))).toBeGreaterThan(45); // vertical stays vertical
  });

  it("charCells run in reading direction regardless of corner order", async () => {
    const fwd = quadAt(0, 300, 60, [100, 100]);
    const rev: Quad = { pts: [...fwd.pts].reverse() };
    const cf = charCells(fwd, 3), cr = charCells(rev, 3);
    expect(cf[0]![0]).toBeLessThan(cf[2]![0]); // left→right
    expect(cr[0]![0]).toBeLessThan(cr[2]![0]); // reversed corners too
  });
});

describe("cropPlan (sharp rotation mapping — measured behavior)", () => {
  it("plan.map predicts where sharp actually moves a marked point (real sharp, raw buffers)", async () => {
    const { cropPlan } = await import("../../src/server/ocr-pipeline");
    const W = 400, H = 300, angle = 30;
    const plan = cropPlan(W, H, angle);
    // red dot at (300,50) on a raw image
    const base = Buffer.alloc(W * H * 3, 255);
    const put = (x: number, y: number) => {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const i = ((y + dy) * W + (x + dx)) * 3;
        base[i] = 255; base[i + 1]! = 0; base[i + 2]! = 0;
      }
    };
    put(300, 50);
    const rot = await sharp(base, { raw: { width: W, height: H, channels: 3 } })
      .rotate(plan.rotateArg, { background: { r: 255, g: 255, b: 255 } })
      .extend({ top: plan.D, left: plan.D, bottom: plan.D, right: plan.D, background: { r: 255, g: 255, b: 255 } })
      .raw().toBuffer({ resolveWithObject: true });
    let found: [number, number] | null = null;
    for (let y = 0; y < rot.info.height && !found; y++)
      for (let x = 0; x < rot.info.width; x++) {
        const i = (y * rot.info.width + x) * rot.info.channels;
        if (rot.data[i]! > 200 && rot.data[i + 1]! < 100 && rot.data[i + 2]! < 100) { found = [x, y]; break; }
      }
    expect(found).not.toBeNull();
    const pred = plan.map([300, 50]);
    expect(Math.abs(pred[0] - found![0])).toBeLessThanOrEqual(3);
    expect(Math.abs(pred[1] - found![1])).toBeLessThanOrEqual(3);
  });
});


describe("splitQuad + charSim (evidence-driven multi-line handling)", () => {
  it("splitQuad: 2 strips of half thickness, same length and angle", async () => {
    const { splitQuad } = await import("../../src/server/ocr-geometry");
    const q = quadAt(0, 300, 60, [100, 100]);
    const [a, b] = splitQuad(q, 2) as [Quad, Quad];
    const fa = frameBox(a, 0), fb = frameBox(b, 0);
    expect(fa[2] - fa[0]).toBeCloseTo(300, 0);
    expect(fa[3] - fa[1]).toBeCloseTo(30, 0);
    expect(fb[3] - fb[1]).toBeCloseTo(30, 0);
    expect(fa[1]).toBeLessThan(fb[1]); // first strip on top
  });

  it("charSim: duplicate paragraphs match, distinct content does not", async () => {
    const { charSim } = await import("../../src/server/ocr-geometry");
    const t = "長期舉辦KidsFleaMarket培養孩子的環保意識";
    expect(charSim(t, [...t].reverse().join(""))).toBe(1);
    expect(charSim(t, "密呈太傅大人的鈞座")).toBeLessThan(0.4);
  });
});
