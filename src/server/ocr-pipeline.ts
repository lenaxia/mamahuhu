/**
 * OCR pipeline v2 — det → rectify → per-crop read → assemble.
 *
 * Roles are fixed by measurement (POC-validated, owner-approved):
 * - GEOMETRY: DBNet det quads via the mamahuhu-ocr sidecar /det — measured,
 *   deterministic, never asked of an LLM
 * - TEXT: blind per-crop reads (upright strips) through the gateway vision
 *   model — context-free reads, no coordinates, Traditional output
 * - Assembly: char cells evenly spaced along each quad axis (consistent chip
 *   sizes — the 0.4.x "sizes all over the place" fix)
 *
 * Det-empty (no text found — e.g. synthetic curved text) → fallback service
 * (the legacy single-pass path). Geometry lives in ocr-geometry.ts (unit-tested).
 */
import OpenCC from "opencc-js";
import sharp from "sharp";
import type { OcrLine, OcrService, Result } from "./ports";

// The app's output contract is ALWAYS Traditional (owner rule) — the reader
// drifts between scripts photo-to-photo (measured: same poster, mixed lines);
// normalizing post-read also makes duplicate detection script-consistent.
const toTrad = OpenCC.Converter({ from: "cn", to: "tw" });
import { axisAngle, axisFlip, charCells, charSim, dedupeQuads, expectChars, readingOrder, splitQuad, validateRead, type Quad } from "./ocr-geometry";

type DetQuad = Quad & { pts: [number, number][] };

const READ_PROMPT =
  "Read this strip of Chinese text. Return ONLY the Chinese characters you actually see, in order. " +
  "Never substitute a plausible-sounding phrase. Output Traditional Chinese characters (繁體) always.";

interface GatewayMsg { role: string; content: string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] }

export class PipelineOcrService implements OcrService {
  constructor(private cfg: { detUrl: string; base: string; key: string; model: string; fallback: OcrService }) {}
  available(): boolean { return true; }

  async extract(image: Blob): Promise<Result<{ lines: OcrLine[]; servedBy?: string }>> {
    const bytes = new Uint8Array(await image.arrayBuffer());
    let det: { quads: DetQuad[]; w: number; h: number };
    try {
      const res = await fetch(this.cfg.detUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`det ${res.status}`);
      det = (await res.json()) as { quads: DetQuad[]; w: number; h: number };
    } catch (e) {
      console.warn(`[ocr-pipeline] det unavailable (${String(e)}) — falling back`);
      return this.cfg.fallback.extract(image);
    }
    if (!det.quads || det.quads.length === 0) {
      // det-empty: no text the detector can see (synthetic curves etc.) — legacy path
      return this.cfg.fallback.extract(image);
    }
    try {
      return await this.pipeline(det, bytes);
    } catch (e) {
      console.warn(`[ocr-pipeline] pipeline failure after det (${String(e)}) — falling back`);
      return this.cfg.fallback.extract(image);
    }
  }

  private async pipeline(det: { quads: DetQuad[]; w: number; h: number }, bytes: Uint8Array): Promise<Result<{ lines: OcrLine[]; servedBy?: string }>> {

    const ordered = readingOrder(dedupeQuads(det.quads)); // IoU dedupe: adjacent dense rows survive, same-region double-reads die
    const meta = await sharp(bytes).metadata();
    const W = meta.width ?? det.w, H = meta.height ?? det.h;

    // angle clusters (±2°): rotate the full image once per cluster, crop members
    const clusters = new Map<number, DetQuad[]>();
    for (const q of ordered) {
      const k = Math.round(axisAngle(q) / 2) * 2;
      (clusters.get(k) ?? clusters.set(k, []).get(k)!).push(q);
    }

    const reads = new Map<DetQuad, string>();
    // dominant cluster representative (real quad point order — flip detection
    // needs it): the cluster with the most members (letter pages: the columns)
    const deadline = Date.now() + 150_000; // bounded read phase — no hour-long requests
    for (const [, members] of clusters) {
      if (Date.now() > deadline) { console.warn("[ocr-pipeline] read deadline exceeded — serving partial"); break; }
      const angle = axisAngle(members[0]!) + (axisFlip(members[0]!) ? 180 : 0); // upright crops regardless of corner order
      const { buf, plan } = await this.rotateFull(bytes, angle);
      const queue = [...members];
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (;;) {
          const q = queue.shift();
          if (!q) return;
          const crop = await this.cropQuad(buf, plan, q);
          let text = await this.readCrop(crop);
          if (text.length === 0) {
            // read variance: model occasionally returns blank for a clean crop — one retry
            console.log("[ocr-pipeline] empty read — retrying once");
            text = await this.readCrop(crop);
          }
          if (text.length === 0) console.warn(`[ocr-pipeline] read empty after retry: quad at [${q.pts[0]![0]},${q.pts[0]![1]}]`);
          reads.set(q, text);
        }
      });
      await Promise.all(workers);
    }

    // assembly: a read's newlines CONFIRM multi-row quads (evidence-driven split)
    const raw: OcrLine[] = [];
    for (const q of ordered) {
      const ang = axisAngle(q);
      const parts = (reads.get(q) ?? "").split(/\n+/).map((t) => toTrad(t.trim())).filter((t) => t.length > 0);
      const quadsForParts = parts.length > 1 ? splitQuad(q, parts.length) : [q];
      parts.forEach((text, i) => {
        const sq = quadsForParts[i]!;
        const xs = sq.pts.map((p) => p[0]), ys = sq.pts.map((p) => p[1]);
        const n = [...text].length;
        if (n > 0 && validateRead(n, expectChars(quadsForParts.length > 1 ? sq : q))) {
          console.log(`[ocr-pipeline] read/geometry mismatch: ${n} chars vs expect — flagged`);
        }
        raw.push({
          text,
          box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [number, number, number, number],
          dir: Math.abs(ang) >= 45 ? ("v" as const) : ("h" as const),
          angle: Math.round(ang),
          charBoxes: n > 0 ? charCells(sq, n) : undefined,
        });
      });
    }
    if (raw.length === 0) {
      // every crop read failed (gateway outage / auth) — det found text; do NOT return empty
      console.warn("[ocr-pipeline] all crop reads empty — falling back");
      return this.cfg.fallback.extract(new File([bytes.slice()], "page.jpg", { type: "image/jpeg" }));
    }
    // reading order: the whole-page read supplies the ORDER (reading a page
    // start-to-end is what that call does naturally — measured: salutation
    // first, 3/3 runs). Text and boxes stay OURS; page lines only permute.
    // Each quad takes the index of its best-overlap page line; ties keep
    // geometric order (merged page lines degrade gracefully). Low confidence
    // → geometric order untouched.
    let finalLines: OcrLine[] = raw;
    if (raw.length > 2) {
      const ord = await this.orderWithImage(bytes, raw);
      if (ord) {
        finalLines = ord.perm.map((i) => raw[i]!);
        console.log("[ocr-pipeline] reading order: reader-confirmed (image + line reads)");
        // recall gap recovery: reader flags lines det missed; geometry
        // interpolates the quad from OUR neighbors; the crop read VERIFIES
        // (blank discarded, duplicate text-deduped). LLM never positions.
        for (const miss of ord.missing.slice(0, 2)) {
          if (finalLines.length < 4) break;
          // between-indices refer to the RAW-numbered list; map through the perm
          const pos = (rawIdx: number) => ord.perm.indexOf(rawIdx);
          const i2 = pos(miss.between[0]!), j2 = pos(miss.between[1]!);
          const synth = this.synthesizeBetween(finalLines, i2, j2);
          if (!synth) continue;
          try {
            const crop = await this.cropQuadOf(bytes, synth);
            let text = crop ? await this.readCrop(crop) : "";
            if (text.length === 0 && crop) text = await this.readCrop(crop);
            text = toTrad(text.trim());
            if (text.length === 0) { console.log("[ocr-pipeline] gap-recovery read empty — discarded"); continue; }
            const dup = finalLines.some((k) => k.text.length >= 4 && text.length >= 4 && charSim(k.text, text) >= 0.7);
            if (dup) { console.log("[ocr-pipeline] gap-recovery read duplicates existing line — discarded"); continue; }
            const n = [...text].length;
            const xs = synth.pts.map((p) => p[0]), ys = synth.pts.map((p) => p[1]);
            const ang = axisAngle(synth);
            finalLines.push({
              text,
              box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [number, number, number, number],
              dir: Math.abs(ang) >= 45 ? ("v" as const) : ("h" as const),
              angle: Math.round(ang),
              charBoxes: charCells(synth, n),
            });
            console.log(`[ocr-pipeline] gap-recovery: recovered missing line (${n} chars): ${text.slice(0, 20)}`);
          } catch (e) {
            console.warn(`[ocr-pipeline] gap-recovery failed: ${String(e)}`);
          }
        }
        // ENUM-VERIFIED GAP RECOVERY (issue #1): the ordering call's missing[]
        // is blind on dense pages — its own anchor list (garbled fused reads)
        // hides columns the model would otherwise see, and any resolution we
        // tried (900→1800px, 300→1500 tokens, neutral framing) stays blind.
        // The list-free enumeration at full width DOES emit missed columns
        // (measured on the owner's letter: 確為真品… line appears at 1400px
        // and 2000px while det has no quad there at any threshold). So:
        // enum proposes, pixels dispose — a candidate is only served when a
        // crop of the geometric slot between neighbor columns READS it back,
        // and phantoms (enum garbles of covered lines) die on the dup-guard
        // (measured on the diagonal letter fixture: slot reads return the
        // EXISTING column text and are discarded).
        await this.enumVerifiedRecovery(bytes, finalLines);
      } else {
        console.warn("[ocr-pipeline] reader ordering unavailable — geometric order kept");
      }
    }
    // duplicate long lines (overlapping det quads re-reading the same paragraph) — keep first
    const lines: OcrLine[] = [];
    for (const l of finalLines) {
      const boxOv = (a2?: [number, number, number, number], b2?: [number, number, number, number]) => {
        if (!a2 || !b2) return 0;
        const ix = Math.max(0, Math.min(a2[2], b2[2]) - Math.max(a2[0], b2[0]));
        const iy = Math.max(0, Math.min(a2[3], b2[3]) - Math.max(a2[1], b2[1]));
        const sm = Math.min((a2[2]-a2[0])*(a2[3]-a2[1]), (b2[2]-b2[0])*(b2[3]-b2[1]));
        return sm > 0 ? (ix*iy)/sm : 0;
      };
      if (l.text.length >= 8 && lines.some((k) => charSim(k.text, l.text) >= 0.85 && boxOv(k.box, l.box) >= 0.3)) {
        console.log(`[ocr-pipeline] duplicate line dropped: "${l.text.slice(0, 16)}…"`);
        continue;
      }
      lines.push(l);
    }

    return { ok: true as const, value: { lines, servedBy: "pipeline2" } };
  }

  /** rotate the cluster upright once; buffer cached (sharp reorders rotate-before-extend, auto-expands) */
  private async rotateFull(bytes: Uint8Array, angle: number): Promise<{ buf: Buffer; plan: ReturnType<typeof cropPlan> }> {
    const meta = await sharp(bytes).metadata();
    const W = meta.width ?? 1, H = meta.height ?? 1;
    const plan = cropPlan(W, H, angle);
    const buf = await sharp(bytes)
      .rotate(plan.rotateArg, { background: { r: 255, g: 255, b: 255 } })
      .extend({ top: plan.D, left: plan.D, bottom: plan.D, right: plan.D, background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer();
    return { buf, plan };
  }

  /** crop the quad's transformed AABB from the rotated buffer (+6px pad) */
  private async cropQuad(buf: Buffer, plan: ReturnType<typeof cropPlan>, q: DetQuad): Promise<Buffer> {
    const pts = q.pts.map(plan.map);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const pad = 6;
    const l = Math.max(0, Math.floor(Math.min(...xs) - pad)), t = Math.max(0, Math.floor(Math.min(...ys) - pad));
    const r = Math.min(plan.rw, Math.ceil(Math.max(...xs) + pad)), b = Math.min(plan.rh, Math.ceil(Math.max(...ys) + pad));
    return sharp(buf).extract({ left: l, top: t, width: Math.max(1, r - l), height: Math.max(1, b - t) }).png().toBuffer();
  }

  /**
   * Reader-confirmed reading order — ONE call, image + our per-line reads
   * together: the photo gives visual context, our reads give content anchors
   * (coordinates alone got echoed back; text alone couldn't be ordered from
   * garbled fragments; both together anchor the answer). Returns a validated
   * permutation of OUR indices or null — never positions anything.
   */
  private async orderWithImage(bytes: Uint8Array, lines: OcrLine[]): Promise<{ perm: number[]; missing: { between: [number, number]; text: string }[] } | null> {
    try {
      const meta = await sharp(bytes).metadata();
      const W = meta.width ?? 1, H = meta.height ?? 1;
      const small = await sharp(bytes).resize({ width: 900 }).jpeg({ quality: 82 }).toBuffer();
      const b64 = small.toString("base64");
      const list = lines.map((l, i) => {
        const b = l.box!;
        return `${i + 1}. [${Math.round((b[0] / W) * 100)},${Math.round((b[1] / H) * 100)} → ${Math.round((b[2] / W) * 100)},${Math.round((b[3] / H) * 100)}] ${l.text.slice(0, 20)}`;
      }).join("\n");
      const body = JSON.stringify({ model: this.cfg.model, temperature: 0, max_tokens: 300, messages: [{
        role: "user",
        content: [
          { type: "text", text: `The photo contains ${lines.length} text lines, already detected and read:\n${list}\n(coordinates are percent of image; the text after each is its transcription)\n\nReturn ONLY JSON with keys order (array of line numbers in correct reading order — the order the text is meant to be read (a letter: salutation first, sign-off last; a poster: top-to-bottom). ) and missing (array of objects for text lines VISIBLE in the photo but ABSENT from my list, each {between: [a,b] — the listed line numbers it sits between, text: your transcription}; empty array if none). Use each number exactly once.` },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
        ],
      }] });
      const res = await fetch(`${this.cfg.base}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.key}` },
        body, signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const txt = (j.choices?.[0]?.message?.content ?? "").replace(/```[a-z]*\n?/g, "").trim();
      const om = txt.match(/"order"\s*:\s*(\[[\s\S]*?\])/);
      const m = om ?? txt.match(/\[[\s\S]*\]/);
      if (!m) return null;
      const arr = JSON.parse(m[1] ?? m[0]) as number[];
      const seen = new Set<number>();
      if (arr.length !== lines.length || !arr.every((n) => Number.isInteger(n) && n >= 1 && n <= lines.length && !seen.has(n) && seen.add(n))) return null;
      const missing: { between: [number, number]; text: string }[] = [];
      const mm = txt.match(/"missing"\s*:\s*\[[\s\S]*?\]/);
      if (mm) {
        try {
          const parsed = JSON.parse(`{${mm[0]}}`) as { missing?: { between?: number[]; text?: string }[] };
          for (const m2 of parsed.missing ?? []) {
            if (m2.between && m2.between.length === 2 && typeof m2.text === "string" && missing.length < 2) {
              missing.push({ between: [m2.between[0]! - 1, m2.between[1]! - 1], text: m2.text });
            }
          }
        } catch { /* malformed missing block — ignore */ }
      }
      return { perm: arr.map((n) => n - 1), missing };
    } catch {
      return null;
    }
  }

  /**
   * Enum-verified gap recovery. Steps (all measured on the issue #1 letter):
   * 1. list-free enumeration of the whole photo (full width — the 900px
   *    ordering image is below the legibility threshold of dense pages)
   * 2. candidates = enum lines (≥6 chars) no served line covers
   *    (script-normalized char-multiset ≥0.6 — splits of covered lines are
   *    subsets and match; a missed column shares only formulaic fragments)
   * 3. verify each candidate against PIXELS: crop the slot between each
   *    adjacent column pair in the rotated cluster space (true column widths
   *    there — AABBs of slanted columns overlap in original space) and serve
   *    the READ only if it matches the candidate and duplicates no line.
   * The read is ground truth for the text; enum only proposes.
   */
  /**
   * Fallback-verified gap recovery. The whole-image single-pass (vector
   * contract) is the ONLY reader measured to emit det-missed columns WITH
   * positions (owner's letter: complete 確為真品 column + box; the anchored
   * ordering call is blind at every resolution/token budget tested, and
   * list-free enums fragment or drop it run-to-run). Division of labor:
   * the vector pass PROPOSES lines with boxes; det's per-crop reads remain
   * the served base; a proposal is only appended when an independent crop of
   * its own box READS it back and it duplicates no served line. Phantoms
   * (the vector pass's garbles point at REAL columns) die on the dup-guard —
   * measured on the diagonal letter fixture.
   */
  private async enumVerifiedRecovery(bytes: Uint8Array, lines: OcrLine[]): Promise<void> {
    if (lines.length < 4) return;
    try {
      // the whole-image pass is stochastic (measured: the missed column
      // appears in most calls but arrives split or merged in others) — one
      // retry when candidates existed yet none verified. Bounded: clean
      // pages emit no candidates and never retry.
      const recoveredLines: OcrLine[] = [];
      const meta = await sharp(bytes).metadata();
      const W0 = meta.width ?? 1;
      for (let attempt = 0; attempt < 2; attempt++) {
        // attempt 2 re-encodes (width 2600): the same bytes return the same
        // deterministic answer — a re-encoded image is a genuinely fresh
        // draw from the stochastic proposer (measured: the missed column
        // appears in most calls but arrives split/merged in others)
        const blobBytes = attempt === 0 ? bytes : new Uint8Array(await sharp(bytes).resize({ width: 2600 }).jpeg({ quality: 85 }).toBuffer());
        const vec = await this.cfg.fallback.extract(new File([blobBytes.slice()], "page.jpg", { type: "image/jpeg" }));
        if (!vec.ok) return;
        // boxes from the re-encoded attempt are in ITS pixel space — scale
        // back to the original before any cropping/serving
        const scale = attempt === 0 ? 1 : W0 / ((await sharp(blobBytes).metadata()).width ?? W0);
        if (scale !== 1) {
          for (const l of vec.value.lines) {
            if (l.box) l.box = [l.box[0] * scale, l.box[1] * scale, l.box[2] * scale, l.box[3] * scale] as [number, number, number, number];
          }
        }
        const covered = (t: string) => lines.some((l) => l.text.length >= 4 && charSim(l.text, t) >= 0.6);
        const candidates = vec.value.lines
          .filter((l) => l.box && [...l.text.replace(/\s+/g, "")].length >= 6)
          .map((l) => ({
            text: toTrad(l.text.replace(/\s+/g, "")),
            box: (scale === 1 ? l.box! : [l.box![0] * scale, l.box![1] * scale, l.box![2] * scale, l.box![3] * scale]) as [number, number, number, number],
            angle: l.angle ?? 0,
          }))
          .filter((l) => !covered(l.text))
          // longest first: the full missed column outranks its own split tails
          .sort((a, b) => [...b.text].length - [...a.text].length)
          .slice(0, 3);
        if (!candidates.length) return;
        console.log(`[ocr-pipeline] fallback-recovery (attempt ${attempt + 1}): ${candidates.length} uncovered candidate(s): ${candidates.map((c) => c.text.slice(0, 12)).join(" | ")}`);
        let verified = 0;
        for (const cand of candidates) {
          const recovered = await this.verifyAtBox(bytes, cand.text, cand.box, cand.angle, lines);
          if (recovered) { lines.push(recovered); verified++; recoveredLines.push(recovered); }
        }
        if (verified > 0) break;
      }
      // reading order: the recovered line(s) were appended — the reader's
      // permutation covers the whole list including them (prod 0.11.6: the
      // column landed last instead of its slot). The reader can misplace a
      // recovered line among overlapping boxes by a slot (prod 0.11.7: one
      // early) — after permuting, each recovered line is re-inserted by the
      // LOCAL geometric trend of its direction (RTL/LTR from the majority
      // of consecutive across-coord deltas of the reader's own order).
      if (recoveredLines.length > 0 && lines.length > 2) {
        const ord = await this.orderWithImage(bytes, lines);
        if (ord) {
          lines.splice(0, lines.length, ...ord.perm.map((i) => lines[i]!));
          console.log("[ocr-pipeline] fallback-recovery: reading order re-confirmed with recovered line(s)");
        } else {
          console.log("[ocr-pipeline] fallback-recovery: re-order unavailable — geometric insertion only");
        }
        for (const rec of recoveredLines) {
          const idx = lines.indexOf(rec);
          if (idx < 0) continue;
          lines.splice(idx, 1);
          const at = this.geometricInsertIndex(lines, rec);
          lines.splice(at, 0, rec);
          console.log(`[ocr-pipeline] fallback-recovery: inserted at ${at} by geometric trend`);
        }
      }
    } catch (e) {
      console.warn(`[ocr-pipeline] fallback-recovery failed (serving pipeline lines): ${String(e)}`);
    }
  }

  /** verify a candidate at its proposed (pixel) box: crop the box with
   *  padding through the standard rotation path, read it, and serve the READ
   *  only if it matches the candidate and duplicates no existing line. The
   *  proposal's geometry and text are both confirmed by pixels or killed. */
  private async verifyAtBox(bytes: Uint8Array, cand: string, box: [number, number, number, number], angleDeg: number, allLines: OcrLine[]): Promise<OcrLine | null> {
    const meta = await sharp(bytes).metadata();
    const W = meta.width ?? 1200, H = meta.height ?? 1600;
    // A vector box is the AABB of a SLANTED line — its width over-covers the
    // true column by the slant smear (measured: 941px box for a ~200px
    // column; cropping it verbatim reads multi-column soup). Narrow the quad
    // by char pitch (chars stack along the line) and rotate it by the line's
    // own vector angle so the standard crop path de-slants it.
    const n = [...cand].length;
    const boxW = box[2] - box[0], boxH = box[3] - box[1];
    const vertical = Math.abs(angleDeg) >= 45;
    const pitch = Math.max(30, (vertical ? boxH : boxW) / Math.max(1, n));
    const hw = Math.max(24, Math.min(boxW / 2, pitch * 0.9));
    const hh = Math.max(40, (vertical ? boxH : boxW) / 2);
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    const rad = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const local: [number, number][] = [[-hh, -hw], [hh, -hw], [hh, hw], [-hh, hw]]; // long axis LOCAL-horizontal, then rotated to angleDeg
    const pts: [number, number][] = local.map(([dx, dy]) => [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]);
    try {
      const crop = await this.cropQuadOf(bytes, { pts });
      let text = crop ? await this.readCrop(crop) : "";
      if (!text && crop) text = await this.readCrop(crop);
      text = toTrad(text.replace(/\s+/g, ""));
      if (!text) { console.log("[ocr-pipeline] fallback-recovery box read empty — discarded"); return null; }
      // verification = containment: ≥75% of the candidate's chars must be
      // present in the crop read (pixel confirmation of the proposal), and
      // the read must not be multi-column soup (≤ ~3x the candidate — bleed
      // at strip ends is normal, wholesale mixing is not). The CANDIDATE is
      // served (its own duplication was excluded at selection); the read's
      // tail bleed never reaches the user.
      const recall = charSim(text, cand); // hits / min-len ≈ containment when read ≥ cand
      const soup = [...text].length > [...cand].length * 3 + 4;
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      console.log(`[ocr-pipeline] fallback-recovery box [${Math.round(Math.min(...xs))},${Math.round(Math.min(...ys))},${Math.round(Math.max(...xs))},${Math.round(Math.max(...ys))}]: read "${text.slice(0, 24)}" recall=${recall.toFixed(2)} soup=${soup}`);
      if (recall < 0.75 || soup) return null;
      const nRead = [...cand].length;
      console.log(`[ocr-pipeline] fallback-recovery: VERIFIED (${nRead} chars): ${cand.slice(0, 24)}`);
      // SERVED GEOMETRY: the vector box is a coarse proposal — snap it to the
      // page's own column grid before serving (prod 0.11.6: recovered line
      // overlapped a neighbor and sat at the vector angle, visibly off).
      // - angle: the median of same-direction neighbors (±15° trust band)
      // - pitch: the neighbors' median chars-per-length (vector boxH/n is
      //   noisy) → quad length = pitch × chars
      // - across-axis position: the vector box's (that IS the slot);
      //   along-axis center: the neighbors' median (columns share extent)
      const served = this.snapToGrid(pts, vertical, nRead, allLines);
      const sx = served.map((p) => p[0]), sy = served.map((p) => p[1]);
      const ang = axisAngle({ pts: served });
      return {
        text: cand,
        box: [Math.round(Math.min(...sx)), Math.round(Math.min(...sy)), Math.round(Math.max(...sx)), Math.round(Math.max(...sy))] as [number, number, number, number],
        dir: Math.abs(ang) >= 45 ? ("v" as const) : ("h" as const),
        angle: Math.round(ang),
        charBoxes: charCells({ pts: served }, nRead),
      };
    } catch (e) {
      console.warn(`[ocr-pipeline] fallback-recovery box read failed: ${String(e)}`);
      return null;
    }
  }

  /** insertion index for a recovered line among the same-direction lines by
   *  the page's own trend: the majority sign of consecutive across-coord
   *  deltas (v-lines: x-center — RTL letters trend decreasing; h-lines:
   *  y-center, increasing). Ambiguous trend → end of the same-dir block. */
  private geometricInsertIndex(lines: OcrLine[], rec: OcrLine): number {
    if (!rec.box || !rec.dir) return lines.length;
    const across = (l: OcrLine) => rec.dir === "v" ? (l.box![0] + l.box![2]) / 2 : (l.box![1] + l.box![3]) / 2;
    const sameDir = lines.map((l, i) => ({ l, i })).filter((x) => x.l.dir === rec.dir && x.l.box);
    if (sameDir.length === 0) return lines.length;
    const coords = sameDir.map((x) => across(x.l));
    let dec = 0, inc = 0;
    for (let i = 1; i < coords.length; i++) {
      if (coords[i]! < coords[i - 1]!) dec++;
      else if (coords[i]! > coords[i - 1]!) inc++;
    }
    const recCoord = across(rec);
    let target: number;
    if (dec > inc) {
      // right-to-left: insert before the first line further left than us
      target = sameDir.find((x) => across(x.l) < recCoord)?.i ?? sameDir[sameDir.length - 1]!.i + 1;
    } else if (inc > dec) {
      target = sameDir.find((x) => across(x.l) > recCoord)?.i ?? sameDir[sameDir.length - 1]!.i + 1;
    } else {
      target = sameDir[sameDir.length - 1]!.i + 1;
    }
    return Math.min(target, lines.length);
  }

  /** snap a verified recovery quad to the page's line grid: angle → median of
   *  same-direction neighbors (±15° trust band), pitch → their median
   *  chars-per-length, along-axis center → their median. Falls back to the
   *  proposal quad when no usable neighbors exist. */
  private snapToGrid(pts: [number, number][], vertical: boolean, nChars: number, allLines: OcrLine[]): [number, number][] {
    const neighbors = allLines.filter((l) => {
      if (!l.box || !l.angle || [...l.text].length < 3) return false;
      return vertical ? Math.abs(l.angle) >= 45 : Math.abs(l.angle) < 45;
    });
    const propAng = axisAngle({ pts });
    const angles = neighbors.map((l) => l.angle as number).sort((a, b) => a - b);
    const medAng = angles[Math.floor(angles.length / 2)];
    const ang = medAng !== undefined && Math.abs(((medAng - propAng + 540) % 360) - 180) <= 15 ? medAng : propAng;
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    // across-axis position comes from the proposal; the along-axis CENTER is
    // ALSO the proposal's own (neighbor median sits ~a pitch off for lines
    // whose extent differs — prod 0.11.7: chips rendered one char high)
    const med = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };
    const neighborPitches = neighbors.map((l) => (vertical ? l.box![3] - l.box![1] : l.box![2] - l.box![0]) / Math.max(1, [...l.text].length));
    const alongCenter = vertical ? cy : cx;
    const propLen = (vertical ? (Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]))) : (Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]))));
    const pitch = neighborPitches.length ? Math.max(30, med(neighborPitches)) : Math.max(30, propLen / Math.max(1, nChars));
    const halfLen = (pitch * nChars) / 2;
    // true column half-width from pitch (the proposal quad's AABB width
    // carries the slant smear — measured 627px half-width for a ~135px
    // column, doubling the served box into the neighbor columns)
    const halfWid = Math.max(20, pitch * 0.7);
    const rad = (ang * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    // axis unit (along text) and perpendicular unit; across-position from proposal
    const axis: [number, number] = [cos, sin];
    const perp: [number, number] = [-sin, cos];
    const anchor: [number, number] = vertical ? [cx, alongCenter] : [alongCenter, cy];
    const corners: [number, number][] = [[-halfLen, -halfWid], [halfLen, -halfWid], [halfLen, halfWid], [-halfLen, halfWid]];
    return corners.map(([a, p]) => [
      anchor[0] + a * axis[0] + p * perp[0],
      anchor[1] + a * axis[1] + p * perp[1],
    ]);
  }

  /** synthesize a quad between two of our lines (vertical: midpoint between the two columns; horizontal: midpoint y) */
  private synthesizeBetween(lines: OcrLine[], i: number, j: number): Quad | null {    if (i < 0 || j < 0 || i >= lines.length || j >= lines.length) return null;
    const a = lines[i]!, b = lines[j]!;
    const widths = lines.map((l) => l.box![2] - l.box![0]).sort((x, y) => x - y);
    const heights = lines.map((l) => l.box![3] - l.box![1]).sort((x, y) => x - y);
    const medW = widths[Math.floor(widths.length / 2)]!;
    const medH = heights[Math.floor(heights.length / 2)]!;
    if (a.dir === "v" && b.dir === "v") {
      const cx = (a.box![0] + b.box![0]) / 2;
      const l = cx - medW / 2, r2 = cx + medW / 2;
      const top = Math.min(a.box![1], b.box![1]);
      const bot = Math.max(a.box![3], b.box![3]);
      return { pts: [[l, top], [r2, top], [r2, bot], [l, bot]] };
    }
    const cy = (a.box![1] + b.box![1]) / 2;
    const t = cy - medH / 2, b2 = cy + medH / 2;
    const l = Math.min(a.box![0], b.box![0]), r2 = Math.max(a.box![2], b.box![2]);
    return { pts: [[l, t], [r2, t], [r2, b2], [l, b2]] };
  }

  /** crop a synthetic quad through the standard rotation path */
  private async cropQuadOf(bytes: Uint8Array, q: Quad): Promise<Buffer | null> {
    const angle = axisAngle(q) + (axisFlip(q) ? 180 : 0);
    const { buf, plan } = await this.rotateFull(bytes, angle);
    return this.cropQuad(buf, plan, q as DetQuad);
  }

  /** blind crop read with retry/backoff; "" on persistent failure */
  private async readCrop(png: Buffer): Promise<string> {
    const b64 = png.toString("base64");
    const messages: GatewayMsg[] = [{
      role: "user",
      content: [
        { type: "text", text: READ_PROMPT },
        { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
      ],
    }];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${this.cfg.base}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.key}` },
          body: JSON.stringify({ model: this.cfg.model, temperature: 0, max_tokens: 400, messages }),
          signal: AbortSignal.timeout(90_000),
        });
        if (res.status === 429 || res.status === 503) {
          console.warn(`[ocr-pipeline] read 429/503 (attempt ${attempt + 1}) — backing off`);
          await new Promise((r2) => setTimeout(r2, 8000 * (attempt + 1)));
          continue;
        }
        if (!res.ok) { console.warn(`[ocr-pipeline] read failed: ${res.status}`); return ""; }
        const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        return (j.choices?.[0]?.message?.content ?? "").trim();
      } catch (e) {
        console.warn(`[ocr-pipeline] read error (attempt ${attempt + 1}): ${String(e)}`);
        if (attempt === 1) return "";
        await new Promise((r2) => setTimeout(r2, 8000 * (attempt + 1)));
      }
    }
    return "";
  }
}

/**
 * Pure crop plan for one rotation cluster. sharp reorders rotate BEFORE extend
 * and auto-expands the canvas to the rotated bounding box — so the plan
 * computes sharp's actual output dims and the point map measured in
 * bench/dbg-sharp-rot.mts (red-dot test): sharp.rotate(φ) moves a point p to
 * rotatePt(p, -φ) about the ORIGINAL center, plus the expand offset.
 */
export function cropPlan(W: number, H: number, angle: number) {
  const rotateArg = -angle;
  // map matrix uses SHARP'S argument (φ = rotateArg): measured map = [x·cosφ − y·sinφ, x·sinφ + y·cosφ]
  const rad = (rotateArg * Math.PI) / 180;
  const rwRaw = Math.abs(W * Math.cos(rad)) + Math.abs(H * Math.sin(rad));
  const rhRaw = Math.abs(W * Math.sin(rad)) + Math.abs(H * Math.cos(rad));
  // sharp rounds the expanded canvas; clamp the analytic estimate to the safe side
  const rw = Math.ceil(rwRaw), rh = Math.ceil(rhRaw);
  const D = 8; // post-rotate white margin
  const offX = (rw - W) / 2 + D, offY = (rh - H) / 2 + D;
  const c = Math.cos(rad), s = Math.sin(rad);
  const map = (p: [number, number]): [number, number] => {
    const x = p[0] - W / 2, y = p[1] - H / 2;
    return [x * c - y * s + W / 2 + offX, x * s + y * c + H / 2 + offY];
  };
  // inverse of map (rotate back): measured-gap recovery maps slot quads from
  // rotated space to original pixel space for the served line box/charCells
  const inv = (p: [number, number]): [number, number] => {
    const x = p[0] - W / 2 - offX, y = p[1] - H / 2 - offY;
    return [x * c + y * s + W / 2, -x * s + y * c + H / 2];
  };
  return { rotateArg, D, rw: rw + 2 * D, rh: rh + 2 * D, map, inv };
}
