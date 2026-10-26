import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV3 } from "ai/test";
import { classify, CATEGORIES_PER_CALL } from "../workers/categories/classify";

// C-10: more described categories than one answer holds are asked in several calls, each fully answered.
test("C-10: 41 described categories are classified in calls of a few, and every one gets its verdict", async () => {
  const calls: number[] = [];
  const model = new MockLanguageModelV3({ doGenerate: async (options: any) => {
    const text = JSON.stringify(options.prompt);
    const ids = [...new Set([...text.matchAll(/id\\":\\"(c\d+)/g)].map((m) => m[1]!))];
    calls.push(ids.length);
    return { content: [{ type: "text", text: JSON.stringify({ results: ids.map((id) => ({ id, match: id === "c7", reason: "x" })) }) }], finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] } as any;
  } });
  const categories = Array.from({ length: 41 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, description: `Mail about topic ${i}` }));
  const verdicts = await classify(model, categories, { sender: "a@x.invalid", subject: "s", text: "t", to: "me@owner.example" } as any);
  assert.equal(verdicts.length, 41);
  assert.ok(calls.every((n) => n <= CATEGORIES_PER_CALL), JSON.stringify(calls));
  assert.equal(calls.reduce((a, b) => a + b, 0), 41);
  assert.deepEqual(verdicts.filter((v) => v.match).map((v) => v.id), ["c7"]);
  assert.ok(!verdicts.some((v) => /no answer/.test(v.reason)));
});
