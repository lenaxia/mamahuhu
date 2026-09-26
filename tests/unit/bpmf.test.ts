import { describe, expect, it } from "vitest";
import { numberedToBpmf, numberedToMarks, marksToNumbered, phraseToBpmf } from "../../src/shared/bpmf";

describe("numberedToBpmf", () => {
  const cases: [string, string][] = [
    ["ni3", "ㄋㄧˇ"], ["hao3", "ㄏㄠˇ"], ["bu4", "ㄅㄨˋ"], ["zhi1", "ㄓ"],
    ["dao4", "ㄉㄠˋ"], ["dui4", "ㄉㄨㄟˋ"], ["xuan3", "ㄒㄩㄢˇ"], ["yue4", "ㄩㄝˋ"],
    ["wo3", "ㄨㄛˇ"], ["yi1", "ㄧ"], ["men5", "˙ㄇㄣ"], ["de5", "˙ㄉㄜ"],
    ["ma5", "˙ㄇㄚ"], ["yu2", "ㄩˊ"], ["nü3", "ㄋㄩˇ"], ["nv3", "ㄋㄩˇ"],
    ["nu:3", "ㄋㄩˇ"], ["qu4", "ㄑㄩˋ"], ["er2", "ㄦˊ"], ["er4", "ㄦˋ"],
    ["shan1", "ㄕㄢ"], ["chi1", "ㄔ"], ["shi2", "ㄕˊ"], ["qi1", "ㄑㄧ"],
    ["xi1", "ㄒㄧ"], ["jia1", "ㄐㄧㄚ"], ["dan4", "ㄉㄢˋ"], ["shui4", "ㄕㄨㄟˋ"],
    ["jiao4", "ㄐㄧㄠˋ"], ["xue2", "ㄒㄩㄝˊ"], ["sheng1", "ㄕㄥ"], ["jiong3", "ㄐㄩㄥˇ"],
    ["yong4", "ㄩㄥˋ"], ["xie4", "ㄒㄧㄝˋ"], ["shuo1", "ㄕㄨㄛ"], ["zhong1", "ㄓㄨㄥ"],
    ["wen2", "ㄨㄣˊ"], ["lao3", "ㄌㄠˇ"], ["shi5", "˙ㄕ"], ["ma1", "ㄇㄚ"],
    ["tou2", "ㄊㄡˊ"], ["heng2", "ㄏㄥˊ"], ["ju4", "ㄐㄩˋ"], ["lve4", "ㄌㄩㄝˋ"],
    ["nüe4", "ㄋㄩㄝˋ"], ["xiong1", "ㄒㄩㄥ"], ["yuan2", "ㄩㄢˊ"], ["wei4", "ㄨㄟˋ"],
    ["xiang3", "ㄒㄧㄤˇ"], ["gou3", "ㄍㄡˇ"], ["zhu4", "ㄓㄨˋ"], ["nan2", "ㄋㄢˊ"],
  ];
  it.each(cases)("%s → %s", (input, expected) => {
    expect(numberedToBpmf(input)).toBe(expected);
  });

  it("returns empty string for garbage", () => {
    expect(numberedToBpmf("xyz")).toBe("");
    expect(numberedToBpmf("")).toBe("");
  });
});

describe("numberedToMarks", () => {
  const cases: [string, string][] = [
    ["zhong1", "zhōng"], ["wen2", "wén"], ["ni3", "nǐ"], ["hao3", "hǎo"],
    ["bu4", "bù"], ["zhi1", "zhī"], ["dao4", "dào"], ["dui4", "duì"],
    ["shui4", "shuì"], ["jiao4", "jiào"], ["xue2", "xué"], ["lü4", "lǜ"],
    ["nü3", "nǚ"], ["yue4", "yuè"], ["liu2", "liú"], ["gui4", "guì"],
    ["men5", "men"], ["ma5", "ma"], ["xiang3", "xiǎng"], ["yuan2", "yuán"],
  ];
  it.each(cases)("%s → %s", (input, expected) => {
    expect(numberedToMarks(input)).toBe(expected);
  });
});

describe("marksToNumbered roundtrip", () => {
  it.each([
    ["nǐ", "ni3"], ["shuì", "shui4"], ["lǜ", "lv4"], ["jué", "jue2"],
    ["zhōng", "zhong1"], ["yuè", "yue4"], ["hǎo", "hao3"], ["men", "men1"],
  ])("%s → %s", (input, expected) => {
    expect(marksToNumbered(input)).toBe(expected);
  });
});

describe("phraseToBpmf", () => {
  it("joins syllables", () => {
    expect(phraseToBpmf("bu4 zhi1 dao4")).toBe("ㄅㄨˋ ㄓ ㄉㄠˋ");
    expect(phraseToBpmf("shui4 jiao4")).toBe("ㄕㄨㄟˋ ㄐㄧㄠˋ");
  });
});
