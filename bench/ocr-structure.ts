// STRUCTURE-FUSION matrix driver — real fixtures through src/server/ocr-fusion.
// Data: /tmp/opencode/fusion-cache/<name>.{classical,structure}.json
//   classical:  /tmp/opencode/ocrvenv/bin/python bench/rapid-json.py <img> 1600
//   structure:  LLM STRUCTURE_SYSTEM prompt (prompt v2 — unchanged; no prompt
//               iteration happens here, matcher work only)
// Run: npx tsx bench/ocr-structure.ts [fixture ...]   (default: all cached)
import { readFileSync, existsSync } from "node:fs";
import { fuseStructure, parseStructureLines, type ClassicalItem } from "../src/server/ocr-fusion";

const CACHE = "/tmp/opencode/fusion-cache";

const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const all = names.length ? names : ["letter-4920", "letter-4921", "letter-4919", "letter-diagonal", "poster-flat", "grid-handwriting", "grid-poem-h", "grid-poem-v", "banner-insitu", "wordcloud-color", "curve-arc", "curve-s"];

const summary: { name: string; chars: number; anchored: number; interp: number; extrap: number; unanchoredLines: number; llmLines: number; classicalItems: number; unmatched: number; oob: number; angles: string }[] = [];

for (const name of all) {
  // trailing 'b'/'c' = LLM structure variance sample; classical comes from the base name
  const base = name.replace(/[bc]$/, "");
  const cPath = `${CACHE}/${base}.classical.json`, sPath = `${CACHE}/${name}.structure.json`;
  if (!existsSync(cPath) || !existsSync(sPath)) { console.log(`skip ${name}: missing cache`); continue; }
  const classical = JSON.parse(readFileSync(cPath, "utf8")) as { items: ClassicalItem[]; w: number; h: number };
  const llm = parseStructureLines(readFileSync(sPath, "utf8"));
  const res = fuseStructure(classical.items ?? [], llm);

  console.log(`\n=== ${name} — classical ${classical.items?.length ?? 0} items, LLM ${llm.length} lines ===`);
  let chars = 0, anchored = 0, interp = 0, extrap = 0, unanchoredLines = 0, oob = 0;
  const angles: number[] = [];
  for (const l of res.lines) {
    chars += l.chars.length;
    const a = l.chars.filter((c) => c.anchored).length;
    const e = l.chars.filter((c) => c.extrapolated).length;
    const i = l.chars.length - a - e;
    anchored += a; extrap += e; interp += i;
    if (a === 0) unanchoredLines++;
    if (l.angle !== null && a >= 2) angles.push(l.angle);
    for (const c of l.chars) {
      if (!c.box) continue;
      const [x1, y1, x2, y2] = c.box;
      if (x2 - x1 < 4 || y2 - y1 < 4) oob++; // degenerate
      if (x1 < -60 || y1 < -60 || x2 > classical.w * 1.05 || y2 > classical.h * 1.05) oob++;
    }
    const gapStr = l.gaps.length ? ` gaps:${l.gaps.map((g) => `${g.atChar}+${g.widths}`).join(",")}` : "";
    console.log(`  [${l.dir}]${l.angle === null ? "  --  " : String(l.angle).padStart(4) + "°"} ${l.text.slice(0, 26).padEnd(26, " ")} ${String(a).padStart(2)}/${String(l.chars.length).padStart(2)} anchored${l.dirFromLLM && l.angle !== null ? " (dir=LLM)" : ""}${e ? ` +${e}extrap` : ""}${gapStr}`);
  }
  if (res.unmatchedFragments.length) {
    console.log(`  unmatched fragments (${res.unmatchedFragments.length}): ${res.unmatchedFragments.map((f) => f.text.slice(0, 10)).join(" | ")}`);
  }
  if (oob) console.log(`  GEOMETRY WARN: ${oob} degenerate/out-of-bounds boxes`);
  summary.push({ name, chars, anchored, interp, extrap, unanchoredLines, llmLines: res.lines.length, classicalItems: classical.items?.length ?? 0, unmatched: res.unmatchedFragments.length, oob, angles: [...new Set(angles)].slice(0, 6).join("/") });
}

console.log(`\n${"fixture".padEnd(18)} ${"chars".padStart(5)} ${"anch".padStart(5)} ${"anch%".padStart(5)} ${"intrp".padStart(5)} ${"extrp".padStart(5)} ${"unLn".padStart(4)} ${"unFr".padStart(4)} ${"oob".padStart(4)}  angles`);
for (const s of summary) {
  console.log(`${s.name.padEnd(18)} ${String(s.chars).padStart(5)} ${String(s.anchored).padStart(5)} ${((s.anchored / Math.max(1, s.chars)) * 100).toFixed(0).padStart(4)}% ${String(s.interp).padStart(5)} ${String(s.extrap).padStart(5)} ${String(s.unanchoredLines).padStart(4)} ${String(s.unmatched).padStart(4)} ${String(s.oob).padStart(4)}  ${s.angles}`);
}
