// B-218: the first Admin agent key of a server, made with the account's Cloudflare token and no person signing in
// (scripts/agent-key-bootstrap.mjs). The parts that decide what is written are pure and tested here; the calls to
// Cloudflare, R2 and the vault are the same ones agent-standing.mjs and the server make.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addKey, appPolicies, findApp, MAX_KEYS, parseArgs, policyBody, policyName, vaultPutCommand } from "../scripts/agent-key-bootstrap.mjs";

test("B-218: the key is written as the server writes one, Admin, made by the account token", () => {
  const now = new Date("2026-11-08T10:00:00.000Z");
  const { record, key } = addKey({ keys: [{ id: "old", name: "Owner's key", level: "mail" }] }, { id: "t1", client_id: "c1.access", expires_at: "2027-11-08T10:00:00Z" },
    { name: "Organization agent", standing: ["keys", "people", "nope"] }, now);
  assert.deepEqual(key, { id: "t1", clientId: "c1.access", name: "Organization agent", level: "admin", send: "send", dailySendLimit: 50,
    createdAt: "2026-11-08T10:00:00.000Z", expiresAt: "2027-11-08T10:00:00Z", accounts: null, createdBy: "account-token", standing: ["people", "keys"] });
  assert.equal(record.keys.length, 2, "the keys already there stay");
  assert.equal("standing" in addKey({ keys: [] }, { id: "t2", client_id: "c2" }, { name: "Plain" }).key, false, "no standing unless asked");
  assert.deepEqual(addKey(null, { id: "t3", client_id: "c3" }, { name: "First" }).record.keys.map((k: { id: string }) => k.id), ["t3"], "a server with no keys yet");
  assert.throws(() => addKey({ keys: [{ name: "Organization agent" }] }, { id: "t4", client_id: "c4" }, { name: "Organization agent" }), /already on this server/);
  assert.throws(() => addKey({ keys: Array.from({ length: MAX_KEYS }, (_, i) => ({ name: `k${i}` })) }, { id: "t5", client_id: "c5" }, { name: "x" }), /At most 50/);
});

test("B-218: the agents policy keeps every token it names, and the application keeps the owner's policies first", () => {
  assert.equal(policyName("abcdef0123456789"), "Fabric Inbox agents abcdef012345");
  assert.deepEqual(policyBody("abcdef0123456789", { include: [{ service_token: { token_id: "a" } }, { email: { email: "x@y.invalid" } }] }, "b"),
    { name: "Fabric Inbox agents abcdef012345", decision: "non_identity", include: [{ service_token: { token_id: "a" } }, { service_token: { token_id: "b" } }] });
  assert.deepEqual(policyBody("abcdef0123456789", null, "b").include, [{ service_token: { token_id: "b" } }]);
  assert.deepEqual(appPolicies({ policies: [{ id: "owner", precedence: 1 }, { id: "people" }] }, "agents"),
    [{ id: "owner", precedence: 1 }, { id: "people", precedence: 2 }, { id: "agents", precedence: 3 }]);
  assert.equal(appPolicies({ policies: [{ id: "owner", precedence: 1 }, { id: "agents", precedence: 2 }] }, "agents"), null, "already attached");
  assert.throws(() => appPolicies({ policies: [] }, "agents"), /no sign-in policy of its own/);
});

test("B-218: the application is found by the server's host", () => {
  const apps = [{ id: "a", domain: "other.example.workers.dev" }, { id: "b", domain: "x", self_hosted_domains: ["inbox.example.workers.dev"] },
    { id: "c", domain: "y", destinations: [{ uri: "org.example.workers.dev" }] }];
  assert.equal(findApp(apps, "inbox.example.workers.dev")?.id, "b");
  assert.equal(findApp(apps, "org.example.workers.dev")?.id, "c");
  assert.equal(findApp(apps, "nowhere.example"), null);
});

test("B-218: arguments are checked, and a secret is never one", () => {
  const ok = parseArgs(["--host", "inbox.example.workers.dev", "--bucket", "inbox-bucket", "--name", "Organization agent", "--vault", "org-inbox/prod", "--standing", "people,keys"]);
  assert.deepEqual(ok, { host: "inbox.example.workers.dev", bucket: "inbox-bucket", name: "Organization agent", vault: "org-inbox/prod", duration: "8760h", standing: ["people", "keys"], slotPrefix: "FABRIC_INBOX_" });
  const base = ["--host", "h.example", "--bucket", "b", "--name", "n", "--vault", "p/prod"];
  assert.throws(() => parseArgs([...base, "--token", "x"]), /never an argument/);
  assert.throws(() => parseArgs(base.slice(2)), /--host is required/);
  assert.throws(() => parseArgs(["--host", "https://h.example/", ...base.slice(2)]), /host name/);
  assert.throws(() => parseArgs([...base, "--standing", "owner"]), /not owner/);
  assert.throws(() => parseArgs([...base, "--duration", "5y"]), /--duration/);
  assert.equal(parseArgs([...base, "--slot-prefix", "ORG_INBOX_"]).slotPrefix, "ORG_INBOX_");
  assert.throws(() => parseArgs([...base, "--slot-prefix", "org"]), /upper case/);
  assert.equal(parseArgs([...base, "--vault-host", "studio-space"]).vaultHost, "studio-space");
  assert.throws(() => parseArgs([...base, "--vault-host", "-oProxyCommand=x"]), /ssh host/);
  assert.throws(() => parseArgs([...base, "--vault-host", "h; rm"]), /ssh host/);
});

test("--vault-host puts each slot through ssh, names in the command and the value on stdin only", () => {
  const [cmd, args] = vaultPutCommand("fabric-inbox", "prod", "FABRIC_INBOX_CLIENT_SECRET", "studio-space");
  assert.equal(cmd, "ssh");
  assert.deepEqual(args.slice(0, 3), ["-o", "BatchMode=yes", "studio-space"]);
  assert.match(args.at(-1), /vault\.py" put fabric-inbox prod FABRIC_INBOX_CLIENT_SECRET'$/);
});
