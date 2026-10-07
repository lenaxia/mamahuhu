// POC: CENSUS RUNG — closes the G2 coverage hole. After classical serves, one
// detection-only LLM call lists text regions; regions classical can't explain
// get crop-recognized by the LLM and merged. Verdict by comparison, not trust.
// Usage: npx tsx bench/ocr-census.ts
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);
const BASE = process.env.OPENAI_API_BASE ?? "https://ai.thekao.cloud/v1";
const KEY = process.env.OPENAI_API_KEY ?? "";

async function chat(system: string, b64: string, mime: string, maxTokens: number): Promise<string> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: process.env.MODEL_CHAT ?? "default", temperature: 0, max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: [
          { type: "text", text: system.includes("census") ? "List the text regions." : "Transcribe." },
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
        ] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}`);
  return ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
}

const CENSUS_SYSTEM = `You are a text-region census. List EVERY region of the image that contains ANY text, no matter its angle, curve, or legibility. Do NOT transcribe anything. Return ONLY valid JSON:
{"regions":[{"box":[x1,y1,x2,y2]}]}
Boxes on a 0-1000 grid (0,0 = top-left). One region per contiguous text block.`;

const RECOGNIZE_SYSTEM = "Transcribe ALL Chinese text visible in the image, in reading order. Reply with ONLY the transcription — no JSON, no notes.";

interface Box { x1: number; y1: number; x2: number; y2: number }
interface RapidItem { box: [number, number, number, number]; text: string; score: number }

async function classical(file: string): Promise<{ items: RapidItem[]; w: number; h: number }> {
  const { stdout } = await run("/tmp/opencode/ocrvenv/bin/python", ["-u", "bench/rapid-json.py", file, "1600"], { timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function census(file: string): Promise<Box[]> {
  const b64 = readFileSync(file).toString("base64");
  const mime = file.endsWith(".png") ? "image/png" : "image/jpeg";
  const raw = await chat(CENSUS_SYSTEM, b64, mime, 1200);
  const out: Box[] = [];
  for (const m of raw.matchAll(/\{[^{}]*\}/g)) {
    try {
      const o = JSON.parse(m[0]) as { box?: unknown };
      const b = Array.isArray(o.box) ? o.box.map(Number) : null;
      if (b && b.length === 4 && b.every((n) => Number.isFinite(n)) && b[0]! < b[2]! && b[1]! < b[3]! && b.every((n) => n >= -60 && n <= 1060)) {
        out.push({ x1: b[0]!, y1: b[1]!, x2: b[2]!, y2: b[3]! });
      }
    } catch { /* skip */ }
  }
  return out;
}

function iou(a: Box, b: [number, number, number, number]): number {
  const ix = Math.max(0, Math.min(a.x2, b[2]) - Math.max(a.x1, b[0]));
  const iy = Math.max(0, Math.min(a.y2, b[3]) - Math.max(a.y1, b[1]));
  const inter = ix * iy;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

function covered(regionPx: Box, items: RapidItem[]): boolean {
  // union coverage: classical items collectively explaining >=50% of the region
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

async function cropRecognize(buf: Buffer, px: Box, w: number, h: number): Promise<string> {
  const padX = Math.round((px.x2 - px.x1) * 0.15) + 6;
  const padY = Math.round((px.y2 - px.y1) * 0.15) + 6;
  const left = Math.max(0, px.x1 - padX);
  const top = Math.max(0, px.y1 - padY);
  const width = Math.min(w - left, px.x2 - px.x1 + 2 * padX);
  const height = Math.min(h - top, px.y2 - px.y1 + 2 * padY);
  const scale = Math.min(3, Math.max(1, 600 / Math.max(width, height)));
  const crop = await sharp(buf).extract({ left, top, width, height }).resize(Math.round(width * scale), Math.round(height * scale)).png().toBuffer();
  const raw = await chat(RECOGNIZE_SYSTEM, crop.toString("base64"), "image/png", 400);
  return raw.replace(/```[a-z]*|```/gi, "").trim();
}

const FIXTURES = [
  { name: "poster-flat", file: "bench/fixtures/poster-flat.jpg", expect: "census ⊆ classical (no add)" },
  { name: "mixed-arc-poster", file: "bench/images/mixed-arc-poster.png", expect: "census flags the arc classical missed" },
  { name: "letter-diagonal", file: "bench/fixtures/letter-diagonal.jpg", expect: "observe" },
  { name: "curve-arc", file: "bench/fixtures/curve-arc.png", expect: "classical empty → whole-image LLM anyway" },
];

for (const fx of FIXTURES) {
  const t0 = Date.now();
  try {
    const { items, w, h } = await classical(fx.file);
    const tCls = Date.now() - t0;
    const buf = readFileSync(fx.file);
    const regions = await census(fx.file);
    const tCensus = Date.now() - t0 - tCls;
    const toPx = (r: Box): Box => ({ x1: Math.round(r.x1 / 1000 * w), y1: Math.round(r.y1 / 1000 * h), x2: Math.round(r.x2 / 1000 * w), y2: Math.round(r.y2 / 1000 * h) });
    const classicalText = items.map((i) => i.text).join("");
    const unmatched = regions.map(toPx).filter((r) => !covered(r, items));
    const additions: { text: string; region: Box }[] = [];
    for (const r of unmatched.slice(0, 12)) {
      const text = await cropRecognize(buf, r, w, h);
      // dedupe: text classical already contains adds nothing
      if (text && /[\u3400-\u9fff]/.test(text) && !classicalText.includes(text.replace(/\s+/g, ""))) additions.push({ text, region: r });
    }
    const dt = Date.now() - t0;
    console.log(`${fx.name} (${fx.expect})`);
    console.log(`  classical=${items.length} items, census=${regions.length} regions, unmatched=${unmatched.length} → additions=${additions.length}  [cls ${tCls}ms + census ${tCensus}ms + crops ${dt - tCls - tCensus}ms]`);
    for (const a of additions.slice(0, 6)) console.log(`    + "${a.text.slice(0, 30)}" @ px[${a.region.x1},${a.region.y1},${a.region.x2},${a.region.y2}]`);
  } catch (e) {
    console.log(`${fx.name} ERROR ${String(e).slice(0, 140)}`);
  }
}
