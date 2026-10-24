import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { checkPty, ptyCheckCommand, ptyHoldCommand, ptyOptions, PTY_CHECK_TOKEN } = createRequire(import.meta.url)("../desktop/console.cjs");

type Call = { file: string; args: string[]; options: Record<string, unknown>; killed: boolean };

/**
 * A node-pty stand-in. The echo prints `output`, then exits with `code` (or never, with exit: false);
 * the waiting shell (the second spawn) exits when killed, unless `holdIgnoresKill`. `onKill` runs on
 * every kill, as node-pty's Windows kill path runs its own work.
 */
function fakePty({ output = `${PTY_CHECK_TOKEN}\r\n`, code = 0, exit = true, spawnError = "", holdIgnoresKill = false, onKill = () => {} } = {}) {
  const calls: Call[] = [];
  return {
    calls,
    pty: {
      spawn(file: string, args: string[], options: Record<string, unknown>) {
        if (spawnError) throw new Error(spawnError);
        const call: Call = { file, args, options, killed: false };
        const hold = calls.length > 0;
        calls.push(call);
        let onData = (_: string) => {}, onExit = (_: { exitCode: number }) => {};
        if (!hold) setTimeout(() => { onData(output); if (exit) onExit({ exitCode: code }); }, 5);
        return {
          onData: (f: typeof onData) => { onData = f; },
          onExit: (f: typeof onExit) => { onExit = f; },
          kill: () => { call.killed = true; onKill(); if (hold && !holdIgnoresKill) setTimeout(() => onExit({ exitCode: 1 }), 5); },
        };
      },
    },
  };
}

const quick = { timeoutMs: 2000, childProcess: { fork: () => ({}) } };

test("B-105: the PTY check runs a fixed echo and is ok when it prints its token and exits 0", async () => {
  const { pty, calls } = fakePty();
  assert.deepEqual(await checkPty({ loadPty: () => pty, platform: "linux", ...quick }), { outcome: "ok" });
  assert.deepEqual(calls[0].file, "/bin/sh");
  assert.deepEqual(calls[0].args, ["-c", `echo ${PTY_CHECK_TOKEN}`]);
  assert.equal(calls[0].killed, false, "the echo ends by itself");
});

test("B-102: the check then stops a waiting shell the way Stop does, and it ends", async () => {
  const { pty, calls } = fakePty();
  assert.deepEqual(await checkPty({ loadPty: () => pty, platform: "linux", ...quick }), { outcome: "ok" });
  assert.equal(calls.length, 2);
  assert.deepEqual([calls[1].file, calls[1].args], ["/bin/sh", ["-c", "exec sleep 60"]]);
  assert.equal(calls[1].killed, true);
});

test("B-102: a stop that forks a process fails the check (on Windows a fork starts a second app)", async () => {
  const childProcess = { fork: (..._: unknown[]) => ({}) };
  const original = childProcess.fork;
  const { pty } = fakePty({ onKill: () => { childProcess.fork("conpty_console_list_agent"); } });
  assert.deepEqual(await checkPty({ loadPty: () => pty, platform: "linux", timeoutMs: 2000, childProcess }), { outcome: "failed", reason: "stop: forked 1" });
  assert.equal(childProcess.fork, original, "fork is restored after the check");
});

test("B-102: a waiting shell that outlives Stop fails the check", async () => {
  const { pty } = fakePty({ holdIgnoresKill: true });
  assert.deepEqual(await checkPty({ loadPty: () => pty, platform: "linux", ...quick, timeoutMs: 800 }), { outcome: "failed", reason: "stop: no exit" });
});

test("B-102: on Windows every PTY runs on node-pty's own conpty.dll; elsewhere the options are unchanged", async () => {
  assert.deepEqual(ptyOptions("win32", { cols: 80 }), { cols: 80, useConptyDll: true });
  assert.deepEqual(ptyOptions("darwin", { cols: 80 }), { cols: 80 });
  assert.deepEqual(ptyOptions("linux", { cols: 80 }), { cols: 80 });
  const { pty, calls } = fakePty();
  await checkPty({ loadPty: () => pty, platform: "win32", env: { SystemRoot: "C:\\Windows", PATH: "" }, ...quick });
  assert.equal(calls.length, 2);
  for (const c of calls) assert.equal(c.options.useConptyDll, true);
});

test("B-105: on Windows the echo and the waiting shell run in the system's cmd.exe, never one found on PATH", () => {
  const echo = ptyCheckCommand("win32", { SystemRoot: "C:\\Windows" });
  assert.match(echo.file, /^C:\\Windows[\\/]System32[\\/]cmd\.exe$/);
  assert.deepEqual(echo.args, ["/d", "/c", `echo ${PTY_CHECK_TOKEN}`]);
  const hold = ptyHoldCommand("win32", { SystemRoot: "C:\\Windows" });
  assert.equal(hold.file, echo.file);
  assert.deepEqual(hold.args, ["/d", "/k"]);
});

test("B-105: a PTY that cannot load, cannot spawn, prints nothing or never exits fails with the reason", async () => {
  assert.match((await checkPty({ loadPty: () => { throw new Error("no prebuild"); }, platform: "linux", ...quick })).reason, /^load: no prebuild/);
  assert.match((await checkPty({ loadPty: () => fakePty({ spawnError: "ENOENT" }).pty, platform: "linux", ...quick })).reason, /^spawn: ENOENT/);
  assert.deepEqual(await checkPty({ loadPty: () => fakePty({ output: "" }).pty, platform: "linux", ...quick }), { outcome: "failed", reason: "no output" });
  assert.deepEqual(await checkPty({ loadPty: () => fakePty({ code: 3 }).pty, platform: "linux", ...quick }), { outcome: "failed", reason: "exit 3" });
  const hung = fakePty({ exit: false });
  assert.deepEqual(await checkPty({ loadPty: () => hung.pty, platform: "linux", ...quick, timeoutMs: 50 }), { outcome: "failed", reason: "no exit" });
  assert.equal(hung.calls[0].killed, true, "only a process that outlives the limit is stopped");
});
