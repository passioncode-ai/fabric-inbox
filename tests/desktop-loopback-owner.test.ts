// Who accepted a loopback connection (B-217, contract DEC-0154 HA-2 and DEC-0155 RT-1/RT-2): the server end of this
// very connection is found in the computer's socket table and its owner compared with ours, so a key is never written
// to another OS account's listener, nor to one whose owner the table will not tell.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ownerWith, normal, netstatDarwinRows, procAddress } = require("../desktop/loopback-owner.cjs");
const { deliverTo, probeWith } = require("../desktop/connect.cjs");

const CONN = { localAddress: "127.0.0.1", localPort: 54331, remoteAddress: "127.0.0.1", remotePort: 47123 };
const SELF = { pid: 900, uid: 501 };

const darwinRow = (local: string, remote: string, proc: string) =>
  `tcp4       0      0  ${local.padEnd(22)} ${remote.padEnd(22)} ESTABLISHED          286         1337  408256  146988           ${proc}  00102 00000004 0000000011df6aba 00000080 01000800      2      0 000000`;
const HEADER = "Active Internet connections (including servers)\nProto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state  options           gencnt    flags   flags1 usecnt rtncnt fltrs";
const TABLE = [HEADER,
  darwinRow("127.0.0.1.47123", "127.0.0.1.54331", "Fabric:4242"),
  darwinRow("127.0.0.1.54331", "127.0.0.1.47123", "Fabric Inbox:900"),
].join("\n");

/** A macOS world: netstat's table, ps's uids, lsof's own descriptors. */
function darwin({ table = TABLE as string | Error, uids = { 4242: 501 } as Record<number, number>, lsof = "" } = {}) {
  const calls: string[] = [];
  const exec = async (file: string, args: string[]) => {
    calls.push(file.split("/").pop()!);
    if (file.endsWith("netstat")) { if (table instanceof Error) throw table; return { stdout: table }; }
    if (file.endsWith("ps")) { const uid = uids[Number(args.at(-1))]; if (uid === undefined) throw Object.assign(new Error("exit 1"), { code: 1 }); return { stdout: `  ${uid}\n` }; }
    if (file.endsWith("lsof")) return { stdout: lsof };
    throw new Error(file);
  };
  return { check: ownerWith(exec, "darwin", undefined, SELF), calls };
}

test("macOS: the server end's process in netstat, its uid from ps, decides", async () => {
  assert.deepEqual(netstatDarwinRows(TABLE).map((r: { pid: number }) => r.pid), [4242, 900], "a process name with a space still yields its pid");
  assert.deepEqual(await darwin().check(CONN), { owner: "self" });
  assert.deepEqual(await darwin({ uids: { 4242: 502 } }).check(CONN), { owner: "foreign-user", reason: "other-account" });
  assert.deepEqual(await darwin({ uids: { 4242: 0 } }).check(CONN), { owner: "foreign-user", reason: "other-account" }, "root's listener is another account's");
  assert.deepEqual(await darwin({ uids: {} }).check(CONN), { owner: "foreign-user", reason: "owner-unknown: process gone" });
  const other = darwin({ table: [HEADER, darwinRow("127.0.0.1.47123", "127.0.0.1.60000", "Fabric:4242")].join("\n") });
  assert.equal((await other.check(CONN)).reason, "table-restricted: no row for this connection", "another connection's row says nothing about this one");
});

test("macOS: a restricted table proves nothing by a missing row; the accepted socket among our descriptors does (RT-1, RT-2)", async () => {
  const own = "p4242\nu501\nf12\nn127.0.0.1:47123->127.0.0.1:54331\nf13\nn127.0.0.1:47123->127.0.0.1:60000\n";
  for (const [table, why] of [["", "no rows"], [HEADER, "no rows"], [[HEADER, darwinRow("127.0.0.1.54331", "127.0.0.1.47123", "Fabric Inbox:900")].join("\n"), "own rows only"]] as const) {
    assert.deepEqual(await darwin({ table, lsof: own }).check(CONN), { owner: "self" }, `${why}: proven by our own descriptor`);
    assert.deepEqual(await darwin({ table }).check(CONN), { owner: "foreign-user", reason: `table-restricted: ${why}` }, why);
  }
  const failed = darwin({ table: Object.assign(new Error("exit 1"), { code: 1 }) });
  assert.deepEqual(await failed.check(CONN), { owner: "foreign-user", reason: "table-restricted: netstat exit 1" });
  const wrongUid = "p77\nu502\nf9\nn127.0.0.1:47123->127.0.0.1:54331\n";
  assert.equal((await darwin({ table: "", lsof: wrongUid }).check(CONN)).owner, "foreign-user", "a descriptor of another uid proves nothing");
  const readable = darwin({ uids: { 4242: 502 }, lsof: own });
  assert.equal((await readable.check(CONN)).reason, "other-account", "a readable table naming another account decides");
  assert.ok(!readable.calls.includes("lsof"), "and lsof is not asked");
});

const hex4 = (address: string) => address.split(".").map((n) => Number(n).toString(16).toUpperCase().padStart(2, "0")).reverse().join("");
const hexPort = (port: number) => port.toString(16).toUpperCase().padStart(4, "0");
const procLine = (n: number, local: string, lport: number, remote: string, rport: number, state: string, uid: number, inode: string) =>
  `   ${n}: ${local}:${hexPort(lport)} ${remote}:${hexPort(rport)} ${state} 00000000:00000000 00:00000000 00000000  ${uid}        0 ${inode} 1 0000000000000000 20 4 30 10 -1`;
const PROC_HEAD = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const LO = hex4("127.0.0.1"), ANY = hex4("0.0.0.0");

function linux(tcp: string[], tcp6: string[] | null = []) {
  const fs = { readFile: async (path: string) => {
    if (path === "/proc/net/tcp") return [PROC_HEAD, ...tcp].join("\n");
    if (path === "/proc/net/tcp6" && tcp6) return [PROC_HEAD, ...tcp6].join("\n");
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  } };
  return ownerWith(async () => { throw new Error("no exec on Linux"); }, "linux", fs, { pid: 900, uid: 1000 });
}

test("Linux: the accepted connection's row carries its uid; a row not yet accepted falls to the listener on the address", async () => {
  const listen = (address: string, uid: number) => procLine(0, address, 47123, ANY, 0, "0A", uid, "111");
  const accepted = (uid: number) => procLine(1, LO, 47123, LO, 54331, "01", uid, "222");
  const pending = procLine(1, LO, 47123, LO, 54331, "01", 0, "0");
  assert.deepEqual(await linux([listen(LO, 1000), accepted(1000)])(CONN), { owner: "self" });
  assert.deepEqual(await linux([listen(LO, 1000), accepted(1001)])(CONN), { owner: "foreign-user", reason: "other-account" }, "the connection's own row wins over the listener");
  assert.deepEqual(await linux([listen(LO, 1000), pending])(CONN), { owner: "self" }, "inode 0: its uid 0 is no root owner; the listener decides");
  assert.deepEqual(await linux([listen(LO, 1001), listen(ANY, 1000), pending])(CONN), { owner: "foreign-user", reason: "other-account" }, "the listener on the local address counts before a wildcard");
  assert.deepEqual(await linux([listen(ANY, 1000), pending])(CONN), { owner: "self" }, "a wildcard counts when none listens on the address");
  assert.equal((await linux([listen(ANY, 1000), listen(ANY, 1001), pending])(CONN)).reason, "owner-unknown: listeners of several accounts");
  assert.equal((await linux([procLine(1, LO, 47123, LO, 54331, "06", 0, "0")])(CONN)).reason, "owner-unknown: server end closed");
  assert.equal((await linux([listen(LO, 1000)])(CONN)).reason, "owner-unknown: no row for this connection");
  assert.equal((await linux([], null)(CONN)).reason, "owner-unknown: no row for this connection", "no tcp6 is fine");
});

test("Linux: IPv6 rows, ::1 and a dual-stack socket's v4-mapped address", async () => {
  assert.equal(procAddress("00000000000000000000000001000000"), "::1");
  assert.equal(procAddress("0000000000000000FFFF00000100007F"), "127.0.0.1");
  assert.equal(procAddress("00000000000000000000000000000000"), "::");
  assert.equal(procAddress(LO), "127.0.0.1");
  const mapped = procLine(1, "0000000000000000FFFF00000100007F", 47123, "0000000000000000FFFF00000100007F", 54331, "01", 1000, "333");
  assert.deepEqual(await linux([], [mapped])(CONN), { owner: "self" }, "a dual-stack listener accepted the IPv4 connection");
  const six = { localAddress: "::1", localPort: 54331, remoteAddress: "::1", remotePort: 47123 };
  const v6 = procLine(1, "00000000000000000000000001000000", 47123, "00000000000000000000000001000000", 54331, "01", 1001, "444");
  assert.deepEqual(await linux([], [v6])(six), { owner: "foreign-user", reason: "other-account" });
  assert.equal(normal("[::FFFF:127.0.0.1]"), "127.0.0.1");
});

function windows(rows: string[], users: Record<number, string>) {
  return ownerWith(async (file: string, args: string[]) => {
    if (file.endsWith("netstat.exe")) return { stdout: ["Active Connections", "", "  Proto  Local Address          Foreign Address        State           PID", ...rows].join("\r\n") };
    if (file.endsWith("tasklist.exe")) {
      assert.equal(args[0], "/V");
      const pid = Number(/PID eq (\d+)/.exec(args.join(" "))![1]);
      return { stdout: `"app.exe","${pid}","Console","1","10,000 K","Running","${users[pid] ?? "N/A"}","0:00:01","N/A"\r\n` };
    }
    throw new Error(file);
  }, "win32", undefined, { pid: 900, uid: null });
}

test("Windows: the connection's row in netstat names the process; tasklist names its user, ours or not", async () => {
  const rows = ["  TCP    127.0.0.1:47123        0.0.0.0:0              LISTENING       4242", "  TCP    127.0.0.1:47123        127.0.0.1:54331        HERGESTELLT     4242", "  TCP    127.0.0.1:54331        127.0.0.1:47123        HERGESTELLT     900"];
  assert.deepEqual(await windows(rows, { 4242: "PC\\me", 900: "pc\\ME" })(CONN), { owner: "self" }, "a translated state word and the name's case do not matter");
  assert.deepEqual(await windows(rows, { 4242: "PC\\other", 900: "PC\\me" })(CONN), { owner: "foreign-user", reason: "other-account" });
  assert.deepEqual(await windows(rows, { 900: "PC\\me" })(CONN), { owner: "foreign-user", reason: "owner-unknown: process cannot be opened" }, "another account's process reads N/A");
  assert.equal((await windows(rows.slice(0, 1), { 4242: "PC\\me", 900: "PC\\me" })(CONN)).reason, "owner-unknown: no row for this connection", "a listener is not the connection");
  const six = { localAddress: "::1", localPort: 54331, remoteAddress: "::1", remotePort: 47123 };
  assert.deepEqual(await windows(["  TCP    [::1]:47123            [::1]:54331            ESTABLISHED     4242"], { 4242: "PC\\me", 900: "PC\\me" })(six), { owner: "self" });
});

async function listen(onData: (chunk: Buffer) => void): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => { req.on("data", onData); req.on("end", () => { res.writeHead(200); res.end("{}"); }); });
  server.on("connection", (socket) => socket.on("data", onData));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as { port: number }).port };
}

test("a key is written only after the check passes on the open socket; a refusal writes not a byte", async () => {
  const bytes: Buffer[] = [];
  const { server, port } = await listen((c) => bytes.push(c));
  try {
    const seen: Record<string, unknown>[] = [];
    const yes = async (conn: Record<string, unknown>) => { seen.push(conn); return { owner: "self" }; };
    const body = { state: "s".repeat(32), outcome: "connected", clientSecret: "SECRET-VALUE" };
    assert.equal(await deliverTo(`http://127.0.0.1:${port}/cb`, { check: yes })(body), true);
    assert.equal(seen[0]!.remotePort, port, "the check sees this socket's server end");
    assert.match(Buffer.concat(bytes).toString(), /SECRET-VALUE/);
    bytes.length = 0;
    const no = async () => ({ owner: "foreign-user", reason: "other-account" });
    assert.deepEqual(await deliverTo(`http://127.0.0.1:${port}/cb`, { check: no })(body), { refused: "foreign_user", detail: "other-account" });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(Buffer.concat(bytes).length, 0, "not even the request line was written");
    const throws = async () => { throw new Error("boom"); };
    assert.equal((await deliverTo(`http://127.0.0.1:${port}/cb`, { check: throws })(body)).refused, "foreign_user", "a check that fails refuses");
    let checked = 0;
    const counting = async () => { checked++; return { owner: "self" }; };
    assert.equal(await deliverTo(`http://127.0.0.1:${port}/cb`, { check: counting, fetch: async () => new Response("{}", { status: 200 }) })({ state: "s".repeat(32), outcome: "denied" }), true);
    assert.equal(checked, 0, "a body with no key goes as before");
  } finally { server.close(); }
});

test("the probe before the prompt: self, another account, or nothing listening", async () => {
  const { server, port } = await listen(() => {});
  try {
    assert.deepEqual(await probeWith(async () => ({ owner: "self" }))(`http://127.0.0.1:${port}/cb`), { state: "self" });
    assert.deepEqual(await probeWith(async () => ({ owner: "foreign-user", reason: "table-restricted: no rows" }))(`http://127.0.0.1:${port}/cb`), { state: "foreign-user", detail: "table-restricted: no rows" });
  } finally { server.close(); }
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(await probeWith(async () => ({ owner: "self" }))(`http://127.0.0.1:${port}/cb`), { state: "down" });
});

const execAsync = (file: string, args: string[]) => new Promise<{ stdout: string }>((resolve, reject) =>
  execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve({ stdout }))));

test("this computer's own table tells our own listener as ours", { skip: process.platform === "win32" ? "tasklist /V is slow on the runner; the Windows path is covered by its fixtures" : false }, async () => {
  const { server, port } = await listen(() => {});
  try {
    const check = ownerWith(execAsync);
    assert.equal(await deliverTo(`http://127.0.0.1:${port}/cb`, { check })({ clientSecret: "x" }), true, "our own server is ours, from a full or a restricted table");
  } finally { server.close(); }
});
