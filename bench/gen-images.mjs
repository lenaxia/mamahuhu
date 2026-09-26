// OCR benchmark: Tesseract (chi_tra) vs vision LLM on synthetic Taiwan-style pages.
// Usage: node bench/gen-images.mjs  → writes bench/images/*.png + groundtruth.json
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";

const F = "Noto Sans TC";
const HAN = (s, size = 64, fill = "#1c1917", weight = 400) =>
  `<text x="0" y="0" font-family="${F}" font-size="${size}" fill="${fill}" font-weight="${weight}">${s}</text>`;
const BPMF = (s, size = 22, fill = "#7c3a0d") =>
  `<text x="0" y="0" font-family="${F}" font-size="${size}" fill="${fill}">${s}</text>`;

const LINE1 = "小貓在院子裡睡覺，牠最喜歡曬太陽。";
const LINE2 = "明天我們要去搭飛機去看奶奶。";
const LINE3 = "你可以幫我拿鞋子嗎？謝謝你！";
const LINE4 = "睡覺前要先刷牙，還要聽一個故事。";
const GT = [LINE1, LINE2, LINE3, LINE4].join("");

/** char + zhuyin beside it, Taiwan kids-book style */
function zhuyinLine(chars, bpmfs, y) {
  let x = 40;
  let out = "";
  chars.forEach((ch, i) => {
    out += `<g transform="translate(${x},${y})">${HAN(ch, 72)}</g>`;
    out += `<g transform="translate(${x + 76},${y - 58})">${BPMF(bpmfs[i])}</g>`;
    x += 76 + 34;
  });
  return out;
}

const svg = (inner, w = 900) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="560" viewBox="0 0 ${w} 560">${inner}</svg>`;

function plainText(fill = "#1c1917", bg = "#ffffff") {
  const lines = [LINE1, LINE2, LINE3, LINE4]
    .map((t, i) => `<g transform="translate(40,${100 + i * 110})">${HAN(t, 56, fill)}</g>`)
    .join("");
  return svg(`<rect width="100%" height="100%" fill="${bg}"/>${lines}`);
}

function zhuyinPage() {
  const rows = [
    { chars: [..."小貓在院子"], bpmfs: ["ㄒㄧㄠˇ", "ㄇㄠ", "ㄗㄞˋ", "ㄩㄢˋ", "ㄗˇ"] },
    { chars: [..."裡睡覺，牠最"], bpmfs: ["ㄌㄧˇ", "ㄕㄨㄟˋ", "ㄐㄧㄠˋ", "，", "ㄊㄚ", "ㄗㄨㄟˋ"] },
    { chars: [..."喜歡曬太陽"], bpmfs: ["ㄒㄧˇ", "ㄏㄨㄢ", "ㄕㄞˋ", "ㄊㄞˋ", "ㄧㄤˊ"] },
  ];
  const body = rows
    .map((r, i) => zhuyinLine(r.chars.filter((_, j) => r.bpmfs[j] !== "，"), r.bpmfs.filter((b) => b !== "，"), 120 + i * 150))
    .join("");
  return svg(`<rect width="100%" height="100%" fill="#fffdf5"/>${body}`);
}

function colorfulPage() {
  const lines = [LINE1, LINE2, LINE3, LINE4]
    .map((t, i) => `<g transform="translate(40,${100 + i * 110})">${HAN(t, 56, "#27272a")}</g>`)
    .join("");
  return svg(`
    <rect width="100%" height="100%" fill="#fef3c7"/>
    <circle cx="780" cy="90" r="140" fill="#fca5a5" opacity="0.7"/>
    <rect x="20" y="200" width="240" height="90" rx="24" fill="#86efac" opacity="0.7"/>
    <path d="M0 470 Q 450 380 900 470 L 900 560 L 0 560 Z" fill="#93c5fd" opacity="0.6"/>
    <rect x="620" y="330" width="230" height="70" rx="16" fill="#c4b5fd" opacity="0.7"/>
    ${lines}`);
}

const cases = [
  { id: "clean", svg: plainText(), gt: GT },
  { id: "zhuyin-beside", svg: zhuyinPage(), gt: "小貓在院子裡睡覺牠最喜歡曬太陽" },
  { id: "colorful", svg: colorfulPage(), gt: GT },
];

mkdirSync("bench/images", { recursive: true });
const meta = [];
for (const c of cases) {
  const png = await sharp(Buffer.from(c.svg)).png().toBuffer();
  writeFileSync(`bench/images/${c.id}.png`, png);
  meta.push({ id: c.id, gt: c.gt });
}
// skewed + photo-noise variants derived from clean
const clean = Buffer.from(plainText());
writeFileSync("bench/images/skewed.png", await sharp(clean).rotate(-8, { background: "#ffffff" }).png().toBuffer());
meta.push({ id: "skewed", gt: GT });
writeFileSync(
  "bench/images/photoish.jpg",
  await sharp(clean).modulate({ brightness: 0.92 }).jpeg({ quality: 55 }).toBuffer(),
);
meta.push({ id: "photoish", gt: GT });

writeFileSync("bench/groundtruth.json", JSON.stringify(meta, null, 1));
console.log("generated:", meta.map((m) => m.id).join(", "));
