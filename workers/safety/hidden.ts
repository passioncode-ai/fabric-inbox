/**
 * B-178: the text of an HTML message that a person does not see but a model reads: elements styled out of sight,
 * the `hidden` attribute, comments, and the alt and title of elements. Pure and tolerant of broken HTML: a tag
 * that never closes hides at most what follows it up to HIDDEN_CHARS.
 */
export const HIDDEN_CHARS = 20_000;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const SKIPPED = new Set(["script", "style", "head", "title"]);

/** Inline styles that put text out of a person's sight. */
const HIDING_STYLE = [
  /display\s*:\s*none/i,
  /visibility\s*:\s*(hidden|collapse)/i,
  /opacity\s*:\s*0(\.0+)?\s*(;|$|!)/i,
  /font-size\s*:\s*(0|0?\.\d+|1)(px|pt|em|rem|%)?\s*(;|$|!)/i,
  /(max-)?height\s*:\s*0(px)?\s*(;|$|!)[^]*overflow\s*:\s*hidden|overflow\s*:\s*hidden[^]*(max-)?height\s*:\s*0(px)?\s*(;|$|!)/i,
  /(left|top|text-indent)\s*:\s*-\d{3,}/i,
  /clip(-path)?\s*:\s*(rect\(\s*0|inset\(\s*50%)/i,
  // White or transparent text: the background is rarely white-on-white on purpose.
  /(^|;|\s)color\s*:\s*(#fff(fff)?|white|transparent|rgba\([^)]*,\s*0\s*\))\s*(;|$|!)/i,
];

export function hidesText(style: string): boolean {
  return HIDING_STYLE.some((r) => r.test(style));
}

const decode = (s: string) => s
  .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/gi, "&");

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? "") : null;
};

export interface HiddenText {
  /** What a person sees, as text. */
  visible: string;
  /** What only a machine reads, as text, at most HIDDEN_CHARS. */
  hidden: string;
}

export function splitHidden(html: string): HiddenText {
  const visible: string[] = [];
  const hidden: string[] = [];
  let hiddenChars = 0;
  const keepHidden = (text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t || hiddenChars >= HIDDEN_CHARS) return;
    hidden.push(t.slice(0, HIDDEN_CHARS - hiddenChars));
    hiddenChars += t.length;
  };
  // The open elements: each with whether it hides its content, and whether it is skipped altogether.
  const stack: { name: string; hides: boolean; skips: boolean }[] = [];
  const hiding = () => stack.some((e) => e.hides);
  const skipping = () => stack.some((e) => e.skips);
  const token = /<!--([\s\S]*?)(-->|$)|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|([^<]+|<)/g;
  for (let m: RegExpExecArray | null; (m = token.exec(html)); ) {
    if (m[1] !== undefined) { keepHidden(m[1]); continue; }
    if (m[5] !== undefined) {
      if (skipping()) continue;
      const text = decode(m[5]);
      if (hiding()) keepHidden(text); else visible.push(text);
      continue;
    }
    const name = m[3]!.toLowerCase();
    const whole = m[0];
    if (whole.startsWith("</")) {
      const at = stack.map((e) => e.name).lastIndexOf(name);
      if (at >= 0) stack.length = at;
      continue;
    }
    // A machine reads these attributes; a person sees them only on hover, or never.
    for (const a of ["alt", "title", "aria-label"]) {
      const value = attr(whole, a);
      if (value && value.length > 40) keepHidden(value);
    }
    const style = attr(whole, "style") ?? "";
    const hides = /\shidden(\s|=|>|\/)/i.test(whole) || hidesText(style);
    if (VOID.has(name) || whole.endsWith("/>")) continue;
    stack.push({ name, hides, skips: SKIPPED.has(name) });
    if (stack.length > 400) stack.splice(0, stack.length - 400);
  }
  return { visible: visible.join(" ").replace(/\s+/g, " ").trim(), hidden: hidden.join("\n") };
}
