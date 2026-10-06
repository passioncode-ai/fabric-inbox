// imapflow imports pino for a default logger we never use (workers/providers/imap/client.ts passes
// `logger: false`); pino's sonic-boom cannot load in workerd, and `npm run dev` stopped on it. The
// Vite config swaps in a silent stand-in for the Worker in dev and in the build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pino from "../workers/providers/imap/pino-stub";

test("the Worker build aliases pino to a silent logger that answers every call imapflow makes", () => {
  assert.match(readFileSync("vite.config.ts", "utf8"), /alias: \{ pino: fileURLToPath\(new URL\("\.\/workers\/providers\/imap\/pino-stub\.ts"/);
  const log = pino();
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) assert.equal(log[level]({ x: 1 }, "message"), undefined);
  assert.equal(log.child().child(), log.child());
  assert.equal(log.isLevelEnabled(), false);
  assert.match(readFileSync("workers/providers/imap/client.ts", "utf8"), /logger: false/);
});
