import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { agentableOf, levelsFor, normaliseMembers, readMembers, standingOf, updateMembers, writableOf, MembersError, MEMBERS_KEY, type Member } from "../workers/lib/members";
import { agentChoiceOf, memberBody, memberGate, readsOnly } from "../workers/lib/member-gate";
import { membersRouter } from "../workers/routes/members";
import { scopedApi } from "../workers/mcp/scope";

/** An R2 bucket as far as the list uses it: get, and put with an etag condition. */
function fakeBucket(initial?: string) {
  const store = new Map<string, { text: string; etag: string }>();
  let n = 0;
  if (initial !== undefined) store.set(MEMBERS_KEY, { text: initial, etag: `e${++n}` });
  const bucket = {
    async get(key: string) {
      const o = store.get(key);
      return o ? { etag: o.etag, text: async () => o.text, json: async () => JSON.parse(o.text) } : null;
    },
    async put(key: string, text: string, opts?: { onlyIf?: { etagMatches?: string } | Headers }) {
      const cur = store.get(key);
      const cond = opts?.onlyIf;
      if (cond instanceof Headers ? cur : cond?.etagMatches !== undefined && cur?.etag !== cond.etagMatches) return null;
      store.set(key, { text, etag: `e${++n}` });
      return {};
    },
  };
  return { bucket: bucket as unknown as R2Bucket, store };
}
const member = (email: string, role: Member["role"], accounts: string[] | null = null): Member => ({ email, role, accounts, addedAt: "2026-10-23T00:00:00Z" });

test("B-149: with nobody listed everyone is an administrator; once listed, a member reaches their mailboxes and anyone else nothing", () => {
  assert.deepEqual(standingOf([], "Owner@Owner.example"), { role: "admin", email: "owner@owner.example", listed: false });
  const list = [member("owner@owner.example", "admin"), member("ann@owner.example", "member", ["cloudflare:sales@owner.example"])];
  assert.equal(standingOf(list, "owner@owner.example").role, "admin");
  assert.deepEqual(standingOf(list, "ANN@owner.example"), { role: "member", email: "ann@owner.example", accounts: ["cloudflare:sales@owner.example"], levels: {} });
  assert.deepEqual(standingOf(list, "bob@owner.example"), { role: "none", email: "bob@owner.example" });
});

test("B-149: the first change a person makes lists them as administrator; the list always keeps one and never empties", async () => {
  const { bucket } = fakeBucket();
  const saved = await updateMembers(bucket, (l) => [...l, member("ann@owner.example", "member", ["cloudflare:sales@owner.example"])], "Owner@owner.example");
  assert.deepEqual(saved.map((m) => [m.email, m.role]), [["owner@owner.example", "admin"], ["ann@owner.example", "member"]]);
  await assert.rejects(updateMembers(bucket, (l) => l.filter((m) => m.role !== "admin"), null), (e: unknown) => e instanceof MembersError && e.status === 409);
  await assert.rejects(updateMembers(bucket, () => [], null), /last administrator/);
  // An agent's change (no person) to an empty list must bring its own administrator.
  const empty = fakeBucket();
  await assert.rejects(updateMembers(empty.bucket, () => [member("ann@owner.example", "member", ["cloudflare:a@owner.example"])], null), /administrator/);
});

test("B-149: a list that is there but cannot be read lets nobody in; damaged entries are dropped", async () => {
  await assert.rejects(readMembers(fakeBucket("{not json").bucket), (e: unknown) => e instanceof MembersError && e.status === 503);
  await assert.rejects(readMembers(fakeBucket(JSON.stringify({ people: [] })).bucket), /cannot be read/);
  const list = await readMembers(fakeBucket(JSON.stringify({ members: [{ email: "x" }, { email: "A@b.example", role: "boss" }, { email: "a@b.example", role: "admin" }] })).bucket);
  assert.deepEqual(list.map((m) => [m.email, m.role, m.accounts]), [["a@b.example", "member", []]], "an unknown role is a member with nothing; a duplicate keeps the first");
});

test("B-149: a member reaches their mailboxes' mail and the feed, never settings, a mailbox's own settings, agents or the agent protocol", () => {
  const mine = ["cloudflare:sales@owner.example", "gmail:g1"];
  const pass = [["GET", "/"], ["GET", "/assets/app.js"], ["GET", "/api/me"], ["GET", "/api/v1/mailboxes/sales%40owner.example/emails"],
    ["POST", "/api/v1/mailboxes/sales@owner.example/emails/m1/reply"], ["GET", "/api/accounts/g1/messages"], ["POST", "/api/accounts/g1/send"]];
  for (const [m, p] of pass) assert.equal(memberGate(m!, p!, mine), "pass", `${m} ${p}`);
  for (const p of ["/api/inbox", "/api/accounts", "/api/inbox/hidden"]) assert.equal(memberGate("GET", p, mine), "feed", p);
  const refuse = [["GET", "/api/v1/mailboxes/other@owner.example/emails"], ["PUT", "/api/v1/mailboxes/sales@owner.example"], ["DELETE", "/api/v1/mailboxes/sales@owner.example"],
    ["POST", "/api/accounts/g1/disconnect"], ["PUT", "/api/accounts/g1/password"], ["GET", "/api/agents"], ["GET", "/api/members"], ["GET", "/api/agent-keys"],
    ["GET", "/api/domains"], ["POST", "/mcp"], ["GET", "/agents/chat/x"], ["GET", "/fabric/v1/usage"], ["GET", "/.well-known/fabric-service"], ["GET", "/api/accounts/g2/messages"]];
  for (const [m, p] of refuse) assert.equal(memberGate(m!, p!, mine), "refuse", `${m} ${p}`);
});

test("B-149: the routes list, save and remove people, and a member's mailboxes are required", async () => {
  const { bucket, store } = fakeBucket();
  const app = new Hono<{ Bindings: { BUCKET: R2Bucket }; Variables: { standing?: unknown } }>();
  app.use("*", async (c, next) => { c.set("standing", { role: "admin", email: "owner@owner.example", listed: false }); await next(); });
  app.route("/", membersRouter as unknown as Hono);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } }, { BUCKET: bucket });
    return { status: r.status, data: await r.json() as any };
  };
  assert.deepEqual((await call("GET", "/api/members")).data.open, true);
  assert.equal((await call("PUT", "/api/members/ann%40owner.example", { role: "member" })).status, 400, "a member needs a mailbox");
  assert.equal((await call("PUT", "/api/members/not-an-email", { role: "admin" })).status, 400);
  const saved = await call("PUT", "/api/members/ann%40owner.example", { role: "member", accounts: ["Sales@Owner.example", "bad/one"] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.members.map((m: Member) => [m.email, m.role, m.accounts]), [["owner@owner.example", "admin", null], ["ann@owner.example", "member", ["cloudflare:sales@owner.example"]]]);
  assert.equal((await call("DELETE", "/api/members/bob%40owner.example")).status, 404);
  assert.equal((await call("DELETE", "/api/members/owner%40owner.example")).status, 409, "the only administrator stays");
  assert.equal((await call("DELETE", "/api/members/ann%40owner.example")).status, 200);
  assert.deepEqual((await call("GET", "/api/me")).data, { role: "admin", email: "owner@owner.example", accounts: null, levels: null, listed: false });
});

test("B-149: a member's refusals from the scoped feed speak to the person, not to a key", async () => {
  const api = { request: async () => ({ status: 200, contentType: "application/json", data: {} }) };
  await assert.rejects(scopedApi(api, ["cloudflare:sales@owner.example"], "person").request("GET", "/api/v1/mailboxes/other@owner.example/emails"), /You reach only sales@owner.example/);
  await assert.rejects(scopedApi(api, ["cloudflare:sales@owner.example"]).request("GET", "/api/v1/mailboxes/other@owner.example/emails"), /This key is limited/);
});

test("B-149: a member empties Spam and brings back discarded mail in their own mailboxes only, never taking back a shared rule", () => {
  const mine = ["cloudflare:sales@owner.example", "gmail:g1"];
  assert.equal(memberGate("POST", "/api/spam/empty", mine), "body");
  assert.equal(memberGate("POST", "/api/discard/restore", mine), "body");
  assert.equal(memberGate("DELETE", "/api/discard/rules/l-0000aaaa", mine), "refuse");
  assert.deepEqual(memberBody("POST /api/spam/empty", {}, mine), { body: { addresses: ["sales@owner.example"] } });
  const restore = { messages: [{ accountId: "gmail:g1", providerMessageId: "m1" }], unlearn: true };
  assert.deepEqual(memberBody("POST /api/discard/restore", restore, mine), { body: { ...restore, unlearn: false } });
  assert.deepEqual(memberBody("POST /api/discard/restore", { messages: [{ accountId: "gmail:other", providerMessageId: "m1" }] }, mine), { refuse: true });
  assert.deepEqual(memberBody("POST /api/discard/restore", { messages: [] }, mine), { refuse: true });
});

test("B-36: a member names mailboxes only; a whole-domain entry is not kept", async () => {
  const { normaliseMembers } = await import("../workers/lib/members");
  const read = normaliseMembers({ members: [{ email: "m@owner.example", role: "member", accounts: ["domain:owner.example", "cloudflare:m@owner.example"] }] });
  assert.deepEqual(read[0]?.accounts, ["cloudflare:m@owner.example"]);
});

test("N-1: a member is gated on the path the router matches, so an encoded path reaches no route the plain one is refused", async () => {
  const { Hono } = await import("hono");
  const mine = ["cloudflare:me@owner.example"];
  const app = new Hono();
  app.use("*", async (c, next) => (memberGate(c.req.method, c.req.path, mine) === "pass" ? next() : c.text("refused", 403)));
  app.put("/api/members/:email", (c) => c.text("made admin"));
  app.all("/mcp", (c) => c.text("agent protocol"));
  app.get("/fabric/v1/events", (c) => c.text("events"));
  app.get("/api/v1/mailboxes/:id/emails", (c) => c.text("mail"));
  app.get("*", (c) => c.text("page"));
  for (const [method, path] of [["PUT", "/%61pi/members/x%40owner.example"], ["POST", "/%6dcp"], ["GET", "/f%61bric/v1/events"], ["PUT", "/api/members/x%40owner.example"]] as const)
    assert.equal((await app.request(path, { method })).status, 403, `${method} ${path}`);
  assert.equal(await (await app.request("/api/v1/mailboxes/me%40owner.example/emails")).text(), "mail", "their own mailbox still passes");
  assert.equal(await (await app.request("/inbox")).text(), "page");
  // The server's own middleware judges that same path, never the raw one.
  const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("../workers/app.ts", import.meta.url), "utf8"));
  assert.match(source, /memberGate\(c\.req\.method, path, standing\.accounts, writable, agentable\)/);
  assert.match(source, /const path = c\.req\.path;/);
});

test("N-8: a member's held mail is looked up and decided for their own mailboxes only", async () => {
  assert.equal(memberGate("POST", "/api/safety/lookup", ["cloudflare:me@owner.example"]), "feed");
  assert.equal(memberGate("POST", "/api/safety/decide", ["cloudflare:me@owner.example"]), "feed");
  const calls: string[] = [];
  const api = { request: async (method: string, path: string) => { calls.push(`${method} ${path}`); return { status: 200, contentType: "application/json", data: { records: {} } }; } };
  const s = scopedApi(api as never, ["cloudflare:me@owner.example"], "person");
  await s.request("POST", "/api/safety/lookup", { body: { keys: [{ accountId: "cloudflare:me@owner.example", messageId: "m" }] } });
  await assert.rejects(() => s.request("POST", "/api/safety/decide", { body: { accountId: "cloudflare:other@owner.example", messageId: "m", action: "release" } }), /You reach only/);
  assert.deepEqual(calls, ["POST /api/safety/lookup"]);
});

test("N-4: the keys a person made go when they leave the server or become a member; others' keys stay", async () => {
  const { bucket } = fakeBucket();
  const { AGENT_KEYS_KEY } = await import("../workers/mcp/keys").then((m: any) => ({ AGENT_KEYS_KEY: m.AGENT_KEYS_KEY ?? "config/agent-keys.json" }));
  const key = (id: string, createdBy?: string) => ({ id, clientId: id + ".access", name: id, level: "admin", send: "send", dailySendLimit: 50, createdAt: "2026-10-26T00:00:00Z", expiresAt: null, accounts: null, ...(createdBy ? { createdBy } : {}) });
  await bucket.put(AGENT_KEYS_KEY, JSON.stringify({ keys: [key("k-ann", "ann@owner.example"), key("k-bob", "bob@owner.example"), key("k-old")] }));
  const app = new Hono<{ Bindings: { BUCKET: R2Bucket }; Variables: { standing?: unknown } }>();
  app.use("*", async (c, next) => { c.set("standing", { role: "admin", email: "owner@owner.example", listed: true }); await next(); });
  app.route("/", membersRouter as unknown as Hono);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } }, { BUCKET: bucket });
    return { status: r.status, data: await r.json() as any };
  };
  await call("PUT", "/api/members/ann%40owner.example", { role: "admin" });
  await call("PUT", "/api/members/bob%40owner.example", { role: "admin" });
  const demoted = await call("PUT", "/api/members/bob%40owner.example", { role: "member", accounts: ["sales@owner.example"] });
  assert.deepEqual(demoted.data.revokedKeys, ["k-bob"]);
  assert.match(demoted.data.warning, /Zero Trust/, "with no Cloudflare token here, the token is named for deletion");
  const removed = await call("DELETE", "/api/members/ann%40owner.example");
  assert.deepEqual(removed.data.revokedKeys, ["k-ann"]);
  const left = JSON.parse(await (await bucket.get(AGENT_KEYS_KEY))!.text()).keys.map((k: any) => k.id);
  assert.deepEqual(left, ["k-old"], "a key from before the record stays; the operator sees it in Agent access");
});

test("B-160: a member's mailbox is read or send; a list saved before levels reads as send everywhere", () => {
  const mine = ["cloudflare:sales@owner.example", "gmail:g1"];
  assert.deepEqual(levelsFor(mine, { "CLOUDFLARE:sales@owner.example": "read", "gmail:g1": "send", "gmail:other": "read" }), { "cloudflare:sales@owner.example": "read" },
    "only the member's own mailboxes, and only read is kept");
  assert.deepEqual(levelsFor(mine, { "gmail:g1": "admin" }), { "gmail:g1": "read" }, "an unknown level is the narrower one");
  assert.deepEqual(levelsFor(mine, ["read"]), {});
  const [before] = normaliseMembers({ members: [{ email: "ann@owner.example", role: "member", accounts: mine }] });
  assert.equal(before!.levels, undefined);
  const ann = standingOf([member("o@owner.example", "admin"), before!], "ann@owner.example");
  assert.deepEqual(ann.role === "member" && writableOf(ann), mine, "no levels: every mailbox is read and send, as before");
  const [after] = normaliseMembers({ members: [{ email: "ann@owner.example", role: "member", accounts: mine, levels: { "gmail:g1": "read" } }] });
  const reader = standingOf([member("o@owner.example", "admin"), after!], "ann@owner.example");
  assert.deepEqual(reader.role === "member" && reader.levels, { "gmail:g1": "read" });
  assert.deepEqual(reader.role === "member" && writableOf(reader), ["cloudflare:sales@owner.example"]);
  const admin = normaliseMembers({ members: [{ email: "o@owner.example", role: "admin", levels: { "gmail:g1": "read" } }] })[0]!;
  assert.equal(admin.levels, undefined, "an administrator has no levels");
});

test("B-160: in a mailbox they may only read, a member opens and searches, and is refused any change or send", () => {
  const mine = ["cloudflare:sales@owner.example", "gmail:g1"];
  const writable = ["cloudflare:sales@owner.example"];
  for (const [method, path] of [["GET", "/api/accounts/g1/messages"], ["HEAD", "/api/accounts/g1/messages"], ["GET", "/api/accounts/g1/messages/m1"]] as const)
    assert.equal(memberGate(method, path, mine, writable), "pass", `${method} ${path}`);
  for (const [method, path] of [["POST", "/api/accounts/g1/send"], ["POST", "/api/accounts/g1/messages/m1/reply"], ["PUT", "/api/accounts/g1/messages/m1"], ["DELETE", "/api/accounts/g1/messages/m1"]] as const)
    assert.equal(memberGate(method, path, mine, writable), "readonly", `${method} ${path}`);
  assert.equal(memberGate("POST", "/api/v1/mailboxes/sales@owner.example/emails/m1/reply", mine, writable), "pass", "the read-and-send mailbox as before");
  assert.equal(memberGate("POST", "/api/accounts/other/send", mine, writable), "refuse", "someone else's mailbox is still refused, not read only");
  assert.equal(memberGate("POST", "/api/v1/mailboxes/sales@owner.example/emails/m1/reply", mine), "pass", "without levels every mailbox is writable");
  assert.equal(readsOnly("POST", "/api/safety/lookup"), true);
  assert.equal(readsOnly("POST", "/api/safety/decide"), false);
  // Emptying Spam and bringing mail back change mail: they are narrowed to the writable mailboxes.
  assert.deepEqual(memberBody("POST /api/spam/empty", {}, writable), { body: { addresses: ["sales@owner.example"] } });
  assert.deepEqual(memberBody("POST /api/discard/restore", { messages: [{ accountId: "gmail:g1", providerMessageId: "m1" }] }, writable), { refuse: true });
});

test("B-160: the server narrows changes to the writable mailboxes and tells the person why", async () => {
  const source = (await import("node:fs")).readFileSync(new URL("../workers/app.ts", import.meta.url), "utf8");
  assert.match(source, /memberBody\(`\$\{c\.req\.method\} \$\{path\}`, await c\.req\.json\(\)\.catch\(\(\) => null\), writable\)/);
  assert.match(source, /scopedApi\(inProcess, readsOnly\(c\.req\.method, path\) \? standing\.accounts : writable, "person"\)/);
  assert.match(source, /gate === "readonly"\) return refuse\(msg\("You can read this mailbox but not change it or send from it/);
});

test("B-160: the routes save a level per mailbox, refuse one for a mailbox the member is not given, and tell the member theirs", async () => {
  const { bucket } = fakeBucket();
  const app = new Hono<{ Bindings: { BUCKET: R2Bucket }; Variables: { standing?: unknown } }>();
  let standing: unknown = { role: "admin", email: "owner@owner.example", listed: false };
  app.use("*", async (c, next) => { c.set("standing", standing); await next(); });
  app.route("/", membersRouter as unknown as Hono);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } }, { BUCKET: bucket });
    return { status: r.status, data: await r.json() as any };
  };
  const saved = await call("PUT", "/api/members/ann%40owner.example", { role: "member", accounts: ["sales@owner.example", "gmail:g1"], levels: { "sales@owner.example": "read", "gmail:g1": "send" } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.members[1].levels, { "cloudflare:sales@owner.example": "read" });
  assert.equal((await call("PUT", "/api/members/ann%40owner.example", { role: "member", accounts: ["gmail:g1"], levels: { "sales@owner.example": "read" } })).status, 400);
  assert.equal((await call("PUT", "/api/members/ann%40owner.example", { role: "member", accounts: ["gmail:g1"], levels: { "gmail:g1": "admin" } })).status, 400, "only read or send");
  const again = await call("PUT", "/api/members/ann%40owner.example", { role: "member", accounts: ["sales@owner.example"] });
  assert.equal(again.data.members[1].levels, undefined, "saved without levels: read and send again");
  standing = { role: "member", email: "ann@owner.example", accounts: ["gmail:g1"], levels: { "gmail:g1": "read" } };
  assert.deepEqual((await call("GET", "/api/me")).data, { role: "member", email: "ann@owner.example", accounts: ["gmail:g1"], levels: { "gmail:g1": "read" }, listed: true });
});

test("B-160: the app leaves a Read only mailbox out of Compose and replaces its reply bar with a sentence", async () => {
  const { readOnlyIn } = await import("../app/lib/me");
  const me = (levels: Record<string, "read" | "send"> | null | undefined, role: "admin" | "member" = "member") => ({ data: { role, email: "a@owner.example", accounts: ["gmail:g1"], levels, listed: true } });
  assert.equal(readOnlyIn(me({ "gmail:g1": "read" }), "gmail:g1"), true);
  assert.equal(readOnlyIn(me({ "gmail:g1": "read" }), "gmail:g2"), false);
  assert.equal(readOnlyIn(me(undefined), "gmail:g1"), false, "a server older than 0.78.0 sends no levels");
  assert.equal(readOnlyIn(me({ "gmail:g1": "read" }, "admin"), "gmail:g1"), false, "an administrator has no levels");
  assert.equal(readOnlyIn({}, "gmail:g1"), false, "before /api/me answers");
  const source = (await import("node:fs")).readFileSync(new URL("../app/routes/unified-inbox.tsx", import.meta.url), "utf8");
  assert.match(source, /const sendable = accounts\.filter\(\(a\) => !readOnlyIn\(me, a\.id\)\)/);
  assert.match(source, /disabled=\{!sendable\.length \|\| !saved\.loaded\}/, "Compose needs a mailbox I may send from");
  assert.match(source, /onReopen=\{saved\.reopen\}\n\s*accounts=\{sendable\}/, "the composer offers only those as senders");
  assert.match(source, /readOnlyIn\(me, selected\.accountId\) \? \(\n\s*<p className="fi-muted">\{t\("You can only read this mailbox/);
});

test("B-160 step 3: agents is kept as a level, sends like send, and names the mailboxes whose agent the member chooses", () => {
  const mine = ["cloudflare:sales@owner.example", "gmail:g1", "imap:i1"];
  assert.deepEqual(levelsFor(mine, { "cloudflare:sales@owner.example": "agents", "gmail:g1": "read", "imap:i1": "send" }),
    { "cloudflare:sales@owner.example": "agents", "gmail:g1": "read" });
  const [m] = normaliseMembers({ members: [{ email: "ann@owner.example", role: "member", accounts: mine, levels: { "cloudflare:sales@owner.example": "agents", "gmail:g1": "read" } }] });
  const ann = standingOf([member("o@owner.example", "admin"), m!], "ann@owner.example");
  assert.ok(ann.role === "member");
  assert.deepEqual(writableOf(ann), ["cloudflare:sales@owner.example", "imap:i1"], "agents includes reading and sending");
  assert.deepEqual(agentableOf(ann), ["cloudflare:sales@owner.example"]);
});

test("B-160 step 3: a member chooses the agent of an agents mailbox only; forwarding, its settings and the agents stay an administrator's", () => {
  const mine = ["cloudflare:sales@owner.example", "gmail:g1", "cloudflare:help@owner.example"];
  const writable = mine;
  const agentable = ["cloudflare:sales@owner.example", "gmail:g1"];
  const gate = (method: string, path: string, a: readonly string[] = agentable) => memberGate(method, path, mine, writable, a);
  assert.equal(gate("PUT", "/api/project-addresses/sales%40owner.example/agent"), "pass");
  assert.equal(gate("PUT", "/api/project-addresses/SALES@owner.example/agent"), "pass", "the address is compared as it is stored");
  assert.equal(gate("PUT", "/api/accounts/g1/agent"), "pass", "an account's agent, by the account's own id");
  assert.equal(gate("PUT", "/api/project-addresses/help%40owner.example/agent"), "refuse", "a mailbox at Read and send");
  assert.equal(gate("PUT", "/api/project-addresses/other%40owner.example/agent"), "refuse", "someone else's address");
  assert.equal(gate("PUT", "/api/project-addresses/sales%40owner.example/copy"), "refuse", "forwarding can send the mail away");
  assert.equal(gate("PUT", "/api/v1/mailboxes/sales@owner.example"), "refuse", "the address's own settings");
  assert.equal(gate("DELETE", "/api/accounts/g1/agent"), "refuse");
  assert.equal(gate("POST", "/api/accounts/g1/disconnect"), "refuse");
  for (const [method, path] of [["PUT", "/api/agents/a1"], ["POST", "/api/agents"], ["DELETE", "/api/agents/a1"], ["GET", "/api/knowledge/collections"], ["GET", "/api/agent-runs"]] as const)
    assert.equal(gate(method, path), "refuse", `${method} ${path}`);
  assert.equal(gate("GET", "/api/agents"), "agents", "the list of agents, narrowed");
  assert.equal(gate("GET", "/api/agents", []), "refuse", "without an agents mailbox the list is an administrator's");
  assert.equal(gate("PUT", "/api/project-addresses/sales%40owner.example/agent", []), "refuse");
  assert.equal(agentChoiceOf("PUT", "/api/project-addresses/%E0%A4%A/agent", agentable), null, "an address that does not decode names nothing");
  assert.equal(agentChoiceOf("GET", "/api/accounts/g1/agent", agentable), null);
});

test("B-160 step 3: the server lists the agents by name for those mailboxes and keeps who chose which agent", async () => {
  const source = (await import("node:fs")).readFileSync(new URL("../workers/app.ts", import.meta.url), "utf8");
  assert.match(source, /memberGate\(c\.req\.method, path, standing\.accounts, writable, agentable\)/);
  assert.match(source, /id: a\.id, name: a\.name, replyPolicy: \{ mode: a\.replyPolicy\?\.mode \},/, "names only: no instructions, tools or knowledge");
  assert.match(source, /kind: "member_agent_set", mailbox: chosen, agent, name:/);
});

test("B-160 step 3: the routes save agents per mailbox, and the record and the list say so", async () => {
  const { bucket, store } = fakeBucket();
  const app = new Hono<{ Bindings: { BUCKET: R2Bucket }; Variables: { standing?: unknown } }>();
  app.use("*", async (c, next) => { c.set("standing", { role: "admin", email: "owner@owner.example", listed: false }); await next(); });
  app.route("/", membersRouter as unknown as Hono);
  const r = await app.request("/api/members/ann%40owner.example", { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "member", accounts: ["sales@owner.example", "gmail:g1"], levels: { "sales@owner.example": "agents", "gmail:g1": "read" } }) }, { BUCKET: bucket });
  assert.equal(r.status, 200);
  const data = await r.json() as any;
  assert.deepEqual(data.members[1].levels, { "cloudflare:sales@owner.example": "agents", "gmail:g1": "read" });
  const entries = [...store].filter(([k]) => k.startsWith("audit/")).map(([, o]) => JSON.parse(o.text));
  const saved = entries.find((e: any) => e.kind === "member_saved");
  assert.deepEqual([saved.readOnly, saved.agents], [["gmail:g1"], ["cloudflare:sales@owner.example"]]);
  const { reachText, auditText, agentsOf } = await import("../app/components/settings/sections/PeopleSection");
  const t = ((s: string, v?: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v?.[k] ?? "")) as any;
  t.list = (xs: string[]) => xs.join(", ");
  t.plural = () => "";
  const person = { role: "member" as const, accounts: ["cloudflare:sales@owner.example", "gmail:g1"], levels: { "cloudflare:sales@owner.example": "agents" as const, "gmail:g1": "read" as const } };
  assert.deepEqual(agentsOf(person), ["cloudflare:sales@owner.example"]);
  assert.equal(reachText(person, t), "Only sales@owner.example, gmail:g1; read only: gmail:g1; choosing the agent: sales@owner.example");
  const at = { id: "1", at: "2026-11-02T00:00:00Z", actor: "ann@owner.example" };
  assert.equal(auditText({ ...at, kind: "member_agent_set", mailbox: "cloudflare:sales@owner.example", agent: "a1", name: "Support" }, t), "ann@owner.example chose Support to answer sales@owner.example");
  assert.equal(auditText({ ...at, kind: "member_agent_set", mailbox: "gmail:g1", agent: "off", name: null }, t), "ann@owner.example turned off the agent of gmail:g1");
});

test("B-160 step 3: the app offers the agent choice only for agents mailboxes, and saves it on the mailbox's own route", async () => {
  const { agentChoicesOf } = await import("../app/lib/me");
  const me = (role: "admin" | "member", levels?: Record<string, "read" | "send" | "agents">) =>
    ({ data: { role, email: "a@owner.example", accounts: ["cloudflare:sales@owner.example", "gmail:g1"], levels, listed: true } });
  assert.deepEqual(agentChoicesOf(me("member", { "gmail:g1": "agents" })), ["gmail:g1"]);
  assert.deepEqual(agentChoicesOf(me("member")), [], "a server older than 0.81.0 gives none");
  assert.deepEqual(agentChoicesOf(me("admin", { "gmail:g1": "agents" })), [], "an administrator chooses in Settings");
  const { agentPathOf, currentAgent } = await import("../app/components/settings/MemberAgents");
  assert.equal(agentPathOf("cloudflare:sales@owner.example"), "/api/project-addresses/sales%40owner.example/agent");
  assert.equal(agentPathOf("gmail:g1"), "/api/accounts/g1/agent");
  const agents = [{ id: "a1", name: "Support", addresses: ["sales@owner.example"], accounts: [] }, { id: "a2", name: "Sales", addresses: [], accounts: ["gmail:g1"] }];
  assert.equal(currentAgent(agents, "cloudflare:sales@owner.example"), "a1");
  assert.equal(currentAgent(agents, "gmail:g1"), "a2");
  assert.equal(currentAgent(agents, "imap:i1"), "off");
  const sidebar = (await import("node:fs")).readFileSync(new URL("../app/routes/unified-inbox.tsx", import.meta.url), "utf8");
  assert.match(sidebar, /isMember && agentChoicesOf\(me\)\.length > 0 && \(/, "the member reaches the choice from the sidebar");
});
