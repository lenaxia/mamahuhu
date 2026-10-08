import { readFileSync } from "node:fs";
const file = process.argv[2] ?? "uploads/54636f78-1c31-463c-a098-c0f8d1baa9f6-IMG_4921.jpeg";
const b64 = readFileSync(file).toString("base64");
const SYS = `You are transcribing a handwritten Chinese letter. The letter is written in vertical columns, read TOP TO BOTTOM within each column, columns ordered RIGHT TO LEFT (traditional letter format). There may be a header at the top, a signature/seal at the bottom, and a stamp.

Transcribe the COMPLETE letter character-by-character. For EACH column, output one line: the column's characters in reading order, leftmost output line = the RIGHTMOST column (first read). Mark any character you cannot read confidently as ▢. Do not skip columns. Do not repeat a column. After the transcription, output a line "---" and then list each character you marked ▢ with its column number and your best guesses.

Output format:
COLUMN 1 (rightmost): <characters>
COLUMN 2: <characters>
...
---`;
for (let run = 1; run <= 3; run++) {
  const res = await fetch(`${process.env.OPENAI_API_BASE}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "default", temperature: 0, max_tokens: 2000, messages: [
      { role: "system", content: SYS },
      { role: "user", content: [
        { type: "text", text: "Transcribe this letter completely, column by column." },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
      ] },
    ] }),
  });
  const raw = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? `HTTP ${res.status}`;
  console.log(`\n===== RUN ${run} =====\n${raw.trim()}`);
}
