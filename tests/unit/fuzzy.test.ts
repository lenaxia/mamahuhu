import { describe, expect, it } from "vitest";
import { buildIndex, interpret, candidates, normalizePinyinInput, splitToken } from "../../src/shared/fuzzy";
import { loadCedict, flatOf, type DictWord } from "../../src/shared/cedict";

function w(traditional: string, simplified: string, pyNum: string, english: string): DictWord {
  return { traditional, simplified, pyNum, pyFlat: flatOf(pyNum), english };
}

const mini: DictWord[] = [
  w("你好", "你好", "ni3 hao3", "hello / hi"),
  w("我", "我", "wo3", "I / me"),
  w("不", "不", "bu4", "not / no"),
  w("知道", "知道", "zhi dao5", "to know"),
  w("再見", "再见", "zai4 jian4", "goodbye"),
  w("謝謝", "谢谢", "xie4 xie5", "thank you"),
  w("睡覺", "睡觉", "shui4 jiao4", "sleep"),
  w("該", "该", "gai1", "should"),
  w("了", "了", "le5", "completed action particle"),
  w("水", "水", "shui3", "water"),
  w("腳", "脚", "jiao3", "foot / leg"),
  w("叫", "叫", "jiao4", "to call / to be called"),
  w("吃", "吃", "chi1", "to eat"),
  w("飯", "饭", "fan4", "rice / meal"),
  w("吃飯", "吃饭", "chi1 fan4", "to eat a meal"),
];

const index = buildIndex(mini);

const first = <T,>(arr: T[]): T => {
  const v = arr[0];
  if (v === undefined) throw new Error("expected non-empty array");
  return v;
};

describe("normalizePinyinInput", () => {
  it("repairs common misspellings", () => {
    expect(normalizePinyinInput("Tsai jian!")).toEqual(["cai", "jian"]);
    expect(normalizePinyinInput("shoo")).toEqual(["shu"]);
    expect(normalizePinyinInput("shee-jieh")).toEqual(["shi", "jieh"]);
    expect(normalizePinyinInput("nü3 hǎo")).toEqual(["nv", "hao"]);
  });
});

describe("splitToken", () => {
  it("splits unspaced pinyin", () => {
    expect(splitToken("nihao", index.syllables)).toEqual(["ni", "hao"]);
    expect(splitToken("zaijian", index.syllables)).toEqual(["zai", "jian"]);
    expect(splitToken("gaishuijiaole", index.syllables)).toEqual(["gai", "shui", "jiao", "le"]);
  });
  it("returns null for impossible tokens", () => {
    expect(splitToken("qqq", index.syllables)).toBeNull();
  });
});

describe("interpret", () => {
  it("interprets spaced pinyin", () => {
    const r = interpret(["wo", "bu", "zhi", "dao"], index);
    expect(first(r).traditional).toBe("我不知道");
    expect(first(r).bpmf).toContain("ㄅㄨˋ");
  });

  it("interprets unspaced pinyin", () => {
    const r = interpret(["nihao"], index);
    expect(first(r).traditional).toBe("你好");
    expect(first(r).pinyin).toBe("nǐ hǎo");
    expect(first(r).exactEntry).toBe(true);
    expect(first(r).english.toLowerCase()).toContain("hello");
  });

  it("repairs misspellings and interprets", () => {
    const r = interpret(["zai", "jian"], index);
    expect(first(r).traditional).toBe("再見");
  });

  it("prefers multi-char words over char soup", () => {
    const r = interpret(["gai", "shui", "jiao", "le"], index);
    const words = first(r).words.map((x) => x.traditional);
    expect(words).toEqual(["該", "睡覺", "了"]);
  });

  it("returns nothing when a token can't be split", () => {
    expect(interpret(["qqq"], index)).toEqual([]);
  });
});

describe("candidates", () => {
  it("offers per-syllable character matches", () => {
    const c = candidates(["jiao"], index);
    const trads = c.map((x) => x.traditional);
    expect(trads).toContain("腳");
    expect(trads).toContain("叫");
  });
});

describe("integration with real CC-CEDICT", () => {
  it("loads and interprets", () => {
    const real = buildIndex(loadCedict());
    expect(real.byFlat.size).toBeGreaterThan(20000);
    const r1 = interpret(["wo", "bu", "zhi", "dao"], real);
    expect(first(r1).traditional).toBe("我不知道");
    const r2 = interpret(splitToken("shuijiao", real.syllables)!, real);
    expect(first(r2).traditional).toContain("睡覺");
    const r3 = interpret(normalizePinyinInput("xie xie"), real);
    expect(first(r3).traditional).toBe("謝謝");
  }, 30000);
});
