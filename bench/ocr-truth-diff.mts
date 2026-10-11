/** END-TO-END output acceptance: run the real pipeline on a photo and diff
 *  the served lines against its truth file, IN READING ORDER. Usage:
 *    npx tsx bench/ocr-truth-diff.mts <photo> <truth.json> [runs]
 *  Match: a truth line is covered by one served line (or the concatenation
 *  of two consecutive served lines — split columns) at charSim ≥ 0.6;
 *  alignment is monotonic (each match must not move backward). Exit 1 on
 *  any run failing. Requires the det sidecar (OCR_DET_URL or localhost:8800)
 *  and gateway env. The check that would have caught 0.11.6–0.11.8's
 *  placement bugs before they shipped. */
import { readFileSync } from "node:fs";
import { PipelineOcrService } from "../src/server/ocr-pipeline";
import { GatewayOcrService } from "../src/server/llm";
import { charSim } from "../src/server/ocr-geometry";

const [photo, truthPath, runsArg] = process.argv.slice(2) as [string, string, string | undefined];
const runs = Number(runsArg ?? 1);
if (!photo || !truthPath) { console.error("usage: ocr-truth-diff.mts <photo> <truth.json> [runs]"); process.exit(2); }
const truth = (JSON.parse(readFileSync(truthPath, "utf8")) as { lines: string[] }).lines;
const base = process.env.OPENAI_API_BASE ?? "https://api.openai.com/v1";
const key = process.env.OPENAI_API_KEY ?? "";
const model = process.env.MODEL_VISION ?? "default";
const svc = new PipelineOcrService({
  detUrl: process.env.OCR_DET_URL ?? "http://127.0.0.1:8800/det",
  base, key, model, fallback: new GatewayOcrService({ base, key, model }),
});

let failures = 0;
for (let run = 1; run <= runs; run++) {
  const res = await svc.extract(new File([readFileSync(photo)], "p.jpg", { type: "image/jpeg" }));
  if (!res.ok) { console.log(`run ${run}: EXTRACT FAILED ${res.error}`); failures++; continue; }
  const served = res.value.lines.map((l) => l.text);
  // monotonic alignment: for each truth line, scan forward from the last
  // match position for a served line (or a 2-concat) covering it
  let si = 0, miss = 0;
  const report: string[] = [];
  for (const t of truth) {
    let hit = -1, span = 1;
    for (let i = si; i < served.length; i++) {
      if (charSim(served[i]!, t) >= 0.6) { hit = i; span = 1; break; }
      if (i + 1 < served.length && charSim(served[i]! + served[i + 1]!, t) >= 0.6) { hit = i; span = 2; break; }
    }
    if (hit < 0) { miss++; report.push(`  ✗ "${t.slice(0, 16)}"`); }
    else { report.push(`  ✓ ${span === 2 ? "[merged] " : ""}"${t.slice(0, 16)}" ← ${span === 2 ? served[hit]!.slice(0, 10) + "+" + served[hit + 1]!.slice(0, 10) : served[hit]!.slice(0, 20)}`); si = hit + span; }
  }
  console.log(`run ${run}: ${truth.length - miss}/${truth.length} truth lines in order ${miss === 0 ? "PASS" : "FAIL"}`);
  if (miss > 0) { failures++; for (const r of report.filter((x) => x.includes("✗"))) console.log(r); }
}
process.exit(failures > 0 ? 1 : 0);
