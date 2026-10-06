#!/usr/bin/env node
// Settings scroll check (SCR-02; the 2026-10-06 audit: choosing a domain scrolled the page to the top).
//
// Drives a running app in a Chrome that exposes the DevTools protocol and asserts, at 1360 px and at
// 800 px, that choosing a row deep in a long list moves nothing: window.scrollY, the list's own
// scrollTop and the row's position stay the same, and the row stays the same element. At 800 px it
// also checks that the panel replaces the list and Back returns to the same scroll position with
// the focus on the row. Uses only Node's built-in fetch and WebSocket (Node 22+); no dependency.
//
//   node scripts/settings-scroll-check.mjs --app http://127.0.0.1:5176 [--cdp http://127.0.0.1:9222] [--shots <dir>]
//
// The app needs a long list: start it with npm run dev and give it a few dozen addresses (README →
// Develop and test). Exit code 0 when every check holds, 1 when one fails, 2 when it cannot run.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[i + 1]]] : pairs), []));
const app = (args.app ?? "http://127.0.0.1:5176").replace(/\/$/, "");
const cdp = (args.cdp ?? "http://127.0.0.1:9222").replace(/\/$/, "");
const shots = args.shots ?? null;

async function open() {
  const target = await fetch(`${cdp}/json/new?about:blank`, { method: "PUT" }).then((r) => {
    if (!r.ok) throw new Error(`Chrome at ${cdp} answered ${r.status}`);
    return r.json();
  });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("Could not attach to the new tab")); });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const { resolve, reject } = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (fn, ...fnArgs) => {
    const r = await send("Runtime.evaluate", { expression: `(${fn})(...${JSON.stringify(fnArgs)})`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const close = async () => { ws.close(); await fetch(`${cdp}/json/close/${target.id}`).catch(() => {}); };
  return { send, evaluate, close };
}

/** In the page: wait for a row, scroll it into the middle of its list, choose it, and measure. */
async function chooseDeepRow(rowKey) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100 && !document.querySelector(`[data-row-key="${rowKey}"]`); i++) await wait(100);
  const row = document.querySelector(`[data-row-key="${rowKey}"]`);
  if (!row) return { error: `no row ${rowKey}` };
  const list = row.closest('[data-scroll="list"]');
  row.scrollIntoView({ block: "center" });
  await wait(300);
  const before = { scrollY: window.scrollY, listTop: list.scrollTop, rowTop: Math.round(row.getBoundingClientRect().top) };
  row.click();
  for (let i = 0; i < 50 && !document.querySelector(".fi-panel h2"); i++) await wait(100);
  await wait(1200);
  const same = document.querySelector(`[data-row-key="${rowKey}"]`);
  const section = document.querySelector(".fi-section");
  const after = {
    scrollY: window.scrollY, listTop: list.scrollTop, rowTop: Math.round(same.getBoundingClientRect().top), sameElement: same === row,
    selected: same.getAttribute("aria-current") === "true", panel: document.querySelector(".fi-panel h2")?.textContent ?? null,
    listVisible: getComputedStyle(section.querySelector(".fi-section-list")).visibility,
    panelVisible: getComputedStyle(section.querySelector(".fi-section-panel")).visibility,
  };
  return { before, after };
}

/** In the page (narrow): Back from the panel returns to the list where it was, focus on the row. */
async function backToList(rowKey) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const list = document.querySelector('[data-scroll="list"]');
  document.querySelector(".fi-panel-back").click();
  await wait(800);
  const row = document.querySelector(`[data-row-key="${rowKey}"]`);
  return { scrollY: window.scrollY, listTop: list.scrollTop, rowTop: Math.round(row.getBoundingClientRect().top), focus: document.activeElement?.getAttribute("data-row-key"),
    listVisible: getComputedStyle(list.closest(".fi-section-list")).visibility };
}

/** In the page: the arrow keys move the focus to the next row. */
async function arrowDown() {
  const rows = [...document.querySelectorAll("[data-row-key]")];
  rows[0].focus();
  rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  return { focused: document.activeElement?.getAttribute("data-row-key"), expected: rows[1]?.getAttribute("data-row-key") };
}

const failures = [];
const check = (ok, what, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures.push(what);
};

async function pickDeepRow(page, section) {
  await page.send("Page.navigate", { url: `${app}/settings/${section}` });
  // The old document answers until the new one has loaded.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return page.evaluate(async () => {
    for (let i = 0; i < 100 && document.querySelectorAll("[data-row-key]").length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    const keys = [...document.querySelectorAll("[data-row-key]")].map((r) => r.getAttribute("data-row-key")).filter((k) => !["connect", "journal", "answers"].includes(k));
    return { count: keys.length, key: keys[Math.floor(keys.length * 0.8)] ?? null };
  });
}

let page;
try {
  page = await open();
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  if (shots) await mkdir(shots, { recursive: true });
  for (const width of [1360, 800]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 860, deviceScaleFactor: 1, mobile: false });
    for (const section of ["addresses", "domains"]) {
      const { count, key } = await pickDeepRow(page, section);
      check(count >= 20, `${section} at ${width}px has a long list to test (${count} rows)`);
      if (!key) continue;
      const r = await page.evaluate(chooseDeepRow, key);
      if (r.error) { check(false, `${section} at ${width}px: ${r.error}`); continue; }
      check(r.after.scrollY === 0 && r.before.scrollY === 0, `${section} at ${width}px: the page itself never scrolls`, { before: r.before.scrollY, after: r.after.scrollY });
      check(r.after.sameElement && r.after.selected, `${section} at ${width}px: the chosen row stays the same element and is selected`);
      check(r.after.panel === key, `${section} at ${width}px: the panel shows the chosen item`, { panel: r.after.panel });
      if (width > 930) {
        check(r.after.listTop === r.before.listTop && r.after.rowTop === r.before.rowTop, `${section} at ${width}px: the list and the row do not move`, { before: r.before, after: { listTop: r.after.listTop, rowTop: r.after.rowTop } });
      } else {
        check(r.after.listVisible === "hidden" && r.after.panelVisible === "visible", `${section} at ${width}px: the panel takes the list's place`);
        const back = await page.evaluate(backToList, key);
        check(back.listVisible === "visible" && back.listTop === r.before.listTop && back.rowTop === r.before.rowTop, `${section} at ${width}px: Back returns to the same place in the list`, { before: r.before, back });
        check(back.focus === key, `${section} at ${width}px: the focus returns to the row`, { focus: back.focus });
        await page.evaluate(chooseDeepRow, key);
      }
      if (shots) {
        const image = await page.send("Page.captureScreenshot", { format: "png" });
        await writeFile(path.join(shots, `${section}-${width}.png`), Buffer.from(image.data, "base64"));
      }
    }
  }
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1360, height: 860, deviceScaleFactor: 1, mobile: false });
  await pickDeepRow(page, "addresses");
  const keys = await page.evaluate(arrowDown);
  check(keys.focused === keys.expected, "the arrow keys move the focus down the list", keys);
} catch (error) {
  console.error(`Could not run the check: ${error.message}`);
  await page?.close();
  process.exit(2);
}
await page.close();
console.log(failures.length ? `${failures.length} check(s) failed.` : "Every check held.");
process.exit(failures.length ? 1 : 0);
