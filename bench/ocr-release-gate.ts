// RELEASE GATE — pipeline v2, the app-exact seam: the real letter photo through
// the production service (normalizeImage → det sidecar → rectify → crop reads),
// asserted against the owner-confirmed traditional truth baseline.
// Run: npx tsx bench/ocr-release-gate.ts   (needs: local det sidecar on :8001, gateway key)
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { GatewayOcrService } from "../src/server/llm";
import { PipelineOcrService } from "../src/server/ocr-pipeline";

const base = process.env.OPENAI_API_BASE!, key = process.env.OPENAI_API_KEY!;
const detUrl = process.env.OCR_DET_URL ?? "http://localhost:8001/det";
const svc = new PipelineOcrService({ detUrl, base, key, model: "default", fallback: new GatewayOcrService({ base, key, model: "default" }) });

const truth = JSON.parse(readFileSync("bench/fixtures/ladder/letter-diagonal.truth-trad.json", "utf8")) as {
  lines: string[]; charCounts: number[]; minLineCount: number;
};
const phrasesTrad = JSON.parse(readFileSync("bench/fixtures/pipeline2/phrases-trad.json", "utf8")) as Record<string, string[]>;

const count = (t: string) => { const m: Record<string, number> = {}; for (const c of t) m[c] = (m[c] ?? 0) + 1; return m; };
const sim = (a: string, b: string) => { const ca = count(a), cb = count(b); let hit = 0; for (const c in cb) hit += Math.min(ca[c] ?? 0, cb[c] ?? 0); return hit / Math.max(1, [...b].length); };

let fail = 0;
async function gate(name: string, path: string, phrases: string[], opts: { minLines?: number; floor: number }) {
  const bytes = await sharp(path).rotate().jpeg({ quality: 88 }).toBuffer();
  const res = await svc.extract(new File([new Uint8Array(bytes)], "p.jpg", { type: "image/jpeg" }));
  if (!res.ok) { console.log(`FAIL ${name}: ${res.error}`); fail++; return; }
  const { lines, servedBy } = res.value as { lines: { text: string; charBoxes?: [number,number,number,number][] }[]; servedBy?: string };
  console.log(`\n${name}: servedBy=${servedBy} lines=${lines.length}`);
  for (const l of lines) console.log(`  (${l.text.length}) ${l.text.replace(/\n/g, "⏎").slice(0, 30)}`);
  const A = lines.map((l) => l.text.replace(/\s+/g, "")).join("");
  const s = sim(A, phrases.join(""));
  if (servedBy !== "pipeline2") { console.log(`FAIL ${name}: servedBy=${servedBy} (pipeline2 required)`); fail++; }
  if (opts.minLines && lines.length < opts.minLines) { console.log(`FAIL ${name}: ${lines.length} < ${opts.minLines} lines`); fail++; }
  if (s < opts.floor) { console.log(`FAIL ${name}: overlap ${(s * 100).toFixed(0)}% < ${(opts.floor * 100).toFixed(0)}% floor`); fail++; }
  else console.log(`${name} SCORE: overlap ${(s * 100).toFixed(0)}% (floor ${(opts.floor * 100).toFixed(0)}%)`);
  // duplicate lines sanity
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const a = lines[i]!.text, b = lines[j]!.text;
    if (a.length >= 8 && b.length >= 8 && sim(a, b) >= 0.85) { console.log(`FAIL ${name}: duplicate lines ${i}/${j}`); fail++; }
  }
}

await gate("letter-diagonal", "bench/fixtures/letter-diagonal.jpg", truth.lines, { minLines: 9, floor: 0.60 });
await gate("poster-flat", "bench/fixtures/poster-flat.jpg", phrasesTrad["poster-flat"]!, { minLines: 12, floor: 0.80 });
console.log(fail === 0 ? "\nPASS" : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
