import { readFileSync } from "node:fs";
import { VECTOR_SYSTEM } from "../bench/ocr-vectors";

const BASE = process.env.OPENAI_API_BASE ?? "https://api.thekao.cloud/v1";
const KEY = process.env.OPENAI_API_KEY ?? "";

async function main() {
  const file = process.argv[2] ?? "bench/fixtures/letter-diagonal.jpg";
  const b64 = readFileSync(file).toString("base64");
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: process.env.MODEL_CHAT ?? "default", temperature: 0, max_tokens: 6000,
      messages: [
        { role: "system", content: VECTOR_SYSTEM },
        { role: "user", content: [
          { type: "text", text: "Transcribe the Chinese text blocks." },
          { type: "image_url", image_url: { url: `data:${file.endsWith(".png") ? "image/png" : "image/jpeg"};base64,${b64}` } },
        ] },
      ],
    }),
  });
  const raw = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
  console.log("--- RAW ITEMS (model output):");
  for (const m of raw.matchAll(/\{[^{}]*\}/g)) {
    console.log(" ", m[0].slice(0, 150));
  }
  console.log("--- parsed via app parser:");
  const { parseOcrVectors } = await import("../src/server/llm");
  const lines = parseOcrVectors(raw, { w: 3024, h: 4032 });
  for (const l of lines) {
    console.log(`  ${l.text}  from=[${l.from?.map((n) => Math.round(n))}] to=[${l.to?.map((n) => Math.round(n))}] angle=${l.angle}`);
  }
}
void main();
