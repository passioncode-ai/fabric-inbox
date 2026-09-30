import { useEffect, useRef, useState } from "react";
import {
  browserDraftStore,
  DRAFT_KEY,
  DRAFT_PREFIX,
  type Draft,
  type DraftStore,
} from "./draft-store";
import { attachmentRefs, type AttachmentRef } from "./attachment-store";
import { stageAttachments, finishAttachments } from "./compose-payload";
const saveError =
  "Draft could not be saved on this device. Keep this window open and copy your text before leaving.";
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
  const dirty = useRef(new Set<string>());
  const versions = useRef(new Map<string, number>());
  const upsert = (d: Draft) =>
    updateDrafts((all) => [...all.filter((x) => x.id !== d.id), d]);
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
      }
    }
    void load();
    const sync = (e: StorageEvent) => {
      if (
        e.key === null ||
        e.key === DRAFT_KEY ||
        e.key.startsWith(DRAFT_PREFIX)
      )
        refresh();
    };
    window.addEventListener("storage", sync);
    return () => {
      live = false;
      window.removeEventListener("storage", sync);
    };
  }, []);
  async function save(d: Draft) {
    const version = (versions.current.get(d.id) ?? 0) + 1;
    versions.current.set(d.id, version);
    dirty.current.add(d.id);
    upsert(d);
    setPending((p) => ({ ...p, [d.id]: (p[d.id] ?? 0) + 1 }));
    try {
      if (!store.current) throw new Error(saveError);
      await store.current.save(d);
      if (versions.current.get(d.id) === version) {
        dirty.current.delete(d.id);
        setErrors((e) => ({ ...e, [d.id]: "" }));
      }
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
    }
  }
  async function discard(d: Draft) {
    if (!store.current) throw new Error(saveError);
    await store.current.discard(d.id);
    dirty.current.delete(d.id);
    setErrors((e) => ({ ...e, [d.id]: "" }));
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
    statuses: Object.fromEntries(
      drafts.map((d) => [
        d.id,
        errors[d.id]
          ? "Not saved. Open to recover"
          : pending[d.id]
            ? "Saving draft…"
            : d.pendingAttachments?.length
              ? "Files pending. Open draft to recover"
              : "",
      ]),
    ),
    hasUnsaved:
      drafts.some((d) => !!d.pendingAttachments?.length) ||
      Object.values(pending).some(Boolean) ||
      Object.values(errors).some(Boolean),
    create,
    open,
    save,
    addAttachments,
    completeAttachments,
    lock,
    settle,
    discard,
    reopen,
    refresh,
  };
}
