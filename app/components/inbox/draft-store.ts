import {
  attachmentRefs,
  attachmentsOnDevice,
  type AttachmentRef,
  type AttachmentStorage,
} from "./attachment-store";

/** Per-draft records avoid whole-list lost updates. Web Locks serialize revision checks. */
export const DRAFT_KEY = "fabric-inbox:workbench-draft:v1";
export const DRAFT_PREFIX = "fabric-inbox:workbench-drafts:v2:";
export type Draft = {
  id: string;
  accountId: string;
  to: string;
  cc?: string;
  bcc?: string;
  attachments?: AttachmentRef[];
  pendingAttachments?: string[];
  forwardSource?: ForwardSource;
  subject: string;
  text: string;
  idempotencyKey: string;
  originalId?: string;
  mode: "new" | "reply" | "forward";
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  locked?: boolean;
};
export type ForwardSource = {
  accountId: string;
  originalId: string;
  provider: "gmail" | "cloudflare";
  files: { id: string; filename: string; mimeType: string; size: number }[];
};
function forwardSource(value: unknown): ForwardSource | undefined {
  if (value === undefined) return;
  const s = value as ForwardSource;
  if (
    !s ||
    typeof s.accountId !== "string" ||
    !s.accountId ||
    typeof s.originalId !== "string" ||
    !s.originalId ||
    !["gmail", "cloudflare"].includes(s.provider) ||
    !Array.isArray(s.files) ||
    s.files.length > 1000
  )
    throw new Error("Invalid forward source");
  const ids = new Set<string>();
  const files = s.files.map((f) => {
    if (
      !f ||
      typeof f.id !== "string" ||
      !f.id ||
      ids.has(f.id) ||
      typeof f.filename !== "string" ||
      typeof f.mimeType !== "string" ||
      !Number.isSafeInteger(f.size) ||
      f.size < 0
    )
      throw new Error("Invalid forward source");
    ids.add(f.id);
    return {
      id: f.id,
      filename: f.filename,
      mimeType: f.mimeType,
      size: f.size,
    };
  });
  return {
    accountId: s.accountId,
    originalId: s.originalId,
    provider: s.provider,
    files,
  };
}
type RecordV2 = { version: 2; revision: number; draft: Draft | null };
export type DraftStorage = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem"
>;
export type Exclusive = <T>(
  name: string,
  action: () => T | Promise<T>,
) => Promise<T>;
const conflict =
  "This draft changed in another window. Copy any unsaved text, then reopen the saved version from Drafts.";
function content(value: unknown, legacy = false): Omit<Draft, "id"> {
  if (!value || typeof value !== "object") throw new Error("Invalid draft");
  const d = value as Record<string, unknown>;
  for (const key of ["accountId", "to", "subject", "text", "idempotencyKey"])
    if (typeof d[key] !== "string") throw new Error("Invalid draft");
  if (
    !d.idempotencyKey ||
    !["new", "reply", "forward"].includes(d.mode as string)
  )
    throw new Error("Invalid draft");
  for (const key of [
    "originalId",
    "threadId",
    "inReplyTo",
    "references",
    "cc",
    "bcc",
  ])
    if (d[key] !== undefined && typeof d[key] !== "string")
      throw new Error("Invalid draft");
  if (d.locked !== undefined && typeof d.locked !== "boolean")
    throw new Error("Invalid draft");
  const refs =
    legacy || d.attachments === undefined
      ? undefined
      : attachmentRefs(d.attachments, d.id as string);
  if (
    !legacy &&
    d.pendingAttachments !== undefined &&
    (!Array.isArray(d.pendingAttachments) ||
      new Set(d.pendingAttachments).size !== d.pendingAttachments.length ||
      d.pendingAttachments.some(
        (id) => typeof id !== "string" || !refs?.some((ref) => ref.id === id),
      ))
  )
    throw new Error("Invalid pending attachments");
  // Explicit allow-list: bytes and credentials never enter localStorage. Legacy attachment fields were never supported.
  return {
    accountId: d.accountId as string,
    to: d.to as string,
    subject: d.subject as string,
    text: d.text as string,
    idempotencyKey: d.idempotencyKey as string,
    mode: d.mode as Draft["mode"],
    originalId: d.originalId as string | undefined,
    threadId: d.threadId as string | undefined,
    inReplyTo: d.inReplyTo as string | undefined,
    references: d.references as string | undefined,
    locked: d.locked as boolean | undefined,
    ...(!legacy
      ? {
          cc: d.cc as string | undefined,
          bcc: d.bcc as string | undefined,
          attachments: refs,
          pendingAttachments:
            d.pendingAttachments === undefined
              ? undefined
              : [...(d.pendingAttachments as string[])],
          forwardSource: forwardSource(d.forwardSource),
        }
      : {}),
  };
}
export class DraftStore {
  private revisions = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private storage: DraftStorage,
    private exclusive: Exclusive,
    private files?: AttachmentStorage,
  ) {}
  private key(id: string) {
    return DRAFT_PREFIX + encodeURIComponent(id);
  }
  private read(id: string): RecordV2 | null {
    const raw = this.storage.getItem(this.key(id));
    if (raw === null) return null;
    const r = JSON.parse(raw);
    if (
      r.version !== 2 ||
      !Number.isSafeInteger(r.revision) ||
      r.revision < 1 ||
      (r.draft !== null && r.draft?.id !== id)
    )
      throw new Error("Invalid draft record");
    return {
      version: 2,
      revision: r.revision,
      draft: r.draft === null ? null : { ...content(r.draft), id },
    };
  }
  async migrate(): Promise<void> {
    await this.exclusive(DRAFT_PREFIX + "migration", () => {
      const raw = this.storage.getItem(DRAFT_KEY);
      if (!raw) return;
      const legacy = content(JSON.parse(raw), true);
      const id = "legacy:" + legacy.idempotencyKey;
      if (!this.read(id))
        this.storage.setItem(
          this.key(id),
          JSON.stringify({ version: 2, revision: 1, draft: { ...legacy, id } }),
        );
      // Preserve original bytes; a tombstone prevents migration after send/discard.
    });
  }
  list(): { drafts: Draft[]; unreadable: boolean } {
    const drafts: Draft[] = [];
    let unreadable = false;
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(DRAFT_PREFIX)) continue;
      try {
        const r = this.read(decodeURIComponent(key.slice(DRAFT_PREFIX.length)));
        if (r?.draft) drafts.push(r.draft);
      } catch {
        unreadable = true;
      }
    }
    return { drafts, unreadable };
  }
  open(id: string): Draft {
    const record = this.read(id);
    if (!record?.draft)
      throw new Error(
        "This draft is no longer saved. Open another draft or compose a new message.",
      );
    this.revisions.set(id, record.revision);
    return record.draft;
  }
  private mutate(
    id: string,
    transform: (current: Draft | null) => Draft | null,
  ): Promise<Draft | null> {
    const work = this.queue.then(() =>
      this.exclusive(this.key(id), async () => {
        const record = this.read(id);
        if ((record?.revision ?? 0) !== (this.revisions.get(id) ?? 0))
          throw new Error(conflict);
        const draft = transform(record?.draft ?? null);
        const next: RecordV2 = {
          version: 2,
          revision: (record?.revision ?? 0) + 1,
          draft,
        };
        const raw = JSON.stringify(next);
        this.storage.setItem(this.key(id), raw);
        if (this.storage.getItem(this.key(id)) !== raw)
          throw new Error(conflict);
        this.revisions.set(id, next.revision);
        // The durable reference change always precedes best-effort byte cleanup.
        // Each record belongs to one draft; stale windows cannot revive its references.
        const retained = new Set(draft?.attachments?.map((a) => a.id));
        for (const old of record?.draft?.attachments ?? []) {
          if (!retained.has(old.id)) {
            try {
              await this.files?.remove(old.id);
            } catch {
              /* safe orphan retention */
            }
          }
        }
        return draft;
      }),
    );
    this.queue = work.catch(() => {});
    return work;
  }
  save(draft: Draft): Promise<Draft> {
    return this.mutate(draft.id, (current) => {
      if (
        (!current && this.revisions.has(draft.id)) ||
        current?.locked ||
        draft.locked
      )
        throw new Error(conflict);
      return { ...content(draft), id: draft.id };
    }) as Promise<Draft>;
  }
  lock(draft: Draft): Promise<Draft> {
    return this.mutate(draft.id, (current) => {
      if (current?.pendingAttachments?.length)
        throw new Error(
          "Files are not ready. Wait for loading to finish before sending.",
        );
      if (
        !current ||
        JSON.stringify(current) !==
          JSON.stringify({ ...content(draft), id: draft.id })
      )
        throw new Error(conflict);
      return { ...current, locked: true };
    }) as Promise<Draft>;
  }
  settle(
    draft: Draft,
    outcome: "accepted" | "failed" | "editable",
  ): Promise<Draft | null> {
    return this.mutate(draft.id, (current) => {
      if (!current?.locked || current.idempotencyKey !== draft.idempotencyKey)
        throw new Error(conflict);
      if (outcome === "accepted") return null;
      return {
        ...current,
        locked: false,
        idempotencyKey:
          outcome === "failed" ? crypto.randomUUID() : current.idempotencyKey,
      };
    });
  }
  discard(id: string): Promise<Draft | null> {
    return this.mutate(id, (current) => {
      if (current?.locked)
        throw new Error(
          "An uncertain send cannot be discarded. Retry the same attempt to check its outcome.",
        );
      return null;
    });
  }
}
export function browserDraftStore(): DraftStore {
  return new DraftStore(
    localStorage,
    async (name, action) => {
      if (!navigator.locks)
        return Promise.reject(
          new Error(
            "This browser cannot safely save drafts across windows. Keep this window open and use a browser with Web Locks support.",
          ),
        );
      return await navigator.locks.request(name, action);
    },
    attachmentsOnDevice(),
  );
}
