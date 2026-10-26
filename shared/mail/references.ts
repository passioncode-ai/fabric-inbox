/**
 * A References header that fits one header line (M-1). RFC 5322 3.6.4 lets a long chain keep its
 * first id (the conversation's root) and the most recent ones; a reply in a thread of a dozen Gmail
 * messages was refused as an invalid header instead.
 */
export const REFERENCES_MAX = 900;

export function trimReferences(value: string | readonly string[], max = REFERENCES_MAX): string {
  const ids = (typeof value === "string" ? value.split(/\s+/) : [...value]).map((s) => s.trim()).filter(Boolean);
  const joined = ids.join(" ");
  if (joined.length <= max || ids.length < 2) return joined;
  const root = ids[0]!;
  const recent: string[] = [];
  let length = root.length;
  for (let i = ids.length - 1; i > 0; i--) {
    if (length + 1 + ids[i]!.length > max) break;
    recent.unshift(ids[i]!);
    length += 1 + ids[i]!.length;
  }
  return [root, ...recent].join(" ");
}
