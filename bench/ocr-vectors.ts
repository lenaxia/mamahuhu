// OCR vector-contract QUALITY harness — regression gates over bench/fixtures.
// Runs against the live gateway (needs OPENAI_API_*); NOT part of CI.
//   node bench/ocr-vectors.mjs            → run, compare vs baseline.json, exit 1 on regression
//   node bench/ocr-vectors.mjs --update   → re-record baseline.json (raw outputs included)
// CI coverage lives in tests/unit/ocr-baseline.test.ts, which replays the
// recorded raw outputs through the app's own extractJson — no gateway needed.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const BASE = process.env.OPENAI_API_BASE ?? "https://api.thekao.cloud/v1";
const KEY = process.env.OPENAI_API_KEY ?? "";

export const VECTOR_SYSTEM = `You are an OCR engine. Find every block of Chinese text in the image. Return ONLY valid JSON, no prose:
{"items":[{"text":"…","from":[x1,y1],"to":[x2,y2]}]}
- from = point where the text block STARTS (start of its baseline); to = where it ENDS.
- Coordinates on a 0-1000 grid relative to the image (0,0 = top-left, 1000 = bottom-right).
- The from→to vector must run ALONG the text's own axis: horizontal text → left-to-right vector; vertical text → top-to-bottom; diagonal text → its actual diagonal. A single standalone word is its own small block.
- TEXT ON A CURVE: split it into SHORT consecutive blocks (3-5 characters each), each block following the LOCAL direction of the curve at that point.
- Text always reads from→to. Transcribe each block EXACTLY ONCE — never repeat text.`;

export const FIXTURES = [
  { name: "banner-insitu", file: "bench/fixtures/banner-insitu.jpg",
    known: ["亲近自然", "探索发现", "健康成长", "环保", "野营", "蘑菇", "团队"],
    minBlocks: 5, maxDupes: 2 },
  { name: "poster-flat", file: "bench/fixtures/poster-flat.jpg",
    known: ["亲近自然", "探索发现", "健康成长", "环保", "野营", "蘑菇", "团队"],
    minBlocks: 8, maxDupes: 1 },
  { name: "letter-diagonal", file: "bench/fixtures/letter-diagonal.jpg",
    known: ["太傅", "虎符", "随元", "确凿", "密信"],
    minBlocks: 4, maxDupes: 1, minKnown: 3 }, // brush script: hardest text fixture, run variance
  { name: "wordcloud-color", file: "bench/fixtures/wordcloud-color.png",
    known: [], minBlocks: 40, maxDupes: 40 }, // repeats are GENUINE in word clouds — no dedupe gate
  { name: "wordcloud-black", file: "bench/fixtures/wordcloud-black.jpg",
    known: [], minBlocks: 0, maxDupes: 0 }, // honest-zero fixture: gates are structural only
  { name: "grid-handwriting", file: "bench/fixtures/grid-handwriting.jpg",
    known: ["則", "崩", "奠", "侗", "合"], minBlocks: 4, maxDupes: 1 },
  { name: "curve-arc", file: "bench/fixtures/curve-arc.png",
    known: ["床前明月光", "疑是地上霜"], minBlocks: 1, maxDupes: 0 },
  { name: "curve-s", file: "bench/fixtures/curve-s.png",
    known: ["舉頭望明月", "低頭思故鄉"], minBlocks: 1, maxDupes: 0 },
];

async function ask(system: string, file: string, maxTokens = 4000): Promise<string> {
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

export function validateVectorItems(raw: string): { rows: VectorRow[]; dupes: number; offGrid: number; zeroLen: number; rawCount: number } {
  const parsed = extractJsonBalanced(raw) as { items?: { text?: unknown; from?: unknown; to?: unknown }[] } | { text?: unknown; from?: unknown; to?: unknown }[] | null;
  // the model emits EITHER {"items":[…]} OR a bare top-level array — accept both
  const items = Array.isArray(parsed) ? parsed : (parsed && Array.isArray((parsed as { items?: unknown[] }).items) ? (parsed as { items: { text?: unknown; from?: unknown; to?: unknown }[] }).items : []);
  const rows: VectorRow[] = [];
  let outOfGrid = 0, zeroLen = 0, dupes = 0, offGrid = 0;
  const seen = new Set<string>();
  for (const it of items) {
    const text = typeof it.text === "string" ? it.text.trim() : "";
    const f = Array.isArray(it.from) ? (it.from as number[]).map(Number) : null;
    const t = Array.isArray(it.to) ? (it.to as number[]).map(Number) : null;
    if (!text || !f || !t || f.length !== 2 || t.length !== 2 || [...f, ...t].some((n) => !Number.isFinite(n))) continue;
    if ([...f, ...t].some((n) => n < -60 || n > 1060)) { outOfGrid++; continue; }
    const len = Math.hypot(t[0]! - f[0]!, t[1]! - f[1]!);
    if (len < 3) { zeroLen++; continue; }
    if (seen.has(text)) { dupes++; continue; }
    seen.add(text);
    const angle = Math.round((Math.atan2(t[1]! - f[1]!, t[0]! - f[0]!) * 180) / Math.PI);
    const chars = [...text].length;
    rows.push({ text, chars, len, angle, pitch: Math.round(len / chars), from: [f[0]!, f[1]!] as [number, number], to: [t[0]!, t[1]!] as [number, number] });
  }
  return { rows, dupes, offGrid, zeroLen, rawCount: items.length };
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
    const v = validateVectorItems(raw);
    const hits = fx.known.length ? knownHits(v.rows, fx.known) : null;
    const problems: string[] = [];
    if (v.rows.length < fx.minBlocks) problems.push(`blocks ${v.rows.length} < ${fx.minBlocks}`);
    if (v.dupes > fx.maxDupes) problems.push(`dupes ${v.dupes} > ${fx.maxDupes}`);
    const knownFloor = (fx as { minKnown?: number }).minKnown ?? fx.known.length - 1;
    if (hits !== null && hits < knownFloor) problems.push(`known ${hits}/${fx.known.length} < floor ${knownFloor}`);
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
