// POC: STRUCTURE FUSION — LLM returns text + structure (direction, gaps),
// classical provides precise boxes, deterministic matching assembles them.
// Run: npx tsx bench/ocr-structure.ts <fixture>
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const BASE = process.env.OPENAI_API_BASE ?? "https://ai.thekao.cloud/v1";
const KEY = process.env.OPENAI_API_KEY ?? "";

// NEW prompt: no coordinates, just text + direction + gap markers
const STRUCTURE_SYSTEM = `"""You are an OCR reader. Transcribe every PHYSICAL line or column of Chinese text, one at a time.
Return ONLY valid JSON: {"lines":[{"n":1,"text":"…","dir":"h"|"v"}]}
Rules:
- Each physical line/column = one entry, numbered sequentially (n:1, n:2, ...)
- "text": ONLY the characters you read, max 20 per line. If a line is longer, split it.
- If there's a visible gap within a line (space, seal, stamp), insert ⟪N⟫ where N = gap in char-widths.
- "dir": "h" horizontal, "v" vertical/near-vertical.
- Read each line EXACTLY ONCE. Count the lines you see — stop when you've transcribed them all."""`;

async function classical(file: string) {
  const { stdout } = await run("/tmp/opencode/ocrvenv/bin/python", ["-u", "bench/rapid-json.py", file, "1600"], { timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout) as { items: { box: [number, number, number, number]; text: string; score: number }[]; w: number; h: number };
}

async function llmStructure(file: string): Promise<{ text: string; dir: "h" | "v" }[]> {
  const b64 = readFileSync(file).toString("base64");
  const mime = file.endsWith(".png") ? "image/png" : "image/jpeg";
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: "default", temperature: 0, max_tokens: 4000, messages: [
      { role: "system", content: STRUCTURE_SYSTEM },
      { role: "user", content: [
        { type: "text", text: "Transcribe the Chinese text lines." },
        { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
      ] },
    ] }),
  });
  const raw = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
  // parse (accept both wrapped and bare)
  const start = Math.min(...[raw.indexOf("{"), raw.indexOf("[")].filter((n) => n >= 0));
  if (!Number.isFinite(start)) return [];
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]!;
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth === 0) { try { const p = JSON.parse(raw.slice(start, i + 1)); return Array.isArray(p) ? p : p.lines ?? []; } catch { return []; } } }
  }
  return [];
}

// deterministic matching: assign LLM text chars to classical boxes
interface MatchedChar { char: string; box?: [number, number, number, number]; gapBefore?: number; interpolated: boolean }

function matchLine(
  text: string,
  dir: "h" | "v",
  allBoxes: { box: [number, number, number, number]; text: string; score: number }[],
  usedBoxes: Set<number>,
): MatchedChar[] {
  // parse gap markers: "密呈太傅⟪2⟫大人的鈎座" → [{char:"密"},...,{gap:2},...]
  const parts: { char?: string; gap?: number }[] = [];
  for (const m of text.matchAll(/⟪(\d+)⟫|(.[^⟪]*)/g)) {
    if (m[1]) parts.push({ gap: parseInt(m[1]) });
    else if (m[2]) for (const ch of m[2]) parts.push({ char: ch });
  }
  const chars = parts.filter((p) => p.char).map((p) => p.char!);
  const gaps = parts.filter((p) => p.gap).map((p) => p.gap!);

  // find unused classical boxes that could belong to this line
  // heuristic: group boxes by proximity in the line's direction
  // for now: greedy nearest-match preserving order
  const result: MatchedChar[] = [];
  const available = allBoxes.map((b, i) => ({ ...b, idx: i })).filter((b) => !usedBoxes.has(b.idx));

  // compute line pitch from available boxes (median box size)
  const sizes = available.map((b) => dir === "v" ? b.box[3] - b.box[1] : b.box[2] - b.box[0]).filter((s) => s > 5);
  const pitch = sizes.length ? sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)] : 40;

  // sort available boxes by position along the reading direction
  if (dir === "v") available.sort((a, b) => a.box[1] - b.box[1]);
  else available.sort((a, b) => a.box[0] - b.box[0]);

  // greedy sequential assignment: for each char, find the nearest unused box
  // whose position is ahead of the previous match
  let lastPos = available.length ? (dir === 'v' ? available[0]!.box[1] : available[0]!.box[0]) : -Infinity;
  let gapPending = 0;
  for (const part of parts) {
    if (part.gap) { gapPending += part.gap; continue; }
    const ch = part.char!;
    // find best box: ahead of lastPos, within reasonable distance
    let best: { box: [number, number, number, number]; idx: number } | null = null;
    let bestDist = Infinity;
    for (const av of available) {
      const pos = dir === "v" ? av.box[1] : av.box[0];
      if (pos <= lastPos) continue; // must be ahead
      const d = pos - lastPos;
      if (d < bestDist && d < pitch * 4) { bestDist = d; best = av; }
    }
    if (best) {
      usedBoxes.add(best.idx);
      result.push({ char: ch, box: best.box, interpolated: false });
      lastPos = dir === "v" ? best.box[3] : best.box[2];
      gapPending = 0;
    } else {
      // no anchor — estimate position from pitch
      const estimated = lastPos + pitch * (1 + gapPending);
      const half = pitch / 2;
      const center = estimated + half;
      const box: [number, number, number, number] = dir === "v"
        ? [Math.round(center - half), Math.round(lastPos + gapPending * pitch), Math.round(center + half), Math.round(lastPos + (gapPending + 1) * pitch)]
        : [Math.round(lastPos + gapPending * pitch), Math.round(center - half), Math.round(lastPos + (gapPending + 1) * pitch), Math.round(center + half)];
      result.push({ char: ch, box, interpolated: true });
      lastPos = dir === "v" ? box[3] : box[2];
      gapPending = 0;
    }
  }
  return result;
}

async function main() {
  const file = process.argv[2] ?? "bench/fixtures/letter-4920.jpg";
  const [cls, llm] = await Promise.all([classical(file), llmStructure(file)]);
  console.log(`classical: ${cls.items.length} items, LLM: ${llm.length} lines`);

  const usedBoxes = new Set<number>();
  for (const line of llm) {
    const matched = matchLine(line.text, line.dir, cls.items, usedBoxes);
    const anchored = matched.filter((m) => !m.interpolated).length;
    const text = matched.map((m) => m.char).join("");
    const gaps = (line.text.match(/⟪\d+⟫/g) ?? []).length;
    console.log(`  [${line.dir}] ${text.slice(0, 24)} (${anchored}/${matched.length} anchored, ${gaps} gaps)`);
  }
}
void main();
