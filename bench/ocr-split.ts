// POC: SPLIT OCR PIPELINE — detection pass + per-crop recognition + deterministic
// assembly, measured side-by-side against the monolithic vector contract.
// Run: npx tsx bench/ocr-split.ts
import { readFileSync } from "node:fs";
import sharp from "sharp";

const BASE = process.env.OPENAI_API_BASE ?? "https://api.thekao.cloud/v1";
const KEY = process.env.OPENAI_API_KEY ?? "";

// ---- fixture gates (identical to ocr-vectors.ts so numbers are comparable) ----
const FIXTURES = [
  { name: "banner-insitu", file: "bench/fixtures/banner-insitu.jpg", dims: { w: 3024, h: 4032 }, known: ["亲近自然", "探索发现", "健康成长", "环保", "野营", "蘑菇", "团队"] },
  { name: "poster-flat", file: "bench/fixtures/poster-flat.jpg", dims: { w: 750, h: 1000 }, known: ["亲近自然", "探索发现", "健康成长", "环保", "野营", "蘑菇", "团队"] },
  { name: "letter-diagonal", file: "bench/fixtures/letter-diagonal.jpg", dims: { w: 3024, h: 4032 }, known: ["太傅", "虎符", "随元", "密信"], minKnown: 3 },
  { name: "wordcloud-color", file: "bench/fixtures/wordcloud-color.png", dims: { w: 695, h: 458 }, known: [], minBlocks: 40 },
  { name: "wordcloud-black", file: "bench/fixtures/wordcloud-black.jpg", dims: { w: 1125, h: 1104 }, known: [], minBlocks: 0 },
  { name: "grid-handwriting", file: "bench/fixtures/grid-handwriting.jpg", dims: { w: 4032, h: 3024 }, known: ["則", "崩", "奠", "侗", "合"], minKnown: 3 },
  { name: "curve-arc", file: "bench/fixtures/curve-arc.png", dims: { w: 1000, h: 700 }, known: ["床前明月光", "疑是地上霜"] },
  { name: "curve-s", file: "bench/fixtures/curve-s.png", dims: { w: 1000, h: 900 }, known: ["舉頭望明月", "低頭思故鄉"] },
];

async function chat(messages: unknown[], maxTokens: number): Promise<string> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: process.env.MODEL_CHAT ?? "default", temperature: 0, max_tokens: maxTokens, messages }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 150)}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content ?? "";
}

// ---- pass 1: detection (SHORT output — no room to loop) ----
const DETECT_SYSTEM = `Find every region of Chinese text in the image. Return ONLY valid JSON, no prose:
{"regions":[{"box":[x1,y1,x2,y2],"angle":0}]}
- box = tight axis-aligned rectangle around ONE contiguous text region, on a 0-1000 grid (0,0 = top-left).
- angle = the region's text axis in degrees (0 = horizontal, 90 = vertical top-to-bottom, diagonal = its actual tilt).
- ONE region per visual line or word block — never merge lines on separate rows. List top-to-bottom.`;

interface Region { box: [number, number, number, number]; angle: number; px: [number, number, number, number] }

async function detect(buf: Buffer, dims: { w: number; h: number }): Promise<Region[]> {
  const raw = await chat([
    { role: "system", content: DETECT_SYSTEM },
    { role: "user", content: [
      { type: "text", text: "List the text regions." },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` } },
    ] },
  ], 2000);
  const regions: Region[] = [];
  for (const m of raw.matchAll(/\{[^{}]*\}/g)) {
    try {
      const o = JSON.parse(m[0]) as { box?: unknown; angle?: unknown };
      const b = Array.isArray(o.box) ? o.box.map(Number) : null;
      if (!b || b.length !== 4 || b.some((n) => !Number.isFinite(n)) || b[0]! >= b[2]! || b[1]! >= b[3]!) continue;
      if (b.some((n) => n < -60 || n > 1060)) continue;
      const angle = typeof o.angle === "number" && Number.isFinite(o.angle) ? Math.round(o.angle) : 0;
      const sx = dims.w / 1000;
      const sy = dims.h / 1000;
      const px: [number, number, number, number] = [Math.round(b[0]! * sx), Math.round(b[1]! * sy), Math.round(b[2]! * sx), Math.round(b[3]! * sy)];
      if (px[2] - px[0] < 8 || px[3] - px[1] < 8) continue;
      regions.push({ box: [b[0]!, b[1]!, b[2]!, b[3]!], angle, px });
    } catch { /* skip partial */ }
  }
  return regions;
}

// ---- pass 2: recognition per crop (plain text out — nothing to loop inside) ----
const RECOGNIZE_SYSTEM = "Transcribe ALL Chinese text visible in the image, in reading order. Reply with ONLY the transcription — no JSON, no notes, no positions.";

async function recognize(cropB64: string): Promise<string> {
  const raw = await chat([
    { role: "system", content: RECOGNIZE_SYSTEM },
    { role: "user", content: [
      { type: "text", text: "Transcribe." },
      { type: "image_url", image_url: { url: `data:image/png;base64,${cropB64}` } },
    ] },
  ], 400);
  return raw.replace(/```[a-z]*|```/gi, "").trim();
}

async function cropRegion(buf: Buffer, px: [number, number, number, number], dims: { w: number; h: number }): Promise<string> {
  const padX = Math.round((px[2] - px[0]) * 0.12) + 6;
  const padY = Math.round((px[3] - px[1]) * 0.12) + 6;
  const left = Math.max(0, px[0] - padX);
  const top = Math.max(0, px[1] - padY);
  const width = Math.min(dims.w - left, px[2] - px[0] + 2 * padX);
  const height = Math.min(dims.h - top, px[3] - px[1] + 2 * padY);
  // upscale small crops so glyphs are legible to the model
  const scale = Math.min(3, Math.max(1, 600 / Math.max(width, height)));
  const out = await sharp(buf).extract({ left, top, width, height })
    .resize(Math.round(width * scale), Math.round(height * scale))
    .png().toBuffer();
  return out.toString("base64");
}

// ---- pass 3: deterministic assembly ----
function assemble(regions: Region[], texts: string[]): { text: string; angle: number; box: [number, number, number, number] }[] {
  const items = regions.map((r, i) => ({ ...r, text: texts[i] ?? "" })).filter((it) => it.text);
  const vertical = items.filter((it) => Math.abs(it.angle) >= 45);
  const horizontal = items.filter((it) => Math.abs(it.angle) < 45);
  // horizontal: top-to-bottom, left-to-right. vertical columns: right-to-left, top-to-bottom
  horizontal.sort((a, b) => (Math.abs(a.px[1] - b.px[1]) > 30 ? a.px[1] - b.px[1] : a.px[0] - b.px[0]));
  vertical.sort((a, b) => (Math.abs(b.px[0] - a.px[0]) > 30 ? b.px[0] - a.px[0] : a.px[1] - b.px[1]));
  return [...horizontal, ...vertical].map((it) => ({ text: it.text, angle: it.angle, box: it.box }));
}

// ---- runner ----
async function main() {
  for (const fx of FIXTURES) {
    const t0 = Date.now();
    try {
      const buf = readFileSync(fx.file);
      const regions = await detect(buf, fx.dims);
      const tDetect = Date.now() - t0;
      // recognize in bounded parallelism
      const CONC = 8;
      const texts: string[] = [];
      for (let i = 0; i < regions.length; i += CONC) {
        const batch = regions.slice(i, i + CONC);
        const out = await Promise.all(batch.map((r) => cropRegion(buf, r.px, fx.dims).then(recognize).catch(() => "")));
        texts.push(...out);
      }
      const tTotal = Date.now() - t0;
      const assembled = assemble(regions, texts);
      const lines = assembled.filter((a) => a.text);
      const all = lines.map((l) => l.text).join("");
      const dupes = lines.length - new Set(lines.map((l) => l.text)).size;
      const known = fx.known.filter((k) => all.includes(k)).length;
      const chars = all.length;
      const minKnown = (fx as { minKnown?: number }).minKnown ?? fx.known.length;
      const minBlocks = (fx as { minBlocks?: number }).minBlocks ?? 1;
      const ok = lines.length >= minBlocks && known >= (fx.known.length ? Math.min(minKnown, fx.known.length) : 0);
      console.log(`${ok ? "ok  " : "FAIL"} ${fx.name}: regions=${regions.length} lines=${lines.length} chars=${chars} dupes=${dupes} known=${known}/${fx.known.length} detect=${tDetect}ms total=${tTotal}ms`);
      for (const l of lines.slice(0, 5)) console.log(`     ${l.text.slice(0, 30)}`);
    } catch (e) {
      console.log(`ERR  ${fx.name}: ${String(e).slice(0, 120)}`);
    }
  }
}
void main();
