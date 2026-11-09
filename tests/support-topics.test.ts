import { test } from "node:test";
import assert from "node:assert/strict";
import { foldTopics, HIDDEN_BELOW, SUPPORT_TOPICS, TopicLabelSchema, type TopicRow } from "../workers/lib/support-topics";

const rows = (month: string, topic: string | null, n: number, extra: Partial<TopicRow> = {}): TopicRow[] =>
  Array.from({ length: n }, (_, i) => ({ firstIn: `${month}-0${1 + (i % 9)}T10:00:00.000Z`, topic, negative: false, money: null, ...extra }));

test("a month counts its labelled threads per topic with share and change from the month before (B-238)", () => {
  const months = foldTopics([...rows("2026-09", "payments", 10), ...rows("2026-09", "how_to", 10), ...rows("2026-10", "payments", 15), ...rows("2026-10", "how_to", 5)]);
  assert.deepEqual(months.map((m) => m.month), ["2026-09", "2026-10"]);
  const oct = months[1];
  assert.equal(oct.threads, 20);
  assert.equal(oct.labelled, 20);
  const pay = oct.topics.find((t) => t.topic === "payments")!;
  assert.equal(pay.threads, 15);
  assert.equal(pay.share, 0.75);
  assert.equal(pay.change, 0.25);
  assert.deepEqual(oct.rising, ["payments"]);
  assert.deepEqual(oct.new, []);
});

test("a topic under the floor folds into hidden; a new topic is named only once it shows (B-238)", () => {
  const months = foldTopics([...rows("2026-09", "payments", 10), ...rows("2026-10", "payments", 10), ...rows("2026-10", "bug", 6), ...rows("2026-10", "privacy", HIDDEN_BELOW - 1)]);
  const oct = months[1];
  assert.equal(oct.topics.some((t) => t.topic === "privacy"), false);
  assert.deepEqual(oct.hidden, { topics: 1, threads: HIDDEN_BELOW - 1 });
  assert.deepEqual(oct.new, ["bug"]);
  assert.equal(months[0].new.length, 0, "the first month has nothing to compare with");
});

test("unlabelled threads count in threads, not in shares; negative and money shares are of the labelled (B-238)", () => {
  const months = foldTopics([...rows("2026-10", null, 4), ...rows("2026-10", "refund", 6, { negative: true, money: "refund" }), ...rows("2026-10", "how_to", 4)]);
  const m = months[0];
  assert.equal(m.threads, 14);
  assert.equal(m.labelled, 10);
  assert.equal(m.negativeShare, 0.6);
  assert.deepEqual(m.money, { refund: 0.6, charge: 0, purchase_failed: 0 });
});

test("from and to bound the months; the month before from still gives the change (B-238)", () => {
  const all = [...rows("2026-08", "payments", 10), ...rows("2026-09", "payments", 5), ...rows("2026-09", "bug", 5), ...rows("2026-10", "bug", 10)];
  const months = foldTopics(all, { from: "2026-09", to: "2026-09" });
  assert.deepEqual(months.map((m) => m.month), ["2026-09"]);
  assert.equal(months[0].topics.find((t) => t.topic === "payments")!.change, -0.5);
  assert.deepEqual(months[0].new, ["bug"]);
});

test("the label schema accepts only the fixed topics and money kinds (B-238)", () => {
  assert.ok(SUPPORT_TOPICS.includes("other"));
  assert.equal(TopicLabelSchema.safeParse({ topic: "payments", negative: false, money: null }).success, true);
  assert.equal(TopicLabelSchema.safeParse({ topic: "anything", negative: false, money: null }).success, false);
  assert.equal(TopicLabelSchema.safeParse({ topic: "refund", negative: true, money: "bitcoin" }).success, false);
});

import { labelMailboxes } from "../workers/lib/support-topics";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const fakeBox = (n: number) => {
  const saved: { key: string; topic: string }[] = [];
  return { saved, topicCandidates: async (limit: number) => Array.from({ length: Math.min(n - saved.length, limit) }, (_, i) => ({ key: `t${saved.length + i}`, firstIn: "2026-10-01T00:00:00Z", subject: "Refund", body: "<p>I want my money back</p>" })),
    saveTopics: async (labels: { key: string; topic: string }[]) => { saved.push(...labels); return labels.length; } };
};

test("a labelling pass spends at most its calls, mailbox by mailbox, and says when more wait (B-238)", async () => {
  const a = fakeBox(3), b = fakeBox(5);
  const seen: string[] = [];
  const pass = await labelMailboxes(["a@x.example", "b@x.example"], (e) => (e.startsWith("a") ? a : b), 6,
    async (m) => { seen.push(m.text); return { topic: "refund", negative: true, money: "refund" }; }, "m");
  assert.deepEqual(pass, { calls: 6, labelled: 6, failed: 0, unreadable: 0, more: true });
  assert.equal(a.saved.length, 3);
  assert.equal(b.saved.length, 3);
  assert.equal(seen[0], "I want my money back", "the model reads text, not HTML");
  const rest = await labelMailboxes(["a@x.example", "b@x.example"], (e) => (e.startsWith("a") ? a : b), 6, async () => ({ topic: "refund", negative: false, money: null }), "m");
  assert.deepEqual(rest, { calls: 2, labelled: 2, failed: 0, unreadable: 0, more: false });
});

test("a failed label ends that mailbox's pass and keeps what was labelled (B-238)", async () => {
  const a = fakeBox(4);
  let n = 0;
  const pass = await labelMailboxes(["a@x.example"], () => a, 10, async () => { if (++n === 2) throw new Error("model down"); return { topic: "bug", negative: false, money: null }; }, "m");
  assert.deepEqual(pass, { calls: 2, labelled: 1, failed: 1, unreadable: 0, more: false });
  assert.equal(a.saved.length, 1);
});

test("a real mailbox lists unlabelled conversations newest first, keeps labels once and folds them (B-238)", async () => {
  const bundle = await build({ stdin: { contents: `
    import { MailboxDO } from './workers/durableObject/index';
    export class TestBox extends MailboxDO {}
    export default { async fetch(request, env) {
      const box = env.MAILBOX.getByName('support@acme.example');
      const { op, labels } = await request.json();
      if (op === 'seed') {
        const mail = (id, folder, date, thread, subject) => box.createEmail(folder, { id, sender: 'person@mail.example', recipient: 'support@acme.example', subject, body: '<p>body ' + id + '</p>', date, thread_id: thread }, []);
        await mail('in-1', 'inbox', '2026-10-01T10:00:00.000Z', 't1', 'First');
        await mail('in-1b', 'inbox', '2026-10-02T10:00:00.000Z', 't1', 'Re: First');
        await mail('out-1', 'sent', '2026-10-01T11:00:00.000Z', 't1', 'Re: First');
        await mail('in-2', 'archive', '2026-10-05T09:00:00.000Z', 't2', 'Second');
        await mail('spam-1', 'spam', '2026-10-06T09:00:00.000Z', 't9', 'Spam');
        return Response.json(true);
      }
      if (op === 'candidates') return Response.json(await box.topicCandidates(10));
      if (op === 'save') return Response.json(await box.saveTopics(labels));
      return Response.json(await box.topicThreads());
    }};`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022" });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestBox", useSQLite: true } }, r2Buckets: ["BUCKET"] });
  const call = async (op: string, labels?: unknown) => (await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({ op, labels }) })).json() as Promise<any>;
  try {
    await call("seed");
    const candidates = await call("candidates");
    assert.deepEqual(candidates.map((c: any) => [c.key, c.subject]), [["t2", "Second"], ["t1", "First"]], "newest first, from the first incoming message, no spam");
    assert.match(candidates[1].body, /body in-1/);
    assert.equal(await call("save", [{ key: "t1", topic: "refund", negative: true, money: "refund", model: "m" }]), 1);
    assert.equal(await call("save", [{ key: "t1", topic: "bug", negative: false, money: null, model: "m" }]), 0, "a label is kept once");
    assert.deepEqual((await call("candidates")).map((c: any) => c.key), ["t2"]);
    const rows = (await call("threads")).sort((a: any, b: any) => (a.firstIn < b.firstIn ? -1 : 1));
    assert.deepEqual(rows, [
      { firstIn: "2026-10-01T10:00:00.000Z", topic: "refund", negative: true, money: "refund" },
      { firstIn: "2026-10-05T09:00:00.000Z", topic: null, negative: false, money: null },
    ]);
  } finally { await mf.dispose(); }
});

import { parseLabel } from "../workers/lib/support-topics";

test("a label is read from a model's text answer, with the spellings models use (B-238)", () => {
  assert.deepEqual(parseLabel('{"topic": "refund", "negative": true, "money": "refund"}'), { topic: "refund", negative: true, money: "refund" });
  assert.deepEqual(parseLabel('Sure.\n```json\n{"topic":"How to","negative":"false","money":"none"}\n```'), { topic: "how_to", negative: false, money: null });
  assert.deepEqual(parseLabel('{"note": 1} then {"topic":"bug","negative":false,"money":null}'), { topic: "bug", negative: false, money: null });
  assert.equal(parseLabel("I cannot label this."), null);
  assert.equal(parseLabel('{"topic":"weather","negative":false,"money":null}'), null);
});

import { LabelUnreadable } from "../workers/lib/support-topics";

test("an answer with no label skips only that conversation; the pass goes on (B-238)", async () => {
  const a = fakeBox(4);
  let n = 0;
  const pass = await labelMailboxes(["a@x.example"], () => a, 10, async () => { if (++n === 2) throw new LabelUnreadable(); return { topic: "bug", negative: false, money: null }; }, "m");
  assert.deepEqual(pass, { calls: 4, labelled: 3, failed: 0, unreadable: 1, more: false });
});
