import { describe, expect, it, beforeAll } from "vitest";
import { rmSync, mkdirSync } from "node:fs";
import { makeApp, type AppDeps } from "../../src/server/app";

/**
 * API contract tests (TDD). These define the HTTP surface BEFORE the routes
 * exist. Run against a throwaway SQLite file; identity comes from the dev
 * header (x-dev-user) since TRUST_PROXY_HEADERS is off in tests.
 */

const TMP = "./data/test-contract.db";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let deps: AppDeps;

beforeAll(async () => {
  rmSync(TMP, { force: true });
  mkdirSync("./data", { recursive: true });
  ({ app, deps } = await makeApp({
    sqlitePath: TMP,
    llmMock: true, // deterministic translate fixtures — no network in tests
  }));
});

const H = { "x-dev-user": "dad", "content-type": "application/json" };

describe("health & identity", () => {
  it("GET /healthz reports ok with dictionary size", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.dictEntries).toBeGreaterThan(10000);
  });

  it("GET /api/me auto-provisions a user", async () => {
    const res = await app.request("/api/me", { headers: H });
    expect(res.status).toBe(200);
    const me = await res.json();
    expect(me.id).toBeTruthy();
    expect(me.name).toBe("dad");
    expect(me.annotations).toBe("both");
    expect(me.onboarded).toBe(false);
  });

  it("PATCH /api/me persists annotation pref", async () => {
    const res = await app.request("/api/me", {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ annotations: "bpmf", name: "Baba" }),
    });
    expect(res.status).toBe(200);
    const me = await res.json();
    expect(me.annotations).toBe("bpmf");
    expect(me.name).toBe("Baba");
    const again = await (await app.request("/api/me", { headers: H })).json();
    expect(again.annotations).toBe("bpmf");
  });

  it("separates users by dev header", async () => {
    const mom = await (
      await app.request("/api/me", { headers: { "x-dev-user": "mom" } })
    ).json();
    expect(mom.id).not.toBe((await (await app.request("/api/me", { headers: H })).json()).id);
  });
});

describe("pinyin interpreter", () => {
  it("POST /api/ask/pinyin interprets malformed input", async () => {
    const res = await app.request("/api/ask/pinyin", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "wo bu zhi dao" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.interpretations[0].traditional).toBe("我不知道");
    expect(body.interpretations[0].bpmf).toContain("ㄅㄨˋ");
    expect(body.interpretations[0].words.length).toBeGreaterThan(1);
  });

  it("returns candidates when uninterpretable", async () => {
    const res = await app.request("/api/ask/pinyin", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "jiao" }),
    });
    const body = await res.json();
    expect(body.interpretations.length).toBeGreaterThanOrEqual(0);
    expect(body.candidates.length).toBeGreaterThan(3);
    const trads = body.candidates.map((c: { traditional: string }) => c.traditional);
    expect(trads).toContain("腳");
  });
});

describe("translate (mocked LLM)", () => {
  it("POST /api/ask/translate returns both registers with annotations", async () => {
    const res = await app.request("/api/ask/translate", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "i love you" }),
    });
    expect(res.status).toBe(200);
    const card = await res.json();
    expect(card.casual.traditional).toBe("我愛你");
    expect(card.casual.pinyin).toBe("wǒ ài nǐ");
    expect(card.casual.bpmf).toBe("ㄨㄛˇ ㄞˋ ㄋㄧˇ");
    expect(card.casual.gloss.toLowerCase()).toContain("love");
    expect(card.formal.traditional.length).toBeGreaterThan(0);
    expect(card.register).toBe("casual");
    expect(card.syllables[0][0]).toEqual({ h: "我", py: "wǒ", bpmf: "ㄨㄛˇ" });
  });

  it("rejects empty input", async () => {
    const res = await app.request("/api/ask/translate", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "  " }),
    });
    expect(res.status).toBe(400);
  });
});

describe("entries", () => {
  const entry = {
    traditional: "我愛你",
    simplified: "我爱你",
    pinyin: "wǒ ài nǐ",
    pinyinFlat: "woaini",
    bpmf: "ㄨㄛˇ ㄞˋ ㄋㄧˇ",
    english: "I love you",
    register: "casual",
    source: "en-translate",
    syllables: [[{ h: "我", py: "wǒ", bpmf: "ㄨㄛˇ" }, { h: "愛", py: "ài", bpmf: "ㄞˋ" }, { h: "你", py: "nǐ", bpmf: "ㄋㄧˇ" }]],
  };

  it("POST then GET round-trips an entry", async () => {
    const post = await app.request("/api/entries", {
      method: "POST",
      headers: H,
      body: JSON.stringify(entry),
    });
    expect(post.status).toBe(201);
    const saved = await post.json();
    expect(saved.id).toBeTruthy();
    expect(saved.userName).toBe("Baba");

    const list = await (await app.request("/api/entries?scope=mine", { headers: H })).json();
    expect(list.length).toBe(1);
    expect(list[0].traditional).toBe("我愛你");
    expect(list[0].syllables[0][1].bpmf).toBe("ㄞˋ");
  });

  it("save is idempotent per user+phrase+pinyin", async () => {
    const again = await app.request("/api/entries", {
      method: "POST",
      headers: H,
      body: JSON.stringify(entry),
    });
    const dup = await again.json();
    expect(dup.duplicate).toBe(true);
    const list = await (await app.request("/api/entries?scope=mine", { headers: H })).json();
    expect(list.length).toBe(1);
  });

  it("scope=all shows other users with owner labels", async () => {
    await app.request("/api/entries", {
      method: "POST",
      headers: { "x-dev-user": "mom", "content-type": "application/json" },
      body: JSON.stringify({ ...entry, traditional: "你好", pinyin: "nǐ hǎo" }),
    });
    const all = await (await app.request("/api/entries?scope=all", { headers: H })).json();
    expect(all.length).toBe(2);
    const owners = all.map((e: { userName: string }) => e.userName);
    expect(owners).toContain("Baba");
    expect(owners).toContain("mom");
  });

  it("PATCH updates notes; DELETE removes", async () => {
    const list = await (await app.request("/api/entries?scope=mine", { headers: H })).json();
    const id = list[0].id;
    const patched = await app.request(`/api/entries/${id}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ notes: "kid says this constantly" }),
    });
    expect(((await patched.json()) as { notes: string }).notes).toContain("constantly");
    const del = await app.request(`/api/entries/${id}`, { method: "DELETE", headers: H });
    expect(del.status).toBe(204);
    const after = await (await app.request("/api/entries?scope=mine", { headers: H })).json();
    expect(after.length).toBe(0);
  });
});

describe("search", () => {
  it("q matches pinyin, hanzi and english (case-insensitive)", async () => {
    await app.request("/api/entries", {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        traditional: "睡覺", simplified: "睡觉", pinyin: "shuì jiào", pinyinFlat: "shuijiao",
        bpmf: "ㄕㄨㄟˋ ㄐㄧㄠˋ", english: "to sleep", register: "casual", source: "pinyin",
        syllables: [[{ h: "睡", py: "shuì", bpmf: "ㄕㄨㄟˋ" }, { h: "覺", py: "jiào", bpmf: "ㄐㄧㄠˋ" }]],
      }),
    });
    for (const q of ["睡", "shui", "SHUIJIAO", "sleep"]) {
      const r = await (await app.request(`/api/entries?scope=mine&q=${encodeURIComponent(q)}`, { headers: H })).json();
      expect(r.length, `q=${q}`).toBe(1);
    }
  });
});

describe("hanzi input", () => {
  it("POST /api/ask/hanzi segments and defines known words", async () => {
    const res = await app.request("/api/ask/hanzi", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "我要睡覺" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const words: { traditional: string; known: boolean; english: string }[] = body.words;
    expect(words.map((w) => w.traditional)).toEqual(["我", "要", "睡覺"]);
    expect(words.every((w) => w.known)).toBe(true);
    expect(words[2]!.english.toLowerCase()).toContain("sleep");
  });

  it("marks unknown segments", async () => {
    const res = await app.request("/api/ask/hanzi", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "我要𪚥" }),
    });
    const body = await res.json();
    expect(body.words.at(-1)?.known).toBe(false);
  });
});

describe("proxy-auth mode", () => {
  it("name comes from proxy and is not editable", async () => {
    process.env.TRUST_PROXY_HEADERS = "1";
    try {
      const tmp = "./data/test-proxy.db";
      rmSync(tmp, { force: true });
      const proxyApp = (await makeApp({ sqlitePath: tmp })).app;
      const res = await proxyApp.request("/api/me", { headers: { "x-remote-user": "hk.wife@fam.io", "x-remote-name": "Mama" } });
      const me = await res.json();
      expect(me.name).toBe("Mama");
      expect(me.nameFromProxy).toBe(true);
      const patched = await proxyApp.request("/api/me", {
        method: "PATCH",
        headers: { "x-remote-user": "hk.wife@fam.io", "content-type": "application/json" },
        body: JSON.stringify({ name: "Mama Bear", annotations: "pinyin" }),
      });
      const after = await patched.json();
      expect(after.name).toBe("Mama Bear"); // user override is honored
      expect(after.annotations).toBe("pinyin"); // applied
    } finally {
      process.env.TRUST_PROXY_HEADERS = "0";
    }
  });
});

describe("translate alternatives (sense disambiguation)", () => {
  it("returns render-ready alternatives with valid syllables", async () => {
    const res = await app.request("/api/ask/translate", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "airline flight" }),
    });
    expect(res.status).toBe(200);
    const card = await res.json();
    expect(card.casual.traditional).toBe("航班"); // honors "not the plane" hint in fixture
    const alts = card.alternatives ?? [];
    expect(alts.length).toBeGreaterThanOrEqual(2);
    for (const a of alts) {
      for (const reg of ["casual", "formal"] as const) {
        const v = a[reg];
        expect(v.variant.traditional.length).toBeGreaterThan(0);
        const flat = v.syllables.flat();
        expect(flat.length).toBe([...v.variant.traditional].filter((c) => /\p{Script=Han}/u.test(c)).length);
        expect(flat.every((c: { bpmf: string }) => c.bpmf.length > 0)).toBe(true);
      }
    }
    const senses = alts.map((a: { casual: { variant: { traditional: string } } }) => a.casual.variant.traditional);
    expect(senses).toContain("飛機票");
  });
});

describe("tts mode selection", () => {
  it("TTS_MODE=browser forces browser even with a model configured", async () => {
    process.env.TTS_MODE = "browser";
    process.env.MODEL_TTS = "kokoro";
    try {
      const tmp = "./data/test-tts.db";
      rmSync(tmp, { force: true });
      const a = (await makeApp({ sqlitePath: tmp })).app;
      const s = await (await a.request("/api/tts/status")).json();
      expect(s).toEqual({ available: false, mode: "browser" });
    } finally {
      process.env.TTS_MODE = undefined;
      process.env.MODEL_TTS = undefined;
    }
  });

  it("mock mode never exposes server tts", async () => {
    const s = await (await app.request("/api/tts/status")).json();
    expect(s.available).toBe(false);
  });
});

describe("audience fine-tune", () => {
  it("persists per user and flows to translate", async () => {
    const patched = await app.request("/api/me", {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ audience: "talking to my 3-year-old" }),
    });
    expect(((await patched.json()) as { audience: string }).audience).toBe("talking to my 3-year-old");
    const again = await (await app.request("/api/me", { headers: H })).json();
    expect(again.audience).toBe("talking to my 3-year-old");
    // clearing works too
    const cleared = await app.request("/api/me", {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ audience: null }),
    });
    expect(((await cleared.json()) as { audience: string | null }).audience).toBeNull();
  });
});
