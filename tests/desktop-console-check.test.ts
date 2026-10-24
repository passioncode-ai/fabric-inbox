import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { checkPty, ptyCheckCommand, PTY_CHECK_TOKEN } = createRequire(import.meta.url)("../desktop/console.cjs");

/** A node-pty stand-in: prints `output`, then exits with `code` (or never, with exit: false). */
function fakePty({ output = `${PTY_CHECK_TOKEN}\r\n`, code = 0, exit = true, spawnError = "" } = {}) {
  const calls: { file: string; args: string[]; killed: boolean }[] = [];
  return {
    calls,
    pty: {
      spawn(file: string, args: string[]) {
        if (spawnError) throw new Error(spawnError);
        const call = { file, args, killed: false };
        calls.push(call);
        let onData = (_: string) => {}, onExit = (_: { exitCode: number }) => {};
        setTimeout(() => { onData(output); if (exit) onExit({ exitCode: code }); }, 5);
        return { onData: (f: typeof onData) => { onData = f; }, onExit: (f: typeof onExit) => { onExit = f; }, kill: () => { call.killed = true; } };
      },
    },
  };
}

test("B-105: the PTY check runs a fixed echo and is ok when it prints its token and exits 0", async () => {
  const { pty, calls } = fakePty();
  assert.deepEqual(await checkPty({ loadPty: () => pty, platform: "linux" }), { outcome: "ok" });
  assert.deepEqual(calls.map((c) => [c.file, c.args]), [["/bin/sh", ["-c", `echo ${PTY_CHECK_TOKEN}`]]]);
  assert.equal(calls[0].killed, false, "it ends by itself");
});

test("B-105: on Windows the echo runs in the system's cmd.exe, never one found on PATH", () => {
  const { file, args } = ptyCheckCommand("win32", { SystemRoot: "C:\\Windows" });
  assert.match(file, /^C:\\Windows[\\/]System32[\\/]cmd\.exe$/);
  assert.deepEqual(args, ["/d", "/c", `echo ${PTY_CHECK_TOKEN}`]);
});

test("B-105: a PTY that cannot load, cannot spawn, prints nothing or never exits fails with the reason", async () => {
  assert.match((await checkPty({ loadPty: () => { throw new Error("no prebuild"); }, platform: "linux" })).reason, /^load: no prebuild/);
  assert.match((await checkPty({ loadPty: () => fakePty({ spawnError: "ENOENT" }).pty, platform: "linux" })).reason, /^spawn: ENOENT/);
  assert.deepEqual(await checkPty({ loadPty: () => fakePty({ output: "" }).pty, platform: "linux" }), { outcome: "failed", reason: "no output" });
  assert.deepEqual(await checkPty({ loadPty: () => fakePty({ code: 3 }).pty, platform: "linux" }), { outcome: "failed", reason: "exit 3" });
  const hung = fakePty({ exit: false });
  assert.deepEqual(await checkPty({ loadPty: () => hung.pty, platform: "linux", timeoutMs: 50 }), { outcome: "failed", reason: "no exit" });
  assert.equal(hung.calls[0].killed, true, "only a process that outlives the limit is stopped");
});
