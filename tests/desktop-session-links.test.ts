// B-305 (SCN-106): Fabric's session links from Fabric Inbox (fabric-session-links/1 on board thread 3ca40854, over the
// `fabric://` links of fabric-agent-contract DEC-0040). Inbox builds the link and hands it to the system; Fabric opens a
// view and asks the person before it starts or moves anything. What is checked: every link carries ids only and
// from=fabric-inbox, a value that is not an id refuses the link, Fabric absent is said before anything opens, and the
// console's Claude Code session has an id Fabric can open or continue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { sessionLink, openSessionLink, readProjects, rememberProject, PROJECTS_FILE } = require("../desktop/session-links.cjs");
const { createConsole, claudeTranscript } = require("../desktop/console.cjs");

const ID = "0f8c2a51-6b1e-4c2d-9a3e-5d7f0b1c2e3f";

test("the three links carry ids only and from=fabric-inbox", () => {
  assert.deepEqual(sessionLink({ action: "new", project: "fabric-inbox", runner: "claude" }),
    { ok: true, url: "fabric://session/new?project=fabric-inbox&runner=claude-code&from=fabric-inbox" });
  assert.deepEqual(sessionLink({ action: "new", project: "urn:project:a", runner: "codex" }),
    { ok: true, url: "fabric://session/new?project=urn%3Aproject%3Aa&runner=codex&from=fabric-inbox" });
  assert.deepEqual(sessionLink({ action: "new", project: " Acme " }), { ok: true, url: "fabric://session/new?project=Acme&from=fabric-inbox" });
  assert.deepEqual(sessionLink({ action: "open", session: ID }), { ok: true, url: `fabric://session/open?session=${ID}&from=fabric-inbox` });
  assert.deepEqual(sessionLink({ action: "continue", session: ID }), { ok: true, url: `fabric://session/continue?session=${ID}&from=fabric-inbox` });
});

test("a value that is not an id refuses the whole link (DEC-0040 FL-3)", () => {
  assert.deepEqual(sessionLink({ action: "new", project: "" }), { ok: false, error: "project" });
  assert.deepEqual(sessionLink({ action: "new", project: "../etc" }), { ok: false, error: "project" });
  assert.deepEqual(sessionLink({ action: "new", project: "my project" }), { ok: false, error: "project" });
  assert.deepEqual(sessionLink({ action: "new", project: "/srv/acme" }), { ok: false, error: "project" });
  assert.deepEqual(sessionLink({ action: "new", project: "a", runner: "Claude" }), { ok: false, error: "runner" });
  assert.deepEqual(sessionLink({ action: "open", session: "" }), { ok: false, error: "session" });
  assert.deepEqual(sessionLink({ action: "continue", session: "a b" }), { ok: false, error: "session" });
  assert.deepEqual(sessionLink({ action: "start", project: "a" }), { ok: false, error: "action" });
  assert.deepEqual(sessionLink({ action: "new", project: "a".repeat(129) }), { ok: false, error: "project" });
});

test("Fabric absent is said before anything opens; a refusal of the system is named", async () => {
  const opened: string[] = [];
  const url = "fabric://session/open?session=x&from=fabric-inbox";
  assert.deepEqual(await openSessionLink(url, { appForProtocol: () => "", openExternal: async (u: string) => { opened.push(u); } }), { ok: false, error: "not_installed" });
  assert.deepEqual(opened, []);
  assert.deepEqual(await openSessionLink(url, { appForProtocol: () => { throw new Error("no"); }, openExternal: async () => {} }), { ok: false, error: "not_installed" });
  assert.deepEqual(await openSessionLink(url, { appForProtocol: () => "Fabric", openExternal: async (u: string) => { opened.push(u); } }), { ok: true });
  assert.deepEqual(opened, [url]);
  assert.deepEqual(await openSessionLink(url, { appForProtocol: () => "Fabric", openExternal: async () => { throw new Error("refused"); } }), { ok: false, error: "open" });
});

test("the projects a person sent sessions to are kept newest first, eight at most, ids only", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fabric-projects-"));
  assert.deepEqual(await readProjects(fsPromises, dir), []);
  for (const p of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) await rememberProject(fsPromises, dir, p);
  assert.deepEqual(await rememberProject(fsPromises, dir, "c"), ["c", "i", "h", "g", "f", "e", "d", "b"]);
  assert.deepEqual(await rememberProject(fsPromises, dir, "../x"), ["c", "i", "h", "g", "f", "e", "d", "b"], "not an id: not kept");
  writeFileSync(path.join(dir, PROJECTS_FILE), JSON.stringify(["ok", "not ok", 3]));
  assert.deepEqual(await readProjects(fsPromises, dir), ["ok"]);
  writeFileSync(path.join(dir, PROJECTS_FILE), "{");
  assert.deepEqual(await readProjects(fsPromises, dir), []);
});

function consoleWith(home: string) {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "fabric-console-")), "consoles");
  const spawned: string[][] = [];
  let exit: ((e: { exitCode: number }) => void) | null = null;
  const child = { pid: 1, onData() {}, onExit(fn: any) { exit = fn; }, write() {}, resize() {}, kill() {} };
  let n = 0;
  const c = createConsole({
    pty: { spawn(_file: string, args: string[]) { spawned.push(args); return child; } }, fs: fsPromises, dir,
    origin: "https://inbox.example", mcpUrl: "https://inbox.example/mcp", cwd: "/Users/p", loginPath: "/bin", platform: "darwin",
    env: { HOME: home }, mint: async () => ({ ok: true, data: { key: { id: `k${++n}`, clientId: "c.access" }, clientSecret: "s" } }),
    revoke: async () => true, kill: () => {}, setTimer: () => ({ unref() {} }),
  });
  return { c, dir, spawned, exit: async (code: number) => { exit!({ exitCode: code }); for (let i = 0; i < 50 && c.state().phase !== "ended"; i++) await new Promise((r) => setTimeout(r, 5)); } };
}
const CLAUDE = { id: "claude", name: "Claude Code", file: "/bin/claude" };

test("the console's Claude Code session gets its own id, kept after it ends, and is resumed by it when its transcript is there", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "fabric-home-"));
  const s = consoleWith(home);
  assert.equal(await s.c.linkedSession(), null, "no session yet: nothing to open");
  await s.c.start({ runtime: CLAUDE });
  const args = s.spawned[0];
  const id = args[args.indexOf("--session-id") + 1];
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.ok(args[0].startsWith("--mcp-config="), "the config stays first");
  assert.equal(s.c.state().sessionId, id);
  assert.equal(await s.c.linkedSession(), id);
  await s.exit(0);
  assert.equal(s.c.state().sessionId, id, "an ended session can still be continued in Fabric");
  assert.deepEqual(JSON.parse(readFileSync(path.join(s.dir, "last-session.json"), "utf8")), { runtime: "claude", id });

  // Continue last session: no transcript, so the most recent one in the folder, as before, and no id is claimed.
  await s.c.start({ runtime: CLAUDE, resume: true });
  assert.equal(s.spawned[1][0], "--continue");
  assert.ok(!s.spawned[1].includes("--session-id"));
  assert.equal(s.c.state().sessionId, undefined);
  await s.exit(0);

  // With its transcript there, the console's own last session by its id.
  const transcript = claudeTranscript({ HOME: home }, "/Users/p", id);
  assert.equal(transcript, path.join(home, ".claude", "projects", "-Users-p", `${id}.jsonl`));
  mkdirSync(path.dirname(transcript), { recursive: true });
  writeFileSync(transcript, "{}\n");
  await s.c.start({ runtime: CLAUDE, resume: true });
  assert.deepEqual(s.spawned[2].slice(0, 2), ["--resume", id]);
  assert.equal(s.c.state().sessionId, id);
});

test("Codex has no session id Fabric could take: nothing to open or continue", async () => {
  const s = consoleWith(mkdtempSync(path.join(os.tmpdir(), "fabric-home-")));
  await s.c.start({ runtime: { id: "codex", name: "Codex", file: "/bin/codex" } });
  assert.ok(!s.spawned[0].includes("--session-id"));
  assert.equal(await s.c.linkedSession(), null);
});

test("CLAUDE_CONFIG_DIR is where Claude Code keeps the transcript", () => {
  assert.equal(claudeTranscript({ CLAUDE_CONFIG_DIR: "/c", HOME: "/h" }, "/srv/p.q/x", "id"), path.join("/c", "projects", "-srv-p-q-x", "id.jsonl"));
});
