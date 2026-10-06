import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  validateAttachments,
  type MailAttachment,
} from "../../../shared/mail/attachments";
import { msg } from "../../../shared/i18n";

export type AttachmentRef = Omit<MailAttachment, "content"> & {
  id: string;
  draftId: string;
  size: number;
  sourceId?: string;
};
export type AttachmentRecord = { ref: AttachmentRef; bytes: ArrayBuffer };
export interface AttachmentStorage {
  add(record: AttachmentRecord): Promise<void>;
  get(id: string): Promise<AttachmentRecord | undefined>;
  remove(id: string): Promise<void>;
}
export class AttachmentCaptureError extends Error {
  constructor(public refs: AttachmentRef[]) {
    super(
      msg("Some files could not be saved on this device. Remove those files and add them again before sending."),
    );
  }
}
const invalid = () =>
  new Error(
    msg("This attachment has an invalid name or file type. Choose another file."),
  );
export function attachmentRefs(
  value: unknown,
  draftId: string,
): AttachmentRef[] {
  if (!Array.isArray(value)) throw invalid();
  if (value.length > MAX_ATTACHMENTS)
    throw new Error(
      msg("A message can contain up to 10 files. Remove a file before adding another."),
    );
  const ids = new Set<string>();
  let total = 0;
  return value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      !item.id ||
      item.draftId !== draftId ||
      ids.has(item.id) ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      (item.sourceId !== undefined &&
        (typeof item.sourceId !== "string" || !item.sourceId))
    )
      throw invalid();
    ids.add(item.id);
    total += item.size;
    if (total > MAX_ATTACHMENT_BYTES)
      throw new Error(
        msg("Attachments exceed the 5 MiB total limit. Remove a file or choose a smaller one."),
      );
    let checked: MailAttachment;
    try {
      checked = validateAttachments([{ ...item, content: "" }])[0];
    } catch {
      throw invalid();
    }
    const { content: _, ...metadata } = checked;
    return {
      ...metadata,
      id: item.id,
      draftId,
      size: item.size,
      ...(item.sourceId ? { sourceId: item.sourceId } : {}),
    };
  });
}
export function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let text = "";
  for (let offset = 0; offset < view.length; offset += 32768)
    text += String.fromCharCode(...view.subarray(offset, offset + 32768));
  return btoa(text);
}
/** IndexedDB add (never put) plus transaction completion acknowledges immutable bytes. */
export function browserAttachmentStorage(): AttachmentStorage {
  let database: Promise<IDBDatabase> | undefined;
  const db = () => {
    if (!database) {
      database = new Promise<IDBDatabase>((resolve, reject) => {
        let blocked = false;
        const request = indexedDB.open("fabric-inbox-attachments", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("files", { keyPath: "ref.id" });
        request.onsuccess = () => {
          if (blocked) {
            request.result.close();
            return;
          }
          request.result.onversionchange = () => {
            request.result.close();
            database = undefined;
          };
          resolve(request.result);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
          blocked = true;
          reject(
            new Error(
              msg("Attachment storage is blocked. Close other Fabric Inbox windows and retry."),
            ),
          );
        };
      }).catch((error) => {
        database = undefined;
        throw error;
      });
    }
    return database;
  };
  async function transaction<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const connection = await db();
    return new Promise((resolve, reject) => {
      const tx = connection.transaction("files", mode);
      const request = run(tx.objectStore("files"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? request.error);
      tx.onabort = () =>
        reject(tx.error ?? new Error(msg("Attachment could not be saved.")));
    });
  }
  return {
    add: async (record) => {
      await transaction("readwrite", (s) => s.add(record));
    },
    get: (id) => transaction("readonly", (s) => s.get(id)),
    remove: async (id) => {
      await transaction("readwrite", (s) => s.delete(id));
    },
  };
}
let browserStore: AttachmentStorage | undefined;
export const attachmentsOnDevice = () =>
  (browserStore ??= browserAttachmentStorage());

export async function captureFiles(
  storage: AttachmentStorage,
  draftId: string,
  files: {
    name: string;
    type: string;
    size: number;
    arrayBuffer(): Promise<ArrayBuffer>;
    sourceId?: string;
  }[],
  existing: AttachmentRef[] = [],
  lifecycle?: {
    stage(refs: AttachmentRef[]): Promise<boolean>;
    complete(ids: string[]): Promise<boolean>;
  },
): Promise<AttachmentRef[]> {
  const refs = files.map((file) => ({
    id: crypto.randomUUID(),
    draftId,
    filename: file.name,
    type: file.type || "application/octet-stream",
    disposition: "attachment" as const,
    size: file.size,
    ...(file.sourceId ? { sourceId: file.sourceId } : {}),
  }));
  attachmentRefs([...existing, ...refs], draftId);
  // Selection belongs to the draft before reading files or fetching source bytes.
  // A remounted composer sees durable pending IDs and cannot send around this job.
  if (lifecycle && !(await lifecycle.stage(refs)))
    throw new Error(
      msg("File selection could not be saved. Keep this window open before sending."),
    );
  try {
    for (let i = 0; i < files.length; i++) {
      const bytes = await files[i].arrayBuffer();
      if (bytes.byteLength !== refs[i].size)
        throw new Error("Attachment changed while reading.");
      await storage.add({ ref: refs[i], bytes });
    }
  } catch {
    // Keep every chosen reference visible, including missing records, so reload/retry
    // can never turn a failed file write into a successful send without that file.
    throw new AttachmentCaptureError(refs);
  }
  if (lifecycle && !(await lifecycle.complete(refs.map((ref) => ref.id))))
    throw new Error(
      msg("Files were saved, but their ready state could not be saved. Keep this draft open before sending."),
    );
  return refs;
}
export async function loadAttachments(
  storage: AttachmentStorage,
  refs: AttachmentRef[],
  draftId: string,
): Promise<MailAttachment[]> {
  const valid = attachmentRefs(refs, draftId);
  const files: MailAttachment[] = [];
  for (const ref of valid) {
    const record = await storage.get(ref.id);
    if (
      !record ||
      JSON.stringify(attachmentRefs([record.ref], draftId)[0]) !==
        JSON.stringify(ref) ||
      !(record.bytes instanceof ArrayBuffer) ||
      record.bytes.byteLength !== ref.size
    )
      throw new Error(
        msg("Attachment “{filename}” is unavailable on this device. For an editable draft, remove it and add the file again. A locked attempt must keep its saved files.", { filename: ref.filename }),
      );
    const { id: _, draftId: __, size: ___, sourceId: ____, ...metadata } = ref;
    files.push({ ...metadata, content: base64(record.bytes) });
  }
  return validateAttachments(files);
}
