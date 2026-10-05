import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_WAIT_MS,
  answeringOrder,
  decideClaim,
  duplicateReason,
  electAnswerer,
  messageKey,
  type ClaimRow,
} from "../workers/agents/dedupe";

// B-22: one message delivered to several agent addresses of one workspace is answered once,
// from the address it was sent To. The pure parts: which message it is, who answers, and the
// claim decision the registry applies atomically (tests/agents-registry.test.ts runs it in workerd).
const headers = (list: Record<string, string>) => JSON.stringify(Object.entries(list).map(([key, value]) => ({ key, value })));
const email = (over: Record<string, unknown> = {}) => ({
  sender: "ann@customer.invalid", subject: "Price?", message_id: "abc@customer.invalid",
  recipient: "support@project.invalid", cc: "sales@project.invalid",
  raw_headers: headers({ date: "Mon, 5 Oct 2026 10:00:00 +0000", to: "support@project.invalid", cc: "sales@project.invalid" }),
  ...over,
});

test("a message is known by its RFC Message-ID, the same in every delivery (B-22)", async () => {
  const a = await messageKey(email());
  assert.ok(a?.startsWith("mid:"));
  assert.equal(await messageKey(email({ message_id: "<abc@customer.invalid>", recipient: "other@project.invalid" })), a, "brackets and delivery do not change it");
  assert.notEqual(await messageKey(email({ message_id: "def@customer.invalid" })), a);
});

test("without a Message-ID the key falls back to sender, subject, Date, To and Cc; without a Date there is none (B-22)", async () => {
  const fallback = await messageKey(email({ message_id: null }));
  assert.ok(fallback?.startsWith("hdr:"));
  assert.equal(await messageKey(email({ message_id: "", sender: "ANN@customer.invalid" })), fallback, "stable across deliveries");
  assert.notEqual(await messageKey(email({ message_id: null, subject: "Other" })), fallback);
  assert.notEqual(await messageKey(email({ message_id: null, raw_headers: headers({ date: "Mon, 5 Oct 2026 10:00:01 +0000", to: "support@project.invalid", cc: "sales@project.invalid" }) })), fallback);
  assert.notEqual(await messageKey(email({ message_id: null, cc: null, raw_headers: headers({ date: "Mon, 5 Oct 2026 10:00:00 +0000", to: "support@project.invalid" }) })), fallback,
    "a separate message to fewer addresses is another message");
  assert.equal(await messageKey(email({ message_id: null, raw_headers: headers({ to: "support@project.invalid" }) })), null,
    "nothing identifies it across addresses: each delivery is answered on its own, as before");
});

test("addresses are ranked To first, then Cc, each in header order, without repeats (B-22)", () => {
  assert.deepEqual(answeringOrder({ recipient: "B@p.invalid, a@p.invalid", cc: "c@p.invalid, b@p.invalid" }), ["b@p.invalid", "a@p.invalid", "c@p.invalid"]);
  assert.deepEqual(answeringOrder({ recipient: "", cc: null }), []);
});

test("the first agent-served address in To answers, else the first in Cc; an unlisted delivery comes last (B-22)", async () => {
  const served = new Set(["support@p.invalid", "sales@p.invalid", "hr@p.invalid"]);
  const serves = async (a: string) => served.has(a);
  const order = ["hello@p.invalid", "support@p.invalid", "sales@p.invalid"];
  assert.equal(await electAnswerer("sales@p.invalid", order, serves), "support@p.invalid", "an address in Cc defers to one in To");
  assert.equal(await electAnswerer("support@p.invalid", order, serves), "support@p.invalid");
  assert.equal(await electAnswerer("hr@p.invalid", order, serves), "support@p.invalid", "a Bcc delivery defers to a listed one");
  assert.equal(await electAnswerer("hr@p.invalid", ["hello@p.invalid", "x@elsewhere.invalid"], serves), "hr@p.invalid", "no listed agent address: the delivery answers itself");
  const asked: string[] = [];
  await electAnswerer("support@p.invalid", ["support@p.invalid", "sales@p.invalid"], async (a) => { asked.push(a); return true; });
  assert.deepEqual(asked, [], "the first address answers without looking anyone up");
});

test("an address whose agent cannot be read is treated as served: waiting is safe, a second answer is not (B-22)", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const elected = await electAnswerer("sales@p.invalid", ["support@p.invalid", "sales@p.invalid"], async () => { throw new Error("R2 down"); });
    assert.equal(elected, "support@p.invalid");
  } finally { console.warn = warn; }
});

test("the claim: the chosen address takes it; others wait for it, then read as duplicates; past the wait one takes over (B-22)", () => {
  const now = 1_000_000;
  // The chosen address arrives first.
  let step = decideClaim(null, "support@p.invalid", "support@p.invalid", now);
  assert.deepEqual(step.claim, { outcome: "answer" });
  let row: ClaimRow = step.write!;
  assert.deepEqual(row, { owner: "support@p.invalid", taken: true, deadline: now + CLAIM_WAIT_MS });
  assert.deepEqual(decideClaim(row, "sales@p.invalid", "support@p.invalid", now).claim, { outcome: "duplicate", owner: "support@p.invalid" });
  assert.deepEqual(decideClaim(row, "support@p.invalid", "support@p.invalid", now + 1).claim, { outcome: "answer" }, "the same address again keeps its own idempotency");
  assert.equal(decideClaim(row, "support@p.invalid", "support@p.invalid", now + 1).write, null);

  // The Cc address arrives first: it waits, and the To address still answers.
  step = decideClaim(null, "sales@p.invalid", "support@p.invalid", now);
  assert.deepEqual(step.claim, { outcome: "wait", owner: "support@p.invalid", until: now + CLAIM_WAIT_MS });
  row = step.write!;
  assert.deepEqual(row, { owner: "support@p.invalid", taken: false, deadline: now + CLAIM_WAIT_MS });
  assert.deepEqual(decideClaim(row, "sales@p.invalid", "sales@p.invalid", now + 5).claim, { outcome: "wait", owner: "support@p.invalid", until: now + CLAIM_WAIT_MS },
    "the first recorded choice stands even if a later delivery would choose otherwise");
  step = decideClaim(row, "support@p.invalid", "support@p.invalid", now + 10);
  assert.deepEqual(step.claim, { outcome: "answer" });
  assert.equal(step.write!.taken, true);
  assert.deepEqual(decideClaim(step.write, "sales@p.invalid", "support@p.invalid", now + 20).claim, { outcome: "duplicate", owner: "support@p.invalid" });

  // The chosen address never takes it: after the wait the waiting delivery answers instead.
  const late = decideClaim(row, "sales@p.invalid", "support@p.invalid", now + CLAIM_WAIT_MS);
  assert.deepEqual(late.claim, { outcome: "answer" });
  assert.deepEqual(late.write, { owner: "sales@p.invalid", taken: true, deadline: now + CLAIM_WAIT_MS });
  assert.deepEqual(decideClaim(late.write, "support@p.invalid", "support@p.invalid", now + CLAIM_WAIT_MS + 1).claim, { outcome: "duplicate", owner: "sales@p.invalid" },
    "a late delivery to the chosen address does not answer a second time");
});

test("a duplicate's reason names the address that answers (B-22)", () => {
  assert.equal(duplicateReason("support@p.invalid"), "Duplicate: answered from support@p.invalid");
});
