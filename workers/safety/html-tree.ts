import { collectFrom, DEFAULT_BUDGET, treeView, type AbstractNode } from "../../vendor/okolos/core-collect/index";
import type { StyleValues } from "../../vendor/okolos/core-collect/view";
import { detectHidden } from "../../vendor/okolos/core-injection/stage1";
import type { SignalName } from "../../vendor/okolos/core-injection/signals";

/**
 * B-303: the hidden text of an HTML attachment, read the way Okolos reads a page (its answer on the board, 2026-11-19).
 * The attachment is parsed into Okolos's plain tree (`AbstractNode`), its candidates collected with `collectFrom`
 * (comments, text styled out of sight, `aria-hidden`, `<template>`, JSON-LD, `alt`, `title`, `aria-label`, `meta`,
 * `data-*`) and judged with `detectHidden`. A document converted to text loses these: a comment or a `display:none`
 * block is dropped or read as if a person saw it.
 *
 * There is no stylesheet here, only inline `style`, so text a `<style>` rule hides is not seen. What a person cannot see
 * because an ancestor is not rendered (`display:none`, `hidden`, `visibility:hidden`, `opacity:0`) is marked on the
 * descendants too, which a browser's computed `display` would not say: an attachment is never rendered for a person
 * by this server, so reading more as hidden only adds candidates.
 */
export const MAX_HTML_CHARS = 2_000_000;
const MAX_DEPTH = 400;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** Elements whose content is raw text, not markup. */
const RAW = new Set(["script", "style", "textarea", "title", "xmp"]);

const decode = (s: string) => s
  .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => { const n = parseInt(h, 16); return n <= 0x10ffff ? String.fromCodePoint(n) : ""; })
  .replace(/&#(\d+);/g, (_, d) => { const n = Number(d); return n <= 0x10ffff ? String.fromCodePoint(n) : ""; })
  .replace(/&amp;/gi, "&");

/** The attributes of a start tag, names in lower case, the first of a repeated name kept (as a browser does). */
export function attributesOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const inner = tag.replace(/^<[a-zA-Z][a-zA-Z0-9-]*/, "").replace(/\/?>$/, "");
  const re = /([^\s"'=<>\/]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (let m: RegExpExecArray | null; (m = re.exec(inner)); ) {
    const name = m[1]!.toLowerCase();
    if (!(name in out)) out[name] = decode(m[3] ?? m[4] ?? m[5] ?? "");
  }
  return out;
}

const STYLE_NAMES: Record<string, keyof StyleValues> = {
  display: "display", visibility: "visibility", opacity: "opacity", "font-size": "fontSize", "clip-path": "clipPath", clip: "clip",
  position: "position", left: "left", top: "top", color: "color", "background-color": "backgroundColor", background: "backgroundColor",
};

/** An inline `style` as the values the collector reads; a value left out reads as its initial value. */
type Style = { -readonly [K in keyof StyleValues]?: string };

export function styleOf(inline: string | undefined): Style {
  const out: Style = {};
  for (const part of (inline ?? "").split(";")) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    const name = STYLE_NAMES[part.slice(0, at).trim().toLowerCase()];
    if (!name) continue;
    let value = part.slice(at + 1).replace(/!important/i, "").trim().toLowerCase();
    // The collector compares computed values: a bare zero is `0px`, and a shorthand background keeps its colour.
    if (name === "fontSize" && /^0(\.0+)?$/.test(value)) value = "0px";
    if (name === "backgroundColor") value = value.split(/\s+(?![^(]*\))/)[0] ?? value;
    out[name] = value;
  }
  return out;
}

interface Building { tag: string; attributes: Record<string, string>; text: string[]; comments: { text: string }[]; children: Building[]; template?: string[] }

/**
 * The document as Okolos's plain tree, tolerant of broken HTML: an end tag closes up to its match, a stray one is
 * ignored, and nesting past MAX_DEPTH is flattened. Comments before the first element are returned beside the tree.
 */
export function parseHtml(html: string): { root: AbstractNode | null; outside: { text: string }[] } {
  const source = html.slice(0, MAX_HTML_CHARS);
  const top: Building = { tag: "#document", attributes: {}, text: [], comments: [], children: [] };
  const stack: Building[] = [top];
  const current = () => stack[stack.length - 1]!;
  const inTemplate = () => stack.find((b) => b.template);
  const token = /<!--([\s\S]*?)(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|([^<]+|<)/g;
  for (let m: RegExpExecArray | null; (m = token.exec(source)); ) {
    const template = inTemplate();
    // A comment inside a template is read as the template's text: no walk of the page reaches the template's content.
    if (m[1] !== undefined) { if (template) template.template!.push(m[1]); else current().comments.push({ text: m[1] }); continue; }
    if (m[5] !== undefined) { const t = decode(m[5]); if (template) template.template!.push(t); else current().text.push(t); continue; }
    if (m[2] !== undefined) {
      const name = m[2].toLowerCase();
      const at = stack.map((b) => b.tag).lastIndexOf(name);
      if (at > 0) stack.length = at;
      continue;
    }
    if (m[3] === undefined) continue;
    const name = m[3].toLowerCase();
    const whole = m[0];
    if (template) continue; // a template's content is its text, not elements of the page
    const el: Building = { tag: name, attributes: attributesOf(whole), text: [], comments: [], children: [] };
    if (name === "template") el.template = [];
    current().children.push(el);
    if (VOID.has(name) || whole.endsWith("/>")) continue;
    if (RAW.has(name)) {
      // Raw text up to its end tag: a script's or a title's content is never markup.
      const end = new RegExp(`</${name}\\s*>`, "ig");
      end.lastIndex = token.lastIndex;
      const close = end.exec(source);
      el.text.push(name === "title" || name === "textarea" ? decode(source.slice(token.lastIndex, close ? close.index : source.length)) : source.slice(token.lastIndex, close ? close.index : source.length));
      token.lastIndex = close ? end.lastIndex : source.length;
      continue;
    }
    if (stack.length < MAX_DEPTH) stack.push(el);
  }
  const hidden = (b: Building, s: Partial<StyleValues>) => "hidden" in b.attributes || s.display === "none" || s.visibility === "hidden"
    || s.visibility === "collapse" || parseFloat(s.opacity ?? "1") === 0;
  const finish = (b: Building, concealed: boolean): AbstractNode => {
    const own = styleOf(b.attributes.style);
    // The `hidden` attribute is `display: none` in every browser's own stylesheet.
    if ("hidden" in b.attributes && !own.display) own.display = "none";
    const style: Partial<StyleValues> = concealed && !hidden(b, own) ? { ...own, display: "none" } : own;
    const text = b.text.join("");
    return {
      tag: b.tag,
      attributes: b.attributes,
      ...(text.trim() ? { text } : {}),
      ...(b.comments.length ? { comments: b.comments } : {}),
      ...(b.template ? { template: b.template.join("") } : {}),
      style,
      children: b.children.map((c) => finish(c, concealed || hidden(b, own))),
    };
  };
  const roots = top.children;
  const outside = top.comments;
  if (!roots.length && !top.text.join("").trim()) return { root: null, outside };
  // A fragment with no single document element (an HTML part with several top-level elements) gets one, as a browser does.
  const html_ = roots.length === 1 && roots[0]!.tag === "html" ? roots[0]! : { tag: "html", attributes: {}, text: top.text, comments: [], children: roots };
  return { root: finish(html_, false), outside };
}

export interface HtmlHidden {
  /** Signals of the hidden text Okolos's rules decided on (one stands alone or two corroborate: high; one: medium). */
  signals: SignalName[];
  /** The hidden texts that carry them, at most `HIDDEN_QUOTE` characters together. */
  quoted: string;
  /** Okolos's collector stopped at its budget: the rest of the document was not read. */
  truncated: boolean;
}

export const HIDDEN_QUOTE = 4_000;

/**
 * Okolos's budget is a browser tab's (5,000 elements, 50 candidates). An attachment is read once, on the server, and a
 * long one (a report, a table) has more elements than that: with the tab's budget a hidden line at the end of a 2 MB
 * table was never reached (measured 2026-11-19). The whole document up to MAX_HTML_CHARS fits this one.
 */
export const ATTACHMENT_BUDGET = { ...DEFAULT_BUDGET, maxNodes: 200_000, maxCandidates: 400 };

/** An HTML document's hidden text, judged by Okolos's rules. */
export function htmlHidden(html: string, now = new Date()): HtmlHidden {
  const { root, outside } = parseHtml(html);
  const page = collectFrom(treeView(root, outside), { url: "attachment:", frameId: 0, budget: ATTACHMENT_BUDGET, elapsed: () => 0 });
  let n = 0;
  const verdicts = detectHidden(page, { now: now.toISOString(), newId: () => `hidden-${++n}` });
  const signals = new Set<SignalName>();
  const quotes: string[] = [];
  for (const v of verdicts) for (const e of v.evidence) {
    for (const s of String(e.detail?.signals ?? "").split(",")) if (s) signals.add(s as SignalName);
    if (e.snippet) quotes.push(String(e.snippet));
  }
  return { signals: [...signals], quoted: quotes.join("\n").slice(0, HIDDEN_QUOTE), truncated: page.truncated };
}
