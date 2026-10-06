// Every English string the interface shows has a Russian entry (fabric-workspace
// knowledge/localization.md, L10N-02/03; the shape follows Fabric Switchboard's check).
//
// Collected with the TypeScript parser, not regular expressions:
//   - the first argument of every t('…'), t.rich('…') and msg('…') call in app/, shared/,
//     workers/ and the Mac app (desktop/*.cjs, desktop/setup.js) — English source = key;
//   - the `other` form of every t.plural(n, { one, other }) call (its Russian entry holds three
//     forms separated by `|`);
//   - the inner HTML of every [data-i18n] element and the [data-i18n-attrs] attributes of
//     desktop/setup.html.
// Fails when a key has no Russian entry, when an entry's {placeholders} (or HTML tags) differ from
// its key's, when a plural entry does not have three forms, when a key sits in two dictionary
// files, when an entry is no longer used (unless reserved), when t() is given something other
// than literal text, or when the Mac app's copy (desktop/locales/ru.json) is stale.
//
// The second half is the literal guard: English written straight into JSX text or into the
// title, aria-label, placeholder, alt and label props of app/**/*.tsx fails, outside a short
// allowlist of names and examples that read the same in every language.
//
// Usage: node scripts/check-locale.mjs [--write] [--list] [--missing] [--json] [--only path,path…]
//   --only keeps the problems and literals that name one of the paths (a file or a directory
//   prefix), for work on one part of the product; the full check is what the gate runs.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = new Set(process.argv.slice(2));
const onlyAt = process.argv.indexOf('--only');
const ONLY = onlyAt > 0 ? (process.argv[onlyAt + 1] || '').split(',').filter(Boolean) : null;
const WRITE = args.has('--write');
const DESKTOP_COPY = join(ROOT, 'desktop/locales/ru.json');
const DICTIONARY_DIR = join(ROOT, 'shared/i18n/ru');

/** Files under a directory with one of the extensions, skipping generated and vendored trees. */
function walk(dir, extensions) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, extensions));
    else if (extensions.some((ext) => name.endsWith(ext)) && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

const keys = new Map(); // key -> { plural, where, desktop }
const problems = [];
const add = (key, where, { plural = false, desktop = false } = {}) => {
  const known = keys.get(key);
  if (!known) keys.set(key, { plural, where, desktop });
  else { if (plural) known.plural = true; if (desktop) known.desktop = true; }
};
const literal = (node) => (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null);
/** The literal texts an argument can be: a literal, or a conditional between literals. */
function literals(node) {
  if (!node) return null;
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) node = node.expression;
  const text = literal(node);
  if (text !== null) return [text];
  if (ts.isConditionalExpression(node)) {
    const a = literals(node.whenTrue); const b = literals(node.whenFalse);
    return a && b ? [...a, ...b] : null;
  }
  return null;
}
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** Collects the keys of one source file. `desktop` marks keys the Mac app needs in its copy. */
function collect(path, { desktop = false } = {}) {
  const rel = relative(ROOT, path);
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, kind);
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const where = `${rel}:${lineOf(sf, node)}`;
      const name = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 't' ? `t.${callee.name.text}` : null;
      if (name === 't' || name === 't.rich' || name === 'msg') {
        const texts = literals(node.arguments[0]);
        if (texts) for (const text of texts) add(text, where, { desktop });
        else if (node.arguments[0] && ts.isTemplateExpression(node.arguments[0])) problems.push(`${where}: ${name}() is given a template with \${…}; use a {placeholder} and params`);
        else if (node.arguments[0]) problems.push(`${where}: ${name}() is given ${node.arguments[0].getText(sf).slice(0, 60)}, not literal text; a finished sentence from elsewhere goes through t.text()`);
      }
      if (name === 't.plural') {
        const forms = node.arguments[1];
        if (forms && ts.isObjectLiteralExpression(forms)) {
          let other = null; let one = null;
          for (const prop of forms.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const prop_ = prop.name.getText(sf);
            if (prop_ === 'other') other = literal(prop.initializer);
            if (prop_ === 'one') one = literal(prop.initializer);
          }
          if (other === null || one === null) problems.push(`${where}: t.plural() needs literal one and other forms`);
          else add(other, where, { plural: true, desktop });
        } else problems.push(`${where}: t.plural() needs its forms written out: { one: "…", other: "…" }`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const sources = [
  ...walk(join(ROOT, 'app'), ['.ts', '.tsx']),
  ...walk(join(ROOT, 'shared'), ['.ts']).filter((p) => !p.startsWith(DICTIONARY_DIR)),
  ...walk(join(ROOT, 'workers'), ['.ts']),
];
for (const path of sources) collect(path);
const desktopSources = readdirSync(join(ROOT, 'desktop')).filter((f) => f.endsWith('.cjs') || f === 'setup.js').map((f) => join(ROOT, 'desktop', f));
for (const path of desktopSources) collect(path, { desktop: true });

// desktop/setup.html: [data-i18n] inner HTML and [data-i18n-attrs] attribute values.
const html = readFileSync(join(ROOT, 'desktop/setup.html'), 'utf8');
const normalise = (text) => text.replace(/\s+/g, ' ').trim();
for (const match of html.matchAll(/<(\w+)([^>]*)\sdata-i18n(?:\s|>|=)/g)) {
  const tag = match[1];
  const start = match.index + match[0].length - 1;
  const open = html.indexOf('>', start);
  // The element's own closing tag, counting nested ones of the same name.
  let depth = 1; let at = open + 1; const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g'); re.lastIndex = at; let end = -1;
  for (let m; (m = re.exec(html));) { depth += m[1] ? -1 : 1; if (depth === 0) { end = m.index; break; } }
  if (end < 0) { problems.push(`desktop/setup.html: <${tag} data-i18n> is not closed`); continue; }
  const line = html.slice(0, match.index).split('\n').length;
  add(normalise(html.slice(open + 1, end)), `desktop/setup.html:${line}`, { desktop: true });
}
for (const match of html.matchAll(/<\w+[^>]*\sdata-i18n-attrs="([^"]+)"[^>]*>/g)) {
  const line = html.slice(0, match.index).split('\n').length;
  for (const attr of match[1].split(/\s+/)) {
    const value = new RegExp(`\\s${attr}="([^"]*)"`).exec(match[0]);
    if (!value) problems.push(`desktop/setup.html:${line}: data-i18n-attrs names ${attr}, which the element does not have`);
    else add(value[1], `desktop/setup.html:${line}`, { desktop: true });
  }
}

// The dictionary, file by file: a key lives in exactly one file.
const transpile = (path) => ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const load = async (path) => import(`data:text/javascript;base64,${Buffer.from(transpile(path)).toString('base64')}`);
const RU = {};
const home = new Map();
let RESERVED = [];
for (const file of readdirSync(DICTIONARY_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts').sort()) {
  const module = await load(join(DICTIONARY_DIR, file));
  for (const [exported, value] of Object.entries(module)) {
    if (exported === 'RESERVED') { RESERVED = RESERVED.concat(value); continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const [key, entry] of Object.entries(value)) {
      if (home.has(key)) problems.push(`dictionary: ${JSON.stringify(key)} is in ${home.get(key)} and ${file}; keep one home`);
      home.set(key, file);
      RU[key] = entry;
    }
  }
}
const index = readFileSync(join(DICTIONARY_DIR, 'index.ts'), 'utf8');
for (const file of readdirSync(DICTIONARY_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts')) {
  if (!index.includes(`./${file.replace(/\.ts$/, '')}"`)) problems.push(`dictionary: ${file} is not merged in shared/i18n/ru/index.ts`);
}

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const tags = (text) => [...text.matchAll(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi)].map((m) => m[0].replace(/\s+/g, ' ')).sort().join('');
const missing = [];
for (const [key, { plural, where }] of keys) {
  const entry = RU[key];
  if (entry === undefined) { missing.push(key); problems.push(`missing (${where}): ${JSON.stringify(key)}`); continue; }
  if (typeof entry !== 'string' || !entry.trim()) { problems.push(`empty entry (${where}): ${JSON.stringify(key)}`); continue; }
  const forms = plural ? entry.split('|') : [entry];
  if (plural && forms.length !== 3) problems.push(`plural needs three forms, one|few|many (${where}): ${JSON.stringify(key)}`);
  if (!plural && entry.includes('|') && !key.includes('|')) problems.push(`entry has | but the key is not counted with t.plural (${where}): ${JSON.stringify(key)}`);
  for (const form of forms) {
    if (placeholders(form) !== placeholders(key)) problems.push(`placeholders differ (${where}): ${JSON.stringify(key)} → ${JSON.stringify(form)}`);
    if (tags(form) !== tags(key)) problems.push(`HTML tags differ (${where}): ${JSON.stringify(key)} → ${JSON.stringify(form)}`);
  }
}
const reserved = new Set(RESERVED);
for (const key of reserved) if (RU[key] === undefined) problems.push(`reserved key has no entry: ${JSON.stringify(key)}`);
const unused = Object.keys(RU).filter((k) => !keys.has(k) && !reserved.has(k));
for (const key of unused) problems.push(`no longer used (${home.get(key)}): ${JSON.stringify(key)} — remove it, or list it in RESERVED`);

// The Mac app's copy: exactly the keys its own files use, plus the reserved ones.
const desktopCopy = {};
for (const [key, { desktop }] of [...keys].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) if (desktop && RU[key] !== undefined) desktopCopy[key] = RU[key];
for (const key of [...reserved].sort()) if (RU[key] !== undefined) desktopCopy[key] = RU[key];
const copyText = JSON.stringify(desktopCopy, null, 1) + '\n';
if (WRITE) writeFileSync(DESKTOP_COPY, copyText);
else if (!existsSync(DESKTOP_COPY) || readFileSync(DESKTOP_COPY, 'utf8') !== copyText) problems.push('desktop/locales/ru.json is stale: run node scripts/check-locale.mjs --write');

// ── The literal guard ─────────────────────────────────────────────────────
// Names and examples that are the same in every language.
const SAME_IN_EVERY_LANGUAGE = new Set([
  'Fabric Inbox', 'Fabric', 'Gmail', 'Google', 'Google Cloud', 'Cloudflare', 'Outlook', 'Microsoft', 'Microsoft Entra', 'Microsoft 365',
  'Outlook.com', 'Hotmail', 'IMAP', 'SMTP', 'OAuth', 'MCP', 'iCloud Mail', 'Yahoo Mail', 'Fastmail', 'Mail.ru', 'GMX', 'Zoho Mail', 'AOL Mail',
  'Claude', 'Claude Code', 'Cursor', 'Codex', 'PassionCode', 'PassionCode.ai', 'Workers AI', 'Email Routing', 'Client ID', 'Client Secret',
  'JSON', 'HTML', 'URL', 'API', 'DNS', 'MX', 'SPF', 'DKIM', 'DMARC', 'TLS', 'SSL/TLS', 'STARTTLS', 'List-Id', 'Reply-To', 'Cc', 'Bcc', 'From', 'To',
  'English', 'Русский', 'B', 'I', 'U', 'S', 'H1', 'H2', 'Esc', 'Tab', 'Enter', 'Return', 'Shift', 'Space', 'Delete', 'Backspace',
]);
const PROPS = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label', 'aria-description', 'aria-roledescription', 'description', 'heading', 'legend', 'emptyText', 'tooltip']);
/** Is this text something a person reads, in English, that a translation would change? */
function readable(text) {
  const value = text.replace(/\s+/g, ' ').trim();
  if (!/[A-Za-z]{2,}/.test(value)) return false; // symbols, digits, ⌘K, one letter
  if (SAME_IN_EVERY_LANGUAGE.has(value)) return false;
  if (/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(value)) return false; // an example address
  if (/^(https?:\/\/|\/|~\/|\.\/)/.test(value)) return false; // a URL or a path
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(value)) return false; // a host name
  if (/^[a-z][a-z0-9]*(?:[-_:][a-z0-9]+)*$/.test(value)) return false; // an id, a code, a CSS word
  if (/^[A-Z][A-Z0-9_]+$/.test(value)) return false; // a constant's name
  return true;
}
const literalsFound = [];
for (const path of walk(join(ROOT, 'app'), ['.tsx'])) {
  const rel = relative(ROOT, path);
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const report = (node, text, what) => literalsFound.push(`${rel}:${lineOf(sf, node)}: ${what} ${JSON.stringify(text.replace(/\s+/g, ' ').trim().slice(0, 70))} is not wrapped in t()`);
  /** A literal shown as it is: a string, or either branch of a conditional, or either side of ?? and ||. */
  const shown = (node, what) => {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    const text = literal(node);
    if (text !== null) { if (readable(text)) report(node, text, what); return; }
    if (ts.isConditionalExpression(node)) { shown(node.whenTrue, what); shown(node.whenFalse, what); return; }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) {
      if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) shown(node.left, what);
      shown(node.right, what);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
      if (readable(parts)) report(node, parts, what);
    }
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) { if (readable(node.text)) report(node, node.text, 'JSX text'); }
    else if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) shown(node.expression, 'JSX text');
    else if (ts.isJsxAttribute(node) && PROPS.has(node.name.getText(sf)) && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) { if (readable(node.initializer.text)) report(node, node.initializer.text, `${node.name.getText(sf)}=`); }
      else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) shown(node.initializer.expression, `${node.name.getText(sf)}=`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (args.has('--list')) for (const [key] of keys) console.log(key);
if (args.has('--missing')) {
  const wanted = ONLY ? missing.filter((key) => ONLY.some((prefix) => keys.get(key).where.includes(prefix))) : missing;
  console.log(JSON.stringify(wanted, null, 1)); process.exit(0);
}
const scoped = (list) => (ONLY ? list.filter((p) => ONLY.some((prefix) => p.includes(prefix))) : list);
const all = [...scoped(problems), ...scoped(literalsFound)];
if (args.has('--json')) { console.log(JSON.stringify({ keys: keys.size, entries: Object.keys(RU).length, desktop: Object.keys(desktopCopy).length, problems, literals: literalsFound })); process.exit(all.length ? 1 : 0); }
if (all.length) {
  console.error(`${scoped(problems).length} localization problem(s), ${scoped(literalsFound).length} unwrapped literal(s)${ONLY ? ` in ${ONLY.join(', ')}` : ''}:`);
  for (const p of all.slice(0, 80)) console.error(`  - ${p}`);
  if (all.length > 80) console.error(`  … and ${all.length - 80} more`);
  process.exit(1);
}
if (ONLY) { console.log(`No problem in ${ONLY.join(', ')}.`); process.exit(0); }
console.log(`${keys.size} interface strings, all in Russian (${Object.keys(desktopCopy).length} in the Mac app's copy); no unwrapped literal in app/.`);
