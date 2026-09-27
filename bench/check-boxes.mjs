// Compare gateway OCR boxes against ground-truth geometry of bench/images/clean.png
const res = await fetch("http://localhost:5173/api/ask/ocr", {
  method: "POST",
  headers: { "x-dev-user": "dad" },
  body: await (async () => {
    const fs = await import("node:fs/promises");
    const buf = await fs.readFile("bench/images/clean.png");
    const form = new FormData();
    form.append("image", new Blob([buf], { type: "image/png" }), "clean.png");
    return form;
  })(),
});
const data = await res.json();
const W = 900, H = 560;
// ground truth per line: baseline at y = 100 + i*110, font 56px
// top ≈ baseline - 48, bottom ≈ baseline + 7, x1 = 40
const truth = [0, 1, 2, 3].map((i) => ({ x1: 40, y1: 100 + i * 110 - 48, y2: 100 + i * 110 + 7, chars: 56 }));
// group returned words into lines by y1 proximity, take min/max per line
const words = data.lines.flatMap((l) => l.words).filter((w) => w.box);
const byLine = [];
for (const w of words) {
  const ln = byLine.find((b) => Math.abs(b.y1 - w.box[1]) < 30);
  if (ln) { ln.y1 = Math.min(ln.y1, w.box[1]); ln.y2 = Math.max(ln.y2, w.box[3]); ln.x1 = Math.min(ln.x1, w.box[0]); ln.n++; }
  else byLine.push({ y1: w.box[1], y2: w.box[3], x1: w.box[0], n: 1 });
}
byLine.sort((a, b) => a.y1 - b.y1);
console.log("returned line boxes:", JSON.stringify(byLine, null, 1));
console.log("\nper-line comparison (returned vs truth):");
byLine.slice(0, 4).forEach((b, i) => {
  const t = truth[i];
  if (!t) return;
  console.log(`line ${i}: y1 ${b.y1} vs ${t.y1} (Δ${b.y1 - t.y1})  y2 ${b.y2} vs ${t.y2} (Δ${b.y2 - t.y2})  x1 ${b.x1} vs 40 (Δ${b.x1 - 40})`);
});
if (byLine.length >= 2) {
  const y1r = (byLine[1].y1 - byLine[0].y1) / 110;
  console.log(`\ny-line spacing ratio (should be 1.0 if absolute): ${y1r.toFixed(3)}`);
  if (Math.abs(y1r - H / 1000) < 0.06) console.log("→ Y coordinates are 0-1000 NORMALIZED (scale ~", (H / 1000).toFixed(3), ")");
  else if (Math.abs(y1r - 1) < 0.06) console.log("→ Y coordinates are ABSOLUTE pixels");
  else console.log("→ Y scale unclear, ratio", y1r.toFixed(3));
}
