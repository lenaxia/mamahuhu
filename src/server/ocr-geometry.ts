/**
 * OCR pipeline v2 — pure geometry (pixel space, no I/O, no network).
 *
 * Architecture (validated in bench/poc-bench.py + poc-combine.py):
 * det quads → frame-space dedupe → reading order → per-quad rectification →
 * per-crop blind reads → char cells evenly spaced along each quad's axis.
 *
 * All functions are deterministic and unit-testable: geometry is MEASURED
 * (DBNet quads), never asked of an LLM.
 */

export type Pt = [number, number];
export type Quad = { pts: Pt[] };
export type Box = [number, number, number, number];

const rad = (deg: number) => (deg * Math.PI) / 180;

/** rotate p by deg around a center (default origin) */
export function rotatePt(p: Pt, deg: number, about: Pt = [0, 0]): Pt {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
  const x = p[0] - about[0], y = p[1] - about[1];
  return [x * c + y * s + about[0], -x * s + y * c + about[1]];
}

/** angle of the quad's longest edge — the text axis (0 = horizontal line, ±90 = vertical column) */
export function quadAngle(q: Quad): number {
  const bi = longestEdge(q);
  const a = q.pts[bi]!, b = q.pts[(bi + 1) % 4]!;
  return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
}

function edgeLengths(q: Quad): number[] {
  return q.pts.map((p, i) => {
    const b = q.pts[(i + 1) % 4]!;
    return Math.hypot(b[0] - p[0], b[1] - p[1]);
  });
}

function longestEdge(q: Quad): number {
  const e = edgeLengths(q);
  return e.indexOf(Math.max(...e));
}

/** AABB of the quad rotated into its text frame (about origin — relative geometry is what matters) */
export function frameBox(q: Quad, angle: number): Box {
  const pts = q.pts.map((p) => rotatePt(p, angle));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** overlap fraction: intersection over the SMALLER box (1 = contained/identical) */
export function overlapFrac(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const sm = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
  return sm > 0 ? (ix * iy) / sm : 0;
}

export function medianAngle(angles: number[]): number {
  const s = [...angles].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/**
 * Drop detector double-reads: quads whose TEXT-FRAME boxes overlap ≥0.6 of the
 * smaller. Frame-space (not AABB) is essential — slanted lines overlap heavily
 * as AABBs without being dupes (the letter fixture pins this: 9 slanted lines
 * whose AABBs overlap ≥0.6 all survive).
 */
export function dedupeQuads<T extends Quad>(quads: T[]): T[] {
  if (quads.length === 0) return [];
  const med = medianAngle(quads.map(quadAngle));
  const fb = new Map<T, Box>();
  for (const q of quads) fb.set(q, frameBox(q, med));
  const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);
  const sorted = [...quads].sort((a, b) => area(fb.get(b)!) - area(fb.get(a)!));
  const kept: T[] = [];
  for (const q of sorted) {
    if (!kept.some((k) => overlapFrac(fb.get(q)!, fb.get(k)!) >= 0.6)) kept.push(q);
  }
  return kept;
}

/**
 * Reading order. Vertical columns (|median angle| ≥ 45): right-to-left — the
 * traditional standard. Horizontal rows: top-to-bottom by y-band, then x.
 */
export function readingOrder<T extends Quad>(quads: T[]): T[] {
  if (quads.length === 0) return [];
  const med = medianAngle(quads.map(quadAngle));
  if (Math.abs(med) >= 45) {
    return [...quads].sort((a, b) => xCentroid(b) - xCentroid(a));
  }
  const boxes = new Map<T, Box>();
  for (const q of quads) boxes.set(q, frameBox(q, med));
  const bandH = medianAngle([...boxes.values()].map((b) => b[3] - b[1])); // robust typical height
  return [...quads].sort((a, b) => {
    const ba = boxes.get(a)!, bb = boxes.get(b)!;
    const bandA = Math.round(ba[1] / Math.max(1, bandH)), bandB = Math.round(bb[1] / Math.max(1, bandH));
    return bandA - bandB || ba[0] - bb[0];
  });
}

function xCentroid(q: Quad): number {
  return q.pts.reduce((s, p) => s + p[0], 0) / q.pts.length;
}

/** char count a quad's geometry implies: longest edge / thickness (POC-calibrated) */
export function expectChars(q: Quad): number {
  const e = edgeLengths(q);
  return Math.max(2, Math.round(Math.max(...e) / Math.max(1, Math.min(...e))));
}

/**
 * n equal SQUARE cells centered along the quad's text axis — the rendering
 * fix for "sizes all over the place": cell size is measured geometry divided
 * evenly, never an LLM estimate. Cell centers lie on the axis line.
 */
export function charCells(q: Quad, n: number): Box[] {
  const bi = longestEdge(q);
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(q.pts[(bi + 3) % 4]!, q.pts[bi]!);
  const end = mid(q.pts[(bi + 1) % 4]!, q.pts[(bi + 2) % 4]!);
  const len = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (len < 1 || n < 1) return [];
  const u: Pt = [(end[0] - start[0]) / len, (end[1] - start[1]) / len];
  const side = len / n;
  const cells: Box[] = [];
  for (let i = 0; i < n; i++) {
    const f = len * ((i + 0.5) / n);
    const cx = start[0] + u[0] * f, cy = start[1] + u[1] * f;
    const h = side / 2;
    cells.push([Math.round(cx - h), Math.round(cy - h), Math.round(cx + h), Math.round(cy + h)]);
  }
  return cells;
}

/** post-read geometry validation: flag reads deviating >max(3, 40%) from measured chars */
export function validateRead(len: number, expected: number): boolean {
  return Math.abs(len - expected) > Math.max(3, expected * 0.4);
}
