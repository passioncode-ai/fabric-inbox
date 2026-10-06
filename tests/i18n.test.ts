import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  createT, detectLocale, englishT, interpolate, msg, parseAcceptLanguage, parseLocaleChoice, resolveLocale, translateText,
} from "../shared/i18n";
import { RU } from "../shared/i18n/ru/index";
import { readCookie, requestLocale, requestLocaleChoice } from "../shared/i18n/server";
import { formatDetailDate, formatListDate } from "../shared/dates";

const require = createRequire(import.meta.url);
const ru = createT("ru");

/** The shared i18n core, its server side and the Mac app's copy (fabric-workspace localization.md, L10N-01…06). */

test("L10N-01: the first preferred language decides; a stored choice overrides; anything unknown is the system", () => {
  assert.equal(detectLocale(["ru-RU", "en-US"]), "ru");
  assert.equal(detectLocale(["ru"]), "ru");
  assert.equal(detectLocale("ru_RU"), "ru");
  assert.equal(detectLocale(["en-US", "ru-RU"]), "en", "only the first language counts");
  assert.equal(detectLocale([]), "en");
  assert.equal(detectLocale(undefined), "en");
  assert.equal(detectLocale(["uk-UA"]), "en", "no other language is offered yet");
  assert.equal(parseLocaleChoice("ru"), "ru");
  assert.equal(parseLocaleChoice("en"), "en");
  for (const unknown of ["system", "de", "", null, undefined, 1, "RU"]) assert.equal(parseLocaleChoice(unknown), "system", String(unknown));
  assert.equal(resolveLocale("system", ["ru-RU"]), "ru");
  assert.equal(resolveLocale("en", ["ru-RU"]), "en");
  assert.equal(resolveLocale("ru", ["en-US"]), "ru");
});

test("L10N-01: a server page reads ?lang, then the device's cookie, then Accept-Language", () => {
  assert.deepEqual(parseAcceptLanguage("en-US,en;q=0.9,ru;q=0.95"), ["en-US", "ru", "en"]);
  assert.deepEqual(parseAcceptLanguage("ru;q=0, en"), ["en"], "q=0 means not wanted");
  assert.deepEqual(parseAcceptLanguage(""), []);
  assert.equal(readCookie("a=1; fabric-inbox-locale=ru; b=2", "fabric-inbox-locale"), "ru");
  assert.equal(readCookie("fabric-inbox-locale-x=ru", "fabric-inbox-locale"), null);
  const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
  assert.equal(requestLocale(req("https://x.invalid/", { "Accept-Language": "ru-RU,ru;q=0.9" })), "ru");
  assert.equal(requestLocale(req("https://x.invalid/", { "Accept-Language": "ru-RU", Cookie: "fabric-inbox-locale=en" })), "en", "the device's choice wins");
  assert.equal(requestLocale(req("https://x.invalid/?lang=ru", { Cookie: "fabric-inbox-locale=en" })), "ru", "a page opened with lang= keeps it");
  assert.equal(requestLocale(req("https://x.invalid/?lang=xx", { "Accept-Language": "en-GB" })), "en");
  assert.equal(requestLocaleChoice(req("https://x.invalid/")), "system");
});

test("L10N-02: English is the key; a missing entry shows English, never a key; placeholders are named", () => {
  assert.equal(ru("Language"), "Язык");
  assert.equal(ru("A string nobody translated"), "A string nobody translated");
  assert.equal(englishT("Language"), "Language");
  assert.equal(ru("Error {status}", { status: "404" }), "Ошибка 404");
  assert.equal(englishT("Error {status}", { status: "404" }), "Error 404");
  assert.equal(ru("{what} could not load.", {}), "{what}: не удалось загрузить.", "an unnamed value stays visible, not empty");
  // A context in brackets separates two meanings of one English word and never shows in English.
  assert.equal(englishT("[menu] Edit"), "Edit");
  assert.equal(ru("[menu] Edit"), "Правка");
  assert.deepEqual(interpolate(ru("{item} looks for a newer version now."), { item: 1 as unknown as string }), ["1", " — сразу ищет новую версию."]);
  const nodes = ru.rich("{item} chooses the server this app opens.", { item: { el: "strong" } });
  assert.deepEqual(nodes[0], { el: "strong" });
  assert.equal(nodes[1], " — выбирает сервер, который открывает приложение.");
});

test("L10N-03: Russian counts take one, few and many; English one and other; fractions read as few", () => {
  const forms = { one: "{n} domain", other: "{n} domains" };
  const expected: [number, string][] = [
    [0, "0 доменов"], [1, "1 домен"], [2, "2 домена"], [4, "4 домена"], [5, "5 доменов"], [11, "11 доменов"], [12, "12 доменов"],
    [14, "14 доменов"], [21, "21 домен"], [22, "22 домена"], [25, "25 доменов"], [101, "101 домен"], [111, "111 доменов"], [1.5, "1,5 домена"],
  ];
  for (const [n, text] of expected) assert.equal(ru.plural(n, forms), text, String(n));
  assert.equal(ru.plural(1234, forms), "1 234 домена", "thousands are grouped with a no-break space");
  assert.equal(englishT.plural(1, forms), "1 domain");
  assert.equal(englishT.plural(0, forms), "0 domains");
  assert.equal(englishT.plural(1234, forms), "1234 domains", "English output stays exactly as before");
  // Every plural entry in the dictionary has exactly three forms with the same placeholders.
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  for (const [key, entry] of Object.entries(RU)) {
    if (!entry.includes("|") || key.includes("|")) continue;
    const parts = entry.split("|");
    assert.equal(parts.length, 3, key);
    for (const part of parts) assert.equal(placeholders(part), placeholders(key), key);
  }
});

test("L10N-04: a sentence the server wrote in English is shown in Russian; the code still compares the English", () => {
  const refusal = msg("{what} could not load.", { what: "Domains" });
  assert.equal(refusal, "Domains could not load.", "the server's own words do not change");
  assert.equal(translateText("ru", refusal), "Домены: не удалось загрузить.", "the filled template is found and its value translated too");
  assert.equal(ru.text("Something went wrong. Try again."), "Что-то пошло не так. Попробуйте ещё раз.");
  assert.equal(ru.text("A sentence from a newer server"), "A sentence from a newer server", "unknown text stays as it came");
  assert.equal(ru.text("Что-то пошло не так."), "Что-то пошло не так.", "already translated text comes back unchanged");
  assert.equal(englishT.text(refusal), refusal);
  assert.equal(ru.text(""), "");
});

test("L10N-05: dates and numbers follow the language", () => {
  const when = new Date(2026, 3, 15, 15, 42);
  assert.match(ru.date(when, { month: "long", day: "numeric" }), /^15 апреля$/);
  assert.match(ru.time(when, { hour: "numeric", minute: "2-digit" }), /^15:42$/);
  assert.equal(ru.number(1234.5), "1 234,5");
  assert.equal(ru.list(["a", "b", "c"]), "a, b и c");
  assert.equal(englishT.list(["a", "b", "c"]), "a, b, c", "English keeps its existing join");
  const iso = new Date(2020, 3, 15, 15, 42).toISOString();
  assert.match(formatListDate(iso, "ru"), /^15 апр\. 2020 г\.$/);
  assert.match(formatDetailDate(iso, "ru"), /^ср, 15 апр\.,? 15:42$/);
  assert.equal(formatListDate(iso), formatListDate(iso, "en"), "English keeps the system's own format");
});

test("the Mac app's translator reads the same dictionary and keeps the choice in its own file", () => {
  const i18n = require("../desktop/i18n.cjs");
  const copy = JSON.parse(readFileSync("desktop/locales/ru.json", "utf8"));
  for (const [key, value] of Object.entries(copy)) assert.equal(RU[key], value, `desktop copy of ${key}`);
  for (const languages of [["ru-RU"], ["ru"], ["en-US"], [], ["en-US", "ru"]]) assert.equal(i18n.detectLocale(languages), detectLocale(languages), languages.join());
  const dir = mkdtempSync(join(tmpdir(), "fabric-i18n-"));
  try {
    const app = { getPreferredSystemLanguages: () => ["ru-RU", "en-US"] };
    assert.equal(i18n.init({ app, userData: dir }), "ru", "no file: the system language");
    assert.equal(i18n.t("Settings…"), "Настройки…");
    assert.equal(i18n.t("[menu] Edit"), "Правка");
    assert.equal(i18n.setChoice("en", { userData: dir }), true);
    assert.equal(i18n.t("Settings…"), "Settings…");
    assert.equal(i18n.t("[menu] Edit"), "Edit");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "locale.json"), "utf8")), { choice: "en" });
    assert.equal(i18n.init({ app, userData: dir }), "en", "the stored choice wins over the system");
    i18n.setChoice("bogus", { userData: dir });
    assert.equal(i18n.choice(), "system");
    assert.equal(i18n.locale(), "ru");
    assert.deepEqual(i18n.forWindow().locale, "ru");
    assert.equal(i18n.t("{client} is not connected.", { client: "Fabric" }), "Fabric не подключён.");
    assert.equal(i18n.t.plural(3, { one: "{n} thing", other: "{n} things" }), "3 things", "a count the Mac app does not carry stays English");
  } finally {
    require("../desktop/i18n.cjs")._setForTests("en");
    rmSync(dir, { recursive: true, force: true });
  }
});
