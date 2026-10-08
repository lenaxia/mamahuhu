// FUSION v2 MATRIX — fragment-inventory fusion over fixture caches.
// Data: /tmp/opencode/fusion-cache/<name>.{classical,structure}.json
// (classical: local venv rapid-json.py; structure: STRUCTURE prompt v2 —
// unchanged). Routing-level regression coverage with committed fixtures
// lives in tests/unit/ocr-routing.test.ts (CI); this is the live bench.
// Run: npx tsx bench/ocr-structure.ts [fixture ...]
import { readFileSync, existsSync } from "node:fs";
import { fuseStructure, parseStructureLines, type ClassicalItem } from "../src/server/ocr-fusion";

const CACHE = "/tmp/opencode/fusion-cache";

const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const all = names.length ? names : ["letter-diagonal", "poster-flat", "grid-handwriting", "grid-poem-h", "grid-poem-v", "banner-insitu", "wordcloud-color", "curve-arc", "curve-s"];

const summary: { name: string; lines: number; improved: number; inferred: number; dropped: number; chars: number }[] = [];

for (const name of all) {
  const base = name.replace(/[bc]$/, "");
  const cPath = `${CACHE}/${base}.classical.json`, sPath = `${CACHE}/${name}.structure.json`;
  if (!existsSync(cPath) || !existsSync(sPath)) { console.log(`skip ${name}: missing cache`); continue; }
  const classical = JSON.parse(readFileSync(cPath, "utf8")) as { items: ClassicalItem[]; w: number; h: number };
  const llm = parseStructureLines(readFileSync(sPath, "utf8"));
  const res = fuseStructure(classical.items ?? [], llm, { w: classical.w, h: classical.h });

  console.log(`\n=== ${name} — classical ${classical.items?.length ?? 0} items, LLM ${llm.length} lines ===`);
  let improved = 0, inferred = 0;
  for (const l of res.lines) {
    if (l.improved) improved++;
    if (l.inferred) inferred++;
    console.log(`  ${l.inferred ? "infer" : "frag "}${String(l.angle).padStart(4)}° ${l.text.slice(0, 28).padEnd(28)}${l.improved ? " <-LLM" : ""}`);
  }
  if (res.droppedLines.length) console.log(`  dropped dup readings (${res.droppedLines.length}): ${res.droppedLines.map((d) => d.text.slice(0, 12)).join(" | ")}`);
  summary.push({ name, lines: res.lines.length, improved, inferred, dropped: res.droppedLines.length, chars: res.lines.reduce((a, l) => a + l.chars.length, 0) });
}

console.log(`\n${"fixture".padEnd(20)} ${"lines".padStart(5)} ${"impr".padStart(5)} ${"infer".padStart(5)} ${"drop".padStart(4)}  chars`);
for (const x of summary) console.log(`${x.name.padEnd(20)} ${String(x.lines).padStart(5)} ${String(x.improved).padStart(5)} ${String(x.inferred).padStart(5)} ${String(x.dropped).padStart(4)}  ${x.chars}`);
