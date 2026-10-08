// OVERLAY QA: render fused per-char boxes onto fixtures, ask the vision model
// to grade each LINE box: does it sit on the claimed text? Independent check
// that anchored chars are anchored in the RIGHT PLACE (counts != placement).
// NOTE: the judge is NOISY — same boxes grade good↔partial↔wrong across runs
// (measured). Use it to find SYSTEMATIC failures (e.g. every line wrong =
// axis bug), never as a pass/fail gate. bench/ocr-iou.mts is the stable one.
// Run: npx tsx bench/overlay-qa.mts [fixture,fixture]
import { readFileSync } from "node:fs";
import { fuseStructure, parseStructureLines, type ClassicalItem } from "/workspace/src/server/ocr-fusion";

const CACHE = "/tmp/opencode/fusion-cache";
const BASE = process.env.OPENAI_API_BASE!;
const KEY = process.env.OPENAI_API_KEY!;

const ALL: { name: string; ext: string }[] = [
  { name: "poster-flat", ext: "jpg" },
  { name: "banner-insitu", ext: "jpg" },
  { name: "letter-4919", ext: "jpg" },
  { name: "letter-4920", ext: "jpg" },
  { name: "letter-diagonal", ext: "jpg" },
  { name: "wordcloud-color", ext: "png" },
];
const FIXTURES = process.argv[2] ? ALL.filter((f) => process.argv[2]!.split(",").includes(f.name)) : ALL;

async function grade(name: string, ext: string): Promise<void> {
  const classical = JSON.parse(readFileSync(`${CACHE}/${name}.classical.json`, "utf8")) as { items: ClassicalItem[] };
  const llm = parseStructureLines(readFileSync(`${CACHE}/${name}.structure.json`, "utf8"));
  const res = fuseStructure(classical.items, llm);
  const sharp = (await import("sharp")).default;
  const img = sharp(`/workspace/bench/fixtures/${name}.${ext}`);
  const meta = await img.metadata();
  const W = meta.width!, H = meta.height!;

  // anchored lines only, longest first, cap 6 for legibility
  const anchored = res.lines.filter((l) => l.angle !== null && l.chars.some((c) => c.anchored))
    .sort((a, b) => b.chars.length - a.chars.length).slice(0, 6);
  if (!anchored.length) { console.log(`${name}: no anchored lines`); return; }

  const rects = anchored.map((l, i) => {
    const bs = l.chars.filter((c) => c.anchored && c.box).map((c) => c.box!);
    const x1 = Math.min(...bs.map((b) => b[0])), y1 = Math.min(...bs.map((b) => b[1]));
    const x2 = Math.max(...bs.map((b) => b[2])), y2 = Math.max(...bs.map((b) => b[3]));
    return { i: i + 1, x1, y1, x2, y2, text: l.chars.map((c) => c.char).join(""), anchored: l.chars.filter((c) => c.anchored).length };
  });
  const svg = `<svg width="${W}" height="${H}">${rects.map((r) =>
    `<rect x="${r.x1}" y="${r.y1}" width="${r.x2 - r.x1}" height="${r.y2 - r.y1}" fill="none" stroke="#ff2d00" stroke-width="${Math.max(3, Math.round(Math.max(W, H) / 300))}"/>` +
    `<text x="${Math.max(0, r.x1 - 10)}" y="${Math.max(30, r.y1 - 12)}" font-size="${Math.max(28, Math.round(Math.max(W, H) / 40))}" fill="#ff2d00" font-weight="bold">${r.i}</text>`).join("")}</svg>`;
  const scale = Math.min(1, 1600 / Math.max(W, H));
  const png = await sharp(await img.clone().composite([{ input: Buffer.from(svg) }]).png().toBuffer())
    .resize(Math.round(W * scale), Math.round(H * scale)).jpeg({ quality: 80 }).toBuffer();

  const list = rects.map((r) => `${r.i}: "${r.text}" (box covers ${r.anchored}/${r.text.length} chars)`).join("\n");
  const out = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "default", temperature: 0, max_tokens: 800,
      messages: [
        { role: "system", content: "You grade OCR overlay boxes. The image shows numbered red rectangles. Each number claims its rectangle sits tightly on a specific line of Chinese text. For EACH number answer exactly: `<n>: good` (rectangle sits on that exact text), `<n>: wrong` (rectangle is on different text or empty space), or `<n>: partial` (overlaps the text but badly aligned/sized). One line per number, no other text." },
        { role: "user", content: [
          { type: "text", text: `Grade these:\n${list}` },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${png.toString("base64")}` } },
        ] },
      ],
    }),
  });
  const raw = ((await out.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
  const verdicts = new Map<number, string>();
  for (const m of raw.matchAll(/(\d+)\s*:\s*(good|wrong|partial)/gi)) verdicts.set(parseInt(m[1]!), m[2]!.toLowerCase());
  const counts = { good: 0, partial: 0, wrong: 0, missing: 0 };
  for (const r of rects) {
    const v = verdicts.get(r.i);
    if (v === "good") counts.good++;
    else if (v === "partial") counts.partial++;
    else if (v === "wrong") counts.wrong++;
    else counts.missing++;
  }
  console.log(`${name}: good ${counts.good} / partial ${counts.partial} / wrong ${counts.wrong}${counts.missing ? ` / ungraded ${counts.missing}` : ""}  of ${rects.length} graded lines`);
  for (const r of rects) console.log(`   ${r.i}. [${verdicts.get(r.i) ?? "?"}] ${r.text.slice(0, 18)}`);
}

for (const f of FIXTURES) await grade(f.name, f.ext);
