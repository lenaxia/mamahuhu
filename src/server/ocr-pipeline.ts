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
import sharp from "sharp";
import type { OcrLine, OcrService, Result } from "./ports";
import { axisAngle, charCells, charSim, dedupeQuads, expectChars, readingOrder, splitQuad, validateRead, type Quad } from "./ocr-geometry";

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

    const ordered = readingOrder(dedupeQuads(det.quads));
    const meta = await sharp(bytes).metadata();
    const W = meta.width ?? det.w, H = meta.height ?? det.h;

    // angle clusters (±2°): rotate the full image once per cluster, crop members
    const clusters = new Map<number, DetQuad[]>();
    for (const q of ordered) {
      const k = Math.round(axisAngle(q) / 2) * 2;
      (clusters.get(k) ?? clusters.set(k, []).get(k)!).push(q);
    }

    const reads = new Map<DetQuad, string>();
    for (const [, members] of clusters) {
      const angle = axisAngle(members[0]!);
      const { buf, plan } = await this.rotateFull(bytes, angle);
      const queue = [...members];
      const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (;;) {
          const q = queue.shift();
          if (!q) return;
          reads.set(q, await this.readCrop(await this.cropQuad(buf, plan, q)));
        }
      });
      await Promise.all(workers);
    }

    // assembly: a read's newlines CONFIRM multi-row quads (evidence-driven split)
    const raw: OcrLine[] = [];
    for (const q of ordered) {
      const ang = axisAngle(q);
      const parts = (reads.get(q) ?? "").split(/\n+/).map((t) => t.trim()).filter((t) => t.length > 0);
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
    // duplicate long lines (overlapping det quads re-reading the same paragraph) — keep first
    const lines: OcrLine[] = [];
    for (const l of raw) {
      if (l.text.length >= 8 && lines.some((k) => charSim(k.text, l.text) >= 0.7)) {
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
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(`${this.cfg.base}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.key}` },
          body: JSON.stringify({ model: this.cfg.model, temperature: 0, max_tokens: 400, messages }),
          signal: AbortSignal.timeout(240_000),
        });
        if (res.status === 429 || res.status === 503) {
          await new Promise((r2) => setTimeout(r2, 8000 * (attempt + 1)));
          continue;
        }
        if (!res.ok) return "";
        const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        return (j.choices?.[0]?.message?.content ?? "").trim();
      } catch {
        if (attempt === 3) return "";
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
