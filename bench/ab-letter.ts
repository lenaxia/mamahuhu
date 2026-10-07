// A/B matrix: which variable killed full-line reads on the letter?
// Variables: prompt (original-minimal vs current-app), bytes (raw vs normalized), budget.
import { readFileSync } from "node:fs";

const BASE = process.env.OPENAI_API_BASE ?? "https://api.thekao.cloud/v1";
const KEY = process.env.OPENAI_API_KEY ?? "";

const ORIGINAL_PROBE = `You are an OCR engine. Find every block of Chinese text in the image. Return ONLY valid JSON, no prose:
{"items":[{"text":"…","from":[x1,y1],"to":[x2,y2]}]}
- from = point where the text block STARTS (start of its baseline); to = where it ENDS.
- Coordinates on a 0-1000 grid relative to the image (0,0 = top-left, 1000 = bottom-right).
- The from→to vector must run ALONG the text's own axis: horizontal text → left-to-right vector; vertical text → top-to-bottom; diagonal text → its actual diagonal. A single standalone word is its own small block.
- Text always reads from→to. Transcribe each block EXACTLY ONCE — never repeat text.`;

const CURRENT_APP = `You are an OCR engine for photos of Chinese text (Taiwan children's books included). Find every block of Han text (ignore bopomofo/zhuyin annotation symbols). Return ONLY valid JSON, no prose: {"items":[{"text":"…","from":[x1,y1],"to":[x2,y2]}]}
- from = point where the text block STARTS (start of its baseline); to = where it ENDS. Coordinates on a 0-1000 grid relative to the image (0,0 = top-left, 1000 = bottom-right corner on each axis).
- The from→to vector must run ALONG the text's own axis: horizontal text → left-to-right vector; vertical text → top-to-bottom; diagonal text → its actual diagonal. A single standalone word is its own small block.
- LONG STRAIGHT lines (vertical columns included) must be ONE single block covering the ENTIRE line, first character to last — never split, never stop early.
- TEXT ON A CURVE: split it into SHORT consecutive blocks (3-5 characters each), each following the LOCAL direction of the curve at that point. Split ONLY text that physically curves.
- Group characters that belong to one word or short phrase into a SINGLE block (entries in a word cloud are words, not individual characters); emit a standalone single character only when it is truly isolated.
- Text always reads from→to. Transcribe each block EXACTLY ONCE — never repeat text.`;

async function run(label: string, system: string, bytes: Buffer, mime: string, maxTokens: number) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "default", temperature: 0, max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: [
          { type: "text", text: "Transcribe the Chinese text blocks." },
          { type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } },
        ] },
      ],
    }),
  });
  const j = (await res.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
  const raw = j.choices?.[0]?.message?.content ?? "";
  const texts = [...raw.matchAll(/"text"\s*:\s*"([^"]+)"/g)].map((m) => m[1]!);
  const totalChars = texts.join("").length;
  console.log(`${label.padEnd(34)} finish=${j.choices?.[0]?.finish_reason} lines=${texts.length} chars=${totalChars}`);
  for (const t of texts.slice(0, 12)) console.log(`    ${t}`);
  return raw;
}

async function main() {
  const rawBytes = readFileSync("bench/fixtures/letter-diagonal.jpg");
  const sharp = (await import("sharp")).default;
  const normBytes = await sharp(rawBytes).rotate().jpeg({ quality: 88 }).toBuffer();
  console.log(`raw ${rawBytes.length}B, normalized ${normBytes.length}B\n`);

  await run("A original-prompt + raw + 4000", ORIGINAL_PROBE, rawBytes, "image/jpeg", 4000);
  await run("B current-prompt  + raw + 8000", CURRENT_APP, rawBytes, "image/jpeg", 8000);
  await run("C original-prompt + norm + 4000", ORIGINAL_PROBE, normBytes, "image/jpeg", 4000);
  await run("D current-prompt  + norm + 8000", CURRENT_APP, normBytes, "image/jpeg", 8000);
}
void main();
