import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AttachmentCaptureError,
  attachmentRefs,
  captureFiles,
  loadAttachments,
  type AttachmentRecord,
  type AttachmentStorage,
} from "../app/components/inbox/attachment-store";
import {
  appendAttachments,
  stageAttachments,
  finishAttachments,
  missingOriginals,
  prepareMessage,
} from "../app/components/inbox/compose-payload";
import {
  DraftStore,
  DRAFT_PREFIX,
  type Draft,
  type Exclusive,
} from "../app/components/inbox/draft-store";
import { SendEmailRequestSchema } from "../workers/lib/schemas";
import { MAX_ATTACHMENT_BYTES } from "../shared/mail/attachments";
class MemoryFiles implements AttachmentStorage {
  rows = new Map<string, AttachmentRecord>();
  blocked = false;
  onRemove?: (id: string) => void;
  async add(record: AttachmentRecord) {
    if (this.blocked) throw new Error("quota");
    if (this.rows.has(record.ref.id)) throw new Error("immutable");
    this.rows.set(record.ref.id, structuredClone(record));
  }
  async get(id: string) {
    return structuredClone(this.rows.get(id));
  }
  async remove(id: string) {
    this.onRemove?.(id);
    this.rows.delete(id);
  }
}
class MemoryDrafts {
  rows = new Map<string, string>();
  blocked = false;
  get length() {
    return this.rows.size;
  }
  key(i: number) {
    return [...this.rows.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.rows.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.blocked) throw new Error("quota");
    this.rows.set(k, v);
  }
}
function fixture() {
  const files = new MemoryFiles(),
    storage = new MemoryDrafts();
  const queues = new Map<string, Promise<unknown>>();
  const exclusive: Exclusive = (key, run) => {
    const next = (queues.get(key) ?? Promise.resolve()).then(run);
    queues.set(
      key,
      next.catch(() => {}),
    );
    return next;
  };
  return {
    files,
    storage,
    store: new DraftStore(storage, exclusive, files),
    tab: () => new DraftStore(storage, exclusive, files),
  };
}
const draft = (id = "a"): Draft => ({
  id,
  mode: "new",
  accountId: "gmail:a",
  to: "to@example.com",
  cc: "Copy <copy@example.com>",
  bcc: "hidden@example.com",
  subject: "Fixture",
  text: "Original",
  idempotencyKey: "key-" + id,
});
const file = (name = "report.txt", body = "fixture") => {
  const bytes = new TextEncoder().encode(body).buffer;
  return {
    name,
    type: "text/plain",
    size: bytes.byteLength,
    arrayBuffer: async () => bytes,
  };
};
test("references and addressing survive reload; bytes never enter localStorage", async () => {
  const { files, store, storage, tab } = fixture();
  const attachments = await captureFiles(files, "a", [file()]);
  const a = await store.save({ ...draft(), attachments });
  const loaded = tab().open("a");
  assert.deepEqual(loaded, a);
  const payload = await prepareMessage(loaded, files);
  assert.deepEqual(payload.cc, ["copy@example.com"]);
  assert.deepEqual(payload.bcc, ["hidden@example.com"]);
  assert.equal(payload.attachments![0].content, btoa("fixture"));
  assert.equal(
    [...storage.rows.values()].some(
      (raw) => raw.includes(btoa("fixture")) || raw.includes('"content":'),
    ),
    false,
  );
});
test("locked retry retrieves identical immutable bytes, recipients and recovery key", async () => {
  const { files, store, tab } = fixture();
  const refs = await captureFiles(files, "a", [file()]);
  const locked = await store.lock(
    await store.save({ ...draft(), attachments: refs }),
  );
  const before = await prepareMessage(locked, files);
  await assert.rejects(
    files.add({
      ref: refs[0],
      bytes: new TextEncoder().encode("changed").buffer,
    }),
    /immutable/,
  );
  await assert.rejects(
    store.save({ ...locked, locked: false, attachments: [] }),
    /another window/,
  );
  const restarted = tab();
  const retry = await restarted.lock(restarted.open("a"));
  assert.deepEqual(await prepareMessage(retry, files), before);
});
test("missing or altered records refuse preparation without a send lock", async () => {
  const { files, store } = fixture();
  const refs = await captureFiles(files, "a", [file()]);
  const a = await store.save({ ...draft(), attachments: refs });
  files.rows.get(refs[0].id)!.ref.filename = "changed.txt";
  await assert.rejects(prepareMessage(a, files), /unavailable/);
  files.rows.clear();
  await assert.rejects(prepareMessage(a, files), /unavailable/);
  assert.equal(store.open("a").locked, undefined);
});
test("quota-failed files remain references after reload and block send until explicitly removed", async () => {
  const { files, store, tab } = fixture();
  files.blocked = true;
  let failed: AttachmentCaptureError | undefined;
  try {
    await captureFiles(files, "a", [file()]);
  } catch (e) {
    failed = e as AttachmentCaptureError;
  }
  assert.ok(failed instanceof AttachmentCaptureError);
  await store.save({ ...draft(), attachments: failed.refs });
  const reopened = tab().open("a");
  assert.equal(reopened.attachments?.length, 1);
  await assert.rejects(prepareMessage(reopened, files), /unavailable/);
  const removed = await store.save({ ...reopened, attachments: [] });
  assert.equal((await prepareMessage(removed, files)).attachments, undefined);
});
test("Cc/Bcc syntax and header injection are rejected before preparation", async () => {
  const { files } = fixture();
  for (const key of ["to", "cc", "bcc"]) {
    for (const bad of [
      "not-an-email",
      "ok@example.com\r\nBcc: hidden@example.com",
      "\n",
    ]) {
      await assert.rejects(prepareMessage({ ...draft(), [key]: bad }, files));
    }
  }
  assert.deepEqual(
    (await prepareMessage({ ...draft(), cc: "", bcc: "  " }, files)).cc,
    undefined,
  );
});
test("empty files are valid; malicious names/types and limits are refused before storing bytes", async () => {
  const { files } = fixture();
  const empty = await captureFiles(files, "a", [file("empty.txt", "")]);
  assert.equal((await loadAttachments(files, empty, "a"))[0].content, "");
  const count = files.rows.size;
  for (const name of [
    "",
    "../secret",
    "bad\\name",
    "bad\r\nname",
    ".",
    "x".repeat(256),
  ])
    await assert.rejects(captureFiles(files, "a", [file(name)]));
  await assert.rejects(
    captureFiles(files, "a", [{ ...file(), type: "text/plain\r\nEvil: yes" }]),
  );
  await assert.rejects(
    captureFiles(files, "a", [{ ...file(), size: MAX_ATTACHMENT_BYTES + 1 }]),
  );
  await assert.rejects(
    captureFiles(
      files,
      "a",
      Array.from({ length: 11 }, () => file()),
    ),
  );
  await assert.rejects(
    captureFiles(
      files,
      "a",
      [{ ...file(), size: MAX_ATTACHMENT_BYTES }],
      empty.map((r) => ({ ...r, size: 1 })),
    ),
  );
  assert.equal(files.rows.size, count);
});
test("metadata allowlist rejects foreign, duplicate and malformed references", async () => {
  const { files, store, storage, tab } = fixture();
  const refs = await captureFiles(files, "a", [file()]);
  assert.throws(() => attachmentRefs(refs, "b"));
  assert.throws(() => attachmentRefs([refs[0], refs[0]], "a"));
  for (const size of [-1, NaN, 1.1])
    assert.throws(() => attachmentRefs([{ ...refs[0], size }], "a"));
  const saved = await store.save({
    ...draft(),
    attachments: [
      { ...refs[0], content: "must not persist", token: "drop" } as any,
    ],
  });
  assert.equal((saved.attachments![0] as any).content, undefined);
  const key = DRAFT_PREFIX + "a";
  const raw = JSON.parse(storage.getItem(key)!);
  raw.draft.attachments[0].draftId = "other";
  storage.setItem(key, JSON.stringify(raw));
  assert.throws(() => tab().open("a"));
  assert.equal(tab().list().unreadable, true);
});
test("remove, discard and accepted cleanup happen only after durable reference acknowledgement", async () => {
  for (const action of ["remove", "discard", "accepted"] as const) {
    const { files, store, storage, tab } = fixture();
    const refs = await captureFiles(files, "a", [file()]);
    let a = await store.save({ ...draft(), attachments: refs });
    if (action === "accepted") a = await store.lock(a);
    const run = () =>
      action === "remove"
        ? store.save({ ...a, attachments: [] })
        : action === "discard"
          ? store.discard(a.id)
          : store.settle(a, "accepted");
    storage.blocked = true;
    await assert.rejects(run(), /quota/);
    assert.ok(files.rows.has(refs[0].id));
    assert.equal(tab().open("a").attachments?.length, 1);
    storage.blocked = false;
    files.onRemove = () =>
      assert.equal(
        tab()
          .list()
          .drafts.flatMap((d) => d.attachments ?? []).length,
        0,
      );
    await run();
    assert.equal(files.rows.size, 0);
  }
});
test("failed cleanup retains harmless orphan bytes after durable removal", async () => {
  const { files, store } = fixture();
  const refs = await captureFiles(files, "a", [file()]);
  const a = await store.save({ ...draft(), attachments: refs });
  files.onRemove = () => {
    throw new Error("database unavailable");
  };
  await store.save({ ...a, attachments: [] });
  assert.equal(store.open("a").attachments?.length, 0);
  assert.equal(files.rows.size, 1);
});
test("file read racing text edits merges references into current draft; another draft is untouched", async () => {
  const { files, store, tab } = fixture();
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const original = file();
  const loading = captureFiles(files, "a", [
    {
      ...original,
      arrayBuffer: async () => {
        await wait;
        return original.arrayBuffer();
      },
    },
  ]);
  await store.save(draft());
  await store.save(draft("b"));
  const latest = await store.save({ ...draft(), text: "Newer text" });
  release();
  const refs = await loading;
  await store.save(appendAttachments(latest, "a", refs));
  assert.equal(tab().open("a").text, "Newer text");
  assert.equal(tab().open("b").attachments, undefined);
  assert.throws(() => appendAttachments(undefined, "a", refs), /changed/);
  assert.throws(
    () => appendAttachments({ ...latest, locked: true }, "a", refs),
    /changed/,
  );
  assert.throws(() => appendAttachments(draft("b"), "a", refs), /changed/);
});
test("forward requires every original and uses captured bytes after source metadata disappears", async () => {
  const { files, store, tab } = fixture();
  const a: Draft = {
    ...draft(),
    mode: "forward",
    originalId: "message",
    forwardSource: {
      accountId: "gmail:a",
      originalId: "message",
      provider: "gmail",
      files: [
        { id: "one", filename: "one.txt", size: 7, mimeType: "text/plain" },
        { id: "two", filename: "two.txt", size: 7, mimeType: "text/plain" },
      ],
    },
  };
  await assert.rejects(prepareMessage(a, files), /Include all/);
  const refs = await captureFiles(files, "a", [
    { ...file("one.txt"), sourceId: "one" },
    { ...file("two.txt"), sourceId: "two" },
  ]);
  await assert.rejects(
    prepareMessage({ ...a, attachments: refs.slice(0, 1) }, files),
    /Include all/,
  );
  await store.save({ ...a, attachments: refs });
  const reopened = tab().open("a");
  assert.equal(missingOriginals(reopened).length, 0);
  assert.equal((await prepareMessage(reopened, files)).attachments!.length, 2);
  await assert.rejects(
    prepareMessage({ ...draft(), mode: "forward" }, files),
    /Original attachment information/,
  );
});
test("an initially quota-blocked draft can be durably discarded without stale resurrection", async () => {
  const { storage, store, tab } = fixture();
  storage.blocked = true;
  await assert.rejects(store.save(draft()), /quota/);
  storage.blocked = false;
  await store.discard("a");
  assert.deepEqual(tab().list().drafts, []);
  await assert.rejects(store.save(draft()), /another window/);
  await assert.rejects(tab().save(draft()), /another window/);
});

test("provider payloads omit empty optional recipients and preserve legacy attempt shape", async () => {
  const { files } = fixture();
  const d = { ...draft(), cc: undefined, bcc: undefined, locked: true };
  const payload = await prepareMessage(d, files);
  assert.deepEqual(payload, {
    to: ["to@example.com"],
    subject: d.subject,
    text: d.text,
    idempotencyKey: d.idempotencyKey,
  });
  assert.equal(
    SendEmailRequestSchema.safeParse({ ...payload, from: "sender@example.com" })
      .success,
    true,
  );
  const withRecipients = await prepareMessage(draft(), files);
  assert.equal(
    SendEmailRequestSchema.safeParse({
      ...withRecipients,
      from: "sender@example.com",
    }).success,
    true,
  );
});

test("selection is durable before deferred file or original reads; reopening cannot send around capture", async () => {
  for (const original of [false, true]) {
    const { files, store, tab } = fixture();
    let current = await store.save(draft());
    let release!: () => void;
    const pendingRead = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const startedRead = new Promise<void>((resolve) => (started = resolve));
    const input = file();
    const work = captureFiles(
      files,
      current.id,
      [
        {
          ...input,
          ...(original ? { sourceId: "original" } : {}),
          arrayBuffer: async () => {
            started();
            await pendingRead;
            return input.arrayBuffer();
          },
        },
      ],
      [],
      {
        stage: async (refs) => {
          current = await store.save(
            stageAttachments(current, current.id, refs),
          );
          return true;
        },
        complete: async (ids) => {
          current = await store.save(
            finishAttachments(current, current.id, ids),
          );
          return true;
        },
      },
    );
    await startedRead;
    // A fresh store models closing/reopening Composer or a whole page reload.
    const reopenedStore = tab();
    const reopened = reopenedStore.open(current.id);
    assert.equal(reopened.attachments?.length, 1);
    assert.equal(reopened.pendingAttachments?.length, 1);
    assert.equal(files.rows.size, 0);
    await assert.rejects(
      prepareMessage(reopened, files),
      /Files are not ready/,
    );
    await assert.rejects(reopenedStore.lock(reopened), /Files are not ready/);
    current = await store.save({ ...current, text: "Edited while reading" });
    release();
    await work;
    const ready = tab().open(current.id);
    assert.deepEqual(ready.pendingAttachments, []);
    assert.equal(ready.text, "Edited while reading");
    assert.equal((await prepareMessage(ready, files)).attachments?.length, 1);
  }
});

test("selection acknowledgement precedes reads; quota and failed readiness persist pending recovery", async () => {
  const { files, store, storage, tab } = fixture();
  let current = await store.save(draft());
  let read = false;
  const input = {
    ...file(),
    arrayBuffer: async () => {
      read = true;
      return file().arrayBuffer();
    },
  };
  storage.blocked = true;
  await assert.rejects(
    captureFiles(files, current.id, [input], [], {
      stage: async (refs) => {
        current = await store.save(stageAttachments(current, current.id, refs));
        return true;
      },
      complete: async () => true,
    }),
    /quota/,
  );
  assert.equal(read, false);
  storage.blocked = false;
  files.blocked = true;
  await assert.rejects(
    captureFiles(files, current.id, [input], [], {
      stage: async (refs) => {
        current = await store.save(stageAttachments(current, current.id, refs));
        return true;
      },
      complete: async () => true,
    }),
    AttachmentCaptureError,
  );
  const recovered = tab().open(current.id);
  assert.equal(recovered.pendingAttachments?.length, 1);
  await assert.rejects(prepareMessage(recovered, files), /Files are not ready/);
  await store.save({ ...current, attachments: [], pendingAttachments: [] });
  assert.equal(
    (await prepareMessage(store.open(current.id), files)).attachments,
    undefined,
  );
});

test("failed completion acknowledgement cannot expose ready files after reload", async () => {
  const { files, store, storage, tab } = fixture();
  let current = await store.save(draft());
  await assert.rejects(
    captureFiles(files, current.id, [file()], [], {
      stage: async (refs) => {
        current = await store.save(stageAttachments(current, current.id, refs));
        return true;
      },
      complete: async (ids) => {
        storage.blocked = true;
        await store.save(finishAttachments(current, current.id, ids));
        return true;
      },
    }),
    /quota/,
  );
  assert.equal(files.rows.size, 1);
  await assert.rejects(
    prepareMessage(tab().open(current.id), files),
    /Files are not ready/,
  );
});

// B10-01/02/03: the composer's honesty pass — a sending-worded busy state, the fixed-sender
// explanation once the draft is on the server, and focus moved to a failed validation.
test("the composer says Sending…, explains a fixed sender, and focuses a failed field (B10-01, B10-02, B10-03)", () => {
  const code = readFileSync("app/components/inbox/Composer.tsx", "utf8");
  assert.match(code, /\? t\("Sending…"\)/);
  assert.doesNotMatch(code, /t\("Checking…"\)/);
  assert.match(code, /t\("Loading and saving files… You can keep editing the message\."\)/, "the files state keeps its own words");
  assert.match(code, /\{!!draft\.serverId && \(\s*<p className="fi-muted">\{t\("Sender is fixed once the draft is on your server; discard to start over\."\)\}<\/p>/);
  assert.match(code, /focusProblem\(\);/, "a validation failure moves focus");
  assert.match(code, /ref=\{alertRef\} tabIndex=\{-1\}/, "the alert itself is focusable");
  for (const ref of ["toField", "ccField", "bccField"]) assert.match(code, new RegExp(`ref=\\{${ref}\\}`));
});
