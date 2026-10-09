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

/**
 * Canonical text-axis angle in [-90, 90) with READING-direction orientation:
 * near-horizontal axes point left→right (dx > 0), near-vertical top→bottom
 * (dy > 0). Det quads arrive with arbitrary corner order (a row can read as
 * ~170° = same axis flipped) — rotations and cell orderings must be canonical
 * or crops come out upside-down and chars map to mirrored cells.
 */
export function axisAngle(q: Quad): number {
  let a = quadAngle(q);
  return ((((a + 90) % 180) + 180) % 180) - 90; // axis → [-90, 90)
}

/**
 * True when the quad's longest edge runs BACKWARD along the text axis
 * (det corner order is arbitrary). Rotating by axisAngle alone leaves such
 * crops 180° upside-down; callers rotate by axisAngle + (flip ? 180 : 0).
 */
export function axisFlip(q: Quad): boolean {
  const bi = longestEdge(q);
  const p0 = q.pts[bi]!, p1 = q.pts[(bi + 1) % 4]!;
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const a = axisAngle(q);
  return Math.abs(a) < 45 ? dx < 0 : dy < 0;
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
 * Drop detector double-reads: quads whose TEXT-FRAME boxes have IoU ≥ 0.6.
 * Frame-space (not AABB) is essential — slanted lines overlap heavily as
 * AABBs without being dupes. IoU (not overlap-of-smaller) is essential the
 * other way: tightly-spaced ADJACENT rows (dense wrapped paragraphs) overlap
 * heavily as a fraction of the smaller box but have low IoU — they are
 * different lines and must survive (owner photo regression). True double-
 * reads box the same region: IoU ≈ 0.9+. Same-content stragglers are caught
 * downstream by the text-similarity layer.
 */
export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const uni = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return uni > 0 ? inter / uni : 0;
}

export function dedupeQuads<T extends Quad>(quads: T[]): T[] {
  if (quads.length === 0) return [];
  const med = medianAngle(quads.map(quadAngle));
  const fb = new Map<T, Box>();
  for (const q of quads) fb.set(q, frameBox(q, med));
  const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);
  const sorted = [...quads].sort((a, b) => area(fb.get(b)!) - area(fb.get(a)!));
  const kept: T[] = [];
  for (const q of sorted) {
    if (!kept.some((k) => iou(fb.get(q)!, fb.get(k)!) >= 0.6)) kept.push(q);
  }
  return kept;
}

/**
 * Merge collinear fragments: same text axis (±8° of the shared median),
 * centers within 0.35× the thinner quad's thickness PERPENDICULAR to the
 * axis (fragments of ONE line barely differ; adjacent lines differ by a
 * full pitch — 0.75 was too loose and chained whole columns together),
 * axially contiguous (gap ≤ 1.5× thickness) → one spanning quad.
 * Det splits a single column into stacked fragments (owner photo:
 * 卑職深知… + 大不敢有絲 are two reads of one column).
 */
export function mergeCollinear<T extends Quad>(quads: T[]): Quad[] {
  if (quads.length < 2) return quads;
  const med = medianAngle(quads.map(axisAngle));
  // canonical rotation makes text HORIZONTAL in frame space (axis = x', perp = y')
  const items = quads.map((q) => {
    const a = axisAngle(q);
    const fb = frameBox(q, med);
    return { q, a, fb };
  });
  const perp = (fb: Box) => (fb[1] + fb[3]) / 2;
  const axial = (fb: Box) => [fb[0], fb[2]] as const;
  const thickness = (fb: Box) => fb[3] - fb[1];
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (i: number, j: number) => { parent[find(i)] = find(j); };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i]!, B = items[j]!;
      if (Math.abs(A.a - med) > 8 || Math.abs(B.a - med) > 8) continue;
      const thin = Math.min(thickness(A.fb), thickness(B.fb));
      if (Math.abs(perp(A.fb) - perp(B.fb)) > 0.35 * thin) continue;
      const [a0, a1] = axial(A.fb), [b0, b1] = axial(B.fb);
      const gap = Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));
      if (gap > 1.5 * thin) continue;
      union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  items.forEach((_, i) => {
    const r = find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(i);
  });
  const rad = (med * Math.PI) / 180;
  const back = (x: number, y: number): [number, number] => {
    // rotate frame coords back to original space (frameBox rotated by -med about origin)
    const c = Math.cos(rad), sn = Math.sin(rad);
    return [x * c - y * sn, x * sn + y * c];
  };
  const out: Quad[] = [];
  for (const [root, members] of groups) {
    if (members.length === 1) { out.push(items[root]!.q); continue; }
    const fbs = members.map((m) => items[m]!.fb);
    const l = Math.min(...fbs.map((b) => b[0])), t = Math.min(...fbs.map((b) => b[1]));
    const r = Math.max(...fbs.map((b) => b[2])), bo = Math.max(...fbs.map((b) => b[3]));
    out.push({ pts: [back(l, t), back(r, t), back(r, bo), back(l, bo)] });
  }
  return out;
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
  let start = mid(q.pts[(bi + 3) % 4]!, q.pts[bi]!);
  let end = mid(q.pts[(bi + 1) % 4]!, q.pts[(bi + 2) % 4]!);
  // canonical reading direction: cells run left→right (near-horizontal) / top→bottom (near-vertical)
  const ang = axisAngle(q);
  if (Math.abs(ang) < 45 ? end[0] < start[0] : end[1] < start[1]) {
    const t = start; start = end; end = t;
  }
  const len = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (len < 1 || n < 1) return [];
  const u: Pt = [(end[0] - start[0]) / len, (end[1] - start[1]) / len];
  const side = Math.max(4, len / n); // clamp: hallucinated long reads must not collapse cells to 0px
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

/**
 * Split one quad into k equal strips perpendicular to its text axis. Used
 * AFTER a crop read returns k lines (newlines in the text) — the READ confirms
 * the geometry, never the reverse (thickness alone can't distinguish a merged
 * pair of rows from a large-font title).
 */
export function splitQuad<T extends Quad>(q: T, k: number): Quad[] {
  if (k < 2) return [q];
  const bi = longestEdge(q);
  const P = q.pts;
  const e1a = P[bi]!, e1b = P[(bi + 1) % 4]!, e2a = P[(bi + 2) % 4]!, e2b = P[(bi + 3) % 4]!;
  const out: Quad[] = [];
  for (let j = 0; j < k; j++) {
    const f0 = j / k, f1 = (j + 1) / k;
    const lerp = (a2: Pt, b2: Pt, f: number): Pt => [a2[0] + (b2[0] - a2[0]) * f, a2[1] + (b2[1] - a2[1]) * f];
    out.push({ pts: [lerp(e1a, e2a, f0), lerp(e1b, e2b, f0), lerp(e1b, e2b, f1), lerp(e1a, e2a, f1)] });
  }
  return out;
}
/** character-multiset similarity (0-1) — duplicate-line detection */
export function charSim(a: string, b: string): number {
  const count = (t: string) => { const m: Record<string, number> = {}; for (const c of t) m[c] = (m[c] ?? 0) + 1; return m; };
  const ca = count(a), cb = count(b);
  let hit = 0, la = 0, lb = 0;
  for (const c in ca) { la += ca[c]!; hit += Math.min(ca[c]!, cb[c] ?? 0); }
  for (const c in cb) lb += cb[c]!;
  return hit / Math.max(1, Math.min(la, lb));
}

function xCentroid(q: Quad): number {
  return q.pts.reduce((s2, p) => s2 + p[0], 0) / q.pts.length;
}

/**
 * Fill missing columns at regular pitch: when ≥4 near-vertical columns share
 * a consistent x-pitch, a gap ≥1.6× the median pitch marks an undetected
 * column (owner photo: 8 of 9 found — 確為真品 missed at every threshold).
 * The synthesized quad spans the median column extent at the gap position —
 * the ink is real, det simply didn't box it; the crop read recovers the text.
 */
export function fillGaps<T extends Quad>(quads: T[]): Quad[] {
  const cols = quads.filter((q) => Math.abs(axisAngle(q)) >= 45);
  if (cols.length < 4) return quads;
  // columns are near-vertical: page-x position ≈ AABB x-center (crops get
  // per-quad deskew later, so a plain vertical AABB synthesis is fine)
  const infos = cols.map((q) => {
    const xs = q.pts.map((p) => p[0]), ys = q.pts.map((p) => p[1]);
    const l = Math.min(...xs), r2 = Math.max(...xs), t = Math.min(...ys), b = Math.max(...ys);
    return { cx: (l + r2) / 2, w: r2 - l, t, b };
  }).sort((a, b) => a.cx - b.cx);
  const pitches: number[] = [];
  for (let i = 1; i < infos.length; i++) pitches.push(infos[i]!.cx - infos[i - 1]!.cx);
  const med = medianAngle(pitches);
  const medW = medianAngle(infos.map((i) => i.w));
  // pitch must be CONSISTENT (uneven spacing → estimate is noise; synthesizing
  // from noise fabricated dozens of phantom columns — owner photo regression)
  if (med < 8 || med > 500) return quads;
  // most pitches near-median (a missing column shows as ONE 2× pitch among
  // normals; irregular layouts fail this and are left alone)
  const near = pitches.filter((p) => Math.abs(p - med) <= 0.25 * med).length;
  if (near < 0.6 * pitches.length) return quads;
  const out: Quad[] = [...quads];
  for (let i = 1; i < infos.length; i++) {
    const gap = infos[i]!.cx - infos[i - 1]!.cx;
    if (gap < 1.6 * med) continue;
    const nMissing = Math.round(gap / med) - 1;
    if (nMissing > 2) continue; // a 3+ column hole means the pitch model is wrong
    for (let k = 1; k <= nMissing; k++) {
      const cx = infos[i - 1]!.cx + (gap * k) / (nMissing + 1);
      const t = medianAngle(infos.map((x) => x.t)), b = medianAngle(infos.map((x) => x.b));
      const l = cx - medW / 2, r3 = cx + medW / 2;
      out.push({ pts: [[l, t], [r3, t], [r3, b], [l, b]] });
    }
  }
  return out;
}

