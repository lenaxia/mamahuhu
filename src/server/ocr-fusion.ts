/**
 * STRUCTURE FUSION (POC for the 0.6.x architecture): LLM returns text +
 * relative structure (line identity, direction, gap markers in char-width
 * units); classical OCR returns precise pixel boxes as MULTI-CHAR fragments;
 * this module deterministically aligns the two.
 *
 * Division of labor (measured, three lessons deep):
 *   LLM       = WHAT (text) + relative structure — bad at absolute geometry
 *   classical = WHERE (pixel boxes) — bad at hard script text
 *   this code = alignment + geometry assembly, guessing neither
 *
 * The matcher is SEQUENCE ALIGNMENT, not nearest-neighbor: classical items
 * are multi-char fragments, so we seed approximate substring matches between
 * fragment text and line text (variant/whitespace tolerant), then chain the
 * seeds per line order-preserving (DP), resolving cross-line conflicts by
 * spatial coherence. Repeated text yields MULTIPLE candidate windows —
 * position resolves the ambiguity, text never deduplicates (the 11x lesson).
 * Anchored geometry is PIECEWISE between anchors so curved text follows its
 * own bend; per-fragment pitch is LOCAL (word clouds vary >2x, no snapping).
 *
 * Not wired into app.ts — bench/ocr-structure.ts drives it over fixtures.
 */
import { toTraditional } from "../shared/cedict";

export interface ClassicalItem { box: [number, number, number, number]; text: string; score: number }
export interface StructureLine { n: number; text: string; dir: "h" | "v" }

export interface FusedChar {
  char: string;
  /** pixel AABB; absent when the line has no anchor geometry at all */
  box?: [number, number, number, number];
  /** position derived from a classical anchor span */
  anchored: boolean;
  /** outside the anchor span — extrapolated from the nearest anchor's pitch */
  extrapolated?: boolean;
}

export interface FusedLine {
  n: number;
  dir: "h" | "v";
  text: string; // clean text, gap markers stripped
  chars: FusedChar[];
  /** degrees — mean anchor direction; null when the line has no anchors */
  angle: number | null;
  /** direction is the LLM prior (fewer than 2 anchors — no spatial evidence) */
  dirFromLLM: boolean;
  /** gap markers preserved: atChar = index into clean text, widths in char-widths */
  gaps: { atChar: number; widths: number }[];
  matchedFragments: number[];
}

export interface FusionResult {
  lines: FusedLine[];
  /** classical fragments no line claimed — LLM misses or detector junk */
  unmatchedFragments: { idx: number; text: string; box: [number, number, number, number] }[];
}

// ---------- tokenization ----------

interface Token { char?: string; gap?: number }

/** "我愛你⟪2⟫你是我的" → tokens (chars + gap widths in char-width units). */
export function parseStructureTokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/⟪(\d+(?:\.\d+)?)⟫|[^⟪]/gu)) {
    if (m[1]) out.push({ gap: Math.max(0, parseFloat(m[1])) });
    else if (m[0]) out.push({ char: m[0] });
  }
  return out;
}

/** variant/whitespace normalization: both OCR sides compared through this */
const cleanNorm = (s: string) => toTraditional(s.replace(/\s+/g, ""));

// ---------- local alignment ----------
// Smith-Waterman-style: best aligned chunk with FREE ENDS ON BOTH SIDES.
// Classical fragments span LLM line slices (the ≤20-char prompt cap) and
// carry CTC errors, so a fragment's HEAD may anchor one line and its TAIL
// the next — the whole-fragment containment assumption was wrong.
// Costs: mismatch (CTC error) allowed cheaply, insertions in C (punctuation
// the classical elided) cheap, deletions from F (classical dropped a char)
// expensive. Returns both windows: the line span AND the fragment sub-range.

interface LocalAlign { fStart: number; fEnd: number; startC: number; endC: number; score: number; matched: number }

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
  // walk back to the local chunk's origin (score 0 boundary)
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

// ---------- chaining ----------

interface Candidate {
  frag: number;
  fStart: number; fEnd: number; // aligned SUB-RANGE of the fragment (may be partial)
  startC: number; endC: number; // window into the line's clean-char array
  weight: number; // anchored-char credit (matched chars)
}

interface Frag { idx: number; chars: string[]; box: [number, number, number, number]; cx: number; cy: number }

/** order-preserving, text-non-overlapping chain maximizing Σ weight (DP). */
function chainLine(cands: Candidate[], frags: Frag[]): Candidate[] {
  if (!cands.length) return [];
  const cx = cands.map((c) => frags[c.frag]!.cx), cy = cands.map((c) => frags[c.frag]!.cy);
  const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
  const byX = spread(cx) >= spread(cy); // dominant axis; both projections of a straight line are monotone
  const key = (c: Candidate) => { const f = frags[c.frag]!; return byX ? f.cx * 1e4 + f.cy : f.cy * 1e4 + f.cx; };
  const sorted = [...cands].sort((a, b) => key(a) - key(b));
  const K = sorted.length;
  const dp = sorted.map((c) => c.weight), prev = sorted.map(() => -1);
  for (let k = 0; k < K; k++) {
    for (let p = 0; p < k; p++) {
      // text order + non-overlap; a fragment may serve twice only via
      // NON-OVERLAPPING sub-ranges (head to one slice, tail to the next)
      const fragOk = sorted[p]!.frag !== sorted[k]!.frag || sorted[p]!.fEnd <= sorted[k]!.fStart;
      if (fragOk && sorted[p]!.endC <= sorted[k]!.startC && dp[p]! + sorted[k]!.weight > dp[k]!) {
        dp[k] = dp[p]! + sorted[k]!.weight;
        prev[k] = p;
      }
    }
  }
  let best = 0;
  for (let k = 1; k < K; k++) if (dp[k]! > dp[best]!) best = k;
  const out: Candidate[] = [];
  for (let k = best; k >= 0; k = prev[k]!) out.unshift(sorted[k]!);
  return out;
}

/** distance of a fragment from the axis through a chain's other fragments, in pitch units. Infinity = no evidence. */
function axisResidual(f: Frag, chain: Candidate[], frags: Frag[]): number {
  const others = chain.map((c) => frags[c.frag]!).filter((x) => x.idx !== f.idx);
  const pitchOf = (o: Frag) => Math.max(20, (o.box[2] - o.box[0] + o.box[3] - o.box[1]) / (2 * Math.max(1, o.chars.length)));
  if (others.length === 0) return Infinity;
  if (others.length === 1) return Math.hypot(f.cx - others[0]!.cx, f.cy - others[0]!.cy) / pitchOf(others[0]!);
  const mx = others.reduce((s, o) => s + o.cx, 0) / others.length;
  const my = others.reduce((s, o) => s + o.cy, 0) / others.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const o of others) { sxx += (o.cx - mx) ** 2; syy += (o.cy - my) ** 2; sxy += (o.cx - mx) * (o.cy - my); }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const nx = -Math.sin(theta), ny = Math.cos(theta);
  const resid = Math.abs((f.cx - mx) * nx + (f.cy - my) * ny);
  const pitch = Math.max(20, others.reduce((s, o) => s + pitchOf(o), 0) / others.length);
  return resid / pitch;
}

// ---------- geometry ----------

interface Anchor {
  frag: Frag;
  oStart: number; oEnd: number; // char-offset span in CHAR-WIDTH units (gaps included)
  pitch: number;                // LOCAL per-char cell size — never snapped
  pStart: [number, number];     // pixel position of the span's first char center
  pEnd: [number, number];       // pixel position of the span's last char center
}

function axisOf(anchors: Anchor[], dir: "h" | "v"): { ux: number; uy: number; fromLLM: boolean } {
  const prior = dir === "v" ? { ux: 0, uy: 1, fromLLM: true } : { ux: 1, uy: 0, fromLLM: true };
  if (anchors.length < 2) return prior;
  let sx = 0, sy = 0;
  for (let i = 1; i < anchors.length; i++) {
    const dx = anchors[i]!.pStart[0] - anchors[i - 1]!.pEnd[0];
    const dy = anchors[i]!.pStart[1] - anchors[i - 1]!.pEnd[1];
    const l = Math.hypot(dx, dy) || 1;
    sx += dx / l; sy += dy / l;
  }
  const l = Math.hypot(sx, sy);
  return l < 1e-6 ? prior : { ux: sx / l, uy: sy / l, fromLLM: false };
}

// ---------- fusion ----------

export function fuseStructure(items: ClassicalItem[], llmLines: StructureLine[]): FusionResult {
  // frags stay INDEX-ALIGNED with items (f.idx === array index) — empty-text
  // fragments simply generate no candidates; a filtered array would scramble
  // every frags[idx] lookup (the 4919 misalignment bug)
  const frags: Frag[] = items.map((it, idx) => ({ idx, chars: [...cleanNorm(it.text)], box: it.box, cx: (it.box[0] + it.box[2]) / 2, cy: (it.box[1] + it.box[3]) / 2 }));
  const fragByIdx = new Map(frags.map((f) => [f.idx, f]));

  interface LineData { n: number; dir: "h" | "v"; cleanChars: string[]; normChars: string[]; offsets: number[]; gaps: { atChar: number; widths: number }[] }
  const lines: LineData[] = llmLines.map((l) => {
    const tokens = parseStructureTokens(l.text);
    const cleanChars: string[] = [], offsets: number[] = [], gaps: { atChar: number; widths: number }[] = [];
    let o = 0;
    for (const t of tokens) {
      if (t.gap) { o += t.gap; if (cleanChars.length) gaps.push({ atChar: cleanChars.length, widths: t.gap }); }
      else { offsets.push(o); cleanChars.push(t.char!); o += 1; }
    }
    return { n: l.n, dir: l.dir, cleanChars, normChars: cleanChars.map((c) => cleanNorm(c)), offsets, gaps };
  });

  // candidate seeds: fragment × line windows. Exact contiguous occurrences
  // give MULTIPLE windows (the chain DP resolves repeats spatially — text
  // never deduplicates); the local-alignment window covers CTC errors and
  // fragments that SPAN LLM line slices (head in one, tail in the next).
  const cands: Candidate[][] = lines.map((ln) => {
    const out: Candidate[] = [];
    for (const f of frags) {
      const m = f.chars.length;
      if (m === 0) continue;
      if (m === 1) {
        for (let s = 0; s < ln.normChars.length; s++) {
          if (ln.normChars[s] === f.chars[0]) out.push({ frag: f.idx, fStart: 0, fEnd: 1, startC: s, endC: s + 1, weight: 1 });
        }
        continue;
      }
      const seen = new Set<string>();
      for (let s = 0; s + m <= ln.normChars.length; s++) {
        if (f.chars.every((c, k) => c === ln.normChars[s + k])) {
          out.push({ frag: f.idx, fStart: 0, fEnd: m, startC: s, endC: s + m, weight: m });
          seen.add(`0:${s}`);
        }
      }
      const w = localAlign(f.chars, ln.normChars);
      // partial windows must carry real evidence: ≥2 matched chars AND either
      // ≥4 matched (long clean chunk of a CTC-rotten fragment) or ≥45% of the
      // fragment — 2-char coincidence windows (a shared 孩子 in an unrelated
      // line) die here
      if (w && w.matched >= 2 && (w.matched >= 4 || w.matched >= 0.45 * m) && w.matched / (w.endC - w.startC) >= 0.5 && w.endC - w.startC <= m * 3) {
        const key = `${w.fStart}:${w.startC}`;
        if (!seen.has(key)) { out.push({ frag: f.idx, fStart: w.fStart, fEnd: w.fEnd, startC: w.startC, endC: w.endC, weight: w.matched }); seen.add(key); }
      }
    }
    return out;
  });

  // chain per line, sequential first-claim, then contested-range reassignment
  const DBG = typeof process !== "undefined" && process.env.FUSION_DEBUG === "1";
  if (DBG) for (let li = 0; li < lines.length; li++) console.error(`[fusion] line ${li + 1} "${lines[li]!.cleanChars.join("").slice(0, 12)}": ${cands[li]!.length} cands [${cands[li]!.map((c) => `f${c.frag}:${c.fStart}-${c.fEnd}@C${c.startC}-${c.endC}w${c.weight}`).join(" ")}]`);
  const claims = new Map<number, { li: number; fStart: number; fEnd: number }[]>();
  const blocked = (c: Candidate, li: number) =>
    (claims.get(c.frag) ?? []).some((e) => e.li !== li && c.fStart < e.fEnd && e.fStart < c.fEnd);
  /** re-sync a line's claims with its (possibly changed) chain */
  const refreshClaims = (li: number) => {
    for (const [frag, entries] of claims) claims.set(frag, entries.filter((e) => e.li !== li));
    for (const c of chains[li]!) claims.set(c.frag, [...(claims.get(c.frag) ?? []), { li, fStart: c.fStart, fEnd: c.fEnd }]);
  };
  const chains: Candidate[][] = lines.map(() => []);
  for (let li = 0; li < lines.length; li++) {
    chains[li] = chainLine(cands[li]!.filter((c) => !blocked(c, li)), frags);
    refreshClaims(li);
  }
  // contested ranges: reassign by spatial coherence — but textual evidence
  // dominates geometry: a steal must carry comparable matched-char weight, and
  // a steal the thief's own chain doesn't use is reverted (no vandalism)
  for (let round = 0; round < 3; round++) {
    let moved = false;
    for (let li = 0; li < lines.length; li++) {
      for (const c of cands[li]!) {
        if (!blocked(c, li)) continue;
        const entries = (claims.get(c.frag) ?? []).filter((e) => e.li !== li && c.fStart < e.fEnd && e.fStart < c.fEnd);
        if (entries.length !== 1) continue; // ambiguous multi-owner — leave it
        const owner = entries[0]!.li;
        const ownerCands = chains[owner]!.filter((x) => x.frag === c.frag && x.fStart < c.fEnd && c.fStart < x.fEnd);
        if (!ownerCands.length) continue;
        // textual strength: never steal from a decisively stronger claim
        const ownerW = Math.max(...ownerCands.map((x) => x.weight));
        if (c.weight < ownerW * 0.75) continue;
        const myRes = axisResidual(frags[c.frag]!, chains[li]!.filter((x) => x.frag !== c.frag), frags);
        const theirRes = axisResidual(frags[c.frag]!, chains[owner]!.filter((x) => x.frag !== c.frag), frags);
        if (!Number.isFinite(myRes) || !(myRes < theirRes * 0.7)) continue; // need decisive finite evidence
        const removedFromOwner = chains[owner]!.filter((x) => x.frag === c.frag && x.fStart < c.fEnd && c.fStart < x.fEnd);
        chains[owner] = chains[owner]!.filter((x) => !(x.frag === c.frag && x.fStart < c.fEnd && c.fStart < x.fEnd));
        refreshClaims(owner);
        const before = chains[li]!;
        chains[li] = chainLine(cands[li]!.filter((c2) => !blocked(c2, li) || c2 === c), frags);
        if (!chains[li]!.some((x) => x.frag === c.frag && x.fStart === c.fStart && x.fEnd === c.fEnd)) {
          // thief didn't use it — revert
          chains[li] = before;
          chains[owner] = [...chains[owner]!, ...removedFromOwner];
        } else {
          refreshClaims(li);
          // the VICTIM re-chains too: its freed candidates include its own
          // exact matches (4919: line 11 reclaimed its exact fragment after
          // line 12 took the spanning one)
          chains[owner] = chainLine(cands[owner]!.filter((c2) => !blocked(c2, owner)), frags);
          refreshClaims(owner);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  const outLines: FusedLine[] = lines.map((ln, li) => {
    const mk = (chars: FusedChar[], angle: number | null, dirFromLLM: boolean, matched: number[]): FusedLine =>
      ({ n: ln.n, dir: ln.dir, text: ln.cleanChars.join(""), chars, angle, dirFromLLM, gaps: ln.gaps, matchedFragments: matched });

    if (!chains[li]!.length || ln.cleanChars.length === 0) {
      return mk(ln.cleanChars.map((c) => ({ char: c, anchored: false })), null, true, []);
    }

    // char-offset span of a window (gaps before covered chars included in offsets)
    const N = ln.cleanChars.length;
    const spanOf = (c: Candidate) => {
      const from = ln.offsets[Math.min(c.startC, N - 1)] ?? 0;
      const lastIdx = Math.max(0, Math.min(c.endC, N) - 1);
      return { oStart: from, oEnd: (ln.offsets[lastIdx] ?? 0) + 1 };
    };
    const mkAnchor = (c: Candidate, u: { ux: number; uy: number }): Anchor => {
      const f = fragByIdx.get(c.frag)!;
      const w = f.box[2] - f.box[0], h = f.box[3] - f.box[1];
      const extent = w * Math.abs(u.ux) + h * Math.abs(u.uy); // AABB projection on the axis
      const m = f.chars.length;
      const pitchFull = extent / m;
      // aligned SUB-RANGE occupies a proportional sub-extent of the box
      const midOff = (c.fStart + c.fEnd) / 2 - m / 2; // fragment-char units from box center
      const scx = f.cx + u.ux * midOff * pitchFull;
      const scy = f.cy + u.uy * midOff * pitchFull;
      const { oStart, oEnd } = spanOf(c);
      const cells = Math.max(1, c.endC - c.startC);
      const pitch = ((c.fEnd - c.fStart) * pitchFull) / cells; // line cells divide the sub-extent
      const half = (Math.max(1, oEnd - oStart) - 1) / 2;
      return {
        frag: f, oStart, oEnd, pitch,
        pStart: [scx - u.ux * half * pitch, scy - u.uy * half * pitch],
        pEnd: [scx + u.ux * half * pitch, scy + u.uy * half * pitch],
      };
    };
    // bootstrap axis from chain fragment centers, refine once with anchor endpoints
    const cxs = chains[li]!.map((c) => fragByIdx.get(c.frag)!.cx);
    const cys = chains[li]!.map((c) => fragByIdx.get(c.frag)!.cy);
    const rng = (a: number[]) => Math.max(...a) - Math.min(...a);
    const boot = rng(cxs) >= rng(cys) ? { ux: 1, uy: 0 } : { ux: 0, uy: 1 };
    let anchors = chains[li]!.map((c) => mkAnchor(c, boot)).sort((a, b) => a.oStart - b.oStart);
    const { ux, uy, fromLLM } = axisOf(anchors, ln.dir);
    anchors = chains[li]!.map((c) => mkAnchor(c, { ux, uy })).sort((a, b) => a.oStart - b.oStart);

    const chars: FusedChar[] = ln.cleanChars.map((ch, oi) => {
      const offset = ln.offsets[oi]!;
      const anchor = anchors.find((a) => offset >= a.oStart && offset < a.oEnd);
      if (anchor) {
        // pStart/pEnd are CENTERS of the first/last covered chars (offsets oStart, oEnd-1)
        const cSpan = anchor.oEnd - 1 - anchor.oStart;
        const t = cSpan > 0 ? (offset - anchor.oStart) / cSpan : 0;
        const px = anchor.pStart[0] + (anchor.pEnd[0] - anchor.pStart[0]) * t;
        const py = anchor.pStart[1] + (anchor.pEnd[1] - anchor.pStart[1]) * t;
        const hp = anchor.pitch / 2;
        return { char: ch, box: [Math.round(px - hp), Math.round(py - hp), Math.round(px + hp), Math.round(py + hp)], anchored: true };
      }
      const first = anchors[0]!, last = anchors[anchors.length - 1]!;
      let px: number, py: number, pitch: number, extrapolated = false;
      if (offset < first.oStart) {
        pitch = first.pitch;
        px = first.pStart[0] + (offset - first.oStart) * pitch * ux;
        py = first.pStart[1] + (offset - first.oStart) * pitch * uy;
        extrapolated = true;
      } else if (offset >= last.oEnd) {
        pitch = last.pitch;
        px = last.pEnd[0] + (offset - (last.oEnd - 1)) * pitch * ux;
        py = last.pEnd[1] + (offset - (last.oEnd - 1)) * pitch * uy;
        extrapolated = true;
      } else {
        // between consecutive anchors: PIECEWISE interpolation over char-CENTER
        // offsets (a.oEnd-1 → b.oStart) — curves follow their own bend
        let a = anchors[0]!, b = anchors[1]!;
        for (let k = 0; k + 1 < anchors.length; k++) {
          if (offset >= anchors[k]!.oEnd - 1 && offset < anchors[k + 1]!.oStart) { a = anchors[k]!; b = anchors[k + 1]!; break; }
        }
        const aEnd = a.oEnd - 1, bStart = b.oStart;
        const dOff = bStart - aEnd;
        const t = dOff > 0 ? (offset - aEnd) / dOff : 0;
        px = a.pEnd[0] + (b.pStart[0] - a.pEnd[0]) * t;
        py = a.pEnd[1] + (b.pStart[1] - a.pEnd[1]) * t;
        pitch = Math.hypot(b.pStart[0] - a.pEnd[0], b.pStart[1] - a.pEnd[1]) / Math.max(1, dOff);
      }
      const hp = pitch / 2;
      return { char: ch, box: [Math.round(px - hp), Math.round(py - hp), Math.round(px + hp), Math.round(py + hp)], anchored: false, extrapolated: extrapolated || undefined };
    });

    // line angle: mean direction across consecutive anchor endpoints
    let ax = 0, ay = 0, cnt = 0;
    for (let k = 1; k < anchors.length; k++) {
      ax += anchors[k]!.pStart[0] - anchors[k - 1]!.pEnd[0];
      ay += anchors[k]!.pStart[1] - anchors[k - 1]!.pEnd[1];
      cnt++;
    }
    if (cnt === 0) { ax = ux; ay = uy; cnt = 1; }
    const angle = Math.round((Math.atan2(ay / cnt, ax / cnt) * 180) / Math.PI);

    return mk(chars, angle, fromLLM, chains[li]!.map((c) => c.frag));
  });

  const used = new Set<number>();
  for (const l of outLines) for (const f of l.matchedFragments) used.add(f);
  return {
    lines: outLines,
    unmatchedFragments: frags.filter((f) => f.chars.length > 0 && !used.has(f.idx)).map((f) => ({ idx: f.idx, text: items[f.idx]!.text, box: f.box })),
  };
}
