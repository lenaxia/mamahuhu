// POC: FUSION — classical boxes for WHERE + LLM text/angles for WHAT/HOW.
// Run: npx tsx bench/ocr-fuse.ts <fixture>
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseOcrVectors } from "../src/server/llm";
import { VECTOR_SYSTEM } from "./ocr-vectors";

const run = promisify(execFile);
const BASE = process.env.OPENAI_API_BASE ?? "https://ai.thekao.cloud/v1";
const KEY = process.env.OPENAI_API_KEY ?? "";

async function classical(file: string) {
  const { stdout } = await run("/tmp/opencode/ocrvenv/bin/python", ["-u", "bench/rapid-json.py", file, "1600"], { timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout) as { items: { box: [number, number, number, number]; text: string; score: number }[]; w: number; h: number };
}

async function llmLines(file: string, dims: { w: number; h: number }) {
  const b64 = readFileSync(file).toString("base64");
  const mime = file.endsWith(".png") ? "image/png" : "image/jpeg";
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: "default", temperature: 0, max_tokens: 8000, messages: [
      { role: "system", content: VECTOR_SYSTEM },
      { role: "user", content: [
        { type: "text", text: "Transcribe the Chinese text blocks." },
        { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
      ] },
    ] }),
  });
  const raw = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
  return parseOcrVectors(raw, dims);
}

interface FusedWord { text: string; box: [number, number, number, number]; angle: number; source: "classical" | "census" }

function fuse(
  classicalItems: { box: [number, number, number, number]; text: string; score: number }[],
  llm: { text: string; from?: [number, number]; to?: [number, number]; angle?: number }[],
): FusedWord[] {
  const out: FusedWord[] = [];
  for (const line of llm) {
    if (!line.from || !line.to || line.angle === undefined) continue;
    const chars = [...line.text];
    const len = Math.hypot(line.to[0]! - line.from[0]!, line.to[1]! - line.from[1]!);
    const pitch = len / Math.max(1, chars.length);
    const ux = (line.to[0]! - line.from[0]!) / len;
    const uy = (line.to[1]! - line.from[1]!) / len;

    // for each char in the LLM line, find the nearest classical box
    for (let i = 0; i < chars.length; i++) {
      const cx = line.from[0]! + ux * (i + 0.5) * pitch;
      const cy = line.from[1]! + uy * (i + 0.5) * pitch;
      // nearest classical box whose center is within 2×pitch
      let best: { box: [number, number, number, number]; text: string; score: number } | null = null;
      let bestDist = Infinity;
      for (const ci of classicalItems) {
        const bx = (ci.box[0]! + ci.box[2]!) / 2;
        const by = (ci.box[1]! + ci.box[3]!) / 2;
        const d = Math.hypot(bx - cx, by - cy);
        if (d < bestDist && d < pitch * 2) { bestDist = d; best = ci; }
      }
      if (best) {
        out.push({ text: chars[i]!, box: best.box, angle: line.angle, source: "classical" });
      } else {
        // no classical anchor — synthesize from the LLM position (approximate)
        const half = pitch / 2;
        out.push({ text: chars[i]!, box: [Math.round(cx - half), Math.round(cy - half), Math.round(cx + half), Math.round(cy + half)], angle: line.angle, source: "census" });
      }
    }
  }
  return out;
}

async function main() {
  const file = process.argv[2] ?? "bench/fixtures/letter-4920.jpg";
  const cls = await classical(file);
  const llm = await llmLines(file, { w: cls.w, h: cls.h });
  const fused = fuse(cls.items, llm);
  const classicalCount = fused.filter((f) => f.source === "classical").length;
  const censusCount = fused.filter((f) => f.source === "census").length;
  // group by angle to reconstruct lines
  const byAngle = new Map<number, FusedWord[]>();
  for (const f of fused) {
    const list = byAngle.get(f.angle) ?? [];
    list.push(f);
    byAngle.set(f.angle, list);
  }
  console.log(`classical items: ${cls.items.length}, LLM lines: ${llm.length}, fused words: ${fused.length} (${classicalCount} classical-anchored, ${censusCount} synthesized)`);
  for (const [angle, words] of byAngle) {
    const text = words.map((w) => w.text).join("");
    const boxes = words.filter((w) => w.source === "classical").map((w) => w.box);
    const sizes = boxes.map((b) => Math.max(b[2] - b[0], b[3] - b[1]));
    const sizeStr = sizes.length ? ` sizes:${Math.min(...sizes)}-${Math.max(...sizes)}px` : "";
    console.log(`  ${angle}° ${text.slice(0, 20)} (${words.filter((w) => w.source === "classical").length}/${words.length} anchored${sizeStr})`);
  }
}
void main();
