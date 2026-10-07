// PROBE: can the vision model emit reliable from→to text-line vectors?
// Run BEFORE implementing the vector overlay. Usage: node bench/probe-vectors.mjs
// Fixtures: banner-in-situ (known text), flat poster (known text, upright),
// letter@45° (diagonal), word cloud (mixed per-word angles).
import { readFileSync } from "node:fs";

const BASE = process.env.OPENAI_API_BASE ?? "https://api.thekao.cloud/v1";
const KEY = process.env.OPENAI_API_KEY ?? "";

const VECTOR_SYSTEM = `You are an OCR engine. Find every block of Chinese text in the image. Return ONLY valid JSON, no prose:
{"items":[{"text":"…","from":[x1,y1],"to":[x2,y2]}]}
- from = point where the text block STARTS (start of its baseline); to = where it ENDS.
- Coordinates on a 0-1000 grid relative to the image (0,0 = top-left, 1000 = bottom-right).
- The from→to vector must run ALONG the text's own axis: horizontal text → left-to-right vector; vertical text → top-to-bottom; diagonal text → its actual diagonal. A single standalone word is its own small block.
- Text always reads from→to. Transcribe each block EXACTLY ONCE — never repeat text.`;

const BOX_SYSTEM = `You are an OCR engine for photos of Chinese text. Transcribe EVERY line of Han character text. Return ONLY valid JSON: {"items":[{"text":"…","box":[x1,y1,x2,y2],"dir":"h|v"}]}.`;

async function ask(system, file, maxTokens = 4000) {
  const b64 = readFileSync(file).toString("base64");
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
          { type: "image_url", image_url: { url: `data:${file.endsWith(".png") ? "image/png" : "image/jpeg"};base64,${b64}` } },
        ] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content ?? "";
}

// balanced-bracket JSON extraction (arrays or objects)
function extractJson(text) {
  const s = text.replace(/```(?:json)?/gi, "").replace(/```/g, "");
  const start = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((n) => n >= 0));
  if (!Number.isFinite(start)) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
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

const GRID = 1000;
function validateVectorItems(raw) {
  const parsed = extractJson(typeof raw === "string" ? raw : JSON.stringify(raw));
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const rows = [];
  let outOfGrid = 0, zeroLen = 0, dupes = 0;
  const seen = new Set();
  for (const it of items) {
    const text = typeof it.text === "string" ? it.text.trim() : "";
    const f = Array.isArray(it.from) ? it.from.map(Number) : null;
    const t = Array.isArray(it.to) ? it.to.map(Number) : null;
    if (!text || !f || !t || f.length !== 2 || t.length !== 2 || f.some((n) => !Number.isFinite(n))) continue;
    if (f.some((n) => n < -60 || n > 1060) || t.some((n) => n < -60 || n > 1060)) { outOfGrid++; continue; }
    const len = Math.hypot(t[0] - f[0], t[1] - f[1]);
    if (len < 3) { zeroLen++; continue; }
    if (seen.has(text)) { dupes++; continue; }
    seen.add(text);
    const angle = (Math.atan2(t[1] - f[1], t[0] - f[0]) * 180) / Math.PI;
    const chars = [...text].length;
    rows.push({ text, chars, len, angle: Math.round(angle), pitch: Math.round(len / chars) });
  }
  return { rows, outOfGrid, zeroLen, dupes, rawCount: items.length };
}

function angleReport(rows) {
  const hist = new Map();
  for (const r of rows) {
    // canonicalize: a line reading right-to-left upside down would show ~180; keep raw for diagnosis
    const bucket = Math.round(r.angle / 15) * 15;
    hist.set(bucket, (hist.get(bucket) ?? 0) + 1);
  }
  return [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([a, n]) => `${a}°×${n}`).join(" ");
}

function knownTextHits(rows, known) {
  const all = rows.map((r) => r.text).join("");
  const hits = known.filter((k) => all.includes(k));
  return { hits: hits.length, of: known.length, missing: known.filter((k) => !all.includes(k)) };
}

const FIXTURES = [
  { name: "banner-in-situ", file: "/workspace/uploads/574442ae-4a9d-4e22-9bf5-fb39cadd2cd6-IMG_4791.jpeg",
    known: ["亲近自然", "探索发现", "健康成长", "环保", "野营", "蘑菇", "团队"] },
  { name: "poster-flat", file: "/tmp/poster-upright.jpg",
    known: ["亲近自然", "探索发现", "健康成长", "环保", "野营", "蘑菇", "团队"] },
  { name: "letter-45deg", file: "/workspace/uploads/f66ffd78-cb2a-4ab5-876a-992a4e002f09-IMG_4900.jpeg",
    known: ["太傅", "虎符", "随元", "确凿", "密信", "禀"] },
  { name: "word-cloud-color", file: "/workspace/uploads/ef46aad1-1e3b-4830-942f-de6177c458c5-IMG_4913.png", known: [] },
  { name: "word-cloud-black", file: "/workspace/uploads/a5d058bc-1443-4796-8dfd-fce7522c526a-IMG_4914.jpeg", known: [] },
  { name: "grid-handwriting", file: "/workspace/uploads/692838d7-e6a5-41fb-82c0-c44f7f261d22-IMG_4915.jpeg", known: ["濂", "夔", "瀛", "遘", "繻"] },
  { name: "curve-arc", file: "/workspace/bench/images/curve-arc.png", known: ["床前明月光", "疑是地上霜"] },
  { name: "curve-s", file: "/workspace/bench/images/curve-s.png", known: ["舉頭望明月", "低頭思故鄉"] },
];

for (const fx of FIXTURES) {
  console.log(`\n=== ${fx.name} ===`);
  // vector contract
  try {
    const v = validateVectorItems(await ask(VECTOR_SYSTEM, fx.file));
    console.log(`vector: ${v.rows.length} blocks (raw ${v.rawCount}, dupes ${v.dupes}, off-grid ${v.outOfGrid}, zero-len ${v.zeroLen})`);
    console.log(`  angles: ${angleReport(v.rows) || "—"}`);
    const pitches = v.rows.map((r) => r.pitch).sort((a, b) => a - b);
    if (pitches.length) console.log(`  pitch px/char: median ${pitches[Math.floor(pitches.length / 2)]}, spread ${pitches[0]}–${pitches[pitches.length - 1]}`);
    if (fx.known.length) {
      const k = knownTextHits(v.rows, fx.known);
      console.log(`  known text: ${k.hits}/${k.of} found${k.missing.length ? " missing: " + k.missing.join(",") : ""}`);
    }
    console.log(`  sample: ${v.rows.slice(0, 4).map((r) => `${r.text}(${r.angle}°,${r.pitch}px)`).join(" | ")}`);
  } catch (e) { console.log("vector FAILED:", String(e).slice(0, 120)); }
  // box contract (text quality comparison)
  try {
    const b = extractJson(await ask(BOX_SYSTEM, fx.file, 3000));
    const texts = (b?.items ?? []).map((i) => String(i.text ?? "")).filter(Boolean);
    const all = texts.join("");
    const kd = fx.known.length ? fx.known.filter((k) => all.includes(k)).length : "-";
    console.log(`box:    ${texts.length} lines, known ${kd}/${fx.known.length || "-"}`);
  } catch (e) { console.log("box FAILED:", String(e).slice(0, 120)); }
}
