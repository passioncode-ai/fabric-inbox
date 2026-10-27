// B-153: a held message is answered again when the knowledge owner closes the gap it reported. The gap tool's
// list (the knowledge agent's gaps.list) names each report by the request id we sent, `<runId>-<kind hash>`
// (gapRequestId, runner.ts), with its state from the owner's gap ledger. States change only when the ledger is
// rebuilt, so the list is read again only when its ledgerRevision moves.

/** How often the gap lists are asked whether their ledger moved. */
export const GAPS_CHECK_MS = 15 * 60_000;
/** A list that refuses (not granted to this consumer, unreachable) is asked again after this long. */
export const GAPS_UNAVAILABLE_MS = 6 * 3_600_000;
export const GAPS_PAGE = 200;
/** At most this many pages per ledger revision; a longer list is read on the next revision. */
export const GAPS_PAGES = 10;
/** The ledger's states that mean the knowledge now answers the question. */
export const CLOSED_STATES: ReadonlySet<string> = new Set(["closed", "answered"]);

export interface GapRow { id: number; requestId: string; state: string; item: string | null }
export interface GapPage { ledgerRevision: string | null; gaps: GapRow[] }

/** A gaps.list answer, or null when the text is not one. */
export function parseGapList(text: string): GapPage | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { gaps?: unknown }).gaps)) return null;
  const r = raw as { ledgerRevision?: unknown; gaps: unknown[] };
  const gaps: GapRow[] = [];
  for (const g of r.gaps) {
    if (!g || typeof g !== "object") continue;
    const row = g as { id?: unknown; requestId?: unknown; state?: unknown; closedBy?: { item?: unknown } | null };
    if (typeof row.id !== "number" || typeof row.requestId !== "string") continue;
    gaps.push({ id: row.id, requestId: row.requestId, state: typeof row.state === "string" ? row.state : "reported",
      item: typeof row.closedBy?.item === "string" ? row.closedBy.item : null });
  }
  return { ledgerRevision: typeof r.ledgerRevision === "string" ? r.ledgerRevision : null, gaps };
}

/** The run a gap report came from: our request id is the run id and a 12-digit hash of the kind. */
export function runOfRequest(requestId: string): string | null {
  return /^(.+)-[0-9a-f]{12}$/.exec(requestId)?.[1] ?? null;
}
