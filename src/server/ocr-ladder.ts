/**
 * LADDER OCR: deterministic classical OCR (RapidOCR / PaddleOCR PP-OCRv4 models)
 * first; a confidence gate decides; weak/empty results fall through to the LLM
 * vector path. Each rung does what it is measurably best at (bench/ocr-ladder.ts):
 * classical = upright print, deterministic pixel geometry, no LLM failure modes;
 * LLM = curves, handwriting, diagonal brush script.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { OcrLine, OcrService, Result } from "./ports";

const run = promisify(execFile);

interface RapidItem { box: [number, number, number, number]; text: string; score: number }

/** RapidOCR access — HTTP service (production: OCR_HTTP_URL → mamahuhu-ocr
 *  container) or the python venv shell-out (POC mode). Same response contract:
 *  {items:[{box,text,score}], w, h} with boxes in ORIGINAL pixel space. */
export class RapidOcrService {
  constructor(private cfg: { python: string; script: string; httpUrl?: string }) {}

  async extract(bytes: Uint8Array): Promise<{ items: RapidItem[]; w: number; h: number }> {
    if (this.cfg.httpUrl) {
      const res = await fetch(`${this.cfg.httpUrl}/ocr`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new Error(`ocr service ${res.status}`);
      const j = (await res.json()) as { items?: RapidItem[]; w: number; h: number };
      return { items: j.items ?? [], w: j.w, h: j.h };
    }
    const dir = await mkdtemp(join(tmpdir(), "mmh-ocr-"));
    try {
      const img = join(dir, "in.png");
      await writeFile(img, bytes);
      const { stdout } = await run(this.cfg.python, ["-u", this.cfg.script, img, "1600"], { timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
      const j = JSON.parse(stdout) as { items: RapidItem[]; w: number; h: number };
      return { items: j.items ?? [], w: j.w, h: j.h };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** gate: is the classical pass good enough to serve alone? */
export function classicalSufficient(items: RapidItem[]): boolean {
  if (items.length === 0) return false;
  const conf = items.filter((i) => i.score >= 0.75);
  const mean = items.reduce((s, i) => s + i.score, 0) / items.length;
  const chars = items.reduce((s, i) => s + [...i.text].length, 0);
  return conf.length >= 3 && mean >= 0.78 && chars >= 8;
}

/** classical lines → OcrLine (pixel boxes, deterministic reading order, aspect angle) */
export function classicalLines(items: RapidItem[]): OcrLine[] {
  const lines: OcrLine[] = items.map((i) => {
    const bw = i.box[2] - i.box[0];
    const bh = i.box[3] - i.box[1];
    const tall = bh > bw * 1.3 && [...i.text].length > 1;
    return { text: i.text, box: [Math.round(i.box[0]), Math.round(i.box[1]), Math.round(i.box[2]), Math.round(i.box[3])], dir: tall ? ("v" as const) : ("h" as const) };
  });
  const horizontal = lines.filter((l) => l.dir === "h");
  const vertical = lines.filter((l) => l.dir === "v");
  horizontal.sort((a, b) => (Math.abs(a.box![1] - b.box![1]) > (a.box![3] - a.box![1]) * 0.7 ? a.box![1] - b.box![1] : a.box![0] - b.box![0]));
  vertical.sort((a, b) => (Math.abs(b.box![0] - a.box![0]) > (b.box![2] - b.box![0]) * 0.7 ? b.box![0] - a.box![0] : a.box![1] - b.box![1]));
  return [...horizontal, ...vertical];
}


const CENSUS_SYSTEM = `You are a text-region census. List EVERY region of the image that contains ANY text, no matter its angle, curve, or legibility. Do NOT transcribe anything. Return ONLY valid JSON:
{"regions":[{"box":[x1,y1,x2,y2]}]}
Boxes on a 0-1000 grid (0,0 = top-left). One region per contiguous text block.`;

const RECOGNIZE_SYSTEM = "Transcribe ALL Chinese text visible in the image, in reading order. Reply with ONLY the transcription — no JSON, no notes.";

interface Box { x1: number; y1: number; x2: number; y2: number }

export class LadderOcrService implements OcrService {
  constructor(private rapid: RapidOcrService, private llm: OcrService, private chatCfg?: { base: string; key: string; model: string }) {}
  available(): boolean { return this.llm.available(); }
  /** which rung served the last call (diagnostics/tests) */
  public lastServedBy: "classical" | "llm" = "classical";

  private async chat(system: string, b64: string, maxTokens: number): Promise<string> {
    if (!this.chatCfg) throw new Error("chat cfg missing");
    const res = await fetch(`${this.chatCfg.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.chatCfg.key}` },
      body: JSON.stringify({
        model: this.chatCfg.model, temperature: 0, max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: [
            { type: "text", text: system === CENSUS_SYSTEM ? "List the text regions." : "Transcribe." },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
          ] },
        ],
      }),
    });
    if (!res.ok) throw new Error(`gateway ${res.status}`);
    return ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
  }

  /** census pass: LLM lists text regions; returns boxes classical left unexplained */
  async censusGaps(bytes: Uint8Array, items: RapidItem[], w: number, h: number): Promise<Box[]> {
    const raw = await this.chat(CENSUS_SYSTEM, Buffer.from(bytes).toString("base64"), 1200);
    const regions: Box[] = [];
    for (const m of raw.matchAll(/\{[^{}]*\}/g)) {
      try {
        const o = JSON.parse(m[0]) as { box?: unknown };
        const b = Array.isArray(o.box) ? o.box.map(Number) : null;
        if (b && b.length === 4 && b.every((n) => Number.isFinite(n)) && b[0]! < b[2]! && b[1]! < b[3]! && b.every((n) => n >= -60 && n <= 1060)) {
          regions.push({ x1: Math.round(b[0]! / 1000 * w), y1: Math.round(b[1]! / 1000 * h), x2: Math.round(b[2]! / 1000 * w), y2: Math.round(b[3]! / 1000 * h) });
        }
      } catch { /* skip */ }
    }
    return regions.filter((r) => !covered(r, items));
  }

  /** bounded crop recognition for census gaps (plain text out — nothing to loop in) */
  private async cropRecognize(bytes: Uint8Array, r: Box, w: number, h: number): Promise<string> {
    const sharp = (await import("sharp")).default;
    const padX = Math.round((r.x2 - r.x1) * 0.15) + 6;
    const padY = Math.round((r.y2 - r.y1) * 0.15) + 6;
    const left = Math.max(0, r.x1 - padX);
    const top = Math.max(0, r.y1 - padY);
    const width = Math.min(w - left, r.x2 - r.x1 + 2 * padX);
    const height = Math.min(h - top, r.y2 - r.y1 + 2 * padY);
    const scale = Math.min(3, Math.max(1, 600 / Math.max(width, height)));
    const crop = await sharp(Buffer.from(bytes)).extract({ left, top, width, height }).resize(Math.round(width * scale), Math.round(height * scale)).png().toBuffer();
    const raw = await this.chat(RECOGNIZE_SYSTEM, crop.toString("base64"), 400);
    return raw.replace(/```[a-z]*|```/gi, "").trim();
  }

  async extract(image: Blob): Promise<Result<{ lines: OcrLine[] }>> {
    try {
      const bytes = new Uint8Array(await image.arrayBuffer());
      const { items, w, h } = await this.rapid.extract(bytes);
      if (classicalSufficient(items)) {
        this.lastServedBy = "classical";
        const lines = classicalLines(items);
        if (lines.length) {
          // CENSUS verify: close the coverage hole — LLM lists regions, code
          // compares, unexplained regions get crop-recognized and merged
          if (this.chatCfg) {
            try {
              const gaps = await this.censusGaps(bytes, items, w, h);
              const classicalText = items.map((i) => i.text).join("");
              for (const g of gaps.slice(0, 12)) {
                const text = await this.cropRecognize(bytes, g, w, h);
                if (text && /\p{Script=Han}/u.test(text) && !classicalText.includes(text.replace(/\s+/g, ""))) {
                  const tall = g.y2 - g.y1 > (g.x2 - g.x1) * 1.3 && [...text].length > 1;
                  lines.push({ text, box: [g.x1, g.y1, g.x2, g.y2], dir: tall ? "v" : "h" });
                }
              }
            } catch {
              /* census is best-effort — classical result stands alone */
            }
          }
          return { ok: true, value: { lines } };
        }
      }
    } catch {
      /* classical unavailable/erroring → fall through to the LLM rung */
    }
    this.lastServedBy = "llm";
    return this.llm.extract(image);
  }
}

function covered(regionPx: Box, items: RapidItem[]): boolean {
  const rw = regionPx.x2 - regionPx.x1;
  const rh = regionPx.y2 - regionPx.y1;
  if (rw <= 0 || rh <= 0) return true;
  let interSum = 0;
  for (const it of items) {
    const ix = Math.max(0, Math.min(regionPx.x2, it.box[2]) - Math.max(regionPx.x1, it.box[0]));
    const iy = Math.max(0, Math.min(regionPx.y2, it.box[3]) - Math.max(regionPx.y1, it.box[1]));
    interSum += ix * iy;
  }
  return interSum / (rw * rh) >= 0.5;
}
