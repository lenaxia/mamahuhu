import { describe, expect, it } from "vitest";
import { LlmTranslationService } from "../../src/server/llm";
import type { ChatClient, ChatMessage, Result } from "../../src/server/ports";

/** Degrade behavior for translation responses: hanzi is the payload —
 *  pinyin mismatches must not nuke the card; only a hanzi-less English
 *  echo after a repair retry fails (with a friendly message). */

function chatStub(responses: string[]): ChatClient {
  let i = 0;
  return {
    async complete(_messages: ChatMessage[]): Promise<Result<string>> {
      const value = responses[Math.min(i++, responses.length - 1)];
      return { ok: true, value };
    },
  };
}

const OK_JSON = (trad: string, pinyin: string) =>
  JSON.stringify({
    understood: "",
    casual: { traditional: trad, simplified: trad, pinyin, gloss: "mudslide", note: "" },
    formal: { traditional: trad, simplified: trad, pinyin, gloss: "mudslide", note: "" },
  });

describe("LlmTranslationService degrade", () => {
  it("accepts hanzi with mismatched pinyin (readings come from the dictionary)", async () => {
    const svc = new LlmTranslationService(chatStub([OK_JSON("泥石流", "ni2")]), "test-model");
    const res = await svc.translate("mudslide");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.casual.traditional).toBe("泥石流");
  });

  it("retries an English echo once, then fails with a friendly message", async () => {
    const echo = OK_JSON("mudslide", "mudslide");
    let calls = 0;
    const svc = new LlmTranslationService(
      {
        async complete(): Promise<Result<string>> {
          calls++;
          return { ok: true, value: echo };
        },
      },
      "test-model",
    );
    const res = await svc.translate("mudslide");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("try rephrasing");
    expect(calls).toBe(2);
  });

  it("repairs an English echo when the retry returns hanzi", async () => {
    let calls = 0;
    const svc = new LlmTranslationService(
      {
        async complete(): Promise<Result<string>> {
          calls++;
          return { ok: true, value: calls === 1 ? OK_JSON("mudslide", "mudslide") : OK_JSON("泥石流", "ni2 shi2 liu2") };
        },
      },
      "test-model",
    );
    const res = await svc.translate("mudslide");
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
  });
});
