/**
 * S03 §2 (B-269): what a file is by its bytes, not its name. The first 4 KiB are matched against a table of
 * signatures; an Office document's ZIP central directory (the last 64 KiB) is listed for macros without
 * decompressing anything. A match is never called safe: it says what the file is.
 *
 * Written here and offered to Okolos for `core-download`; once Okolos has it, it is vendored instead.
 */

/** How much of a file's start the reader looks at, and of its end for a ZIP's central directory. */
export const HEAD_BYTES = 4096;
export const TAIL_BYTES = 65536;
/** Fewer bytes than this say nothing about a file's type. */
export const MIN_BYTES = 8;

export type FileKind =
  | "pe" | "elf" | "macho" | "script" | "ole" | "ooxml" | "zip" | "rar" | "7z" | "pdf" | "image" | "html" | "svg" | "text" | "unknown";

/** Kinds that run code wherever they are opened. */
export const PROGRAM_KINDS: ReadonlySet<FileKind> = new Set(["pe", "elf", "macho", "script"]);
export const ARCHIVE_KINDS: ReadonlySet<FileKind> = new Set(["zip", "rar", "7z"]);

export interface Sniffed {
  /** `tooShort` when there were too few bytes to tell. */
  kind: FileKind | "tooShort";
  /** A PDF that also carries a program's signature in its first KiB. */
  mixed?: boolean;
  /** The MIME type its bytes show, for Okolos's `judgeDownload`. */
  mime: string | null;
}

const starts = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (b: Uint8Array, from = 0, to = b.length) => {
  let s = "";
  for (let i = from; i < Math.min(to, b.length); i++) s += String.fromCharCode(b[i]!);
  return s;
};

/** A PE: "MZ", and the offset at 0x3C pointing at "PE\0\0" within what was read. */
function isPe(b: Uint8Array, at = 0): boolean {
  if (!starts(b, [0x4d, 0x5a], at) || b.length < at + 0x40) return false;
  const off = at + (b[at + 0x3c]! | (b[at + 0x3d]! << 8) | (b[at + 0x3e]! << 16) | (b[at + 0x3f]! << 24));
  return off > at && off + 4 <= b.length && starts(b, [0x50, 0x45, 0, 0], off);
}

const MACHO = [[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]];

/** A program's signature anywhere in `b` (used for a PDF's first KiB). */
function carriesProgram(b: Uint8Array): boolean {
  for (let i = 1; i < b.length - 4; i++) {
    if (b[i] === 0x4d && b[i + 1] === 0x5a && isPe(b, i)) return true;
    if (starts(b, [0x7f, 0x45, 0x4c, 0x46], i)) return true;
  }
  return false;
}

export function sniff(head: Uint8Array): Sniffed {
  if (head.length < MIN_BYTES) return { kind: "tooShort", mime: null };
  if (isPe(head) || starts(head, [0x4d, 0x5a])) return { kind: "pe", mime: "application/vnd.microsoft.portable-executable" };
  if (starts(head, [0x7f, 0x45, 0x4c, 0x46])) return { kind: "elf", mime: "application/x-executable" };
  if (MACHO.some((sig) => starts(head, sig))) return { kind: "macho", mime: "application/x-mach-binary" };
  if (starts(head, [0x23, 0x21])) return { kind: "script", mime: "application/x-sh" };
  if (starts(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { kind: "ole", mime: "application/x-ole-storage" };
  if (starts(head, [0x50, 0x4b, 0x03, 0x04]) || starts(head, [0x50, 0x4b, 0x05, 0x06]) || starts(head, [0x50, 0x4b, 0x07, 0x08]))
    return { kind: "zip", mime: "application/zip" };
  if (starts(head, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return { kind: "rar", mime: "application/vnd.rar" };
  if (starts(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { kind: "7z", mime: "application/x-7z-compressed" };
  // A PDF's signature may sit anywhere in its first KiB.
  const first = ascii(head, 0, 1024);
  if (first.includes("%PDF-")) return { kind: "pdf", mime: "application/pdf", ...(carriesProgram(head.subarray(0, 1024)) ? { mixed: true } : {}) };
  if (starts(head, [0x89, 0x50, 0x4e, 0x47])) return { kind: "image", mime: "image/png" };
  if (starts(head, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg" };
  if (ascii(head, 0, 4) === "GIF8") return { kind: "image", mime: "image/gif" };
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return { kind: "image", mime: "image/webp" };
  if (ascii(head, 4, 12) === "ftypheic" || ascii(head, 4, 12) === "ftypmif1") return { kind: "image", mime: "image/heic" };
  const text = ascii(head, 0, 1024).replace(/^﻿|^\xef\xbb\xbf/, "").trimStart().toLowerCase();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(text) || (text.startsWith("<?xml") && text.includes("<svg"))) return { kind: "svg", mime: "image/svg+xml" };
  if (/^(<!--[\s\S]*?-->\s*)*<(!doctype html|html|head|body|script|iframe|meta|form)[\s>]/.test(text)) return { kind: "html", mime: "text/html" };
  // Text: no NUL and few control characters in what was read.
  let control = 0;
  for (const byte of head) { if (byte === 0) { control = Infinity; break; } if (byte < 9 || (byte > 13 && byte < 32)) control++; }
  if (control < head.length / 100) return { kind: "text", mime: "text/plain" };
  return { kind: "unknown", mime: null };
}

/**
 * The names in a ZIP's central directory, read from the file's last bytes (`tail`) and its whole size. Null when the
 * directory cannot be read from them (cut, too large, ZIP64): the caller says "macros not checked".
 */
export function zipNames(tail: Uint8Array, size: number): string[] | null {
  // The end-of-central-directory record: "PK\5\6", within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (starts(tail, [0x50, 0x4b, 0x05, 0x06], i)) { eocd = i; break; }
  if (eocd < 0) return null;
  const u16 = (i: number) => tail[i]! | (tail[i + 1]! << 8);
  const u32 = (i: number) => (tail[i]! | (tail[i + 1]! << 8) | (tail[i + 2]! << 16) | (tail[i + 3]! << 24)) >>> 0;
  const count = u16(eocd + 10), cdSize = u32(eocd + 12), cdOffset = u32(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) return null;
  const tailStart = size - tail.length;
  const start = cdOffset - tailStart;
  if (start < 0 || start + cdSize > eocd) return null;
  const names: string[] = [];
  let at = start;
  for (let n = 0; n < count; n++) {
    if (at + 46 > tail.length || !starts(tail, [0x50, 0x4b, 0x01, 0x02], at)) return null;
    const nameLength = u16(at + 28), extra = u16(at + 30), comment = u16(at + 32);
    names.push(ascii(tail, at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;
  }
  return names;
}

/** Whether a ZIP's names are an Office document's, and whether it carries macros. */
export function officeOf(names: string[]): { office: boolean; macros: boolean } {
  const office = names.includes("[Content_Types].xml");
  const macros = names.some((n) => /(^|\/)vbaProject\.bin$/i.test(n) || /^xl\/macrosheets\//i.test(n) || /^word\/vbaData\.xml$/i.test(n));
  return { office, macros };
}
