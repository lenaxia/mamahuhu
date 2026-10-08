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
  if (shorter < 4) return 0;
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
  const accept = (w: { fStart: number; fEnd: number; matched: number } | null, m: number) =>
    !!w && ((w.fEnd - w.fStart) / m >= 0.9 || w.matched >= 0.55 * m);
  const windows = new Map<string, LocalAlign>();
  const acceptingFrags: number[][] = lines.map(() => []);
  for (const f of keep) {
    const fChars = [...cleanNorm(f.it.text)];
    for (let li = 0; li < lines.length; li++) {
      const w = localAlign(fChars, lines[li]!.normChars);
      windows.set(`${f.idx}:${li}`, w!);
      if (accept(w, fChars.length)) acceptingFrags[li]!.push(f.idx);
    }
  }
  const improvedBy = new Map<number, string>();
  for (const f of keep) {
    const fChars = [...cleanNorm(f.it.text)];
    let best: { text: string; cov: number; score: number } | null = null;
    for (let li = 0; li < lines.length; li++) {
      const w = windows.get(`${f.idx}:${li}`);
      if (!w || !accept(w, fChars.length)) continue;
      const cov = (w.fEnd - w.fStart) / fChars.length;
      const whole = acceptingFrags[li]!.length === 1 && cov >= 0.6;
      const slice = whole
        ? lines[li]!.cleanChars.join("")
        : lines[li]!.cleanChars.slice(Math.max(0, w.startC - w.fStart), Math.min(lines[li]!.cleanChars.length, w.endC + (fChars.length - w.fEnd))).join("");
      if (!slice.trim()) continue;
      const rank = Math.max(cov, w.matched / fChars.length);
      if (!best || rank > best.cov || (rank === best.cov && w.score > best.score)) best = { text: slice, cov: rank, score: w.score };
    }
    if (best) improvedBy.set(f.idx, best.text);
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
  const usedFragText = new Set([...outLines.map((l) => l.text), ...keep.map((f) => f.it.text)]);

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
      if (accept(localAlign(fChars, ln.normChars), fChars.length)) return true;
    }
    return false;
  };
  const llmOnly = lines.filter((ln) => ln.cleanChars.length >= 2 && !coveredByInventory(ln));
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

    slots.sort((a, b) => (verticalPage ? b - a : a - b)); // reading order
    // column start (along axis) from the fragment lines' first-char medians
    const alongOf = (p: [number, number]) => p[0] * ax + p[1] * ay;
    const starts = outLines.map((l) => {
      const b0 = l.chars[0]!.box!;
      return alongOf([(b0[0] + b0[2]) / 2, (b0[1] + b0[3]) / 2]);
    }).sort((a, b) => a - b);
    const baseAlong = starts[Math.floor(starts.length / 2)]!;
    const taken = [...crosses];
    // group variant readings of the SAME missing column (text-similar): one
    // group = one column = one slot; non-representative members are dropped
    // (the rare genuine repeat classical also missed is the accepted trade)
    const groups: { lines: typeof llmOnly }[] = [];
    const groupDrops: typeof llmOnly = [];
    for (const ln of llmOnly) {
      const g = groups.find((gr) => gr.lines.some((m) => textSimilar(m.cleanChars.join(""), ln.cleanChars.join("")) >= 0.55));
      if (g) { g.lines.push(ln); groupDrops.push(ln); } else groups.push({ lines: [ln] });
    }
    for (const d of groupDrops) dropped.push({ n: d.n, text: d.cleanChars.join("") });
    // slot supply scales to demand: interior free gaps first, then outer
    // columns stepping by colGap past the last-read edge (a letter's columns
    // continue past classical's coverage), clamped by image bounds. The old
    // ONE-outer-slot cap starved real columns (owner-measured: 6 LLM-only
    // columns, 4 slots, 3 dropped).
    const verticalPage2 = medAngle > 45 || medAngle < -45;
    const lastCross = verticalPage2 ? crosses[0]! : crosses[crosses.length - 1]!;
    const dir = verticalPage2 ? -1 : 1; // reading advances toward the far edge
    for (let i = 1; i <= groups.length; i++) slots.push(lastCross + dir * colGap * i);
    for (const ln of groups.map((g) => g.lines[0]!)) {
      const slot = slots.find((s) => !taken.some((t) => Math.abs(t - s) < 0.9 * pitch));
      if (slot === undefined) { dropped.push({ n: ln.n, text: ln.cleanChars.join("") }); continue; }
      slots.splice(slots.indexOf(slot), 1);
      taken.push(slot);
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

  return { lines: outLines, droppedLines: dropped };
}

function l0(l: FusedLine): number { return l.chars.length; }

/** does inventory text t plausibly contain the LLM line's content (normalized) */
function covers(t: string, llmText: string): boolean {
  const A = cleanNorm(t), B = cleanNorm(llmText);
  if (B.length < 2) return true;
  let hit = 0;
  for (const c of new Set([...B])) if (A.includes(c)) hit += [...B].filter((x) => x === c).length;
  return hit / B.length >= 0.6;
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
