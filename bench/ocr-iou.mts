// FUSION GEOMETRY GROUND TRUTH: do fused char boxes sit inside their anchor
// fragment boxes (IoU)? Independent of any vision judge. Sub-range anchors
// (window < fragment) legitimately score low vs the WHOLE-fragment union —
// read LOW flags together with the window size, not as automatic failures.
// Run: npx tsx bench/ocr-iou.mts
import { readFileSync } from "node:fs";
import { fuseStructure, parseStructureLines, type ClassicalItem } from "/workspace/src/server/ocr-fusion";
const CACHE = "/tmp/opencode/fusion-cache";
for (const name of ["poster-flat", "banner-insitu", "letter-4919", "letter-4920", "letter-diagonal", "wordcloud-color"]) {
  const classical = JSON.parse(readFileSync(`${CACHE}/${name}.classical.json`, "utf8")) as { items: ClassicalItem[] };
  const llm = parseStructureLines(readFileSync(`${CACHE}/${name}.structure.json`, "utf8"));
  const res = fuseStructure(classical.items, llm);
  console.log(`\n=== ${name} ===`);
  for (const l of res.lines) {
    if (l.angle === null) continue;
    const anchoredChars = l.chars.filter((c) => c.anchored && c.box);
    if (!anchoredChars.length) continue;
    const u = {
      x1: Math.min(...anchoredChars.map((c) => c.box![0])), y1: Math.min(...anchoredChars.map((c) => c.box![1])),
      x2: Math.max(...anchoredChars.map((c) => c.box![2])), y2: Math.max(...anchoredChars.map((c) => c.box![3])),
    };
    // union of matched fragment boxes
    const fboxes = l.matchedFragments.map((i) => classical.items[i]!.box);
    const fu = {
      x1: Math.min(...fboxes.map((b) => b[0])), y1: Math.min(...fboxes.map((b) => b[1])),
      x2: Math.max(...fboxes.map((b) => b[2])), y2: Math.max(...fboxes.map((b) => b[3])),
    };
    const ix = Math.max(0, Math.min(u.x2, fu.x2) - Math.max(u.x1, fu.x1));
    const iy = Math.max(0, Math.min(u.y2, fu.y2) - Math.max(u.y1, fu.y1));
    const iou = (ix * iy) / Math.max(1, ((u.x2 - u.x1) * (u.y2 - u.y1) + (fu.x2 - fu.x1) * (fu.y2 - fu.y1) - ix * iy));
    console.log(`  ${l.text.slice(0, 16).padEnd(16)} chars${anchoredChars.length}/${l.chars.length} fused[${u.x1},${u.y1},${u.x2},${u.y2}] frag[${fu.x1},${fu.y1},${fu.x2},${fu.y2}] IoU=${iou.toFixed(2)}${iou < 0.3 ? "  ← LOW" : ""}`);
  }
}
