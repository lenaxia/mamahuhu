// A/B battery for the fullZh NONE-decision (bug: nonsense grids flip between
// NONE/echo/translate across gateway backends — owner lost the grid card).
// Run: npx tsx bench/ab-fullzh.mts [current|tight] [runs]
import { readFileSync } from "node:fs";

const BASE = process.env.OPENAI_API_BASE!;
const KEY = process.env.OPENAI_API_KEY!;
const variant = process.argv[2] ?? "current";
const RUNS = parseInt(process.argv[3] ?? "4");

const CURRENT = `Translate this Chinese text into natural English. The text may be Mandarin OR colloquial Cantonese (口語) and may contain line breaks from a photo.
DECIDE FIRST: if the text is a single word or a short standalone phrase (something a dictionary entry alone would explain), reply with exactly NONE — no translation needed. Otherwise reply with ONLY the complete translation: join lines that form one sentence, keep separate items (bullets, lists, slogans) on their own lines. No notes, no Chinese.`;

const TIGHT = `Translate this Chinese text into natural English. The text may be Mandarin OR colloquial Cantonese (口語) and may contain line breaks from a photo.
DECIDE FIRST: reply with exactly NONE — no translation needed — ONLY when the ENTIRE text is one dictionary word or one short standalone phrase (a few characters on ONE line that a dictionary entry alone would explain). Text with multiple lines, multiple words, or full sentences is ALWAYS translated — even random, archaic, or practice characters: describe what they are (e.g. "a grid of handwriting-practice characters: X means …"). Never repeat the Chinese text back. Otherwise reply with ONLY the complete translation: join lines that form one sentence, keep separate items (bullets, lists, slogans) on their own lines. No notes, no Chinese.`;

const SYS = variant === "tight" ? TIGHT : CURRENT;

const battery: { name: string; text: string; want: "none" | "translate" }[] = [
  { name: "grid", text: "合侗蕈崩則\n粲韻波瀛登\n歲徜沱螻繢\n鐺宦雙蠢間\n四邁瀼蘀承\n繻傴蕙活臧", want: "translate" },
  { name: "grid-structure", text: "則登續聞承臧\n崩遠鴻喬夔\n奠波疁雙濊\n侗韻倘室\n合祭歲", want: "translate" },
  { name: "letter", text: "密呈太傅大人的鈎座\n年職日夜奔波詳查舊案閱\n十七年前魏嚴家將魏", want: "translate" },
  { name: "poster", text: "亲近自然\n定期举办野营活动，让孩子们在帐篷\n和簧火中学习户外技能，增强独立与\n合作能力。", want: "translate" },
  { name: "sentence", text: "今天天氣很好，我們去公園玩吧。", want: "translate" },
  { name: "single-word", text: "睡覺", want: "none" },
  { name: "phrase", text: "早唞", want: "none" },
  { name: "phrase2", text: "再見", want: "none" },
];

console.log(`variant=${variant} runs=${RUNS}`);
let wrong = 0, total = 0;
for (const b of battery) {
  const outcomes: string[] = [];
  for (let i = 0; i < RUNS; i++) {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: "default", temperature: 0.2, max_tokens: 400, messages: [
        { role: "system", content: SYS }, { role: "user", content: b.text }] }),
    });
    const raw = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? `HTTP${res.status}`;
    const t = raw.trim();
    const got = /^none\.?$/i.test(t) ? "none" : t === b.text.trim() || [...t].filter((c) => /\p{Script=Han}/u.test(c)).length > Math.max(3, [...b.text].length / 2) ? "echo" : "translate";
    outcomes.push(got);
    total++;
    if (got !== b.want) wrong++;
  }
  console.log(`${b.name.padEnd(15)} want=${b.want.padEnd(10)} got=[${outcomes.join(",")}]${outcomes.some((o) => o !== b.want) ? "  ← MISMATCH" : ""}`);
}
console.log(`mismatched responses: ${wrong}/${total}`);
void readFileSync;
