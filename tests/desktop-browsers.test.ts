// B-227: the installed browsers the right-click menu offers, found per platform with fakes (nothing real is read).
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error a CommonJS module of the desktop app
import { findBrowsers, openArgs, parseRegClients, parseDesktopEntry, MAX_BROWSERS } from "../desktop/browsers.cjs";

const fakeFs = (present: string[], files: Record<string, string> = {}, dirs: Record<string, string[]> = {}) => ({
  access: async (p: string) => { if (!present.includes(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
  readdir: async (p: string) => { if (!dirs[p]) throw new Error("ENOENT"); return dirs[p]; },
  readFile: async (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; },
});

test("macOS: bundles in /Applications and the person's ~/Applications, opened with open -a", async () => {
  const fs = fakeFs(["/Applications/Safari.app", "/Volumes/Homes/ann/Applications/Google Chrome.app", "/Applications/Dia.app"]);
  const list = await findBrowsers({ platform: "darwin", fs, homedir: "/Volumes/Homes/ann" });
  assert.deepEqual(list.map((b: { name: string }) => b.name), ["Safari", "Chrome", "Dia"]);
  assert.deepEqual(openArgs(list[1], "https://a.example/"), { file: "/usr/bin/open", args: ["-a", "/Volumes/Homes/ann/Applications/Google Chrome.app", "https://a.example/"] });
});

test("Windows: StartMenuInternet clients of both hives, once each, launched by their program", async () => {
  const out = [
    "HKEY_CURRENT_USER\\SOFTWARE\\Clients\\StartMenuInternet\\Firefox-308046B0AF4A39CB",
    "    (Default)    REG_SZ    Firefox",
    "HKEY_CURRENT_USER\\SOFTWARE\\Clients\\StartMenuInternet\\Firefox-308046B0AF4A39CB\\shell\\open\\command",
    "    (Default)    REG_SZ    \"C:\\Program Files\\Mozilla Firefox\\firefox.exe\"",
    "HKEY_CURRENT_USER\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome",
    "    (Default)    REG_SZ    Google Chrome",
    "HKEY_CURRENT_USER\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome\\shell\\open\\command",
    "    (Default)    REG_SZ    \"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\"",
  ].join("\r\n");
  assert.equal(parseRegClients(out).length, 2);
  const execFile = async (_f: string, args: string[]) => (args[1].startsWith("HKCU") ? out : out.replace(/HKEY_CURRENT_USER/g, "HKEY_LOCAL_MACHINE"));
  const list = await findBrowsers({ platform: "win32", execFile });
  assert.deepEqual(list.map((b: { name: string }) => b.name), ["Firefox", "Google Chrome"], "the same program from HKLM is not listed twice");
  assert.deepEqual(openArgs(list[0], "https://a.example/"), { file: "C:\\Program Files\\Mozilla Firefox\\firefox.exe", args: ["https://a.example/"] });
});

test("Linux: desktop entries that handle https, field codes dropped and hidden ones left out", async () => {
  const firefox = "[Desktop Entry]\nName=Firefox\nExec=firefox %u\nMimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;\n[Desktop Action new-window]\nName=New Window\n";
  const hidden = "[Desktop Entry]\nName=Old\nExec=old %U\nMimeType=x-scheme-handler/https;\nNoDisplay=true\n";
  const editor = "[Desktop Entry]\nName=Editor\nExec=editor %F\nMimeType=text/plain;\n";
  assert.deepEqual(parseDesktopEntry(firefox), { name: "Firefox", file: "firefox", args: [] });
  assert.equal(parseDesktopEntry(hidden), null);
  assert.equal(parseDesktopEntry(editor), null);
  const fs = fakeFs([], { "/usr/share/applications/firefox.desktop": firefox, "/usr/share/applications/old.desktop": hidden,
    "/usr/share/applications/editor.desktop": editor }, { "/usr/share/applications": ["editor.desktop", "firefox.desktop", "old.desktop"] });
  const list = await findBrowsers({ platform: "linux", fs, homedir: "/home/ann" });
  assert.deepEqual(list.map((b: { name: string }) => b.name), ["Firefox"]);
});

test("an unknown platform or a failing lookup gives no list, and the list is capped", async () => {
  assert.deepEqual(await findBrowsers({ platform: "freebsd" }), []);
  assert.deepEqual(await findBrowsers({ platform: "win32", execFile: async () => { throw new Error("no reg"); } }), []);
  const all = ["Safari.app", "Google Chrome.app", "Google Chrome Dev.app", "Google Chrome Canary.app", "Chromium.app", "Firefox.app",
    "Firefox Developer Edition.app", "Arc.app", "Dia.app", "Brave Browser.app"].map((b) => `/Applications/${b}`);
  assert.equal((await findBrowsers({ platform: "darwin", fs: fakeFs(all), homedir: "" })).length, MAX_BROWSERS);
});
