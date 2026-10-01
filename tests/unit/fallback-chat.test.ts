import { describe, expect, it } from "vitest";
import { FallbackChatClient } from "../../src/server/llm";
import type { ChatClient, ChatMessage, Result } from "../../src/server/ports";

const ok = (s: string): Result<string> => ({ ok: true, value: s });
const fail = (e: string): Result<string> => ({ ok: false, error: e });

function stub(responses: Result<string>[]): ChatClient & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    async complete(_m: ChatMessage[], opts?: { model?: string }): Promise<Result<string>> {
      calls.push(opts?.model ?? "(default)");
      return responses[Math.min(i++, responses.length - 1)]!;
    },
  };
}

describe("FallbackChatClient", () => {
  const msgs: ChatMessage[] = [{ role: "user", content: "hi" }];

  it("passes through success without touching the fallback", async () => {
    const inner = stub([ok("fine")]);
    const c = new FallbackChatClient(inner, "backup");
    const r = await c.complete(msgs, { model: "primary" });
    expect(r).toEqual(ok("fine"));
    expect(inner.calls).toEqual(["primary"]);
  });

  it("retries a failed call once on the fallback model", async () => {
    const inner = stub([fail("gateway 503"), ok("backup answer")]);
    const c = new FallbackChatClient(inner, "backup");
    const r = await c.complete(msgs, { model: "primary" });
    expect(r).toEqual(ok("backup answer"));
    expect(inner.calls).toEqual(["primary", "backup"]);
  });

  it("returns the failure when both models fail", async () => {
    const inner = stub([fail("gateway 503"), fail("gateway 500")]);
    const c = new FallbackChatClient(inner, "backup");
    const r = await c.complete(msgs, { model: "primary" });
    expect(r).toEqual(fail("gateway 500"));
    expect(inner.calls).toEqual(["primary", "backup"]);
  });

  it("no fallback configured — single attempt, error passed through (graceful)", async () => {
    const inner = stub([fail("gateway 503")]);
    const c = new FallbackChatClient(inner, undefined);
    const r = await c.complete(msgs, { model: "primary" });
    expect(r).toEqual(fail("gateway 503"));
    expect(inner.calls).toEqual(["primary"]);
  });

  it("never retries the fallback model on itself", async () => {
    const inner = stub([fail("gateway 503")]);
    const c = new FallbackChatClient(inner, "backup");
    const r = await c.complete(msgs, { model: "backup" });
    expect(r).toEqual(fail("gateway 503"));
    expect(inner.calls).toEqual(["backup"]);
  });
});
