/**
 * Pure text work for knowledge collections (KN-1): chunking a document at
 * paragraph and heading boundaries, and turning free text into an FTS5 query
 * that cannot inject FTS syntax. Kept apart from the Durable Object so both
 * are testable without storage.
 */
export const CHUNK_TARGET = 1000;
export const LIMITS = {
  collections: 50,
  documentsPerCollection: 5000,
  documentChars: 200_000,
  batchDocuments: 100,
  searchResults: 10,
  queryChars: 500,
} as const;
export const COLLECTION_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const CHUNK_MAX = 1500;

export interface Chunk { ord: number; text: string }

/**
 * Splits text into chunks of about CHUNK_TARGET characters, never above
 * CHUNK_MAX, cutting at blank lines first, then sentences, then hard. Each
 * chunk starts with the heading it sits under, so a passage found alone still
 * says what it is about.
 */
export function chunkText(text: string): Chunk[] {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  if (!normalized) return [];
  const blocks = normalized.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const chunks: string[] = [];
  let heading = "";
  let current = "";
  const flush = () => {
    const body = current.trim();
    if (body) chunks.push(heading && !body.startsWith(heading) ? `${heading}\n${body}` : body);
    current = "";
  };
  for (const block of blocks) {
    if (/^#{1,6}\s/.test(block) && !block.includes("\n")) {
      flush();
      heading = block.replace(/^#{1,6}\s+/, "").slice(0, 200);
      continue;
    }
    for (const piece of splitLong(block)) {
      if (current && current.length + piece.length + 2 > CHUNK_TARGET) flush();
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  flush();
  return chunks.map((t, ord) => ({ ord, text: t.slice(0, CHUNK_MAX + 220) }));
}

function splitLong(block: string): string[] {
  if (block.length <= CHUNK_MAX) return [block];
  const sentences = block.match(/[^.!?\n]+[.!?]*\s*|\n/g) ?? [block];
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf.length + s.length > CHUNK_TARGET && buf) { out.push(buf.trim()); buf = ""; }
    if (s.length > CHUNK_MAX) {
      for (let i = 0; i < s.length; i += CHUNK_TARGET) out.push(s.slice(i, i + CHUNK_TARGET).trim());
      continue;
    }
    buf += s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

/**
 * Free text → an FTS5 MATCH expression of quoted terms joined by OR. Quoting
 * makes every operator (AND, NEAR, *, ^, :, parentheses) a literal, so text
 * from an email cannot change the query. Long words become prefix terms with
 * their last two letters cut, a crude stem that lets "стоимость" find
 * "стоимости" and "prices" find "price". Returns null when nothing is left.
 */
export function ftsQuery(text: string, maxTerms = 16): string | null {
  const words = (text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]{2,}/gu) ?? [])
    .filter((w) => !STOP.has(w));
  const terms = [...new Set(words)].slice(0, maxTerms).map((w) => {
    const stem = w.length > 5 ? w.slice(0, w.length - 2) : w;
    return w.length > 5 ? `"${stem}"*` : `"${stem}"`;
  });
  return terms.length ? terms.join(" OR ") : null;
}

// Words that match nearly every passage and only dilute the ranking.
const STOP = new Set([
  "the", "and", "for", "you", "your", "are", "with", "that", "this", "have", "from", "can", "what", "how", "hi", "hello", "thanks",
  "is", "it", "to", "of", "in", "on", "we", "our", "be", "do", "or", "an", "as", "at", "by", "if", "me", "my", "so",
  "и", "в", "во", "на", "не", "что", "как", "это", "по", "за", "из", "для", "вы", "вас", "ваш", "мы", "но", "да", "или", "то",
  "же", "ли", "бы", "от", "до", "при", "про", "здравствуйте", "привет", "спасибо",
]);

export async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
