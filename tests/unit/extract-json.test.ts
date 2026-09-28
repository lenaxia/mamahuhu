import { describe, expect, it } from "vitest";
import { extractJson } from "../../src/server/llm";

describe("extractJson", () => {
  it("parses objects (unchanged behavior)", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a": [1, {"b": "}"}]}\n```')).toEqual({ a: [1, { b: "}" }] });
    expect(extractJson('prose before {"a":1} prose after')).toEqual({ a: 1 });
  });

  it("parses top-level arrays — the tagger shape that silently produced no tags", () => {
    expect(extractJson('["travel", "airport", "documents"]')).toEqual(["travel", "airport", "documents"]);
    expect(extractJson('```json\n["bedtime"]\n```')).toEqual(["bedtime"]);
    expect(extractJson('Sure! ["a", "b"]')).toEqual(["a", "b"]);
  });

  it("handles brackets inside strings", () => {
    expect(extractJson('["a[b]", "{weird}"]')).toEqual(["a[b]", "{weird}"]);
    expect(extractJson('{"k": "v]"}')).toEqual({ k: "v]" });
  });

  it("returns null for non-JSON", () => {
    expect(extractJson("no structure here")).toBeNull();
    expect(extractJson("")).toBeNull();
  });
});
