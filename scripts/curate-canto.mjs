// Curate vendor/canto raw data into src/shared/canto-data.json (committed).
// Sources: words.hk 粵典數據 (public domain) + rime-cantonese chars (CC BY 4.0).
// Run after refreshing vendor/canto/: node scripts/curate-canto.mjs
import { readFileSync, writeFileSync } from "node:fs";

const wordsRaw = JSON.parse(readFileSync("vendor/canto/wordslist.json", "utf8"));
const charRaw = JSON.parse(readFileSync("vendor/canto/charlist.json", "utf8"));
const freqRaw = JSON.parse(readFileSync("vendor/canto/existingwordcount.json", "utf8"));

const HAN = /^[\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{2ffff}]+$/u;
const SYL = /^[a-z]+[1-6]$/;

// words: multi-char Han words -> first distinct reading ("syll syll")
const words = {};
for (const [w, readings] of Object.entries(wordsRaw)) {
  if (w.length < 2 || !HAN.test(w)) continue;
  const r = [...new Set(readings)].find((x) => x.split(" ").length === [...w].length && x.split(" ").every((s) => SYL.test(s)));
  if (r) words[w] = r;
}

// chars: char -> readings sorted by corpus count desc (words.hk), gap-filled from rime
const chars = {};
for (const [c, m] of Object.entries(charRaw)) {
  const list = Object.entries(m)
    .filter(([s]) => SYL.test(s))
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s);
  if (list.length) chars[c] = list;
}
const missing = new Set();
for (const w of Object.keys(words)) for (const c of w) if (!chars[c]) missing.add(c);
const rimeChars = readFileSync("vendor/canto/jyut6ping3.chars.dict.yaml", "utf8").split("\n");
const gap = {};
for (const line of rimeChars) {
  if (!line.includes("\t") || line.startsWith("#")) continue;
  const [c, jyut] = line.split("\t");
  if (!SYL.test(jyut)) continue;
  (gap[c] ??= []).push(jyut);
}
let filled = 0;
for (const c of missing) {
  const list = [...new Set(gap[c] ?? [])];
  if (list.length) { chars[c] = list; filled++; }
}

// freq: word -> corpus count (segmentation ranking)
const freq = {};
for (const [w, n] of Object.entries(freqRaw)) {
  if (typeof n === "number" && n > 0) freq[w] = n;
}

const out = { _credits: "words.hk 粵典數據 (public domain) + rime-cantonese (CC BY 4.0)", chars, words, freq };
writeFileSync("src/shared/canto-data.json", JSON.stringify(out));
console.log(`words: ${Object.keys(words).length}, chars: ${Object.keys(chars).length} (rime gap-fill: ${filled}), freq: ${Object.keys(freq).length}`);
console.log(`size: ${(JSON.stringify(out).length / 1e6).toFixed(1)}MB`);
// smoke
for (const w of ["唔係", "沖涼", "邊度", "而家", "學校", "飲茶"]) console.log(w, "->", words[w]);
