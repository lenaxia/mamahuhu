// Cantonese capability benchmark: qwen register-pair translation + jyutping accuracy
// vs words.hk public-domain ground truth. Usage: node bench/run-canto.mjs
import { readFileSync, writeFileSync } from "node:fs";

const rawWords = JSON.parse(readFileSync("vendor/canto/wordslist.json", "utf8")); // word -> [readings, may repeat]
// words.hk values are "possible pronunciations" lists that can contain duplicates;
// dedupe so ground truth is the distinct reading(s).
const wordslist = Object.fromEntries(Object.entries(rawWords).map(([w, v]) => [w, [...new Set(v)]]));
const charlist = JSON.parse(readFileSync("vendor/canto/charlist.json", "utf8")); // char -> {syllable: count}

// ---------- ground truth ----------
const jyutWords = [
  "唔係", "冇", "而家", "邊度", "沖涼", "飲茶", "仔女", "學校", "香蕉", "蘋果",
  "刷牙", "瞓覺", "著鞋", "食飯", "飲水", "洗手", "仲未", "第日", "嬲", "攞",
  "靚", "掂", "佢哋", "點解", "咁樣", "立刻", "已經", "應該", "醫院", "天氣",
  "落雨", "遮", "背囊", "校服", "體育課", "圖書館", "攀石", "勞作", "茶點", "嗽口",
];

// household intents the app actually handles
const intents = [
  "time for a bath",
  "do you want some water?",
  "put on your shoes, we're leaving",
  "be careful, the pot is hot!",
  "grandma is coming over tomorrow",
  "stop hitting your sister",
  "where did you put your backpack?",
  "time for school, don't be late",
  "i love you so much",
  "finish your homework first, then play",
];

const CANTO_MARKERS = /[唔嘅咗喺咁噉啲佢冇哋嚟睇畀俾啦囉喇嘛喎啩啱嚟靚]/;
const CANTO_ONLY = /[唔嘅咗喺噉哋冇佢睇嚟畀俾]/;

const base = process.env.OPENAI_API_BASE ?? "https://api.thekao.cloud/v1";
const key = process.env.OPENAI_API_KEY ?? "";

async function chat(messages, maxTokens = 2000) {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: process.env.MODEL_CHAT ?? "default", messages, max_tokens: maxTokens, temperature: 0.3 }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.choices[0].message.content;
}

const parseJson = (s) => {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no json: " + s.slice(0, 200));
  return JSON.parse(m[0]);
};

// ---------- test A: jyutping accuracy on fixed word list ----------
async function testJyutping() {
  const out = [];
  const list = jyutWords.filter((w) => wordslist[w]);
  const batch = 10;
  for (let i = 0; i < list.length; i += batch) {
    const chunk = list.slice(i, i + batch);
    const idx = chunk.map((w, j) => `${j + 1}. ${w}`).join("\n");
    const txt = await chat([
      { role: "system", content: "You are a Cantonese pronunciation expert. Reply with ONLY a JSON object mapping each word to its jyutping (LSHK scheme, syllables space-separated, tone digits, no punctuation). Example: {\"你好\":\"nei5 hou2\"}" },
      { role: "user", content: idx },
    ], 1000);
    const j = parseJson(txt);
    for (const [n, w] of chunk.entries()) {
      const got = String(j[`${n + 1}`] ?? j[w] ?? "").trim().toLowerCase().replace(/[,，.。!！?？]/g, " ").replace(/\s+/g, " ");
      const wants = wordslist[w]; // distinct readings; accept any
      out.push({ word: w, got, wants, ok: wants.includes(got) });
    }
  }
  return out;
}

// ---------- test B: register-pair translation ----------
async function testTranslation() {
  const out = [];
  for (const intent of intents) {
    const txt = await chat([
      { role: "system", content: `You translate a parent's English into Chinese for a Hong Kong household. Reply ONLY with JSON:
{"casual_hanzi": colloquial spoken Cantonese in Hong Kong characters (口語, what a parent actually says aloud),
 "casual_jyutping": jyutping for casual_hanzi (LSHK, tone digits, space-separated),
 "formal_hanzi": standard written Chinese (書面語, for writing/reading, NOT Cantonese-specific characters),
 "english": short English gloss}
Casual must use spoken Cantonese vocabulary (唔係 not 不是, 冇 not 沒有). Keep it short and natural for talking to a child.` },
      { role: "user", content: intent },
    ]);
    try {
      const j = parseJson(txt);
      const casual = String(j.casual_hanzi ?? "");
      const formal = String(j.formal_hanzi ?? "");
      const jyut = String(j.casual_jyutping ?? "").toLowerCase().replace(/\s+/g, " ").trim();
      out.push({
        intent,
        casual, formal, jyut,
        casual_markers: [...casual].filter((c) => CANTO_MARKERS.test(c)).length,
        formal_leak: [...formal].filter((c) => CANTO_ONLY.test(c)),
        jyut_dict: dictJyut(casual),
      });
    } catch (e) {
      out.push({ intent, error: String(e) });
    }
  }
  return out;
}

// dictionary reference jyutping: word matches from wordslist, else best char readings
function dictJyut(text) {
  const parts = [];
  let s = text;
  while (s.length) {
    let hit = "";
    for (let l = Math.min(4, s.length); l >= 1; l--) {
      const w = s.slice(0, l);
      if (wordslist[w]) { hit = w; break; }
    }
    if (!hit) {
      const c = s[0];
      const readings = charlist[c];
      parts.push(readings ? Object.entries(readings).sort((a, b) => b[1] - a[1])[0][0] : `?(${c})`);
      s = s.slice(1);
    } else {
      parts.push(wordslist[hit][0]);
      s = s.slice(hit.length);
    }
  }
  return parts.join(" ");
}

// ---------- run ----------
// syllable-level Levenshtein ratio: 0 = identical, 1 = totally different
const sylDist = (a, b) => {
  const A = a.replace(/[!?.,，。！？]/g, "").split(" ").filter(Boolean);
  const B = b.replace(/[!?.,，。！？]/g, "").split(" ").filter(Boolean);
  const m = A.length, n = B.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
  return d[m][n] / Math.max(m, n);
};

const [jyut, trans] = await Promise.all([testJyutping(), testTranslation()]);
const acc = jyut.filter((r) => r.ok).length / jyut.length;
const transOk = trans.filter((t) => !t.error);
const leakRate = transOk.filter((t) => t.formal_leak.length > 0).length / transOk.length;
const noMarkers = transOk.filter((t) => t.casual_markers === 0).length / transOk.length;
const jyutErr = transOk.map((t) => sylDist(t.jyut ?? "", t.jyut_dict)).filter((x) => Number.isFinite(x));
const jyutErrRate = jyutErr.length ? jyutErr.reduce((a, b) => a + b, 0) / jyutErr.length : 1;

const report = {
  model: process.env.MODEL_CHAT ?? "default",
  jyutping_accuracy: acc,
  jyutping_errors: jyut.filter((r) => !r.ok),
  translation: trans.map((t) => (t.error ? t : { ...t, jyut_syl_err: sylDist(t.jyut ?? "", t.jyut_dict) })),
  formal_leak_rate: leakRate,
  casual_without_markers_rate: noMarkers,
  in_situ_jyutping_syllable_error_rate: jyutErrRate,
};
writeFileSync("bench/canto-results.json", JSON.stringify(report, null, 2));
console.log(`jyutping accuracy: ${(acc * 100).toFixed(1)}% (${jyut.length} words)`);
console.log(`in-situ jyutping syllable error: ${(jyutErrRate * 100).toFixed(0)}% | formal leak: ${(leakRate * 100).toFixed(0)}% | casual w/o markers: ${(noMarkers * 100).toFixed(0)}%`);
for (const t of transOk) {
  console.log(`  [${t.intent}] casual="${t.casual}" jyut="${t.jyut}" dict="${t.jyut_dict}" err=${(sylDist(t.jyut ?? "", t.jyut_dict) * 100).toFixed(0)}% leak=[${t.formal_leak}]`);
}
