import { judgeDownload } from "../../vendor/okolos/core-download/judge";
import type { Colour, FileEntry } from "../../shared/mail/safety";
import { runsCode, type MailFile } from "./files";
import { ARCHIVE_KINDS, HEAD_BYTES, officeOf, PROGRAM_KINDS, sniff, TAIL_BYTES, zipNames } from "./sniff";

/**
 * S03 §2 (B-269): one entry per attachment, always, with what its bytes show and its chip's colour. A file that runs
 * code or hides one under another name is red; a web page, an archive, a document with macros or a mixed PDF amber;
 * a file not checked grey; a checked file with no signal green (never "safe": the panel says what it is).
 */

/** At most this many files of a message are read; the rest are "not checked (cap reached)". */
export const MAX_CHECKED_FILES = 10;
/** A provider that returns a file whole (Gmail, Outlook, IMAP here) is read up to this size. */
export const MAX_WHOLE_BYTES = 10 * 1024 * 1024;

/** Names that are web pages in mail: a common phishing method (amber). */
const WEB_PAGE = /\.(html?|svg|xhtml|shtml|mht|mhtml)$/i;
/** Containers whose contents are not opened here. */
const ARCHIVE_NAME = /\.(zip|rar|7z|cab|arj|lzh|ace|tar|gz|tgz|bz2|xz|zst|wim)$/i;
/** Office formats that are ZIPs: their central directory is listed for macros. */
const OOXML_NAME = /\.(docx|docm|dotx|dotm|xlsx|xlsm|xltx|xltm|xlam|pptx|pptm|potx|potm|ppsx|ppsm|ppam)$/i;
/** Old Office formats (OLE): macros cannot be listed here. */
const OLE_NAME = /\.(doc|dot|xls|xlt|xla|ppt|pot|pps)$/i;

/** The bytes of one file: its first HEAD_BYTES, its last TAIL_BYTES, or null when it cannot be read. */
export type ReadSlices = (file: MailFile) => Promise<{ head: Uint8Array; tail: Uint8Array } | null>;

const worst = (a: Colour, b: Colour): Colour => {
  const rank: Record<Colour, number> = { green: 0, grey: 1, amber: 2, red: 3 };
  return rank[b] > rank[a] ? b : a;
};

/** One file judged from its name, its declared type and the slices of its bytes. */
export function judgeFile(file: MailFile & { id: string }, slices: { head: Uint8Array; tail: Uint8Array }): FileEntry {
  const s = sniff(slices.head);
  const codes: string[] = [];
  let colour: Colour = "green";
  const byName = runsCode(file);
  // Okolos's judgement with the type the bytes show (never the declared one, which the sender wrote).
  const verdict = judgeDownload({
    url: `mail-attachment:${file.filename}`, filename: file.filename, mimeType: s.mime,
    checks: {
      feed: { ran: false, why: "noFeedForFiles" },
      hash: { ran: false, why: "noHashList" },
      "file-type": s.kind === "tooShort" ? { ran: false, why: "tooShort" }
        : PROGRAM_KINDS.has(s.kind) && !byName ? { ran: true, passed: false, detail: "disguised" } : { ran: true, passed: true },
    },
  });
  if (s.kind === "tooShort") return { id: file.id, filename: file.filename, size: file.size, checked: false, why: "tooShort", codes: [], colour: byName ? "red" : "grey" };
  if (byName || verdict.shape.some((x) => x.code === "is-a-program" || x.code === "double-extension" || x.code === "name-hides-a-program")) {
    codes.push("program"); colour = "red";
  }
  if (verdict.shape.some((x) => x.code === "double-extension")) codes.push("doubleExtension");
  if (PROGRAM_KINDS.has(s.kind)) {
    if (!byName) codes.push("disguised");
    else if (!codes.includes("program")) codes.push("program");
    colour = "red";
  }
  if (WEB_PAGE.test(file.filename) || s.kind === "html" || s.kind === "svg") { codes.push("webPage"); colour = worst(colour, "amber"); }
  if (s.kind === "pdf" && s.mixed) { codes.push("mixed"); colour = worst(colour, "amber"); }
  if (ARCHIVE_KINDS.has(s.kind as never) || ARCHIVE_NAME.test(file.filename)) {
    const names = s.kind === "zip" ? zipNames(slices.tail, file.size) : null;
    const office = names ? officeOf(names) : null;
    if (office?.office || (s.kind === "zip" && OOXML_NAME.test(file.filename))) {
      if (!office) { codes.push("macrosNotChecked"); colour = worst(colour, "grey"); }
      else if (office.macros) { codes.push("macros"); colour = worst(colour, "amber"); }
    } else { codes.push("archive"); colour = worst(colour, "amber"); }
  }
  if (s.kind === "ole" || (OLE_NAME.test(file.filename) && s.kind !== "pdf")) { codes.push("macrosNotChecked"); colour = worst(colour, "grey"); }
  return { id: file.id, filename: file.filename, size: file.size, checked: true, kind: s.kind, codes, colour };
}

/** Every attachment of a message, one entry each: checked, or not checked and why. */
export async function judgeFiles(files: (MailFile & { id: string })[], read: ReadSlices, wholeOnly: boolean): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for (const [i, f] of files.entries()) {
    const named: Colour = runsCode(f) ? "red" : "grey";
    const base = { id: f.id, filename: f.filename, size: f.size, checked: false, codes: runsCode(f) ? ["program"] : [], colour: named };
    if (i >= MAX_CHECKED_FILES) { out.push({ ...base, why: "capReached" }); continue; }
    if (wholeOnly && f.size > MAX_WHOLE_BYTES) { out.push({ ...base, why: "tooLarge" }); continue; }
    const slices = await read(f).catch(() => null);
    if (!slices) { out.push({ ...base, why: "unreadable" }); continue; }
    out.push(judgeFile(f, slices));
  }
  return out;
}

/** The slices of a whole file (a provider that returns it whole). */
export function slicesOf(bytes: Uint8Array): { head: Uint8Array; tail: Uint8Array } {
  return { head: bytes.subarray(0, HEAD_BYTES), tail: bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES)) };
}
