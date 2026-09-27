// resize clean.png to canonical 1000px height, run through the REAL gateway, verify alignment
import sharp from "sharp";
import { readFileSync } from "node:fs";
const orig = readFileSync("bench/images/clean.png");
const resized = await sharp(orig).resize({ height: 1000 }).jpeg({ quality: 85 }).toBuffer();
const meta = await sharp(resized).metadata();
console.log("sent image:", meta.width, "x", meta.height);

const form = new FormData();
form.append("image", new Blob([resized], { type: "image/jpeg" }), "page.jpg");
const res = await fetch("http://localhost:5173/api/ask/ocr", { method: "POST", headers: { "x-dev-user": "dad" }, body: form });
const data = await res.json();
const words = data.lines.flatMap((l) => l.words).filter((w) => w.box);

// ground truth scaled: baseline y = (100 + i*110) * s, s = 1000/560; x1 = 40*s; font 56*s
const s = meta.height / 560;
const byLine = [];
for (const w of words) {
  const ln = byLine.find((b) => Math.abs(b.y1 - w.box[1]) < 40);
  if (ln) { ln.y1 = Math.min(ln.y1, w.box[1]); ln.y2 = Math.max(ln.y2, w.box[3]); ln.x1 = Math.min(ln.x1, w.box[0]); ln.n++; }
  else byLine.push({ y1: w.box[1], y2: w.box[3], x1: w.box[0], n: 1 });
}
byLine.sort((a, b) => a.y1 - b.y1);
let ok = 0;
byLine.slice(0, 4).forEach((b, i) => {
  const ty1 = (100 + i * 110 - 48) * s, ty2 = (100 + i * 110 + 7) * s, tx1 = 40 * s;
  const d1 = Math.round(b.y1 - ty1), d2 = Math.round(b.y2 - ty2), dx = Math.round(b.x1 - tx1);
  const within = Math.abs(d1) < 45 && Math.abs(d2) < 55 && Math.abs(dx) < 30;
  if (within) ok++;
  console.log(`line ${i}: y1Δ${d1} y2Δ${d2} x1Δ${dx} ${within ? "✓" : "✗"}`);
});
console.log(ok >= 3 ? "ALIGNED ✓" : "STILL OFF ✗");
