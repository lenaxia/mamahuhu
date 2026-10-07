// POC: the FULL LADDER — RapidOCR (classical, deterministic) first; a confidence
// gate decides; insufficient results fall through to the LLM vector path (the
// app's real parser). One unified output shape. Usage: npx tsx bench/ocr-ladder.ts
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseOcrVectors } from "../src/server/llm";
import { VECTOR_SYSTEM } from "./ocr-vectors";

const run = promisify(execFile);
const BASE = process.env.OPENAI_API_BASE ?? "https://api.thekao.cloud/v1";
const KEY = process.env.OPENAI_API_KEY ?? "";

interface RapidItem { box: [number, number, number, number]; text: string; score: number }
interface Line { text: string; box: [number, number, number, number]; angle: number; source: "classical" | "llm" }

const FIXTURES = [
  { name: "banner-insitu", file: "bench/fixtures/banner-insitu.jpg", known: ["亲近自然", "探索发现", "健康成长", "环保", "野营", "蘑菇", "团队"] },
  { name: "poster-flat", file: "bench/fixtures/poster-flat.jpg", known: ["亲近自然", "探索发现", "健康成长", "环保", "野营", "蘑菇", "团队"] },
  { name: "letter-diagonal", file: "bench/fixtures/letter-diagonal.jpg", known: ["太傅", "虎符", "随元", "密信"], minKnown: 3 },
  { name: "wordcloud-color", file: "bench/fixtures/wordcloud-color.png", known: [] },
  { name: "wordcloud-black", file: "bench/fixtures/wordcloud-black.jpg", known: [] },
  { name: "grid-handwriting", file: "bench/fixtures/grid-handwriting.jpg", known: ["則", "崩", "奠", "侗", "合"], minKnown: 3 },
  { name: "curve-arc", file: "bench/fixtures/curve-arc.png", known: ["床前明月光", "疑是地上霜"] },
  { name: "curve-s", file: "bench/fixtures/curve-s.png", known: ["舉頭望明月", "低頭思故鄉"] },
];

async function classical(file: string): Promise<{ items: RapidItem[]; w: number; h: number; ms: number }> {
  const t0 = Date.now();
  const { stdout } = await run("/tmp/opencode/ocrvenv/bin/python", ["-u", "bench/rapid-json.py", file, "1600"], { timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  const j = JSON.parse(stdout) as { items: RapidItem[]; w: number; h: number };
  return { ...j, ms: Date.now() - t0 };
}

/** the confidence gate: is classical output sufficient to serve alone? */
function classicalSufficient(items: RapidItem[]): { ok: boolean; why: string } {
  if (items.length === 0) return { ok: false, why: "no items" };
  const conf = items.filter((i) => i.score >= 0.75);
  const mean = items.reduce((s, i) => s + i.score, 0) / items.length;
  const chars = items.reduce((s, i) => s + [...i.text].length, 0);
  if (conf.length < 3) return { ok: false, why: `only ${conf.length} confident items` };
  if (mean < 0.78) return { ok: false, why: `mean score ${mean.toFixed(2)}` };
  if (chars < 8) return { ok: false, why: `only ${chars} chars` };
  return { ok: true, why: `${conf.length} confident, mean ${mean.toFixed(2)}, ${chars} chars` };
}

/** classical lines: reading order + angle from box aspect (deterministic) */
function assembleClassical(items: RapidItem[], w: number, h: number): Line[] {
  const lines = items.map((i) => {
    const bw = i.box[2] - i.box[0];
    const bh = i.box[3] - i.box[1];
    const chars = [...i.text].length;
    const angle = bh > bw * 1.3 && chars > 1 ? 90 : 0;
    return { text: i.text, box: i.box, angle, source: "classical" as const };
  });
  const horizontal = lines.filter((l) => l.angle === 0);
  const vertical = lines.filter((l) => l.angle === 90);
  horizontal.sort((a, b) => (Math.abs(a.box[1] - b.box[1]) > (a.box[3] - a.box[1]) * 0.7 ? a.box[1] - b.box[1] : a.box[0] - b.box[0]));
  vertical.sort((a, b) => (Math.abs(b.box[0] - a.box[0]) > (b.box[2] - b.box[0]) * 0.7 ? b.box[0] - a.box[0] : a.box[1] - b.box[1]));
  return [...horizontal, ...vertical];
  void w; void h;
}

async function llm(file: string, dims: { w: number; h: number }): Promise<Line[]> {
  const b64 = readFileSync(file).toString("base64");
  const mime = file.endsWith(".png") ? "image/png" : "image/jpeg";
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: process.env.MODEL_CHAT ?? "default", temperature: 0, max_tokens: 8000,
      messages: [
        { role: "system", content: VECTOR_SYSTEM },
        { role: "user", content: [
          { type: "text", text: "Transcribe the Chinese text blocks." },
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
        ] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}`);
  const raw = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
  return parseOcrVectors(raw, dims).map((l) => ({
    text: l.text,
    box: l.box ?? [0, 0, 0, 0],
    angle: l.angle ?? 0,
    source: "llm" as const,
  }));
}

const DIMS: Record<string, { w: number; h: number }> = {
  "banner-insitu": { w: 3024, h: 4032 }, "poster-flat": { w: 750, h: 1000 },
  "letter-diagonal": { w: 3024, h: 4032 }, "wordcloud-color": { w: 695, h: 458 },
  "wordcloud-black": { w: 1125, h: 1104 }, "grid-handwriting": { w: 4032, h: 3024 },
  "curve-arc": { w: 1000, h: 700 }, "curve-s": { w: 1000, h: 900 },
};

async function main() {
  for (const fx of FIXTURES) {
    const t0 = Date.now();
    try {
      const cls = await classical(fx.file);
      const gate = classicalSufficient(cls.items);
      let lines: Line[];
      let servedBy: string;
      if (gate.ok) {
        lines = assembleClassical(cls.items, cls.w, cls.h);
        servedBy = "classical";
      } else {
        const llmLines = await llm(fx.file, DIMS[fx.name]!);
        lines = llmLines;
        servedBy = "llm";
      }
      const dt = Date.now() - t0;
      const all = lines.map((l) => l.text).join("");
      const dupes = lines.length - new Set(lines.map((l) => l.text)).size;
      const known = fx.known.filter((k) => all.includes(k)).length;
      const minKnown = (fx as { minKnown?: number }).minKnown ?? fx.known.length;
      const ok = fx.known.length ? known >= Math.min(minKnown, fx.known.length) : lines.length > 0;
      console.log(`${ok ? "ok  " : "FAIL"} ${fx.name}: served=${servedBy} (gate: ${gate.why}) lines=${lines.length} chars=${all.length} dupes=${dupes} known=${known}/${fx.known.length} cls=${cls.ms}ms total=${dt}ms`);
      for (const l of lines.slice(0, 4)) console.log(`     [${l.source}] ${l.text.slice(0, 30)}`);
    } catch (e) {
      console.log(`ERR  ${fx.name}: ${String(e).slice(0, 140)}`);
    }
  }
}
void main();
