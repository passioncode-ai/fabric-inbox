import { useEffect, useRef, useState } from "react";
import {
  browserDraftStore,
  DRAFT_KEY,
  DRAFT_PREFIX,
  type Draft,
  type DraftStore,
} from "./draft-store";
import { attachmentRefs, attachmentsOnDevice, type AttachmentRef } from "./attachment-store";
import { stageAttachments, finishAttachments } from "./compose-payload";
import { fabric } from "~/services/fabric";
import {
  deleteSavedDraft,
  mergeSynced,
  openServerDraft,
  rebaseEdit,
  refreshFromServer,
  syncDraft,
  type ServerDraftRow,
  type SyncResult,
} from "./server-drafts";

const saveError =
  "Draft could not be saved on this device. Keep this window open and copy your text before leaving.";
/** How the server's copy of a draft stands, for the composer and the Drafts list. */
export type SyncStatus = { state: "saving" | "saved" | "waiting" | "conflict" | "gone" | "refused"; message: string };
const SYNC_DELAY = 1500, RETRY_DELAY = 30_000;

/**
 * The main window's drafts (B-52): each is kept on this device at once (draft-store.ts, so typing
 * survives a crash or no network) and saved to its account's server shortly after each change
 * (server-drafts.ts), which is the copy the Drafts list, other devices and agents see. A draft made
 * before drafts lived on the server is saved up the first time this runs, and its copy here stays
 * until the server has confirmed it.
 */
export function useDrafts() {
  const store = useRef<DraftStore | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const currentDrafts = useRef<Draft[]>([]);
  function updateDrafts(update: (all: Draft[]) => Draft[]) {
    currentDrafts.current = update(currentDrafts.current);
    setDrafts(currentDrafts.current);
  }
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, number>>({});
  const [sync, setSync] = useState<Record<string, SyncStatus>>({});
  const dirty = useRef(new Set<string>());
  const versions = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const running = useRef(new Map<string, Promise<void>>());
  /** Files of this device now on the server, and server files a save added: a keystroke made before the window showed them cannot undo either. */
  const uploaded = useRef(new Set<string>());
  const syncAdded = useRef(new Set<string>());
  const upsert = (d: Draft) =>
    updateDrafts((all) => [...all.filter((x) => x.id !== d.id), d]);
  const setStatus = (id: string, status: SyncStatus | null) =>
    setSync((all) => { const next = { ...all }; if (status) next[id] = status; else delete next[id]; return next; });
  function refresh() {
    if (!store.current) return;
    try {
      const list = store.current.list();
      updateDrafts((all) => [
        ...list.drafts.filter((d) => !dirty.current.has(d.id)),
        ...all.filter((d) => dirty.current.has(d.id)),
      ]);
      if (list.unreadable)
        setNotice(
          "Some saved drafts could not be read. Their stored data has been kept. You can still compose a new message.",
        );
    } catch {
      setNotice(
        "Saved drafts could not be read. Keep this window open and try opening Drafts again.",
      );
    }
  }
  /** Every draft not yet on the server is saved there (the first run saves drafts kept only here). */
  function syncAll(delay = 0) {
    for (const d of currentDrafts.current) if (!d.synced && !d.locked && d.accountId) schedule(d.id, delay);
  }
  useEffect(() => {
    let live = true;
    async function load() {
      try {
        store.current = browserDraftStore();
        await store.current.migrate();
      } catch {
        if (live)
          setNotice(
            "A saved draft could not be restored. Its stored data has been kept. You can still compose a new message.",
          );
      }
      if (live) {
        refresh();
        setLoaded(true);
        syncAll();
      }
    }
    void load();
    const storage = (e: StorageEvent) => {
      if (
        e.key === null ||
        e.key === DRAFT_KEY ||
        e.key.startsWith(DRAFT_PREFIX)
      )
        refresh();
    };
    const online = () => syncAll();
    window.addEventListener("storage", storage);
    window.addEventListener("online", online);
    return () => {
      live = false;
      window.removeEventListener("storage", storage);
      window.removeEventListener("online", online);
      for (const t of timers.current.values()) clearTimeout(t);
    };
  }, []);

  function schedule(id: string, delay = SYNC_DELAY) {
    const old = timers.current.get(id);
    if (old) clearTimeout(old);
    timers.current.set(id, setTimeout(() => { timers.current.delete(id); void runSync(id); }, delay));
  }
  /** One save to the server at a time per draft; a change made meanwhile is saved by the next run. */
  async function runSync(id: string): Promise<void> {
    const busy = running.current.get(id);
    if (busy) { await busy; return runSync(id); }
    const work = (async () => {
      for (let step = 0; step < 3; step++) {
        const snapshot = currentDrafts.current.find((d) => d.id === id);
        if (!snapshot || snapshot.locked || snapshot.synced || !store.current) return;
        if (dirty.current.has(id)) { schedule(id); return; }
        setStatus(id, { state: "saving", message: "Saving to your server…" });
        const result: SyncResult = await syncDraft(snapshot, attachmentsOnDevice(), fabric);
        const current = currentDrafts.current.find((d) => d.id === id);
        if (!current || current.locked) return;
        if (result.ok) {
          for (const id of result.uploaded) uploaded.current.add(id);
          const known = new Set((current.serverFiles ?? []).map((f) => f.id));
          for (const f of result.serverFiles) if (!known.has(f.id)) syncAdded.current.add(f.id);
          const merged = mergeSynced(current, snapshot, result);
          if (!(await persist(merged))) return;
          setStatus(id, merged.synced ? { state: "saved", message: "Saved to your server" } : null);
          if (!merged.synced) schedule(id);
          return;
        }
        if (result.reason === "pending") {
          if (!(await persist({ ...current, ...result.patch }))) return;
          continue;
        }
        const state = result.reason === "conflict" ? "conflict" : result.reason === "gone" ? "gone" : result.reason === "refused" ? "refused" : "waiting";
        setStatus(id, { state, message: result.message });
        if (result.reason === "offline") schedule(id, RETRY_DELAY);
        return;
      }
    })();
    running.current.set(id, work);
    try { await work; } finally { if (running.current.get(id) === work) running.current.delete(id); }
  }
  /** A server result written into the copy here; false (and the reason shown) when this device refused it. */
  async function persist(d: Draft) {
    try {
      if (!store.current) throw new Error(saveError);
      // Shown at once, so a keystroke made while it is written builds on it.
      upsert(d);
      const saved = await store.current.save(d);
      upsert({ ...saved, ...(currentDrafts.current.find((x) => x.id === d.id) ?? {}) });
      return true;
    } catch (e) {
      setErrors((all) => ({ ...all, [d.id]: e instanceof Error && e.message.includes("another window") ? e.message : saveError }));
      return false;
    }
  }

  async function save(d: Draft) {
    const before = currentDrafts.current.find((x) => x.id === d.id);
    const next = rebaseEdit(before, d, uploaded.current, syncAdded.current);
    for (const f of d.serverFiles ?? []) syncAdded.current.delete(f.id);
    // "Saved to your server" stops being true with the first change after it.
    if (!next.synced) setSync((all) => { if (all[d.id]?.state !== "saved") return all; const rest = { ...all }; delete rest[d.id]; return rest; });
    const version = (versions.current.get(d.id) ?? 0) + 1;
    versions.current.set(d.id, version);
    dirty.current.add(d.id);
    upsert(next);
    setPending((p) => ({ ...p, [d.id]: (p[d.id] ?? 0) + 1 }));
    try {
      if (!store.current) throw new Error(saveError);
      await store.current.save(next);
      if (versions.current.get(d.id) === version) {
        dirty.current.delete(d.id);
        setErrors((e) => ({ ...e, [d.id]: "" }));
      }
      if (!next.synced && !next.locked) schedule(d.id);
      return true;
    } catch (e) {
      setErrors((all) => ({
        ...all,
        [d.id]:
          e instanceof Error && e.message.includes("another window")
            ? e.message
            : saveError,
      }));
      return false;
    } finally {
      setPending((p) => ({ ...p, [d.id]: (p[d.id] ?? 1) - 1 }));
    }
  }
  async function addAttachments(id: string, refs: AttachmentRef[]) {
    const next = stageAttachments(
      currentDrafts.current.find((d) => d.id === id),
      id,
      refs,
    );
    attachmentRefs(next.attachments, id);
    return save(next);
  }
  async function completeAttachments(id: string, ids: string[]) {
    return save(
      finishAttachments(
        currentDrafts.current.find((d) => d.id === id),
        id,
        ids,
      ),
    );
  }
  function create(d: Draft) {
    setActiveId(d.id);
    void save(d);
  }
  function open(id: string) {
    // An unsaved draft stays recoverable in memory; opening it never replaces its text.
    if (dirty.current.has(id)) {
      setActiveId(id);
      return true;
    }
    try {
      if (!store.current) throw new Error(saveError);
      upsert(store.current.open(id));
      setActiveId(id);
      return true;
    } catch (e) {
      setNotice((e as Error).message);
      return false;
    }
  }
  /** Opens a draft from the server (another device's, an agent's): the copy here if there is one. */
  async function openServer(row: ServerDraftRow) {
    const here = currentDrafts.current.find((d) => d.accountId === row.accountId && d.serverId === row.serverId);
    if (here) return open(here.id);
    try {
      const draft = await openServerDraft(row, fabric);
      if (!store.current) throw new Error(saveError);
      if (!(await persist(draft))) return false;
      versions.current.set(draft.id, 0);
      setActiveId(draft.id);
      setStatus(draft.id, { state: "saved", message: "Saved to your server" });
      return true;
    } catch (e) {
      setNotice(e instanceof Error && e.message ? `This draft could not be opened: ${e.message}` : "This draft could not be opened. Try again.");
      return false;
    }
  }
  /** Saves the draft to the server again (after a send refused for a change made elsewhere). */
  async function resync(d: Draft) {
    const current = currentDrafts.current.find((x) => x.id === d.id);
    if (!current || current.locked) return;
    if (await persist({ ...current, synced: false })) schedule(d.id, 0);
  }
  /** Saves now (before a send) and answers the draft as it then stands. */
  async function flush(d: Draft): Promise<Draft | null> {
    const timer = timers.current.get(d.id);
    if (timer) { clearTimeout(timer); timers.current.delete(d.id); }
    await runSync(d.id);
    return currentDrafts.current.find((x) => x.id === d.id) ?? null;
  }
  /**
   * Settles a draft changed elsewhere: "theirs" takes the server's version in place of the text
   * here; "mine" saves the text here over it. A draft sent or deleted elsewhere is saved again as a
   * new one with "mine" (its files on the server went with it).
   */
  async function resolve(d: Draft, choice: "theirs" | "mine") {
    try {
      if (!store.current) throw new Error(saveError);
      const status = sync[d.id]?.state;
      if (choice === "mine" && status === "gone") {
        if (!(await persist({ ...d, serverId: undefined, serverRevision: undefined, serverFiles: [], pendingCreateKey: undefined, synced: false }))) return;
      } else {
        const server = await refreshFromServer(d, fabric);
        const next = choice === "theirs" ? { ...server.draft, id: d.id, idempotencyKey: d.idempotencyKey } :
          { ...d, serverRevision: server.draft.serverRevision, serverFiles: server.matchedFiles, synced: false };
        dirty.current.delete(d.id);
        if (!(await persist(next))) return;
      }
      setStatus(d.id, null);
      schedule(d.id, 0);
    } catch (e) {
      setStatus(d.id, { state: sync[d.id]?.state ?? "refused", message: `The server's version could not be read: ${(e as Error).message}. Try again.` });
    }
  }
  async function lock(d: Draft) {
    if (!store.current || dirty.current.has(d.id)) throw new Error(saveError);
    try {
      const fixed = await store.current.lock(d);
      upsert(fixed);
      return fixed;
    } catch (e) {
      setErrors((all) => ({
        ...all,
        [d.id]: (e as Error).message.includes("another window")
          ? (e as Error).message
          : saveError,
      }));
      throw e;
    }
  }
  async function settle(d: Draft, outcome: "accepted" | "failed" | "editable") {
    if (!store.current) throw new Error(saveError);
    const next = await store.current.settle(d, outcome);
    if (next) upsert(next);
    else {
      updateDrafts((all) => all.filter((x) => x.id !== d.id));
      setErrors((e) => ({ ...e, [d.id]: "" }));
      setStatus(d.id, null);
    }
  }
  /** Discards the draft on the server first, then here; a server that cannot be reached keeps both. */
  async function discard(d: Draft) {
    if (!store.current) throw new Error(saveError);
    await deleteSavedDraft(d, fabric);
    await store.current.discard(d.id);
    dirty.current.delete(d.id);
    setErrors((e) => ({ ...e, [d.id]: "" }));
    setStatus(d.id, null);
    updateDrafts((all) => all.filter((x) => x.id !== d.id));
  }
  function reopen(d: Draft) {
    try {
      if (!store.current) throw new Error(saveError);
      const saved = store.current.open(d.id);
      dirty.current.delete(d.id);
      upsert(saved);
      setErrors((e) => ({ ...e, [d.id]: "" }));
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  return {
    drafts,
    draft: drafts.find((d) => d.id === activeId) ?? null,
    loaded,
    notice,
    error: activeId ? (errors[activeId] ?? "") : "",
    saving: !!(activeId && pending[activeId]),
    sync: activeId ? (sync[activeId] ?? null) : null,
    statuses: Object.fromEntries(
      drafts.map((d) => [
        d.id,
        errors[d.id]
          ? "Not saved. Open to recover"
          : pending[d.id]
            ? "Saving draft…"
            : d.pendingAttachments?.length
              ? "Files pending. Open draft to recover"
              : sync[d.id] && sync[d.id]!.state !== "saved" && sync[d.id]!.state !== "saving"
                ? sync[d.id]!.message
                : !d.synced && !d.locked
                  ? "Kept on this device; not on your server yet"
                  : "",
      ]),
    ),
    hasUnsaved:
      drafts.some((d) => !!d.pendingAttachments?.length) ||
      Object.values(pending).some(Boolean) ||
      Object.values(errors).some(Boolean),
    create,
    open,
    openServer,
    save,
    flush,
    resync,
    resolve,
    addAttachments,
    completeAttachments,
    lock,
    settle,
    discard,
    reopen,
    refresh,
  };
}
