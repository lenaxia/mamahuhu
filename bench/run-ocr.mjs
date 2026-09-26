// OCR benchmark runner: tesseract.js (chi_tra) vs vision LLM via gateway.
// Usage: node bench/run-ocr.mjs
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);

const groundtruth = JSON.parse(readFileSync("bench/groundtruth.json", "utf8"));
const images = ["clean", "zhuyin-beside", "colorful", "skewed", "photoish"];

// ---------- scoring ----------
const lev = (a, b) => {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
};
// keep only Han ideographs (drop zhuyin, punctuation, whitespace) for fair comparison
const normalize = (s) => [...s].filter((c) => /[\u3400-\u9fff\uf900-\ufaff]/.test(c)).join("");
const cer = (got, want) => {
  const g = normalize(got), w = normalize(want);
  return w.length ? lev(g, w) / w.length : 1;
};

// ---------- engine 1: tesseract.js ----------
async function tesseractOcr(file) {
  const { createWorker } = require("tesseract.js");
  const path = require("node:path");
  const langPath = path.join(path.dirname(require.resolve("@tesseract.js-data/chi_tra/package.json")), "4.0.0_best_int");
  const worker = await createWorker("chi_tra", 1, { langPath });
  const { data } = await worker.recognize(file);
  await worker.terminate();
  return data.text;
}

// ---------- engine 2: vision LLM ----------
async function visionOcr(file) {
  const base = process.env.OPENAI_API_BASE ?? "https://api.openai.com/v1";
  const key = process.env.OPENAI_API_KEY ?? "";
  const b64 = readFileSync(file).toString("base64");
  const isJpg = file.endsWith(".jpg");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.MODEL_VISION ?? "default",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You are an OCR engine. Transcribe ALL Chinese text in the image. Return ONLY the transcribed text lines, nothing else. Ignore any bopomofo/zhuyin annotation symbols — output only the Han characters.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe the Chinese text." },
            { type: "image_url", image_url: { url: `data:image/${isJpg ? "jpeg" : "png"};base64,${b64}` } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`vision ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------- run ----------
const results = [];
for (const id of images) {
  const file = id === "photoish" ? "bench/images/photoish.jpg" : `bench/images/${id}.png`;
  const gt = groundtruth.find((g) => g.id === id).gt;

  let t0 = Date.now();
  const tessText = await tesseractOcr(file).catch((e) => `ERROR ${e.message}`);
  const tessMs = Date.now() - t0;

  t0 = Date.now();
  const llmText = await visionOcr(file).catch((e) => `ERROR ${e.message}`);
  const llmMs = Date.now() - t0;

  results.push({
    case: id,
    tesseract: { cer: +cer(tessText, gt).toFixed(3), ms: tessMs, sample: normalize(tessText).slice(0, 24) },
    vision: { cer: +cer(llmText, gt).toFixed(3), ms: llmMs, sample: normalize(llmText).slice(0, 24) },
  });
  console.log(JSON.stringify(results.at(-1)));
}

writeFileSync("bench/ocr-results.json", JSON.stringify(results, null, 1));
const avg = (engine, key) => (results.reduce((s, r) => s + r[engine][key], 0) / results.length).toFixed(key === "cer" ? 3 : 0);
console.log(`\nAVG char-error-rate  tesseract: ${avg("tesseract", "cer")}   vision: ${avg("vision", "cer")}`);
console.log(`AVG latency (ms)     tesseract: ${avg("tesseract", "ms")}   vision: ${avg("vision", "ms")}`);
