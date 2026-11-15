/**
 * B-277: a forward's origin kept by the server beside its draft, never in the message. The app writes
 * it on every save of a forward and reads it when the draft is opened where this device has no copy,
 * so the original's files come back with Attach and Retry instead of as plain saved files.
 */
import { parseForwardSource, parseLeftOut, type Draft, type ForwardSource, type LeftOut, type ServerFile } from "./draft-store";
import { storedAttachmentName } from "../../../shared/mail/attachments";

/** Longest meta the server keeps (`FORWARD_META_MAX` in `workers/lib/draft-forward.ts`). */
export const FORWARD_META_MAX = 200_000;

type Attached = { sourceId: string; serverId?: string; filename: string; size: number };
export type ForwardMeta = { v: 1; source: ForwardSource; leftOut: LeftOut[]; attached: Attached[] };

/** The meta of a forward draft as a string for the save, or undefined for any other draft (or one too large to keep). */
export function forwardMetaFor(d: Draft): string | undefined {
  if (!d.forwardSource || d.mode !== "forward") return;
  const files = new Map(d.forwardSource.files.map((f) => [f.id, f]));
  const attached: Attached[] = [];
  for (const f of d.serverFiles ?? []) if (f.sourceId && files.has(f.sourceId)) attached.push({ sourceId: f.sourceId, serverId: f.id, filename: f.filename, size: f.size });
  for (const a of d.attachments ?? []) if (a.sourceId && files.has(a.sourceId)) attached.push({ sourceId: a.sourceId, filename: a.filename, size: a.size });
  const meta: ForwardMeta = { v: 1, source: d.forwardSource, leftOut: d.leftOut ?? [], attached };
  const text = JSON.stringify(meta);
  return text.length <= FORWARD_META_MAX ? text : undefined;
}

/** The meta read back, or null when there is none or it does not hold together. */
export function readForwardMeta(text: string | null | undefined): ForwardMeta | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<ForwardMeta>;
    if (!value || value.v !== 1 || !Array.isArray(value.attached) || value.attached.length > 1000) return null;
    const source = parseForwardSource(value.source);
    if (!source) return null;
    const leftOut = parseLeftOut(value.leftOut ?? []) ?? [];
    const attached = value.attached.map((a) => {
      if (!a || typeof a.sourceId !== "string" || !a.sourceId || typeof a.filename !== "string" || !Number.isSafeInteger(a.size) || a.size < 0
        || (a.serverId !== undefined && typeof a.serverId !== "string")) throw new Error("bad attached entry");
      return { sourceId: a.sourceId, filename: a.filename, size: a.size, ...(a.serverId ? { serverId: a.serverId } : {}) };
    });
    return { v: 1, source, leftOut, attached };
  } catch {
    return null;
  }
}

/**
 * The server draft as a forward again (B-277, reviewed by a second model: K-2, K-8). A server file is
 * an original only when the meta names it: by its server id, else by the one file of that name (as
 * the server stores names) and size; size alone never decides, so two files of one size are never
 * swapped. Every original not matched to a file comes back left out (with its recorded reason, else
 * "removed"), so reopening never attaches a file by itself, whatever the meta says.
 */
export function restoreForward(meta: ForwardMeta, serverFiles: readonly ServerFile[]): Pick<Draft, "mode" | "forwardSource" | "leftOut" | "originalId" | "serverFiles"> {
  const known = new Set(meta.source.files.map((f) => f.id));
  const files = serverFiles.map(({ sourceId: _old, ...plain }) => ({ ...plain }) as ServerFile);
  const taken = new Set<number>();
  const seen = new Set<string>();
  for (const a of meta.attached) {
    if (!known.has(a.sourceId) || seen.has(a.sourceId)) continue;
    seen.add(a.sourceId);
    let i = a.serverId ? files.findIndex((f, j) => !taken.has(j) && f.id === a.serverId) : -1;
    if (i < 0) {
      const name = storedAttachmentName(a.filename);
      const same = files.map((f, j) => j).filter((j) => !taken.has(j) && files[j]!.size === a.size && storedAttachmentName(files[j]!.filename) === name);
      if (same.length === 1) i = same[0]!;
    }
    if (i < 0) continue;
    taken.add(i);
    files[i] = { ...files[i]!, sourceId: a.sourceId };
  }
  const carried = new Set(files.flatMap((f) => (f.sourceId ? [f.sourceId] : [])));
  const why = new Map(meta.leftOut.map((x) => [x.id, x.why] as const));
  const leftOut: LeftOut[] = meta.source.files.filter((f) => !carried.has(f.id)).map((f) => ({ id: f.id, why: why.get(f.id) ?? "removed" }));
  return { mode: "forward", forwardSource: meta.source, leftOut, originalId: meta.source.originalId, serverFiles: files };
}
