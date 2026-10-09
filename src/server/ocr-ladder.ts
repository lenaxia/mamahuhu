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
import { fuseStructure, parseStructureLines, fusedToOcrLines } from "./ocr-fusion";

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

/** gate: is the classical pass good enough to serve alone?
 *  Two failure classes measured on the bench:
 *  1. confident-wrong: high CTC scores on hard script (scores alone lie)
 *  2. fragment soup: the detector groups diagonal/handwritten text into
 *     single-char fragments with wild pitch variance — useless for lines/chips
 *     even when each fragment reads correctly (letter-4919: 29 fragments,
 *     pitch 39-153px). So the gate requires GROUPING COHERENCE as well:
 *     median >=3 chars/item, pitch CV <=0.6, single-char fraction <=50%. */
export function classicalSufficient(items: RapidItem[]): boolean {
  if (items.length === 0) return false;
  const conf = items.filter((i) => i.score >= 0.75);
  const mean = items.reduce((s, i) => s + i.score, 0) / items.length;
  const chars = items.reduce((s, i) => s + [...i.text].length, 0);
  if (!(conf.length >= 3 && mean >= 0.78 && chars >= 8)) return false;
  // grouping coherence
  const itemChars = items.map((i) => [...i.text].length).sort((a, b) => a - b);
  const median = itemChars[Math.floor(itemChars.length / 2)]!;
  const singles = itemChars.filter((n) => n === 1).length / itemChars.length;
  const pitches = items.filter((i) => [...i.text].length >= 2).map((i) => (i.box[2] - i.box[0]) / [...i.text].length);
  if (median < 3 || singles > 0.5) return false;
  if (pitches.length >= 3) {
    const pm = pitches.reduce((s, p) => s + p, 0) / pitches.length;
    const pv = Math.sqrt(pitches.reduce((s, p) => s + (p - pm) ** 2, 0) / pitches.length);
    if (pm > 0 && pv / pm > 0.6) return false;
  }
  return true;
}

/** classical lines → OcrLine (pixel boxes, deterministic reading order, aspect angle) */
export function classicalLines(items: RapidItem[]): OcrLine[] {
  const lines: OcrLine[] = items.map((i) => {
    const bw = i.box[2] - i.box[0];
    const bh = i.box[3] - i.box[1];
    const tall = bh > bw * 1.3 && [...i.text].length > 1;
    return { text: i.text, box: [Math.round(i.box[0]), Math.round(i.box[1]), Math.round(i.box[2]), Math.round(i.box[3])], dir: tall ? ("v" as const) : ("h" as const) };
  });
  // READING ORDER: rows top→bottom, left→right within a row; vertical columns
  // right→left, top→bottom within a column. Bands are CENTER-based, quantized
  // by a fraction of the median extent — the old |y1 diff| > 0.7×height rule
  // never banded real paragraph rows 20px apart under 45-56px padded boxes and
  // silently fell back to detector order, which arrived swapped (measured on
  // poster-flat: 堂里… printed before 带领…在自然课).
  const banded = (ls: OcrLine[], axis: "y" | "x", reverseBands: boolean): OcrLine[] => {
    if (ls.length < 2) return ls;
    const ext = (l: OcrLine) => (axis === "y" ? l.box![3] - l.box![1] : l.box![2] - l.box![0]);
    const exts = ls.map(ext).sort((a, b) => a - b);
    const tol = Math.max(4, 0.3 * exts[Math.floor(ls.length / 2)]!);
    const center = (l: OcrLine) => (axis === "y" ? (l.box![1] + l.box![3]) / 2 : (l.box![0] + l.box![2]) / 2);
    return [...ls].sort((a, b) => {
      const ka = Math.round(center(a) / tol), kb = Math.round(center(b) / tol);
      if (ka !== kb) return reverseBands ? kb - ka : ka - kb;
      return axis === "y" ? a.box![0] - b.box![0] : a.box![1] - b.box![1];
    });
  };
  return [...banded(lines.filter((l) => l.dir === "h"), "y", false), ...banded(lines.filter((l) => l.dir === "v"), "x", true)];
}


const CENSUS_SYSTEM = `You are a text-region census. List EVERY region of the image that contains ANY text, no matter its angle, curve, or legibility. Do NOT transcribe anything. Return ONLY valid JSON:
{"regions":[{"box":[x1,y1,x2,y2]}]}
Boxes on a 0-1000 grid (0,0 = top-left). One region per contiguous text block.`;

const RECOGNIZE_SYSTEM = "Transcribe ALL Chinese text visible in the image, in reading order. Reply with ONLY the transcription — no JSON, no notes.";

// STRUCTURE prompt v2 — validated on the letter fixtures (9 clean lines, correct
// text, no loops). A/B-matrix rule applies: no edits without bench/ab-letter.ts.
export const STRUCTURE_SYSTEM = `You are an OCR reader. Transcribe every PHYSICAL line or column of Chinese text, one at a time.
Return ONLY valid JSON: {"lines":[{"n":1,"text":"…","dir":"h"|"v"}]}
Rules:
- Each physical line/column = one entry, numbered sequentially (n:1, n:2, ...)
- "text": ONLY the characters you read, max 20 per line. If a line is longer, split it.
- If there's a visible gap within a line (space, seal, stamp), insert ⟪N⟫ where N = gap in char-widths.
- "dir": "h" horizontal, "v" vertical/near-vertical.
- Read each line EXACTLY ONCE. Count the lines you see — stop when you've transcribed them all.`;

interface Box { x1: number; y1: number; x2: number; y2: number }

/** FUSION ATTEMPT as a pure function — the routing layer under test
 *  (tests/unit/ocr-routing.test.ts replays committed classical+structure
 *  fixtures through it; no network, no venv, runs in CI with the suite).
 *
 *  Coverage guarantees (owner-measured failure on prod 0.7.1/0.7.2: "only
 *  captured half the lines" — the structure LLM's line SET varies per call;
 *  whole columns were absent from its output. Fusion cannot transcribe lines
 *  the structure call never emitted):
 *  - UNMATCHED-FRAGMENT RESCUE: classical fragments no line claimed are
 *    appended as classical-style lines (text + box) — columns the LLM missed
 *    stay visible.
 *
 *  Serve gates, both required:
 *  - anchored ≥ 0.2 of chars (≥6): positions must be substantially REAL
 *  - BOXED ≥ 0.5 of chars (anchored/inferred/rescued): fusion must capture
 *    at least half the content — partial loses to the vector rung's
 *    complete positioning. */
export function fuseAndServe(
  items: RapidItem[],
  structureRaw: string,
  dims: { w: number; h: number },
): { lines: OcrLine[]; anchoredFraction: number; boxedFraction: number; totalChars: number } | null {
  const result = fuseStructure(items, parseStructureLines(structureRaw), dims);
  const totalChars = result.lines.reduce((s, l) => s + l.chars.length, 0);
  if (totalChars === 0) return null;
  // fragment-inventory: every inventory line is anchored by construction;
  // inferred lines (LLM-only columns) are not. Truthfulness floor: ≥20% of
  // chars must live on real fragments, else the vector rung serves.
  const anchoredChars = result.lines.filter((l) => !l.inferred).reduce((s, l) => s + l.chars.length, 0);
  const anchoredFraction = anchoredChars / totalChars;
  const fused = fusedToOcrLines(result);
  const boxedChars = fused.filter((l) => l.charBoxes || l.box).reduce((s, l) => s + [...l.text].length, 0);
  const boxedFraction = boxedChars / totalChars;
  if (anchoredFraction < 0.2 || anchoredChars < 6 || boxedFraction < 0.5) return null;
  if (!fused.some((l) => l.charBoxes)) return null;
  return { lines: fused, anchoredFraction, boxedFraction, totalChars };
}

export class LadderOcrService implements OcrService {
  constructor(private rapid: RapidOcrService, private llm: OcrService, private chatCfg?: { base: string; key: string; model: string }) {}
  available(): boolean { return this.llm.available(); }
  /** which rung served the last call (diagnostics/tests) */
  public lastServedBy: "classical" | "fusion" | "llm" = "classical";

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
            { type: "text", text: system === CENSUS_SYSTEM ? "List the text regions." : system === STRUCTURE_SYSTEM ? "Transcribe the Chinese text lines." : "Transcribe." },
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

  async extract(image: Blob): Promise<Result<{ lines: OcrLine[]; servedBy?: string }>> {
    let items: RapidItem[] = [];
    let w = 0, h = 0;
    let eligible = false; // classical sees coherent LINE structure (print, letters, grids)
    try {
      const bytes = new Uint8Array(await image.arrayBuffer());
      ({ items, w, h } = await this.rapid.extract(bytes));
      eligible = classicalSufficient(items);
      const b64 = Buffer.from(bytes).toString("base64");

      // UNIFIED PIPELINE (OCR_FUSION=1): classical boxes NEVER serve directly —
      // an AABB cannot represent rotated text (the owner's diagonal letter
      // served overlapping raw boxes through the old "classical sufficient"
      // branch). EVERY photo with classical items goes through fusion; the
      // ≥20% anchored serve-gate is the single quality valve, the vector rung
      // catches whatever fusion can't anchor. No eligibility pre-filter —
      // every routing exception this far was measured optimization, not
      // correctness, and each one caused a routing surprise.
      if (process.env.OCR_FUSION === "1" && this.chatCfg) {
        if (items.length > 0) {
          try {
            const raw = await this.chat(STRUCTURE_SYSTEM, b64, 4000);
            const served = fuseAndServe(items, raw, { w, h });
            if (served) {
              this.lastServedBy = "fusion";
              return { ok: true, value: { lines: served.lines, servedBy: "fusion" } };
            }
          } catch {
            /* fusion is best-effort — vector rung stands behind it */
          }
        }
        this.lastServedBy = "llm";
        const vec = await this.llm.extract(image);
        return vec.ok ? { ...vec, value: { ...vec.value, servedBy: "llm" } } : vec;
      }

      // LEGACY PATH (OCR_FUSION unset — the rollback kill-switch): classical
      // serves its own boxes, CENSUS verify closes coverage gaps
      if (eligible) {
        this.lastServedBy = "classical";
        const lines = classicalLines(items);
        if (lines.length) {
          if (this.chatCfg) {
            try {
              const gaps = await this.censusGaps(bytes, items, w, h);
              const classicalText = items.map((i) => i.text).join("");
              for (const g of gaps.slice(0, 12)) {
                const text = await this.cropRecognize(bytes, g, w, h);
                if (text && /\p{Script=Han}/u.test(text) && !classicalText.includes(text.replace(/\s+/g, ""))) {
                  // a crop can contain SEVERAL physical lines — split on
                  // newlines and tile the crop box (measured: 76-char \n-laden
                  // crop transcriptions were becoming single monster lines)
                  const parts = text.split(/\n+/).map((t) => t.trim()).filter((t) => /\p{Script=Han}/u.test(t) && !classicalText.includes(t.replace(/\s+/g, "")));
                  parts.forEach((part, pi) => {
                    const tall = g.y2 - g.y1 > (g.x2 - g.x1) * 1.3 && [...part].length > 1;
                    let box: [number, number, number, number] = [g.x1, g.y1, g.x2, g.y2];
                    if (parts.length > 1) {
                      if (tall) {
                        const hStep = (g.y2 - g.y1) / parts.length;
                        box = [g.x1, Math.round(g.y1 + hStep * pi), g.x2, Math.round(g.y1 + hStep * (pi + 1))];
                      } else {
                        const wStep = (g.x2 - g.x1) / parts.length;
                        box = [Math.round(g.x1 + wStep * pi), g.y1, Math.round(g.x1 + wStep * (pi + 1)), g.y2];
                      }
                    }
                    lines.push({ text: part, box, dir: tall ? "v" : "h" });
                  });
                }
              }
            } catch {
              /* census is best-effort — classical result stands alone */
            }
          }
          return { ok: true, value: { lines, servedBy: "classical" } };
        }
      }
    } catch {
      /* classical unavailable/erroring → fall through to the LLM rung */
    }
    this.lastServedBy = "llm";
    const vec = await this.llm.extract(image);
    return vec.ok ? { ...vec, value: { ...vec.value, servedBy: "llm" } } : vec;
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
