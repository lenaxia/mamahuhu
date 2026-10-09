/**
 * STRUCTURE FUSION v2 — FRAGMENT-INVENTORY ARCHITECTURE (0.8.0)
 *
 * Division of labor, one level deeper than v1:
 *   classical fragments = THE LINE INVENTORY (RapidOCR is deterministic: same
 *     fragments every call — the inventory cannot contain duplicates, merges,
 *     or misses by construction)
 *   structure LLM        = TEXT IMPROVEMENT (its better reading replaces a
 *     fragment's CTC text where it covers the fragment) + detection of
 *     columns classical can't read (LLM-only lines, placed by inference)
 *
 * v1 trusted the LLM's line SET as inventory and taught the matcher to digest
 * its instability (duplicates/merges/missing columns every call — three prod
 * incidents). The chain/claims/prune machinery that required is deleted here:
 * per-fragment selection has no cross-fragment placement problem. The one
 * durable rule retained from that era: an LLM-only line whose inferred slot
 * is occupied is a duplicate reading of that column — genuine repeats anchor
 * their own fragments or infer into their own line-numbered slots.
 *
 * Not wired into app.ts until verified; bench/ocr-structure.ts drives it.
 */
import { toTraditional } from "../shared/cedict";

export interface ClassicalItem { box: [number, number, number, number]; text: string; score: number }
export interface StructureLine { n: number; text: string; dir: "h" | "v" }

export interface FusedChar {
  char: string;
  box?: [number, number, number, number];
  anchored: boolean;
  extrapolated?: boolean;
}

export interface FusedLine {
  n: number;
  dir: "h" | "v";
  text: string;
  chars: FusedChar[];
  angle: number | null;
  dirFromLLM: boolean;
  gaps: { atChar: number; widths: number }[];
  matchedFragments: number[];
  /** true when the LLM's reading replaced the fragment's CTC text */
  improved?: boolean;
  /** geometry LAYOUT-INFERRED (LLM-only column, no fragment) */
  inferred?: boolean;
}

export interface FusionResult {
  lines: FusedLine[];
  /** LLM lines that matched no fragment and lost their slot — diagnostics */
  droppedLines: { n: number; text: string }[];
  /** true when the fragment lattice cannot represent the page (diagonal
   *  strips read as rows / orientation disagreement) — fusion's geometry is
   *  worthless and the VECTOR rung (from→to per line) is the better server */
  latticeDegenerate?: boolean;
}

// ---------- tokenization / parsing ----------

interface Token { char?: string; gap?: number }

export function parseStructureTokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/⟪(\d+(?:\.\d+)?)⟫|[^⟪]/gu)) {
    if (m[1]) out.push({ gap: Math.max(0, parseFloat(m[1])) });
    else if (m[0]) out.push({ char: m[0] });
  }
  return out;
}

const cleanNorm = (s: string) => toTraditional(s.replace(/\s+/g, ""));

/** normalized-char overlap ratio — used ONLY between LLM-only lines (no
 *  fragments involved) to group variant readings of one missing column;
 *  fragment lines are never text-deduped (the 11× genuine-repeat rule). */
function textSimilar(a: string, b: string): number {
  const A = cleanNorm(a), B = cleanNorm(b);
  const shorter = Math.min(A.length, B.length);
  if (shorter < 4) return A === B ? 1 : 0; // short columns: exact match IS a duplicate reading
  let hit = 0;
  for (const c of new Set([...A])) hit += Math.min([...A].filter((x) => x === c).length, [...B].filter((x) => x === c).length);
  return hit / shorter;
}

/** parse the structure-LLM raw response → StructureLine[] (balanced-bracket
 *  JSON, tolerant of fences/bare arrays; gap-only/empty-text lines dropped). */
export function parseStructureLines(raw: string): StructureLine[] {
  const s = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "");
  const starts = [s.indexOf("{"), s.indexOf("[")].filter((n) => n >= 0);
  if (!starts.length) return [];
  const start = Math.min(...starts);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        try {
          const p: unknown = JSON.parse(s.slice(start, i + 1));
          const arr = (Array.isArray(p) ? p : (p as { lines?: unknown[] }).lines ?? []) as { n?: number; text?: unknown; dir?: unknown }[];
          return arr
            .filter((l) => typeof l.text === "string" && l.text.replace(/⟪[^⟫]*⟫/gu, "").trim())
            .map((l, i) => ({ n: typeof l.n === "number" ? l.n : i + 1, text: l.text as string, dir: l.dir === "v" ? "v" as const : "h" as const }));
        } catch { return []; }
      }
    }
  }
  return [];
}

// ---------- local alignment (fragment ↔ LLM-line text) ----------

interface LocalAlign { fStart: number; fEnd: number; startC: number; endC: number; score: number; matched: number }

/** Smith-Waterman with free ends both sides: best aligned chunk. Variant and
 *  punctuation tolerant; returns the fragment sub-range and line window. */
export function localAlign(fChars: string[], cChars: string[]): LocalAlign | null {
  const m = fChars.length, n = cChars.length;
  if (!m || !n) return null;
  const MATCH = 1, MISMATCH = -0.25, SKIP_C = -0.15, SKIP_F = -0.5;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  let best = 0, bi = 0, bj = 0;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const v = Math.max(
        0,
        dp[i - 1]![j - 1]! + (fChars[i - 1] === cChars[j - 1] ? MATCH : MISMATCH),
        dp[i]![j - 1]! + SKIP_C,
        dp[i - 1]![j]! + SKIP_F,
      );
      dp[i]![j] = v;
      if (v > best) { best = v; bi = i; bj = j; }
    }
  }
  if (best <= 0) return null;
  let i = bi, j = bj, matched = 0;
  while (i > 0 && j > 0 && dp[i]![j]! > 0) {
    const eq = fChars[i - 1] === cChars[j - 1];
    if (Math.abs(dp[i]![j]! - (dp[i - 1]![j - 1]! + (eq ? MATCH : MISMATCH))) < 1e-9) { if (eq) matched++; i--; j--; }
    else if (Math.abs(dp[i]![j]! - (dp[i]![j - 1]! + SKIP_C)) < 1e-9) j--;
    else if (Math.abs(dp[i]![j]! - (dp[i - 1]![j]! + SKIP_F)) < 1e-9) i--;
    else break;
  }
  return { fStart: i, fEnd: bi, startC: j, endC: bj, score: best, matched };
}

// ---------- geometry ----------

/** axis from a single fragment's own box. Orientation from chars-per-extent,
 *  not the dir label (banner columns are labeled "h"). `lean`/`axisLocked`
 *  mark when the box's directional claim is credible evidence. */
function axisFromBox(box: [number, number, number, number], m: number, dir: "h" | "v"): { ux: number; uy: number; lean: boolean } {
  const w = box[2] - box[0], h = box[3] - box[1];
  const mm = Math.max(2, m);
  const gX = w / mm, gY = h / mm;
  if (gY >= gX * 1.3) {
    if (w <= gY * 1.8) return { ux: 0, uy: 1, lean: false }; // clean column
    const g = Math.hypot(w, h) / (mm + Math.SQRT2);
    const sinT = Math.min(0.999, Math.max(0.05, (h - g) / (mm * g)));
    return { ux: Math.sqrt(1 - sinT * sinT), uy: sinT, lean: true }; // lean sign +x (measured)
  }
  if (h > gX * 2.5 && dir === "v") {
    const g = Math.hypot(w, h) / (mm + Math.SQRT2);
    const sinT = Math.min(0.999, Math.max(0.05, (h - g) / (mm * g)));
    return { ux: Math.sqrt(1 - sinT * sinT), uy: sinT, lean: true };
  }
  return { ux: 1, uy: 0, lean: false }; // row (rotated strips masquerade as rows — no directional claim)
}

/** per-char cells evenly along the fragment's axis (square cells at pitch) */
function fragmentChars(text: string, box: [number, number, number, number], dir: "h" | "v"): { chars: FusedChar[]; angle: number } {
  const m = Math.max(1, [...text].length);
  const { ux, uy } = axisFromBox(box, m, dir);
  const w = box[2] - box[0], h = box[3] - box[1];
  const extent = w * Math.abs(ux) + h * Math.abs(uy);
  const pitch = extent / m;
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const chars = [...text].map((ch, k) => {
    const off = k - (m - 1) / 2;
    const px = cx + ux * off * pitch, py = cy + uy * off * pitch;
    const hp = pitch / 2;
    return { char: ch, box: [Math.round(px - hp), Math.round(py - hp), Math.round(px + hp), Math.round(py + hp)] as [number, number, number, number], anchored: true };
  });
  return { chars, angle: Math.round((Math.atan2(uy, ux) * 180) / Math.PI) };
}

// ---------- fusion ----------

/** Fragment-inventory fusion. Output = one line per classical fragment (text
 *  improved by the best fully-covering LLM reading) + inferred lines for
 *  LLM-only columns. Reading order: banded rows/columns, vertical R→L. */
export function fuseStructure(items: ClassicalItem[], llmLines: StructureLine[], dims?: { w: number; h: number }): FusionResult {
  // LLM lines: normalized char arrays for matching
  const lines = llmLines.map((l) => {
    const tokens = parseStructureTokens(l.text);
    const cleanChars: string[] = [], normChars: string[] = [], gaps: { atChar: number; widths: number }[] = [];
    let o = 0;
    for (const t of tokens) {
      if (t.gap) { o += t.gap; if (cleanChars.length) gaps.push({ atChar: cleanChars.length, widths: t.gap }); }
      else { cleanChars.push(t.char!); normChars.push(cleanNorm(t.char!)); o += 1; }
    }
    return { ...l, cleanChars, normChars, gaps };
  });

  // INVENTORY: fragments with ≥2 chars or a Han char (drops M / + / 1 noise;
  // keeps latin words — real content), then GEOMETRIC DOUBLE-READ DEDUP —
  // the detector emits overlapping re-reads of one region (prod OpenVINO:
  // 密呈…钓庄 AND 密呈…钧座 as separate fragments; a column plus its tail
  // re-read). Overlap ≥60% of the smaller box = same region → keep the longer
  // reading (then higher score). Position-based: same text at DIFFERENT
  // positions always survives (the 11× genuine-repeat rule).
  const area = (b: [number, number, number, number]) => Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
  const overlapFrac = (a: [number, number, number, number], b: [number, number, number, number]) => {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    return (ix * iy) / Math.min(area(a), area(b));
  };
  const candidates = items.map((it, idx) => ({ idx, it, m: [...it.text].length }))
    .filter((f) => f.m >= 2 || /\p{Script=Han}/u.test(f.it.text));
  const keep: typeof candidates = [];
  for (const f of candidates) {
    // geometry ALONE cannot dedup: adjacent diagonal columns' AABBs overlap
    // up to 0.78 (measured). Double-reads are same-region AND same-content.
    const dupOf = keep.find((k) => overlapFrac(k.it.box, f.it.box) >= 0.6 && textSimilar(k.it.text, f.it.text) >= 0.5);
    if (!dupOf) { keep.push(f); continue; }
    if (f.m > dupOf.m || (f.m === dupOf.m && f.it.score > dupOf.it.score)) keep[keep.indexOf(dupOf)] = f;
  }
  const tall = (f: { it: ClassicalItem }) => (f.it.box[3] - f.it.box[1]) > (f.it.box[2] - f.it.box[0]) * 1.3;
  const bandSort = <T extends { it: ClassicalItem }>(fs: T[], axis: "y" | "x", reverse: boolean): T[] => {
    if (fs.length < 2) return fs;
    const exts = fs.map((f) => (axis === "y" ? f.it.box[3] - f.it.box[1] : f.it.box[2] - f.it.box[0])).sort((a, b) => a - b);
    const tol = Math.max(4, 0.3 * exts[Math.floor(fs.length / 2)]!);
    const center = (f: T) => (axis === "y" ? (f.it.box[1] + f.it.box[3]) / 2 : (f.it.box[0] + f.it.box[2]) / 2);
    return [...fs].sort((a, b) => {
      const ka = Math.round(center(a) / tol), kb = Math.round(center(b) / tol);
      if (ka !== kb) return reverse ? kb - ka : ka - kb;
      return axis === "y" ? a.it.box[0] - b.it.box[0] : a.it.box[1] - b.it.box[1];
    });
  };
  const ordered = [...bandSort(keep.filter((f) => !tall(f)), "y", false), ...bandSort(keep.filter(tall), "x", true)];

  // TEXT IMPROVEMENT: per fragment, the best LLM window covering it. A window
  // accepts at ≥90% span OR ≥55% matched (CTC-tolerant). When a line improves
  // EXACTLY ONE fragment and covers ≥60% of it, the line is that column's
  // FULL reading — take it whole (slicing assumes 1:1 char counts and loses
  // tails when the reading inserts chars: measured 密呈…鈞座 lost 座). Lines
  // improving several fragments keep per-fragment slices (straddle case).
  // room guard: a genuine reading must be able to cover the fragment's
  // trimmed tail ((lineLen - endC) >= (m - fEnd)) — without it, another
  // column's line sharing an in-order phrase (太傅大人 in 明望太傅大人 vs
  // 太傅大人親啟) substitutes or swallows content (reviewer case 2)
  const accept = (w: { fStart: number; fEnd: number; startC: number; endC: number; matched: number } | null, m: number, lineLen: number) =>
    !!w && ((w.fEnd - w.fStart) / m >= 0.9 || w.matched >= 0.55 * m) && (lineLen - w.endC >= m - w.fEnd);
  const windows = new Map<string, LocalAlign | null>();
  const acceptingFrags: number[][] = lines.map(() => []);
  for (const f of keep) {
    const fChars = [...cleanNorm(f.it.text)];
    for (let li = 0; li < lines.length; li++) {
      const w = localAlign(fChars, lines[li]!.normChars);
      windows.set(`${f.idx}:${li}`, w!);
      if (accept(w, fChars.length, lines[li]!.normChars.length)) acceptingFrags[li]!.push(f.idx);
    }
  }
  const improvedBy = new Map<number, string>();
  for (const f of keep) {
    const fChars = [...cleanNorm(f.it.text)];
    let best: { text: string; cov: number; score: number } | null = null;
    for (let li = 0; li < lines.length; li++) {
      const w = windows.get(`${f.idx}:${li}`);
      if (!w || !accept(w, fChars.length, lines[li]!.normChars.length)) continue;
      const cov = (w.fEnd - w.fStart) / fChars.length;
      const whole = acceptingFrags[li]!.length === 1 && cov >= 0.6;
      const slice = whole
        ? lines[li]!.cleanChars.join("")
        : lines[li]!.cleanChars.slice(Math.max(0, w.startC - w.fStart), Math.min(lines[li]!.cleanChars.length, w.endC + (fChars.length - w.fEnd))).join("");
      if (!slice.trim()) continue;
      const rank = Math.max(cov, w.matched / fChars.length);
      if (!best || rank > best.cov || (rank === best.cov && w.score > best.score)) best = { text: slice, cov: rank, score: w.score };
    }
    if (best && best.text !== f.it.text) improvedBy.set(f.idx, best.text);
  }

  // assemble fragment lines
  const outLines: FusedLine[] = ordered.map((f, i) => {
    const text = improvedBy.get(f.idx) ?? f.it.text;
    const dir: "h" | "v" = tall(f) ? "v" : "h";
    const { chars, angle } = fragmentChars(text, f.it.box, dir);
    return {
      n: i + 1, dir, text, chars, angle, dirFromLLM: false, gaps: [],
      matchedFragments: [f.idx], ...(improvedBy.has(f.idx) ? { improved: true } : {}),
    };
  });
  // LLM-ONLY COLUMNS: lines whose content no inventory fragment covers —
  // classical couldn't read the column. Placed into the lattice's FREE GAPS
  // (cross-axis spacing ≥1.8× the column gap, plus the outer edges), in the
  // LLM's reading order; more variants than free slots = duplicate readings,
  // dropped. Genuine repeats always have their own fragments or slots.
  // covered = the line would be (or was) ACCEPTED as an improvement reading of
  // some fragment — the SAME standard (≥0.9 span or ≥0.55 matched). A looser
  // test ate real columns: 明望太傅大人 was "covered" by the 密呈 fragment on
  // shared 太傅大人 (4 chars) and dropped, its content nowhere in the output.
  const coveredByInventory = (ln: { normChars: string[] }) => {
    for (const f of keep) {
      const fChars = [...cleanNorm(f.it.text)];
      const w0 = localAlign(fChars, ln.normChars);
      if (accept(w0, fChars.length, ln.normChars.length)) return true;
    }
    return false;
  };
  let latticeDegenerateFlag = false;
  const llmOnlyAll = lines.filter((ln) => ln.cleanChars.length >= 2 && !coveredByInventory(ln));
  // DEGENERATE LATTICE: the fragment inventory cannot represent the page.
  // TWO signals AND-ed (each alone false-positives on print fixtures):
  // 1. COUNT DEFICIT — LLM-only lines outnumber classical fragments
  //    (owner letter: 5 unanchored columns vs 4 garbled strips; posters
  //    have llmOnly ≪ fragments, so print never trips this)
  // 2. STRIP OVERLAP — fragment boxes mutually overlap ≥60% of the smaller
  //    box: diagonal strips crossing columns (letter: 0.80-0.94), not the
  //    0-overlap clean geometry of seatable LLM-only-column cases
  // Measured: letter fixture 0.80 / app-exact 0.94; synthetic seat tests 0.
  let maxOverlap = 0;
  for (let i = 0; i < keep.length; i++)
    for (let j = i+1; j < keep.length; j++)
      maxOverlap = Math.max(maxOverlap, overlapFrac(keep[i]!.it.box, keep[j]!.it.box));
  latticeDegenerateFlag = llmOnlyAll.length > keep.length && maxOverlap >= 0.6;
  const llmOnly = latticeDegenerateFlag ? [] : llmOnlyAll;
  const dropped: { n: number; text: string }[] = [];
  if (outLines.length && llmOnly.length) {
    const angles = outLines.map((l) => l.angle!).sort((a, b) => a - b);
    const medAngle = angles[Math.floor(angles.length / 2)]!;
    const rad = (medAngle * Math.PI) / 180;
    const ax = Math.cos(rad), ay = Math.sin(rad);
    const cxn = -ay, cyn = ax;
    const info = outLines.map((l) => {
      const bs = l.chars.map((c) => c.box!) as [number, number, number, number][];
      const mid = bs[Math.floor(bs.length / 2)]!;
      const sizes = bs.map((b) => Math.max(b[2] - b[0], b[3] - b[1])).sort((a, b) => a - b);
      return { center: [(mid[0] + mid[2]) / 2, (mid[1] + mid[3]) / 2] as [number, number], pitch: sizes[Math.floor(sizes.length / 2)]! };
    });
    const crossOf = (p: [number, number]) => p[0] * cxn + p[1] * cyn;
    const crosses = info.map((i) => crossOf(i.center)).sort((a, b) => a - b);
    const pitch = info.map((i) => i.pitch).sort((a, b) => a - b)[Math.floor(info.length / 2)]!;
    const gapList: number[] = [];
    for (let i = 1; i < crosses.length; i++) gapList.push(crosses[i]! - crosses[i - 1]!);
    gapList.sort((a, b) => a - b);
    const colGap = gapList.length ? gapList[Math.floor(gapList.length / 2)]! : pitch * 1.2;
    const freeThreshold = 1.8 * Math.min(colGap, pitch * 1.5);
    // reading direction on the cross axis (which end the reading starts at):
    // from the page's dominant angle — vertical pages read R→L (high cross
    // first) when columns are near-vertical; horizontal pages L→R
    const verticalPage = medAngle > 45 || medAngle < -45;
    const slots: number[] = [];
    for (let i = 1; i < crosses.length; i++) {
      if (crosses[i]! - crosses[i - 1]! >= freeThreshold) slots.push((crosses[i]! + crosses[i - 1]!) / 2);
    }

    // column start (along axis) from the fragment lines' first-char medians
    const alongOf = (p: [number, number]) => p[0] * ax + p[1] * ay;
    const starts = outLines.map((l) => {
      const b0 = l.chars[0]!.box!;
      return alongOf([(b0[0] + b0[2]) / 2, (b0[1] + b0[3]) / 2]);
    }).sort((a, b) => a - b);
    const baseAlong = starts[Math.floor(starts.length / 2)]!;
    // SEATING in PIXEL space: cross-space distinctness is not pixel
    // distinctness on rotated pages (a degenerate cross axis stacks boxes at
    // one pixel — owner-measured six columns at x=-40). A column is seated
    // only if its pixel center is ≥0.9×pitch from every seated column.
    const centerOf = (cross: number) => ({ x: ax * baseAlong + cxn * cross, y: ay * baseAlong + cyn * cross });
    const takenPix: { x: number; y: number }[] = info.map((i) => ({ x: i.center[0], y: i.center[1] }));
    // group variant readings of the SAME missing column (text-similar ≥0.55):
    // one group = one column; non-representative members drop
    const groups: { lines: typeof llmOnly }[] = [];
    const groupDrops: typeof llmOnly = [];
    for (const ln of llmOnly) {
      const g = groups.find((gr) => gr.lines.some((m) => textSimilar(m.cleanChars.join(""), ln.cleanChars.join("")) >= 0.55));
      if (g) { g.lines.push(ln); groupDrops.push(ln); } else groups.push({ lines: [ln] });
    }
    for (const d of groupDrops) dropped.push({ n: d.n, text: d.cleanChars.join("") });
    // slot supply: interior free gaps + outer stepping past the last-read
    // column (both page orientations read toward ascending cross), clamped to
    // image bounds over all four corners
    const crossAt = (px: number, py: number) => px * cxn + py * cyn;
    const corners = dims ? [[0, 0], [dims.w, 0], [0, dims.h], [dims.w, dims.h]] : null;
    const crossVals = corners ? corners.map(([x, y]) => crossAt(x!, y!)) : null;
    const maxCross = crossVals ? Math.max(...crossVals) : Infinity;
    const minCross = crossVals ? Math.min(...crossVals) : -Infinity;
    const lastCross = crosses[crosses.length - 1]!;
    // a supply value that needs clamping is OUTSIDE the lattice — offering it
    // as a seat pins boxes to the image edge (measured: 40px OOB at the bottom)
    const supply = [...slots];
    for (let i = 1; i <= groups.length; i++) supply.push(lastCross + colGap * i);
    const candidates = supply
      .filter((c) => c >= minCross && c <= maxCross)
      .map(centerOf)
      .sort((a, b) => (verticalPage ? (b.x - a.x) : (a.y - b.y))); // reading order
    const seated = new Map<number, { x: number; y: number }>();
    for (let gi = 0; gi < groups.length; gi++) {
      const spot = candidates.find((c) =>
        // seats must be INSIDE the image — an outside seat clamps to the edge
        // and renders a mangled box (measured: columns stacked at x=-40)
        (!dims || (c.x > -pitch && c.x < dims.w + pitch && c.y > -pitch && c.y < dims.h + pitch)) &&
        !takenPix.some((t) => Math.hypot(t.x - c.x, t.y - c.y) < 0.9 * pitch) &&
        ![...seated.values()].some((t) => Math.hypot(t.x - c.x, t.y - c.y) < 0.9 * pitch));
      if (spot) seated.set(gi, spot);
    }
    const groupLines = groups.map((g) => g.lines[0]!);
    for (let gi = 0; gi < groupLines.length; gi++) {
      const ln = groupLines[gi]!;
      const spot = seated.get(gi);
      if (!spot) {
        // the lattice cannot seat this column (rotated page / degenerate axis):
        // serve the text UNPOSITIONED (loose-words list), never a wrong box
        outLines.push({ n: ln.n, dir: ln.dir, text: ln.cleanChars.join(""), chars: ln.cleanChars.map((c) => ({ char: c, anchored: false })), angle: null, dirFromLLM: true, gaps: ln.gaps, matchedFragments: [] });
        continue;
      }
      // recover the cross value for placement from the seated pixel center
      const slot = (spot.x * cxn + spot.y * cyn);
      const chars: FusedChar[] = ln.cleanChars.map((ch, k) => {
        const along = baseAlong + (k + 0.5) * pitch;
        let px = ax * along + cxn * slot;
        let py = ay * along + cyn * slot;
        const hp = pitch / 2;
        if (dims) {
          px = Math.max(hp - 40, Math.min(dims.w - hp + 40, px));
          py = Math.max(hp - 40, Math.min(dims.h - hp + 40, py));
        }
        return { char: ch, box: [Math.round(px - hp), Math.round(py - hp), Math.round(px + hp), Math.round(py + hp)] as [number, number, number, number], anchored: false };
      });
      outLines.push({
        n: ln.n, dir: ln.dir, text: ln.cleanChars.join(""), chars,
        angle: medAngle, dirFromLLM: true, gaps: ln.gaps, matchedFragments: [], inferred: true,
      });
    }
  }

  return { lines: outLines, droppedLines: dropped, latticeDegenerate: latticeDegenerateFlag || undefined };
}



/** fusion result → the app's OcrLine contract. Fragment and inferred lines
 *  carry per-char boxes; nothing is text-only by construction. */
export function fusedToOcrLines(res: FusionResult): import("./ports").OcrLine[] {
  return res.lines.map((l) => {
    const boxes = l.chars.map((c) => c.box ?? null);
    const anchored = boxes.length > 0 && boxes.every((b) => b !== null);
    if (!anchored) return { text: l.text, dir: l.dir };
    const bs = boxes as [number, number, number, number][];
    const box: [number, number, number, number] = [
      Math.round(Math.min(...bs.map((b) => b[0]))),
      Math.round(Math.min(...bs.map((b) => b[1]))),
      Math.round(Math.max(...bs.map((b) => b[2]))),
      Math.round(Math.max(...bs.map((b) => b[3]))),
    ];
    const dir = l.angle !== null && Math.abs(l.angle) > 45 ? "v" : "h";
    return { text: l.text, box, dir, angle: l.angle ?? undefined, charBoxes: bs };
  });
}
