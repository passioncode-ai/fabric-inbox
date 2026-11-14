/**
 * A forward's original files (B-274, S09): attached by themselves as the composer opens, in the
 * original's order, while they fit in one message; each removable. What is not attached on purpose
 * is the draft's `leftOut`: removed by the person, past the 10 files and 5 MiB one message carries,
 * or found dangerous by the safety check (a red file is never attached by itself).
 */
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "../../../shared/mail/attachments";
import type { Draft, ForwardSource, LeftOut } from "./draft-store";

export type Original = ForwardSource["files"][number];

/** Original ids the draft already carries: on this device (loading, failed or ready) or saved with it on the server. */
export function includedOriginalIds(d: Draft): Set<string> {
  const ids = new Set<string>();
  for (const a of d.attachments ?? []) if (a.sourceId) ids.add(a.sourceId);
  for (const f of d.serverFiles ?? []) if (f.sourceId) ids.add(f.sourceId);
  return ids;
}

/** Original ids left out on purpose. */
export function leftOutIds(d: Draft): Set<string> {
  return new Set((d.leftOut ?? []).map((x) => x.id));
}

/** What one message can still take besides the files the draft carries now. */
export function roomLeft(d: Draft): { files: number; bytes: number } {
  const carried = [...(d.attachments ?? []), ...(d.serverFiles ?? [])];
  return {
    files: MAX_ATTACHMENTS - carried.length,
    bytes: MAX_ATTACHMENT_BYTES - carried.reduce((n, f) => n + f.size, 0),
  };
}

/** No room for even an empty file: the person's own file is refused with "No room left". */
export function noRoom(d: Draft): boolean {
  const room = roomLeft(d);
  return room.files <= 0 || room.bytes <= 0;
}

/**
 * Which originals to attach now and which to leave out. Without `ids`: every original the draft does
 * not carry and has not left out, in the original's order. With `ids`: those originals (to put a
 * left-out file back, or to retry one), whatever their `leftOut`. A file is attached when it fits in
 * the room left; one that does not is "no-room" and later smaller files may still fit. A red file is
 * "dangerous" unless `anyway`.
 */
export function planOriginals(
  d: Draft,
  ids?: readonly string[],
  { anyway = false }: { anyway?: boolean } = {},
): { attach: Original[]; leftOut: LeftOut[] } {
  const source = d.forwardSource;
  if (!source || d.locked) return { attach: [], leftOut: [] };
  const included = includedOriginalIds(d);
  const skipped = leftOutIds(d);
  const wanted = ids ? new Set(ids) : null;
  const room = roomLeft(d);
  const attach: Original[] = [];
  const out: LeftOut[] = [];
  for (const file of source.files) {
    if (included.has(file.id)) continue;
    if (wanted ? !wanted.has(file.id) : skipped.has(file.id)) continue;
    if (file.safety === "red" && !anyway) {
      out.push({ id: file.id, why: "dangerous" });
      continue;
    }
    if (room.files >= 1 && file.size <= room.bytes) {
      attach.push(file);
      room.files -= 1;
      room.bytes -= file.size;
    } else out.push({ id: file.id, why: "no-room" });
  }
  return { attach, leftOut: out };
}

/** The draft with a plan's choices recorded: attached ids leave `leftOut`, left-out ones replace their entries. */
export function applyPlan(d: Draft, plan: { attach: readonly Original[]; leftOut: readonly LeftOut[] }): Draft {
  const touched = new Set([...plan.attach.map((f) => f.id), ...plan.leftOut.map((x) => x.id)]);
  if (!touched.size) return d;
  const kept = (d.leftOut ?? []).filter((x) => !touched.has(x.id));
  const next = [...kept, ...plan.leftOut];
  const same = JSON.stringify(next) === JSON.stringify(d.leftOut ?? []);
  return same ? d : { ...d, leftOut: next };
}

/** One original left out on purpose (the person pressed Remove on a file never attached). */
export function leaveOut(d: Draft, id: string, why: LeftOut["why"] = "removed"): Draft {
  return { ...d, leftOut: [...(d.leftOut ?? []).filter((x) => x.id !== id), { id, why }] };
}

/** A file on this device removed; an original's removal is recorded, so it is not asked for again. */
export function removeAttachment(d: Draft, attachmentId: string): Draft {
  const ref = d.attachments?.find((a) => a.id === attachmentId);
  const next: Draft = {
    ...d,
    attachments: d.attachments?.filter((a) => a.id !== attachmentId),
    pendingAttachments: d.pendingAttachments?.filter((id) => id !== attachmentId),
  };
  return ref?.sourceId && d.forwardSource ? leaveOut(next, ref.sourceId) : next;
}

/** A file saved with the draft on the server removed; an original's removal is recorded too. */
export function removeServerFile(d: Draft, fileId: string): Draft {
  const file = d.serverFiles?.find((f) => f.id === fileId);
  const next: Draft = { ...d, serverFiles: d.serverFiles?.filter((f) => f.id !== fileId) };
  return file?.sourceId && d.forwardSource ? leaveOut(next, file.sourceId) : next;
}

/** An original whose loading failed, dropped from the draft so Retry can fetch it again. */
export function dropForRetry(d: Draft, sourceId: string): Draft {
  const drop = new Set((d.attachments ?? []).filter((a) => a.sourceId === sourceId).map((a) => a.id));
  return {
    ...d,
    attachments: d.attachments?.filter((a) => !drop.has(a.id)),
    pendingAttachments: d.pendingAttachments?.filter((id) => !drop.has(id)),
  };
}

/** The original's file a left-out entry names, in the original's order. */
export function leftOutFiles(d: Draft): { file: Original; why: LeftOut["why"] }[] {
  const why = new Map((d.leftOut ?? []).map((x) => [x.id, x.why] as const));
  const included = includedOriginalIds(d);
  return (d.forwardSource?.files ?? [])
    .filter((f) => why.has(f.id) && !included.has(f.id))
    .map((file) => ({ file, why: why.get(file.id)! }));
}

/** The safety colour of an original by its id, when a check named one. */
export function safetyOf(d: Draft, sourceId: string | undefined) {
  return sourceId ? d.forwardSource?.files.find((f) => f.id === sourceId)?.safety : undefined;
}
