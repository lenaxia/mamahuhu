import { describe, expect, it, beforeAll } from "vitest";
import { rmSync, mkdirSync } from "node:fs";
import { makeApp } from "../../src/server/app";

/**
 * zh-HK (Cantonese) contract: variety-aware translate with dictionary-derived
 * jyutping (never LLM), entry pairs (口語 primary + 書面 fields), per-user
 * varieties, and TTS status surfacing canto availability. Mock LLM fixtures,
 * no network.
 */

const TMP = "./data/test-canto.db";

let app: Awaited<ReturnType<typeof makeApp>>["app"];

beforeAll(async () => {
  rmSync(TMP, { force: true });
  mkdirSync("./data", { recursive: true });
  ({ app } = await makeApp({ sqlitePath: TMP, llmMock: true }));
});

const H = { "x-dev-user": "dad", "content-type": "application/json" };
const H2 = { "x-dev-user": "mom", "content-type": "application/json" }; // untouched by the variety patch

describe("user varieties", () => {
  it("defaults to zh-Hant only", async () => {
    const me = await (await app.request("/api/me", { headers: H })).json();
    expect(me.varieties).toEqual(["zh-Hant"]);
    expect(me.primaryVariety).toBe("zh-Hant");
  });

  it("enables both varieties with a canto default", async () => {
    const res = await app.request("/api/me", {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ varieties: ["zh-Hant", "zh-HK"], primaryVariety: "zh-HK" }),
    });
    expect(res.status).toBe(200);
    const me = await res.json();
    expect(me.varieties).toEqual(["zh-Hant", "zh-HK"]);
    expect(me.primaryVariety).toBe("zh-HK");
  });
});

describe("zh-HK translate", () => {
  it("returns the canto pair with dictionary jyutping, not the model's", async () => {
    const res = await app.request("/api/ask/translate", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "time for a bath", variety: "zh-HK" }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.variety).toBe("zh-HK");
    expect(j.casual.traditional).toBe("沖涼喇");
    // dictionary-derived (words.hk), overriding the mock's own romanization
    expect(j.casual.jyutping).toBe("cung1 loeng4 laa3");
    expect(j.formal.traditional).toBe("該洗澡了");
    expect(j.formal.jyutping).toBe("goi1 sai2 cou3 liu5"); // dictionary readings, never the model's
    // per-char syllables grouped by dictionary word: 沖涼 is one word, 喇 its own char
    expect(j.syllables.map((g: { h: string; py: string }[]) => g.map((c) => [c.h, c.py]))).toEqual([
      [["沖", "cung1"], ["涼", "loeng4"]],
      [["喇", "laa3"]],
    ]);
  });

  it("good night uses the idiomatic 早唞, 晚安 stays formal (wife-reported trap)", async () => {
    const res = await app.request("/api/ask/translate", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "good night", variety: "zh-HK" }),
    });
    const j = await res.json();
    expect(j.casual.traditional).toBe("早唞");
    expect(j.casual.jyutping).toBe("zou2 tau2");
    expect(j.formal.traditional).toBe("晚安");
    expect(j.casual.traditional).not.toContain("晚安");
  });

  it("zh-Hant path is unchanged for a zh-Hant user", async () => {
    const res = await app.request("/api/ask/translate", {
      method: "POST",
      headers: H2,
      body: JSON.stringify({ text: "time for a bath" }),
    });
    const j = await res.json();
    expect(j.variety).toBe("zh-Hant");
    expect(j.casual.jyutping).toBe("");
  });

  it("falls back to the user's primary variety", async () => {
    const res = await app.request("/api/ask/translate", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "time for a bath" }),
    });
    const j = await res.json();
    expect(j.casual.traditional).toBe("沖涼喇"); // primary is zh-HK from the patch above
  });
});

describe("zh-HK entries", () => {
  const postEntry = async (body: object) =>
    app.request("/api/entries", { method: "POST", headers: H, body: JSON.stringify(body) });

  it("stores the 口語 form with its 書面 pair and jyutping", async () => {
    const res = await postEntry({
      traditional: "沖涼喇",
      simplified: "沖涼喇",
      pinyin: "cung1 loeng4 laa3",
      bpmf: "",
      jyutping: "cung1 loeng4 laa3",
      formalZh: "該洗澡了",
      formalJyut: "",
      english: "time for a bath (spoken Cantonese)",
      register: "casual",
      source: "en-translate",
      syllables: [[{ h: "沖", py: "cung1", bpmf: "" }, { h: "涼", py: "loeng4", bpmf: "" }, { h: "喇", py: "laa3", bpmf: "" }]],
      variety: "zh-HK",
    });
    expect(res.status).toBe(201);
    const e = await res.json();
    expect(e.variety).toBe("zh-HK");
    expect(e.jyutping).toBe("cung1 loeng4 laa3");
    expect(e.formalZh).toBe("該洗澡了");
  });

  it("same hanzi in different varieties are distinct entries", async () => {
    const a = await postEntry({
      traditional: "飲茶", pinyin: "jam2 caa4", english: "canto sense",
      source: "manual", syllables: [], variety: "zh-HK",
    });
    expect(a.status).toBe(201);
    const b = await postEntry({
      traditional: "飲茶", pinyin: "jam2 caa4", english: "mandarin sense",
      source: "manual", syllables: [], variety: "zh-Hant",
    });
    expect(b.status).toBe(201);
    expect((await b.json()).id).not.toBe((await a.json()).id);
  });

  it("review due list carries canto entries with their fields", async () => {
    const res = await app.request("/api/review/due", { headers: H });
    const list = await res.json();
    const canto = list.find((e: { variety: string; traditional: string }) => e.variety === "zh-HK" && e.traditional === "沖涼喇");
    expect(canto).toBeDefined();
    expect(canto.jyutping).toBe("cung1 loeng4 laa3");
  });
});

describe("tts variety surface", () => {
  it("status reports canto availability separately (false under mock)", async () => {
    const res = await app.request("/api/tts/status");
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.cantoAvailable).toBe(false);
  });
});

describe("zh-HK follow-ups", () => {
  it("answers a Chinese question as a 口語/書面 pair", async () => {
    const res = await app.request("/api/ask/followup", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ question: "咩時候用呢個？", hanzi: "沖涼喇", variety: "zh-HK" }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.variety).toBe("zh-HK");
    expect(j.answer).toContain("口語"); // spoken-canto mock fixture
    expect(j.answerWritten).toContain("書面");
  });

  it("answers an English question in English (single answer)", async () => {
    const res = await app.request("/api/ask/followup", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ question: "when would I say this?", hanzi: "沖涼喇", variety: "zh-HK" }),
    });
    const j = await res.json();
    expect(j.answer).toMatch(/Mock English/);
    expect(j.answerWritten).toBeUndefined();
  });

  it("threads prior turns as context (contract accepts history)", async () => {
    const res = await app.request("/api/ask/followup", {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        question: "what about with strangers?",
        hanzi: "早唞",
        variety: "zh-HK",
        history: [{ q: "when would I say this?", a: "早唞 is the casual bedtime parting." }],
      }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.answer).toBeTruthy();
  });

  it("zh-Hant follow-ups stay single-answer", async () => {
    const res = await app.request("/api/ask/followup", {
      method: "POST",
      headers: H2,
      body: JSON.stringify({ question: "when would I say this?", hanzi: "該睡覺了" }),
    });
    const j = await res.json();
    expect(j.answer).toBeTruthy();
    expect(j.answerWritten).toBeUndefined();
    expect(j.variety).toBeUndefined();
  });
});
