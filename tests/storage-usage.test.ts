// B-206 step 1: how full this server's storage is (docs/app-store/tasks/2026-11-05-storage-capacity.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { FULL_PERCENT, WARN_PERCENT, objectLimitBytes, storageReport, usageOf } from "../workers/lib/storage-usage";

const GB = 1024 ** 3;

test("B-206: the per-object limit is Workers Paid's 10 GB unless STORAGE_LIMIT_GB names a smaller one", () => {
  assert.equal(objectLimitBytes(undefined), 10 * GB);
  assert.equal(objectLimitBytes("1"), GB, "Workers Free");
  for (const bad of ["0", "-1", "11", "x", ""]) assert.equal(objectLimitBytes(bad), 10 * GB, bad);
});

test("B-206: an object is ok under 80%, warn from 80%, full from 95%, unknown when unreadable", () => {
  const limit = 10 * GB;
  assert.deepEqual([WARN_PERCENT, FULL_PERCENT], [80, 95]);
  assert.equal(usageOf("mailbox:a@example.invalid", 0.1 * limit, limit).level, "ok");
  assert.equal(usageOf("mailbox:a@example.invalid", 0.8 * limit, limit).level, "warn");
  const full = usageOf("mailbox:a@example.invalid", 0.986 * limit, limit);
  assert.deepEqual([full.level, full.percent], ["full", 98.6]);
  const lost = usageOf("store:accounts", null, limit, { error: "timeout" });
  assert.deepEqual([lost.level, lost.percent, lost.error], ["unknown", null, "timeout"]);
});

test("B-206: the report puts the fullest first and takes the worst level", () => {
  const limit = 10 * GB;
  const report = storageReport([usageOf("mailbox:a@example.invalid", 1, limit), usageOf("store:ledger", null, limit),
    usageOf("store:accounts", 0.85 * limit, limit)], { objects: 2, bytes: 10, partial: false }, limit);
  assert.deepEqual(report.objects.map((o) => o.object), ["store:accounts", "mailbox:a@example.invalid", "store:ledger"]);
  assert.equal(report.level, "warn");
  assert.equal(storageReport([usageOf("store:ledger", null, limit)], null, limit).level, "unknown");
  assert.equal(storageReport([], null, limit).level, "ok");
});

test("B-206: a real mailbox reports its SQLite size and its messages per folder", async () => {
  const bundle = await build({ stdin: { contents: `
    export { MailboxDO } from './workers/durableObject/index';
    export default { async fetch(request, env) {
      const mailbox = env.MAILBOX.getByName('a@example.invalid');
      const { op } = await request.json();
      if (op === 'seed') {
        for (const [id, folder] of [['m1', 'inbox'], ['m2', 'inbox'], ['m3', 'spam']])
          await mailbox.createEmail(folder, { id, sender: 'sender@example.invalid', recipient: 'a@example.invalid', subject: 'Fixture', body: 'x'.repeat(5000) }, []);
        return Response.json(true);
      }
      return Response.json(await mailbox.storageUsage());
    }};`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022" });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "MailboxDO", useSQLite: true } }, r2Buckets: ["BUCKET"] });
  const call = async (op: string) => (await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({ op }) })).json() as Promise<any>;
  try {
    const before = await call("usage");
    assert.ok(before.bytes > 0, "an empty mailbox still has its tables");
    await call("seed");
    const after = await call("usage");
    assert.ok(after.bytes >= before.bytes, `${after.bytes} >= ${before.bytes}`);
    assert.equal(after.folders.inbox, 2);
    assert.equal(after.folders.spam, 1);
  } finally { await mf.dispose(); }
});

test("B-206: every store answers its size, and the route reads mailboxes, automation objects, stores and files", () => {
  for (const [file, cls] of [["workers/providers/accounts-do.ts", "GmailAccountsDO"], ["workers/agents/registry.ts", "AgentRegistryDO"],
    ["workers/mcp/ledger.ts", "EmailMCP"], ["workers/knowledge/store.ts", "KnowledgeDO"], ["workers/automation/index.ts", "AutomationDO"],
    ["workers/campaigns/store.ts", "CampaignsDO"], ["workers/categories/store.ts", "CategoriesDO"]])
    assert.match(readFileSync(file, "utf8"), new RegExp(`export class ${cls} extends DurableObject<[^>]+> \\{\\n[^\\n]*\\n  async storageBytes\\(\\): Promise<number> \\{ return this\\.ctx\\.storage\\.sql\\.databaseSize; \\}`), cls);
  const route = readFileSync("workers/routes/server-errors.ts", "utf8");
  for (const piece of ["storageUsage()", "AUTOMATIONS.getByName(email).storageBytes()", '["accounts", env.GMAIL_ACCOUNTS]', "env.BUCKET.list("])
    assert.ok(route.includes(piece), piece);
});
