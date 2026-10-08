// OCR vector-contract QUALITY harness — regression gates over bench/fixtures.
// Runs against the live gateway (needs OPENAI_API_*); NOT part of CI.
//   node bench/ocr-vectors.mjs            → run, compare vs baseline.json, exit 1 on regression
//   node bench/ocr-vectors.mjs --update   → re-record baseline.json (raw outputs included)
// CI coverage lives in tests/unit/ocr-baseline.test.ts, which replays the
// recorded raw outputs through the app's own extractJson — no gateway needed.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseOcrVectors } from "../src/server/llm";

const BASE = process.env.OPENAI_API_BASE ?? "https://api.thekao.cloud/v1";
const KEY = process.env.OPENAI_API_KEY ?? "";

export const VECTOR_SYSTEM = `You are an OCR engine. Find every block of Chinese text in the image. Return ONLY valid JSON, no prose:
{"items":[{"text":"…","box":[x1,y1,x2,y2],"from":[x1,y1],"to":[x2,y2]}]}
- box = tight axis-aligned rectangle around the text block. from = start of the text baseline, to = its end.
- Coordinates on a 0-1000 grid relative to the image (0,0 = top-left, 1000 = bottom-right).
- The from→to vector runs ALONG the text's own axis: horizontal left-to-right, vertical top-to-bottom, diagonal its actual diagonal.
- ONE item per VISUAL line — never merge lines that print on separate rows.
- Text reads from→to. Transcribe each block EXACTLY ONCE — never repeat text.`;

interface Fixture { name: string; file: string; known: string[]; minBlocks: number; maxDupes: number; minKnown?: number; dims?: { w: number; h: number } }

export const FIXTURES: Fixture[] = [
  { name: "banner-insitu", file: "bench/fixtures/banner-insitu.jpg", dims: { w: 3024, h: 4032 },
    known: ["亲近自然", "探索发现", "健康成长", "环保", "野营", "蘑菇", "团队"],
    minBlocks: 5, maxDupes: 2 },
  { name: "poster-flat", file: "bench/fixtures/poster-flat.jpg", dims: { w: 750, h: 1000 },
    known: ["亲近自然", "探索发现", "健康成长", "环保", "野营", "蘑菇", "团队"],
    minBlocks: 8, maxDupes: 1 },
  { name: "letter-diagonal", file: "bench/fixtures/letter-diagonal.jpg", dims: { w: 3024, h: 4032 },
    known: ["太傅", "虎符", "随元", "确凿", "密信"],
    minBlocks: 4, maxDupes: 1, minKnown: 3 }, // brush script: hardest text fixture, run variance
  { name: "wordcloud-color", file: "bench/fixtures/wordcloud-color.png", dims: { w: 695, h: 458 },
    known: [], minBlocks: 40, maxDupes: 40 }, // repeats are GENUINE in word clouds — no dedupe gate
  { name: "wordcloud-black", file: "bench/fixtures/wordcloud-black.jpg", dims: { w: 1125, h: 1104 },
    known: [], minBlocks: 0, maxDupes: 40 }, // honest-zero floor; repeats GENUINE in word clouds → no dedupe gate (same as color). Gate 0 was set pre-truncation-salvage when this yielded ~0 blocks — a surviving 2× repeat is not the 11× loop signature. RapidOCR-excluded (sandbox OOM)
  { name: "grid-handwriting", file: "bench/fixtures/grid-handwriting.jpg", dims: { w: 4032, h: 3024 },
    known: ["則", "崩", "奠", "侗", "合"], minBlocks: 4, maxDupes: 1 },
  { name: "curve-arc", file: "bench/fixtures/curve-arc.png", dims: { w: 1000, h: 700 },
    known: ["床前明月光", "疑是地上霜"], minBlocks: 1, maxDupes: 0 },
  { name: "curve-s", file: "bench/fixtures/curve-s.png", dims: { w: 1000, h: 900 },
    known: ["舉頭望明月", "低頭思故鄉"], minBlocks: 1, maxDupes: 0 },
];

async function ask(system: string, file: string, maxTokens = 8000): Promise<string> {
  const b64 = readFileSync(file).toString("base64");
  const mime = file.endsWith(".png") ? "image/png" : "image/jpeg";
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: process.env.MODEL_CHAT ?? "default",
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: [
          { type: "text", text: "Transcribe the Chinese text blocks." },
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
        ] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content ?? "";
}

/** balanced-bracket JSON extraction — mirrors src/server/llm.ts extractJson */
export function extractJsonBalanced(text: string): unknown {
  const s = text.replace(/```(?:json)?/gi, "").replace(/```/g, "");
  const starts = [s.indexOf("{"), s.indexOf("[")].filter((n) => n >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } }
    }
  }
  return null;
}

export interface VectorRow { text: string; chars: number; len: number; angle: number; pitch: number; from: [number, number]; to: [number, number] }

export function validateVectorItems(raw: string, dims?: { w: number; h: number }): { rows: VectorRow[]; dupes: number; offGrid: number; zeroLen: number; rawCount: number } {
  // single source of truth: the APP parser (shape tolerance + salvage + chaining)
  // dims REQUIRED in the runner so grid→pixel conversion is exercised — the
  // twice-bitten coordinate-space bug class hides when dims are null
  const lines = parseOcrVectors(raw, dims ?? null);
  const rows: VectorRow[] = [];
  let dupes = 0;
  const seen = new Set<string>();
  for (const ln of lines) {
    if (seen.has(ln.text)) { dupes++; continue; }
    seen.add(ln.text);
    if (!ln.from || !ln.to) continue;
    const f = ln.from;
    const t = ln.to;
    const len = Math.hypot(t[0] - f[0], t[1] - f[1]);
    rows.push({ text: ln.text, chars: [...ln.text].length, len, angle: ln.angle ?? 0, pitch: Math.round(len / Math.max(1, [...ln.text].length)), from: f, to: t });
  }
  return { rows, dupes, offGrid: 0, zeroLen: 0, rawCount: lines.length };
}

function knownHits(rows: VectorRow[], known: string[]): number {
  const all = rows.map((r) => r.text).join("");
  return known.filter((k) => all.includes(k)).length;
}

const BASELINE = "bench/fixtures/baseline.json";
const isMain = process.argv[1]?.replace(/\.(mjs|ts)$/, "").endsWith("ocr-vectors");
if (isMain) {
  const update = process.argv.includes("--update");
  const prev = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
  let failed = 0;
  const recorded: Record<string, unknown> = {};
  for (const fx of FIXTURES) {
    const raw = await ask(VECTOR_SYSTEM, fx.file);
    const v = validateVectorItems(raw, fx.dims);
    // geometry sanity: with dims, rows must live in pixel space and span the image
    const geo = fx.dims && v.rows.length ? (() => {
      const xs = v.rows.flatMap((r) => [r.from[0], r.to[0]]);
      const ys = v.rows.flatMap((r) => [r.from[1], r.to[1]]);
      const spanX = Math.max(...xs) - Math.min(...xs);
      const spanY = Math.max(...ys) - Math.min(...ys);
      const inBounds = [...xs, ...ys].every((n) => n >= -100 && n <= Math.max(fx.dims!.w, fx.dims!.h) * 1.1);
      return { inBounds, coverage: Math.max(spanX / fx.dims!.w, spanY / fx.dims!.h) };
    })() : null;
    const hits = fx.known.length ? knownHits(v.rows, fx.known) : null;
    const problems: string[] = [];
    if (v.rows.length < fx.minBlocks) problems.push(`blocks ${v.rows.length} < ${fx.minBlocks}`);
    if (v.dupes > fx.maxDupes) problems.push(`dupes ${v.dupes} > ${fx.maxDupes}`);
    const knownFloor = (fx as { minKnown?: number }).minKnown ?? fx.known.length - 1;
    if (hits !== null && hits < knownFloor) problems.push(`known ${hits}/${fx.known.length} < floor ${knownFloor}`);
    if (geo && !geo.inBounds) problems.push(`coordinates escape pixel bounds (grid/pixel bug)`);
    if (geo && geo.coverage < 0.25) problems.push(`lines cover only ${(geo.coverage * 100).toFixed(0)}% of the image — likely top-left collapse`);
    if (!update && prev[fx.name]) {
      const p = prev[fx.name] as { blocks: number };
      if (v.rows.length < Math.max(fx.minBlocks, Math.floor(p.blocks * 0.7))) problems.push(`regression vs baseline ${v.rows.length} < 70% of ${p.blocks}`);
    }
    recorded[fx.name] = { blocks: v.rows.length, dupes: v.dupes, known: hits, angles: [...new Set(v.rows.map((r) => r.angle))].slice(0, 6), raw };
    const status = problems.length ? "FAIL " : "ok   ";
    if (problems.length) failed++;
    console.log(`${status}${fx.name}: ${v.rows.length} blocks, dupes ${v.dupes}${hits !== null ? `, known ${hits}/${fx.known.length}` : ""}${problems.length ? "  ← " + problems.join("; ") : ""}`);
  }
  if (update) {
    writeFileSync(BASELINE, JSON.stringify(recorded, null, 2));
    console.log("baseline.json updated (raw outputs recorded for CI replay)");
  }
  process.exit(failed ? 1 : 0);
}
