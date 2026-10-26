/**
 * B-179: what an arriving message's files say. A file that runs code (a program, a script, an Office file with
 * macros, a disk image or a shortcut) is marked by its name and type; the text of a document (PDF, Office, OpenDocument,
 * RTF, HTML, plain text) is read and checked like the body's hidden text (check.ts), since a person rarely reads it all
 * and an agent reads it whole.
 */
export interface MailFile { key: string; filename: string; mimetype: string; size: number }

const RUNS_CODE = /\.(exe|com|scr|pif|msi|msix|appx|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|cpl|jar|apk|dmg|pkg|app|iso|img|vhd|vhdx|lnk|reg|docm|dotm|xlsm|xltm|xlsb|pptm|potm|ppsm|sldm|xlam|ppam)$/i;
const CODE_TYPES = /^(application\/(x-msdownload|x-msdos-program|x-dosexec|x-sh|x-bat|java-archive|vnd\.android\.package-archive|x-apple-diskimage|x-iso9660-image|vnd\.ms-(word|excel|powerpoint)\.[a-z]*macroenabled[.a-z0-9]*|hta))$/i;
const READABLE = /\.(pdf|docx|doc|xlsx|xls|pptx|odt|ods|odp|rtf|html?|txt|csv|md|xml)$/i;
/** Documents read per message, the largest read, and the text kept. */
export const MAX_READ_FILES = 3;
export const MAX_READ_BYTES = 10 * 1024 * 1024;
export const FILE_TEXT_CHARS = 20_000;

export const runsCode = (f: Pick<MailFile, "filename" | "mimetype">) => RUNS_CODE.test(f.filename.trim()) || CODE_TYPES.test(f.mimetype.trim());
export const readable = (f: MailFile) => !runsCode(f) && READABLE.test(f.filename.trim()) && f.size > 0 && f.size <= MAX_READ_BYTES;

/** Turns documents into text (Workers AI `toMarkdown`); each answer is the text or why it could not be read. */
export type ToText = (files: { name: string; blob: Blob }[]) => Promise<{ name: string; text?: string; error?: string }[]>;

export interface FileFindings {
  /** Files that run code, by name. */
  risky: string[];
  /** The text read from documents, at most FILE_TEXT_CHARS, each part headed by its file's name. */
  text: string;
  /** Documents whose text could not be read, by name (checked by name and type only). */
  unread: string[];
}

export async function readFiles(files: MailFile[], get: (key: string) => Promise<Blob | null>, toText: ToText | null): Promise<FileFindings> {
  const risky = files.filter(runsCode).map((f) => f.filename);
  const docs = files.filter(readable).slice(0, MAX_READ_FILES);
  const unread: string[] = [];
  let text = "";
  if (docs.length && toText) {
    const blobs: { name: string; blob: Blob }[] = [];
    for (const f of docs) {
      const blob = await get(f.key).catch(() => null);
      if (blob) blobs.push({ name: f.filename, blob }); else unread.push(f.filename);
    }
    const answers: { name: string; text?: string; error?: string }[] = blobs.length
      ? await toText(blobs).catch((error: unknown) => blobs.map((b) => ({ name: b.name, error: (error as Error)?.message ?? "failed" }))) : [];
    for (const a of answers) {
      if (a.text?.trim()) text += `\n[${a.name}]\n${a.text.trim()}`;
      else unread.push(a.name);
    }
  } else unread.push(...docs.map((f) => f.filename));
  return { risky, text: text.trim().slice(0, FILE_TEXT_CHARS), unread };
}
