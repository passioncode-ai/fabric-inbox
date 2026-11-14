// S11 (B-276, SCN-099): Settings list every held server's accounts, addresses and domains; the app reads each other
// server through its own session, once per open of the list and on Retry, never on a timer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { readSettings, itemsOf, KINDS, PATHS } = require("../desktop/other-settings.cjs");

const B = { origin: "https://acme.example", label: "Acme" };
const C = { origin: "https://down.example", label: "Down" };
const D = { origin: "https://out.example", label: "Out" };

test("each other server is read once, through the kind's own path", async () => {
	for (const kind of KINDS) {
		const asked: string[] = [];
		const read = async (origin: string, path: string) => { asked.push(`${origin}${path}`); return { status: 200, body: {} }; };
		await readSettings({ servers: [B, C], kind, read });
		assert.deepEqual(asked.sort(), [`${B.origin}${PATHS[kind]}`, `${C.origin}${PATHS[kind]}`].sort(), kind);
	}
	assert.deepEqual(PATHS, { accounts: "/api/accounts", addresses: "/api/project-addresses", domains: "/api/domains" });
});

test("401 and 403 read as signed out, a failure or a strange answer as not reachable; one never hides the others", async () => {
	const read = async (origin: string) => {
		if (origin === B.origin) return { status: 200, body: { accounts: [{ id: "a1", email: "ann@acme.example", provider: "imap", providerName: "Fastmail" }, { id: "a2", email: "bob@acme.example" }] } };
		if (origin === C.origin) throw new Error("ENOTFOUND");
		return { status: origin === D.origin ? 403 : 401, body: null };
	};
	const out = await readSettings({ servers: [B, C, D], kind: "accounts", read });
	assert.equal(out.kind, "accounts");
	assert.deepEqual(out.servers.map((s: any) => [s.label, s.state, s.items.map((i: any) => i.id)]),
		[["Acme", "ok", ["imap:a1", "gmail:a2"]], ["Down", "unreachable", []], ["Out", "signed_out", []]]);
	assert.equal(out.servers[0].items[0].detail, "Fastmail");
	const odd = await readSettings({ servers: [B], kind: "addresses", read: async () => ({ status: 200, body: { error: "x" } }) });
	assert.equal(odd.servers[0].state, "unreachable");
	assert.equal((await readSettings({ servers: [B], kind: "domains", read: async () => ({ status: 401, body: null }) })).servers[0].state, "signed_out");
});

test("each kind's items carry the key its section opens them by", () => {
	assert.deepEqual(itemsOf("accounts", { accounts: [{ id: "o1", email: "c@acme.example", provider: "outlook" }, { email: "no id" }] }).map((i: any) => i.id), ["outlook:o1"]);
	assert.deepEqual(itemsOf("addresses", { addresses: [{ email: "support@acme.example", domain: "acme.example" }, { domain: "x" }] }),
		[{ id: "support@acme.example", title: "support@acme.example", detail: "acme.example" }]);
	assert.deepEqual(itemsOf("domains", { domains: [{ domain: "acme.example", served: true }, { domain: "b.example", served: false }] }),
		[{ id: "acme.example", title: "acme.example", detail: "", served: true }, { id: "b.example", title: "b.example", detail: "", served: false }]);
	assert.equal(itemsOf("accounts", { nope: 1 }), null);
});

test("an unknown kind is refused before anything is read", async () => {
	let asked = 0;
	await assert.rejects(readSettings({ servers: [B], kind: "agents", read: async () => { asked++; return { status: 200, body: {} }; } }));
	assert.equal(asked, 0);
});

test("the bridge offers the read and the console's state; main answers them only to a held server's page, and logs the read", () => {
	const preload = readFileSync(new URL("../desktop/mail-preload.cjs", import.meta.url), "utf8");
	assert.match(preload, /otherSettings: \(kind\) => ipcRenderer\.invoke\('fabric:other-settings', String\(kind\)\)/);
	assert.match(preload, /consoleRunning: \(\) => ipcRenderer\.invoke\('fabric:console-running'\)/);
	const main = readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
	const at = main.indexOf("ipcMain.handle('fabric:other-settings'");
	assert.ok(at > 0, "main answers fabric:other-settings");
	const body = main.slice(at, main.indexOf("ipcMain.handle('fabric:console-running'", at));
	assert.match(body, /const self = from\(event\)/, "only a held server's page, at its own main frame");
	assert.match(body, /servers\.filter\(\(s\) => s\.origin !== self\)/, "the other servers only");
	assert.match(body, /serverApi\(origin\)\.get\(pathname\)/, "each through its own session");
	assert.match(body, /other_settings_read/);
	const running = main.slice(main.indexOf("ipcMain.handle('fabric:console-running'"));
	assert.match(running.slice(0, 200), /from\(event\)/);
	assert.doesNotMatch(readFileSync(new URL("../desktop/other-settings.cjs", import.meta.url), "utf8"), /setInterval|setTimeout/, "no timer");
});
