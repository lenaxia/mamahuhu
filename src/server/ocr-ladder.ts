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

/** shells the RapidOCR python helper (venv with rapidocr-onnxruntime) */
export class RapidOcrService {
  constructor(private cfg: { python: string; script: string }) {}

  async extract(bytes: Uint8Array): Promise<{ items: RapidItem[]; w: number; h: number }> {
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

export class LadderOcrService implements OcrService {
  constructor(private rapid: RapidOcrService, private llm: OcrService) {}
  available(): boolean { return this.llm.available(); }
  /** which rung served the last call (diagnostics/tests) */
  public lastServedBy: "classical" | "llm" = "classical";

  async extract(image: Blob): Promise<Result<{ lines: OcrLine[] }>> {
    try {
      const bytes = new Uint8Array(await image.arrayBuffer());
      const { items } = await this.rapid.extract(bytes);
      if (classicalSufficient(items)) {
        this.lastServedBy = "classical";
        const lines = classicalLines(items);
        if (lines.length) return { ok: true, value: { lines } };
      }
    } catch {
      /* classical unavailable/erroring → fall through to the LLM rung */
    }
    this.lastServedBy = "llm";
    return this.llm.extract(image);
  }
}
