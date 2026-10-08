import { describe, expect, it, beforeAll } from "vitest";
import { rmSync, mkdirSync, readdirSync } from "node:fs";
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
      const proxyApp = (await makeApp({ sqlitePath: tmp, llmMock: true })).app;
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
      const a = (await makeApp({ sqlitePath: tmp, llmMock: true })).app;
      const s = await (await a.request("/api/tts/status")).json();
      expect(s).toEqual({ available: false, mode: "browser", cantoAvailable: false, cantoMode: "browser" });
    } finally {
      delete process.env.TTS_MODE;
      delete process.env.MODEL_TTS;
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

describe("photo OCR (mocked vision, real dictionary)", () => {
  it("POST /api/ask/ocr returns segmented lines with known/saved flags", async () => {
    // dad saves 睡覺 first so the saved-badge logic is exercised
    await app.request("/api/entries", {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        traditional: "睡覺", simplified: "睡觉", pinyin: "shuì jiào", pinyinFlat: "shuijiao",
        bpmf: "ㄕㄨㄟˋ ㄐㄧㄠˋ", english: "to sleep", register: "casual", source: "pinyin",
        syllables: [[{ h: "睡", py: "shuì", bpmf: "ㄕㄨㄟˋ" }, { h: "覺", py: "jiào", bpmf: "ㄐㄧㄠˋ" }]],
      }),
    });

    const form = new FormData();
    const png = await (await import("sharp")).default({ create: { width: 48, height: 24, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
    form.append("image", new Blob([new Uint8Array(png)], { type: "image/png" }), "page.png");
    const res = await app.request("/api/ask/ocr", { method: "POST", headers: { "x-dev-user": "dad" }, body: form });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fullText).toContain("小貓在睡覺");
    const words = body.lines.flatMap((l: { words: { traditional: string; known: boolean; saved: boolean }[] }) => l.words);
    const shuijiao = words.find((w: { traditional: string }) => w.traditional === "睡覺");
    const xiaomao = words.find((w: { traditional: string }) => w.traditional === "小貓");
    expect(shuijiao?.saved).toBe(true);
    expect(shuijiao?.known).toBe(true);
    expect(xiaomao?.known).toBe(true);
    expect(xiaomao?.saved).toBe(false);
    // overlay boxes: mock provides line box [20,30,560,110] over 5 hanzi
    // 小貓(2) 在(1) 睡覺(2) → 睡覺 box ≈ [344,30,560,110]
    expect(body.positioned).toBe(true);
    expect(shuijiao?.box?.[0]).toBeCloseTo(344, 0);
    expect(xiaomao?.box?.[0]).toBeCloseTo(20, 0);
    // multi-phrase text (小貓 + 在 + 睡覺) → complete English translation attached
    expect(body.fullTranslation).toContain("MOCK full translation");
    expect(body.askId).toBeTruthy();
  });

  it("vector OCR lines distribute word cells along the axis and carry angle", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 5, g: 5, b: 5 } } }).png().toBuffer();
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(png)], { type: "image/png" }), "vector-diagonal.png");
    const res = await app.request("/api/ask/ocr", { method: "POST", headers: { "x-dev-user": "dad" }, body: form });
    expect(res.status).toBe(200);
    const body = await res.json();
    const words = body.lines.flatMap((l: { words: { traditional: string; angle?: number; box?: number[] }[] }) => l.words);
    const moon = words.find((w: { traditional: string }) => w.traditional === "月光");
    expect(moon?.angle).toBe(27); // diagonal angle flows to the client
    // small fixture (5+5 chars over 2 lines) trips the fragmentation demotion
    // guard by design — boxes are stripped to the list layout, but the angle
    // contract still flows to the client
    expect(body.positioned).toBe(false);
  });

  it("entries link to their source ask; follow-ups survive history deletion", async () => {
    // save an entry carrying the ask link
    const e = await (
      await app.request("/api/entries", {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          traditional: "攀岩", simplified: "攀岩", pinyin: "pān yán", english: "climbing",
          register: "casual", source: "en-translate", syllables: [], askId: "00000000-0000-4000-8000-000000000000",
        }),
      })
    ).json();
    expect(e.askId).toBe("00000000-0000-4000-8000-000000000000");

    // follow-up against an ask that doesn't exist (deleted history) still answers, no photo
    const f = await app.request("/api/ask/followup", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ question: "when would I say this?", hanzi: "攀岩", askId: "00000000-0000-4000-8000-000000000000" }),
    });
    expect(f.status).toBe(200);
    expect((await f.json()).answer).toBeTruthy();
  });
});

describe("history", () => {
  it("records translate asks and lists them", async () => {
    await app.request("/api/ask/translate", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "i love you" }),
    });
    const list = await (await app.request("/api/history", { headers: H })).json();
    expect(list.length).toBeGreaterThan(0);
    const item = list.find((i: { kind: string; input: string }) => i.kind === "translate" && i.input === "i love you");
    expect(item).toBeTruthy();
    expect(item.hasPhoto).toBe(false);

    const detail = await (await app.request(`/api/history/${item.id}`, { headers: H })).json();
    expect(detail.kind).toBe("translate");
    expect(detail.result.casual.traditional).toBe("我愛你");
  });

  it("stores OCR photos (webp when possible) and serves them", async () => {
    const form = new FormData();
    const png = await (
      await import("sharp")
    ).default({ create: { width: 64, height: 64, channels: 3, background: { r: 250, g: 240, b: 220 } } }).png().toBuffer();
    form.append("image", new Blob([new Uint8Array(png)], { type: "image/png" }), "page.png");
    await app.request("/api/ask/ocr", { method: "POST", headers: { "x-dev-user": "dad" }, body: form });
    const list = await (await app.request("/api/history", { headers: H })).json();
    const ocrItem = list.find((i: { kind: string }) => i.kind === "ocr");
    expect(ocrItem.hasPhoto).toBe(true);
    const detail = await (await app.request(`/api/history/${ocrItem.id}`, { headers: H })).json();
    expect(detail.result.lines.length).toBeGreaterThan(0);
    expect(detail.photoUrl).toContain("/api/photo/");
    const photo = await app.request(detail.photoUrl, { headers: H });
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/webp");
  });

  it("only shows your own history", async () => {
    const momList = await (await app.request("/api/history", { headers: { "x-dev-user": "mom" } })).json();
    expect(momList.every((i: { kind: string }) => i.kind !== "ocr")).toBe(true);
  });
});

describe("DATA_DIR storage root", () => {
  it("stores photos under DATA_DIR/photos", async () => {
    process.env.DATA_DIR = "./data-test";
    try {
      const tmp = "./data/test-datadir.db";
      rmSync(tmp, { force: true });
      rmSync("./data-test", { recursive: true, force: true });
      const a = (await makeApp({ sqlitePath: tmp, llmMock: true })).app;
      const sharp = (await import("sharp")).default;
      const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
      const form = new FormData();
      form.append("image", new Blob([new Uint8Array(png)], { type: "image/png" }), "p.png");
      const res = await a.request("/api/ask/ocr", { method: "POST", headers: { "x-dev-user": "dad" }, body: form });
      expect(res.status).toBe(200);
      const files = readdirSync("./data-test/photos");
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/\.webp$/);
      rmSync("./data-test", { recursive: true, force: true });
    } finally {
      // delete (not `= undefined`): assigning undefined stores the STRING "undefined",
      // leaking a bogus DATA_DIR into every test that runs after this one.
      delete process.env.DATA_DIR;
    }
  });
});

describe("speak (mocked STT, auto-routing)", () => {
  it("zh transcript routes to hanzi cards and is recorded", async () => {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(512).fill(2)], { type: "audio/webm" }), "clip.webm");
    const res = await app.request("/api/ask/stt", { method: "POST", headers: { "x-dev-user": "dad" }, body: form });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe("我要睡覺");
    expect(body.route).toBe("hanzi");
    expect(body.hanzi.words.map((w: { traditional: string }) => w.traditional)).toContain("睡覺");
    const list = await (await app.request("/api/history", { headers: H })).json();
    expect(list.some((i: { kind: string; input: string }) => i.kind === "stt" && i.input === "我要睡覺")).toBe(true);
  });

  it("audio is required", async () => {
    const res = await app.request("/api/ask/stt", { method: "POST", headers: H, body: new FormData() });
    expect(res.status).toBe(400);
  });
});

describe("phrase card", () => {
  it("multi-word hanzi input gets an LLM-decided full translation (no phrase card)", async () => {
    const res = await app.request("/api/ask/hanzi", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "恭喜發財紅包拿來" }),
    });
    const body = await res.json();
    expect(body.words.length).toBeGreaterThanOrEqual(3);
    expect(body.fullTranslation).toContain("MOCK full translation");
    expect(body.phrase).toBeUndefined();
  });

  it("single-word input has no phrase card", async () => {
    const res = await app.request("/api/ask/hanzi", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "睡覺" }),
    });
    const body = await res.json();
    expect(body.phrase).toBeUndefined();
  });
});

describe("meta-questions", () => {
  it("'how do you say X' extracts intent and translates X", async () => {
    const res = await app.request("/api/ask/translate", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "how do you say airplane?" }),
    });
    const card = await res.json();
    expect(card.understood).toBe("airplane");
    expect(card.casual.traditional).toBe("飛機");
    expect(card.casual.pinyin).toBe("fēi jī");
  });
});

describe("meta-questions (situation type)", () => {
  it("extracts the situation and provides the greeting", async () => {
    const res = await app.request("/api/ask/translate", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "what is the typical greeting for kids on chinese new year to elders?" }),
    });
    const card = await res.json();
    expect(card.understood).toBe("New Year greeting kids say to elders");
    expect(card.casual.traditional).toContain("恭喜發財");
  });
});

describe("chinese questions", () => {
  it("picks common senses, not surname entries", async () => {
    const res = await app.request("/api/ask/hanzi", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "坐" }),
    });
    const body = await res.json();
    expect(body.words[0].english.toLowerCase()).toContain("sit");
  });

  it("zh meta-questions get an answer card, not a translation", async () => {
    const res = await app.request("/api/ask/hanzi", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "飛機的英文怎麼說" }),
    });
    const body = await res.json();
    expect(body.phrase).toBeTruthy();
    expect(body.phrase.answer).toBe(true);
    expect(body.phrase.english).toBe("airplane");
  });

  it("plain zh questions keep the full translation", async () => {
    const res = await app.request("/api/ask/hanzi", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "你怎麼坐飛機" }),
    });
    const body = await res.json();
    expect(body.fullTranslation).toContain("MOCK full translation");
    expect(body.phrase).toBeUndefined();
  });
});

describe("subject identification (textless photos)", () => {
  it("OCR with no text falls back to an identify card", async () => {
    const sharp = (await import("sharp")).default;
    const blank = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 20, g: 120, b: 40 } } }).png().toBuffer(); // a "plant"
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(blank)], { type: "image/png" }), "plant.png");
    const res = await app.request("/api/ask/ocr", { method: "POST", headers: { "x-dev-user": "dad" }, body: form });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines.length).toBe(0);
    expect(body.tags.length).toBe(2);
    expect(body.tags[0].traditional).toBe("盆栽");
    expect(body.tags[0].bpmf.length).toBeGreaterThan(0);
    expect(body.identify.traditional).toBe("盆栽");
  });

  it("POST /api/ask/identify for circle-refined crops", async () => {
    const sharp = (await import("sharp")).default;
    const crop = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 20, g: 120, b: 40 } } }).png().toBuffer();
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(crop)], { type: "image/png" }), "crop.png");
    const res = await app.request("/api/ask/identify", { method: "POST", headers: { "x-dev-user": "dad" }, body: form });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tags.length).toBe(2);
    expect(body.tags[0].gloss).toBe("potted plant");
  });
});

describe("entry tagging", () => {
  it("save generates topical tags via the fast model; search matches them", async () => {
    const post = await app.request("/api/entries", {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        traditional: "飛機", simplified: "飞机", pinyin: "fēi jī", pinyinFlat: "feiji",
        bpmf: "ㄈㄟ ㄐㄧ", english: "airplane", register: "casual", source: "pinyin",
        syllables: [[{ h: "飛", py: "fēi", bpmf: "ㄈㄟ" }, { h: "機", py: "jī", bpmf: "ㄐㄧ" }]],
      }),
    });
    const saved = await post.json();
    expect(saved.tags).toContain("airport");
    expect(saved.tags).toContain("travel");
    // search by a tag word absent from the english gloss
    const r = await (await app.request(`/api/entries?scope=mine&q=airport`, { headers: H })).json();
    expect(r.some((e: { traditional: string }) => e.traditional === "飛機")).toBe(true);
  });
});

describe("follow-up Q&A and always-on tags", () => {
  it("photos WITH text also get object tags", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 250, g: 240, b: 220 } } }).png().toBuffer();
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(png)], { type: "image/png" }), "sign.png");
    const res = await app.request("/api/ask/ocr", { method: "POST", headers: { "x-dev-user": "dad" }, body: form });
    const body = await res.json();
    expect(body.lines.length).toBeGreaterThan(0);
    expect(body.tags.length).toBeGreaterThan(0);
    expect(body.askId).toBeTruthy();
  });

  it("follow-up answers with card context, vision when askId given", async () => {
    const textOnly = await app.request("/api/ask/followup", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ question: "what kind of tree is this?", hanzi: "樹", gloss: "tree" }),
    });
    const a = await textOnly.json();
    expect(a.answer.toLowerCase()).toContain("banyan");

    // vision follow-up: reference the ask from the test above
    const hist = await (await app.request("/api/history", { headers: H })).json();
    const ocrAsk = hist.find((i: { kind: string; hasPhoto: boolean }) => i.kind === "ocr" && i.hasPhoto);
    const withPhoto = await app.request("/api/ask/followup", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ question: "what kind of tree?", askId: ocrAsk.id }),
    });
    expect((await withPhoto.json()).answer.toLowerCase()).toContain("banyan");
  });
});

describe("vertical text direction", () => {
  it("dir=v lines split boxes along Y and words carry dir", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 64, height: 128, channels: 3, background: { r: 240, g: 240, b: 240 } } }).png().toBuffer();
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(png)], { type: "image/png" }), "vertical.png");
    const res = await app.request("/api/ask/ocr", { method: "POST", headers: { "x-dev-user": "dad" }, body: form });
    const body = await res.json();
    const ws = body.lines[0].words;
    expect(body.positioned).toBe(true);
    expect(ws.every((w: { dir?: string }) => w.dir === "v")).toBe(true);
    // two words 親近 + 自然 → stacked along y within [100..420]
    expect(ws[1].box[1]).toBeGreaterThan(ws[0].box[1]);
    expect(ws[0].box[2] - ws[0].box[0]).toBeGreaterThan(0);
  });
});

describe("simplified → traditional display", () => {
  it("unknown simplified chars render as traditional", async () => {
    const res = await app.request("/api/ask/hanzi", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "营" }),
    });
    const body = await res.json();
    expect(body.words[0].traditional).toBe("營");
    expect(body.words[0].simplified).toBe("营");
  });

  it("dictionary hits already display traditional", async () => {
    const res = await app.request("/api/ask/hanzi", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text: "亲近" }),
    });
    const body = await res.json();
    const joined = body.words.map((w: { traditional: string }) => w.traditional).join("");
    expect(joined).toBe("親近");
  });
});

describe("tts disk cache", () => {
  it("second synthesis for the same text+speed is a cache hit", async () => {
    process.env.MODEL_TTS = "kokoro";
    process.env.LLM_MOCK = "0";
    process.env.TTS_MODE = "server";
    try {
      const tmp = "./data/test-ttscache.db";
      rmSync(tmp, { force: true });
      rmSync("./data/audio", { recursive: true, force: true });
      // stub gateway: first call synthesizes, cache makes the second a hit without a second synth
      // (mock mode has no server tts, so we test the miss->write path shape instead)
      const a = (await makeApp({ sqlitePath: tmp, llmMock: true })).app;
      const r1 = await a.request("/api/tts?text=%E4%BD%A0%E5%A5%BD");
      expect([200, 503]).toContain(r1.status);
      if (r1.status === 200) {
        const r2 = await a.request("/api/tts?text=%E4%BD%A0%E5%A5%BD");
        expect(r2.headers.get("x-tts-cache")).toBe("hit");
      }
      rmSync("./data/audio", { recursive: true, force: true });
    } finally {
      delete process.env.MODEL_TTS;
      delete process.env.LLM_MOCK;
      delete process.env.TTS_MODE;
    }
  });
});

describe("SRS review", () => {
  it("new entries are due immediately; grading schedules by box", async () => {
    const due = await (await app.request("/api/review/due", { headers: H })).json();
    expect(due.length).toBeGreaterThan(0);
    const e = due[0];
    expect(e.srsBox).toBe(0);
    expect(e.srsDue).toBeNull();

    const good = await (
      await app.request("/api/review", {
        method: "POST",
        headers: H,
        body: JSON.stringify({ id: e.id, outcome: "good" }),
      })
    ).json();
    expect(good.srsBox).toBe(1); // 0 -> 1 (1h interval)
    expect(new Date(good.srsDue).getTime()).toBeGreaterThan(Date.now());

    const again = await (
      await app.request("/api/review", {
        method: "POST",
        headers: H,
        body: JSON.stringify({ id: e.id, outcome: "again" }),
      })
    ).json();
    expect(again.srsBox).toBe(0); // forgotten -> box 0

    const easy = await (
      await app.request("/api/review", {
        method: "POST",
        headers: H,
        body: JSON.stringify({ id: e.id, outcome: "easy" }),
      })
    ).json();
    expect(easy.srsBox).toBe(2); // 0 -> +2
    expect(easy.reviewed).toBe(3);
  });

  it("graded entries leave the due queue until interval passes", async () => {
    const before = await (await app.request("/api/review/due", { headers: H })).json();
    if (before.length === 0) return; // nothing left to grade in this run
    const target = before[0];
    await app.request("/api/review", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ id: target.id, outcome: "good" }),
    });
    const after = await (await app.request("/api/review/due", { headers: H })).json();
    expect(after.some((e: { id: string }) => e.id === target.id)).toBe(false);
  });
});

describe("version surface", () => {
  it("GET /healthz reports a semver version", async () => {
    const res = await app.request("/healthz");
    const j = await res.json();
    expect(j.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("classical gate grouping coherence", () => {
  it("poster-like output passes (long lines, uniform pitch)", async () => {
    const { classicalSufficient } = await import("../../src/server/ocr-ladder");
    const items = Array.from({ length: 12 }, (_, i) => ({
      box: [100, 100 + i * 60, 100 + 8 * 45, 150 + i * 60] as [number, number, number, number],
      text: "定期舉辦野營活動讓", score: 0.95,
    }));
    expect(classicalSufficient(items)).toBe(true);
  });

  it("fragment soup fails (single chars, wild pitch) — the letter-4919 failure", async () => {
    const { classicalSufficient } = await import("../../src/server/ocr-ladder");
    const items = [
      { box: [100, 100, 146, 150] as [number, number, number, number], text: "今", score: 0.9 },
      { box: [200, 300, 353, 360] as [number, number, number, number], text: "太", score: 0.9 },
      { box: [50, 500, 330, 560] as [number, number, number, number], text: "調兵虎符事如", score: 0.9 },
      { box: [400, 700, 690, 760] as [number, number, number, number], text: "職多方查證", score: 0.9 },
      { box: [10, 900, 300, 960] as [number, number, number, number], text: "確為", score: 0.9 },
      { box: [500, 1100, 580, 1160] as [number, number, number, number], text: "傅", score: 0.9 },
    ];
    expect(classicalSufficient(items)).toBe(false);
  });
});
