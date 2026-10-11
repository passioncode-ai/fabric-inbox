// The agent console (B-70, SCN-078): a coding agent in a PTY, connected to this server's MCP with a
// key made for the session and revoked when it ends. node-pty and the server are fakes here; what is
// checked is what protects the person: the key is in no file and no argument, it is revoked on every
// way out, and a key a crash left behind is revoked at the next start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createConsole, findRuntimes, sessionEnv, mcpConfig, ring } = require("../desktop/console.cjs");

const ORIGIN = "https://fabric-inbox.me.workers.dev";
const SECRET = "f00d".repeat(16);

function fakePty() {
  const spawned: any[] = [];
  let exit: ((e: { exitCode: number }) => void) | null = null;
  let data: ((d: string) => void) | null = null;
  const child = { pid: 4242, written: [] as string[], resized: [] as number[][], killed: [] as (string | undefined)[],
    onData(fn: any) { data = fn; }, onExit(fn: any) { exit = fn; },
    write(d: string) { child.written.push(d); }, resize(c: number, r: number) { child.resized.push([c, r]); }, kill(s?: string) { child.killed.push(s); } };
  return { spawned, child, emit: (d: string) => data!(d), exit: (code: number) => exit!({ exitCode: code }),
    pty: { spawn(file: string, args: string[], opts: any) { spawned.push({ file, args, opts }); return child; } } };
}

function setup(over: Record<string, unknown> = {}) {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "fabric-console-")), "consoles");
  const p = fakePty();
  const minted: any[] = []; const revoked: string[] = []; const states: any[] = []; const kills: any[] = [];
  let n = 0;
  const c = createConsole({
    pty: p.pty, fs: fsPromises, dir, origin: ORIGIN, mcpUrl: `${ORIGIN}/mcp`, cwd: os.homedir(), loginPath: "/usr/bin:/bin", platform: "darwin",
    env: { HOME: "/Users/p", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--inspect", KEEP: "yes" },
    mint: async (input: any) => { minted.push(input); n++; return { ok: true, data: { key: { id: `k${n}`, clientId: `c${n}.access` }, clientSecret: SECRET } }; },
    revoke: async (id: string) => { revoked.push(id); return true; },
    kill: (pid: number, sig: string) => kills.push([pid, sig]), setTimer: () => 0,
    onState: (s: any) => states.push(s), ...over,
  });
  return { c, p, dir, minted, revoked, states, kills };
}

test("the agents on PATH are found in order, Windows extensions included", () => {
  const files = new Set(["/opt/homebrew/bin/claude", "/Users/p/.local/bin/codex"]);
  assert.deepEqual(findRuntimes({ platform: "darwin", env: { HOME: "/Users/p" }, loginPath: "/usr/bin", exists: (f: string) => files.has(f) }).map((r: any) => [r.id, r.file]),
    [["claude", "/opt/homebrew/bin/claude"], ["codex", "/Users/p/.local/bin/codex"]]);
  const win = findRuntimes({ platform: "win32", env: { APPDATA: "C:\\Users\\p\\AppData\\Roaming", PATHEXT: ".EXE;.CMD" }, loginPath: "C:\\tools", exists: (f: string) => f === "C:\\Users\\p\\AppData\\Roaming\\npm\\claude.cmd" });
  assert.deepEqual(win.map((r: any) => r.file), ["C:\\Users\\p\\AppData\\Roaming\\npm\\claude.cmd"]);
  assert.deepEqual(findRuntimes({ platform: "linux", env: {}, loginPath: "/usr/bin", exists: () => false }), []);
});

test("the agent's config names variables, the key is in its environment only, and Electron's own switches are gone", () => {
  const names = { id: "FABRIC_INBOX_CONSOLE_ID_AB", secret: "FABRIC_INBOX_CONSOLE_SECRET_AB" };
  const config = mcpConfig(`${ORIGIN}/mcp`, names);
  assert.deepEqual(config.mcpServers["fabric-inbox"].headers, { "CF-Access-Client-Id": "${FABRIC_INBOX_CONSOLE_ID_AB}", "CF-Access-Client-Secret": "${FABRIC_INBOX_CONSOLE_SECRET_AB}" });
  const env = sessionEnv({ ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "x", A: "b" }, { loginPath: "/bin", names, key: { clientId: "c.access", clientSecret: SECRET }, origin: ORIGIN });
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env[names.secret], SECRET);
  assert.equal(env.PATH, "/bin");
});

test("a session: a key for it, Claude Code with only this server, the key in no file or argument (SCN-078)", async () => {
  const s = setup();
  const runtime = { id: "claude", name: "Claude Code", file: "/opt/homebrew/bin/claude" };
  assert.deepEqual(await s.c.start({ runtime, level: "admin", cols: 120, rows: 40 }), { ok: true });
  assert.deepEqual(s.minted[0], { name: "Agent console (Claude Code)", level: "admin", send: "send", dailySendLimit: 50, duration: "30d" });
  const { file, args, opts } = s.p.spawned[0];
  assert.equal(file, "/opt/homebrew/bin/claude");
  assert.ok(args[0].startsWith("--mcp-config="), "joined, so the next argument is never a second config");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(!args.join(" ").includes(SECRET), "no secret in argv");
  const configPath = args[0].slice("--mcp-config=".length);
  const config = readFileSync(configPath, "utf8");
  assert.ok(!config.includes(SECRET) && config.includes("${FABRIC_INBOX_CONSOLE_SECRET_"), "the config names a variable");
  const secretVar = Object.keys(opts.env).find((k) => k.startsWith("FABRIC_INBOX_CONSOLE_SECRET_"))!;
  assert.equal(opts.env[secretVar], SECRET);
  assert.equal(opts.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.deepEqual([opts.cols, opts.rows], [120, 40]);
  assert.equal(s.c.state().phase, "running");

  s.p.emit("hello\r\n"); s.c.write("list my accounts\r"); s.c.resize(5000, 0);
  assert.equal(s.c.output(), "hello\r\n");
  assert.deepEqual(s.p.child.written, ["list my accounts\r"]);
  assert.deepEqual(s.p.child.resized, [[1000, 1]], "clamped");
  assert.deepEqual(await s.c.start({ runtime }), { ok: false, error: "running" }, "one console at a time");

  await s.c.stop();
  assert.deepEqual(s.kills, [[-4242, "SIGHUP"]], "the whole process group is hung up");
  s.p.exit(129);
  for (let i = 0; i < 100 && s.states.at(-1)?.phase !== "ended"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(s.revoked, ["k1"], "the session's key is revoked when it ends");
  assert.ok(!existsSync(path.dirname(configPath)), "its folder is gone");
  assert.deepEqual(s.states.at(-1), { phase: "ended", reason: "stopped", code: 129, runtime: "claude", keyRevoked: true });
  assert.deepEqual(JSON.parse(readFileSync(path.join(s.dir, "keys.json"), "utf8")), [], "nothing left to revoke later");
});

test("Codex gets the server and the header variables as config overrides; Read sends nothing", async () => {
  const s = setup();
  await s.c.start({ runtime: { id: "codex", name: "Codex", file: "/usr/local/bin/codex" }, level: "read" });
  const args = s.p.spawned[0].args as string[];
  assert.ok(args.some((a) => a === `mcp_servers.fabric_inbox.url="${ORIGIN}/mcp"`));
  assert.ok(args.some((a) => /env_http_headers=\{ "CF-Access-Client-Id" = "FABRIC_INBOX_CONSOLE_ID_[0-9A-F]+", "CF-Access-Client-Secret" = "FABRIC_INBOX_CONSOLE_SECRET_[0-9A-F]+" \}/.test(a)));
  assert.ok(!args.join(" ").includes(SECRET));
  assert.equal(s.minted[0].send, "drafts");
});

test("no key without a sign-in, and a spawn that fails revokes the key it made", async () => {
  const signedOut = setup({ mint: async () => ({ ok: false, signIn: true }) });
  assert.deepEqual(await signedOut.c.start({ runtime: { id: "claude", name: "Claude Code", file: "/x/claude" } }), { ok: false, error: "sign_in", detail: undefined });
  assert.deepEqual(signedOut.p.spawned, [], "nothing runs without a key");
  const broken = setup({ pty: { spawn() { throw new Error("posix_spawnp failed"); } } });
  const out = await broken.c.start({ runtime: { id: "claude", name: "Claude Code", file: "/x/claude" } });
  assert.equal(out.error, "spawn");
  assert.deepEqual(broken.revoked, ["k1"]);
  assert.deepEqual(readdirSync(broken.dir).filter((f) => f.startsWith("session-")), []);
});

test("a key a crashed session left is revoked at the next start; one the server would not revoke is kept for later", async () => {
  const first = setup();
  await first.c.start({ runtime: { id: "claude", name: "Claude Code", file: "/x/claude" } });
  // The app dies here: no exit, no revoke.
  let refuse = true;
  const next = createConsole({ pty: fakePty().pty, fs: fsPromises, dir: first.dir, origin: ORIGIN, mcpUrl: `${ORIGIN}/mcp`, mint: async () => ({ ok: false }),
    revoke: async () => !refuse });
  assert.deepEqual(await next.leftovers(), { revoked: 0, kept: 1 });
  refuse = false;
  assert.deepEqual(await next.leftovers(), { revoked: 1, kept: 0 });
  assert.deepEqual(await next.leftovers(), { revoked: 0, kept: 0 });
});

test("the output ring keeps the last megabyte for a view that opens later", () => {
  const r = ring(10);
  r.push("12345"); r.push("67890"); r.push("ab");
  assert.equal(r.text(), "67890ab");
});

test("the console is in the View menu with its shortcut, and absent where the app has none (Mac App Store)", () => {
  const { menuTemplate } = require("../desktop/menu.cjs");
  const t = (s: string) => s;
  const ctx = (console: unknown) => ({ t, update: {}, automatic: {}, usage: {}, openSettings() {}, showServer() {}, showCloudflare() {}, connectGmail() {}, retry() {}, console });
  const view = (menu: any[]) => menu.find((m) => m.label === "[menu] View").submenu;
  assert.deepEqual(view(menuTemplate("darwin", ctx(() => {})))[0].accelerator, "Ctrl+Cmd+T");
  assert.equal(view(menuTemplate("linux", ctx(() => {})))[0].accelerator, "Ctrl+Shift+T");
  assert.ok(!view(menuTemplate("darwin", ctx(null))).some((i: any) => i.label === "Agent Console"));
});

test("only the console window drives the PTY; the mail page may only ask whether there is one and open it", () => {
  const main = readFileSync("desktop/main.cjs", "utf8");
  assert.match(main, /const fromConsole = \(event\) => \{\s*if \(!policy\.isSetupSender\(event, consoleWindow, consoleURL\)\) throw/);
  for (const channel of ["console-state", "console-start", "console-stop", "console-locale"]) assert.match(main, new RegExp(`handle\\('fabric:${channel}', async \\(event[^)]*\\) => \\{ ?\\s*fromConsole\\(event\\)|handle\\('fabric:${channel}', \\(event\\) => \\{ fromConsole\\(event\\)`), channel);
  assert.match(main, /handle\('fabric:console-open', \(event\) => \{ if \(!policy\.isMailSender\(event, mailWindow, config\)\) throw/);
  assert.match(main, /const consoleAvailable = \(\) => !process\.mas;/, "not in the Mac App Store package");
  assert.match(main, /The agent console is still running\./, "quitting with a running console asks first");
});

test("macOS: node-pty is staged universal, spawn-helper executable, nothing else of the package", { skip: process.platform !== "darwin" }, async () => {
  const { stageConsolePty, stageConsoleView } = await import("../desktop/console-assets.mjs");
  const target = mkdtempSync(path.join(os.tmpdir(), "fabric-console-stage-"));
  const dest = stageConsolePty(target, { platform: "darwin" });
  const { execFileSync } = await import("node:child_process");
  for (const arch of ["arm64", "x64"]) {
    assert.equal(execFileSync("lipo", ["-archs", path.join(dest, "prebuilds", `darwin-${arch}`, "pty.node")], { encoding: "utf8" }).trim().split(/\s+/).sort().join(" "), "arm64 x86_64");
    assert.ok((await fsPromises.stat(path.join(dest, "prebuilds", `darwin-${arch}`, "spawn-helper"))).mode & 0o100, "spawn-helper is executable");
  }
  assert.deepEqual(readdirSync(dest).sort(), ["LICENSE", "lib", "package.json", "prebuilds"]);
  const view = stageConsoleView(target);
  assert.deepEqual(readdirSync(view).sort(), ["LICENSE-xterm", "addon-fit.js", "xterm.css", "xterm.js"]);
});
