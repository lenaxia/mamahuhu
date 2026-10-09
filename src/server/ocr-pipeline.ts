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

  /** synthesize a quad between two of our lines (vertical: midpoint between the two columns; horizontal: midpoint y) */
  private synthesizeBetween(lines: OcrLine[], i: number, j: number): Quad | null {
    if (i < 0 || j < 0 || i >= lines.length || j >= lines.length) return null;
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
  return { rotateArg, D, rw: rw + 2 * D, rh: rh + 2 * D, map };
}
