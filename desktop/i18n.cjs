'use strict';
// The Mac app's language (fabric-workspace knowledge/localization.md, L10N-01…06): its menus,
// dialogs and first-run window follow the same choice as the mail window.
//
// English is the source text and the key: `t('Settings…')`. The Russian entries are a generated
// copy of the app's dictionary (shared/i18n/ru/, written by `node scripts/check-locale.mjs
// --write`), because the packaged app carries only desktop/. A missing entry shows English.
//
// The choice ("system", "en" or "ru") is per Mac, kept in <userData>/locale.json. The mail window
// sets it through its bridge (desktop/mail-preload.cjs) when the person chooses a language in
// Settings → App → Language; "system" follows the first preferred system language.
const fs = require('node:fs');
const path = require('node:path');

let RU = {};
try { RU = require('./locales/ru.json'); } catch { RU = {}; }

const FILE = 'locale.json';
let choice = 'system';
let current = 'en';
let systemLanguages = [];

/** The language the first preferred language asks for: Russian for ru and ru-*, else English. */
function detectLocale(languages) {
  const list = typeof languages === 'string' ? [languages] : Array.isArray(languages) ? languages : [];
  const first = String(list[0] || '').trim().toLowerCase();
  return first === 'ru' || first.startsWith('ru-') || first.startsWith('ru_') ? 'ru' : 'en';
}
const parseChoice = (value) => (value === 'en' || value === 'ru' ? value : 'system');
const resolve = (which, languages) => (which === 'system' ? detectLocale(languages) : which);

/** The system's preferred languages, most wanted first (Electron's app, or nothing in tests). */
function preferredLanguages(app) {
  try { if (app && typeof app.getPreferredSystemLanguages === 'function') { const list = app.getPreferredSystemLanguages(); if (list && list.length) return list; } } catch { /* older Electron */ }
  try { if (app && typeof app.getLocale === 'function') { const one = app.getLocale(); if (one) return [one]; } } catch { /* not ready */ }
  return [];
}

/** Reads this Mac's choice once at start; an unreadable or missing file is the system default. */
function init({ app, userData }) {
  systemLanguages = preferredLanguages(app);
  try { choice = parseChoice(JSON.parse(fs.readFileSync(path.join(userData, FILE), 'utf8')).choice); }
  catch { choice = 'system'; }
  current = resolve(choice, systemLanguages);
  return current;
}

/** Keeps a new choice (written privately and atomically); true when it was kept. */
function setChoice(next, { userData }) {
  const value = parseChoice(next);
  try {
    fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
    const target = path.join(userData, FILE);
    fs.writeFileSync(`${target}.tmp`, JSON.stringify({ choice: value }) + '\n', { mode: 0o600 });
    fs.renameSync(`${target}.tmp`, target);
  } catch { choice = value; current = resolve(choice, systemLanguages); return false; }
  choice = value;
  current = resolve(choice, systemLanguages);
  return true;
}

const fill = (text, params) => (params
  ? text.replace(/\{(\w+)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole))
  : text);

/** The text for an English source string, in the current language. A leading "[context] " is dropped in English. */
function t(source, params) {
  return fill(current === 'ru' && Object.prototype.hasOwnProperty.call(RU, source) ? RU[source] : String(source).replace(/^\[[a-z-]+\] /, ''), params);
}

const rules = { en: new Intl.PluralRules('en-US'), ru: new Intl.PluralRules('ru-RU') };
/** A count with its noun: English one/other; the Russian entry of `other` holds one|few|many. */
t.plural = function plural(n, forms, params) {
  const values = Object.assign({}, params, { n });
  const category = rules[current].select(n);
  const entry = current === 'ru' ? RU[forms.other] : undefined;
  if (!entry) return fill(category === 'one' ? forms.one : forms.other, values);
  const [one, few = one, many = few] = entry.split('|');
  return fill(category === 'one' ? one : category === 'few' || category === 'other' ? few : many, values);
};
/** A finished English sentence from elsewhere (a server's refusal), in the language when known. */
t.text = function text(value) {
  return current === 'ru' && Object.prototype.hasOwnProperty.call(RU, value) ? RU[value] : value;
};

/** Marks English text written outside a t() call (a table's words) for the check; returns it as it is. */
function msg(source, params) { return fill(source, params); }

/** What the first-run window needs to speak the language: its code and the dictionary. */
function forWindow() {
  return { locale: current, messages: current === 'ru' ? RU : {} };
}

module.exports = {
  t, msg, init, setChoice, detectLocale, parseChoice, forWindow,
  locale: () => current,
  choice: () => choice,
  /** For tests: switch without a file. */
  _setForTests(next) { choice = parseChoice(next); current = resolve(choice, systemLanguages); },
};
