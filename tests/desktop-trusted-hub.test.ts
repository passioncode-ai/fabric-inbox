// B-307: Fabric's own signed app connects with no dialog; everything else still asks.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { trustedHubWith, bundleOf } = require("../desktop/trusted-hub.cjs");
const { connect } = require("../desktop/connect.cjs");

const SELF = "/Applications/Fabric Inbox.app/Contents/MacOS/Fabric Inbox";
const HUB = { pid: 4242, name: "Fabric", path: "/Applications/Fabric.app/Contents/MacOS/Fabric" };

/** A codesign stand-in: signatures by bundle, and which bundles verify. */
function codesign(sigs: Record<string, { id: string; team: string } | null>, bad: string[] = []) {
  const calls: string[][] = [];
  const exec = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    const bundle = args[args.length - 1];
    if (args[0] === "--verify") { if (bad.includes(bundle)) throw new Error("invalid"); return { stdout: "", stderr: "" }; }
    const sig = sigs[bundle];
    if (!sig) throw Object.assign(new Error("not signed"), { stdout: "", stderr: `${bundle}: code object is not signed at all` });
    return { stdout: "", stderr: `Executable=${bundle}\nIdentifier=${sig.id}\nTeamIdentifier=${sig.team}\n` };
  };
  return { exec, calls };
}
const SIGNED = { "/Applications/Fabric Inbox.app": { id: "ai.passioncode.fabric-inbox", team: "TEAM1" }, "/Applications/Fabric.app": { id: "ai.passioncode.desktop", team: "TEAM1" } };

test("bundleOf finds the .app an executable lies in", () => {
  assert.equal(bundleOf(HUB.path), "/Applications/Fabric.app");
  assert.equal(bundleOf("/usr/local/bin/node"), null);
});

test("Fabric's app signed by the same team, verifying, is trusted", async () => {
  const { exec } = codesign(SIGNED);
  const r = await trustedHubWith(exec, { self: SELF, platform: "darwin" })(HUB);
  assert.deepEqual(r, { trusted: true, reason: "trusted_hub", app: "Fabric" });
});

test("anything else asks the person", async () => {
  const cases: Array<[string, Parameters<typeof codesign>, object, string]> = [
    ["another team", [{ ...SIGNED, "/Applications/Fabric.app": { id: "ai.passioncode.desktop", team: "OTHER" } }], {}, "other_team"],
    ["another app", [{ ...SIGNED, "/Applications/Fabric.app": { id: "com.example.hub", team: "TEAM1" } }], {}, "not_a_trusted_hub"],
    ["an unsigned hub", [{ "/Applications/Fabric Inbox.app": SIGNED["/Applications/Fabric Inbox.app"] }], {}, "hub_unsigned"],
    ["an unsigned self (a development build)", [{ "/Applications/Fabric.app": SIGNED["/Applications/Fabric.app"] }], {}, "self_unsigned"],
    ["a signature that does not verify", [SIGNED, ["/Applications/Fabric.app"]], {}, "signature_invalid"],
    ["the switch off", [SIGNED], { enabled: async () => false }, "switch_off"],
    ["Windows or Linux", [SIGNED], { platform: "linux" }, "platform"],
  ];
  for (const [name, args, opts, reason] of cases) {
    const { exec } = codesign(...args);
    const r = await trustedHubWith(exec, { self: SELF, platform: "darwin", ...opts })(HUB);
    assert.equal(r.trusted, false, name);
    assert.equal(r.reason, reason, name);
  }
  const { exec } = codesign(SIGNED);
  assert.equal((await trustedHubWith(exec, { self: SELF, platform: "darwin" })({ pid: 1, name: "node", path: "/usr/local/bin/node" })).reason, "not_an_app");
});

function flow(trusted: ((l: unknown) => Promise<{ trusted: boolean; app?: string }>) | null) {
  const asked: unknown[] = [];
  const delivered: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  return {
    asked, delivered, logs,
    run: () => connect({
      request: { client: "Fabric", clientId: "fabric", level: "admin", send: "send", callback: "http://127.0.0.1:47000/cb", state: "s".repeat(32) },
      config: { origin: "https://mail.owner.example" },
      confirm: async (p: unknown) => { asked.push(p); return { response: 0 }; },
      identify: async () => HUB,
      mint: async () => ({ ok: true, data: { key: { id: "k1", clientId: "fabric", level: "admin", send: "send" }, clientSecret: "x", mcpUrl: "https://mail.owner.example/mcp" } }),
      revoke: async () => true,
      deliver: async (payload: Record<string, unknown>) => { delivered.push(payload); return true; },
      signIn: async () => {},
      pause: async () => {},
      sleep: async () => {},
      self: 1,
      log: (l: string) => logs.push(l),
      trusted,
    }),
  };
}

test("a trusted hub is connected with no prompt, and says so in the log", async () => {
  const f = flow(async () => ({ trusted: true, app: "Fabric" }));
  const out = await f.run();
  assert.equal(out.outcome, "connected");
  assert.equal(out.auto, true);
  assert.equal(f.asked.length, 0);
  assert.equal(f.delivered[0].outcome, "connected");
  assert.ok(f.logs.some((l) => JSON.parse(l).event === "connect.auto_allowed"));
});

test("an untrusted hub is asked as before (Deny by default)", async () => {
  for (const trusted of [null, async () => ({ trusted: false }), async () => { throw new Error("codesign hung"); }]) {
    const f = flow(trusted as never);
    const out = await f.run();
    assert.equal(out.outcome, "denied");
    assert.equal(f.asked.length, 1);
    assert.equal(out.auto, undefined);
  }
});
