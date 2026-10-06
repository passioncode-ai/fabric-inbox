import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArchiveIcon,
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowBendUpLeftIcon,
  ArrowBendUpRightIcon,
  AtIcon,
  BooksIcon, PlugIcon,
  RobotIcon,
  CaretRightIcon,
  EnvelopeIcon,
  GearSixIcon,
  TrayArrowDownIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PaperPlaneTiltIcon,
  PencilSimpleIcon,
  PlusIcon,
  SparkleIcon,
  StarIcon,
  SunIcon,
  TrayIcon,
  TrashIcon,
  WarningOctagonIcon,
} from "@phosphor-icons/react";
import { fabric } from "~/services/fabric";
import type { Mail } from "~/services/fabric";
import type { Email } from "~/types";
import { htmlToPlainText } from "~/lib/utils";
import EmailIframe from "~/components/EmailIframe";
import { replyRecipient } from "~/components/inbox/send-state";
import Composer, { type Draft } from "~/components/inbox/Composer";
import {
  messagePath,
  normalizeMessage,
  rawAccount,
  rulesPath,
  senderName,
  type InboxData,
  type InboxMessage,
  type OpenMessage,
} from "~/components/inbox/model";
import { useDrafts } from "~/components/inbox/use-drafts";
import DraftsDialog from "~/components/inbox/DraftsDialog";
import MessageActions, { applyMessageChange } from "~/components/inbox/MessageActions";
import TriagedList from "~/components/inbox/TriagedList";
import AccountSidebar from "~/components/inbox/AccountSidebar";
import CategorySidebar from "~/components/inbox/CategorySidebar";
import { progressText, scopeSummary, type CategoryList } from "~/services/categories";
import { totalUnread } from "~/components/inbox/account-groups";
import { displayOrder, groupCounts, isTriageGroup, listDate, nextAfter, pinTriage, triageOf, type ListView } from "~/components/inbox/triage-view";
import type { Triage, TriageGroup } from "../../shared/mail/triage";
import type { InboxFolder } from "../../shared/mail/inbox";
import { refreshScope, refreshSummary, type RefreshResponse } from "~/lib/mail-refresh";
const folders = [
  ["inbox", "Inbox", TrayArrowDownIcon],
  ["starred", "Starred", StarIcon],
  ["sent", "Sent", PaperPlaneTiltIcon],
  ["archive", "Archive", TrayIcon],
  ["trash", "Trash", TrashIcon],
  ["spam", "Spam", WarningOctagonIcon],
] as const;
export function meta() {
  return [{ title: "All inboxes · Fabric Inbox" }];
}
const time = (value: string) => listDate(value);
/** What an empty folder means, in its own words (the inbox keeps the sync sentence). */
const FOLDER_EMPTY: Record<string, [string, string]> = {
  spam: ["No spam", "Mail judged spam lands here with the reason, and is deleted after 30 days."],
  trash: ["Trash is empty", "Deleted mail waits here until you delete it for good."],
  sent: ["Nothing sent yet", "Mail you send from these inboxes appears here."],
  archive: ["Nothing archived", "Archive a message to keep it out of the inbox without deleting it."],
  starred: ["No starred mail", "Star a message to find it here."],
};
/** Plain words for a provider problem, instead of its code. */
const ISSUE_TEXT: Record<string, string> = {
  reconnect_required: "needs to be connected again",
  rate_limited: "is busy right now; its mail loads on the next refresh",
  cache_scan_limit: "has more cached mail than one read can scan",
  account_not_found: "is no longer here",
  message_store_unavailable: "could not read its stored mail",
  account_limit: "is beyond the 100 inboxes one view reads",
  account_unavailable: "could not be read",
};
const OPEN_GROUPS_KEY = "fabric-inbox:open-groups";
function readOpenGroups(): Set<TriageGroup> {
  try {
    const raw = sessionStorage.getItem(OPEN_GROUPS_KEY);
    return new Set((raw ? JSON.parse(raw) : []).filter((g: string) => isTriageGroup(g)));
  } catch { return new Set(); }
}
export default function UnifiedInbox() {
  const [params, setParams] = useSearchParams();
  const accountId = params.get("account") ?? "",
    folder = folders.some((f) => f[0] === params.get("folder"))
      ? params.get("folder")!
      : "inbox",
    search = params.get("query") ?? "";
  const domainFilter = params.get("domain") ?? "";
  const categoryParam = params.get("category") ?? "";
  const providerFilter = params.get("provider") === "gmail" ? "gmail" : "";
  const unreadOnly = params.get("unread") === "1",
    groupParam = params.get("group"),
    group = isTriageGroup(groupParam) ? groupParam : undefined,
    // Focus (important first, the rest grouped) is the inbox default; search and
    // other folders read newest first unless the operator picks Focus.
    requestedView: ListView =
      params.get("view") === "newest" || params.get("view") === "focus"
        ? (params.get("view") as ListView)
        : folder === "inbox" && !search
          ? "focus"
          : "newest";
  const [searchInput, setSearchInput] = useState(search),
    [selected, setSelectedState] = useState<InboxMessage | null>(null),
    [pinned, setPinned] = useState<{ id: string; triage: Triage } | null>(null),
    [openGroups, setOpenGroups] = useState<Set<TriageGroup>>(() => new Set()),
    [issuesOpen, setIssuesOpen] = useState(false),
    [theme, setTheme] = useState("light"),
    [notice, setNotice] = useState(""),
    [checking, setChecking] = useState(false),
    [checkedAt, setCheckedAt] = useState(0),
    [busy, setBusy] = useState(false),
    [composeOpen, setComposeOpen] = useState(false),
    [draftsOpen, setDraftsOpen] = useState(false),
    [rulesOpen, setRulesOpen] = useState(false);
  // Opening a message pins the section it was opened in (see pinTriage).
  function setSelected(next: InboxMessage | null | ((current: InboxMessage | null) => InboxMessage | null)) {
    setSelectedState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      if (value?.id !== current?.id) setPinned(value ? { id: value.id, triage: triageOf(value) } : null);
      return value;
    });
  }
  useEffect(() => { setOpenGroups(readOpenGroups()); }, []);
  function toggleGroup(id: TriageGroup) {
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { sessionStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify([...next])); } catch { /* a per-window convenience */ }
      return next;
    });
  }
  const saved = useDrafts();
  const draft = saved.draft;
  const activeDraft = useRef<string | null>(null);
  activeDraft.current = draft?.id ?? null;
  const client = useQueryClient(),
    rulesDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme ?? "light");
  }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (saved.hasUnsaved) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saved.hasUnsaved]);
  useEffect(() => {
    setSearchInput(search);
  }, [search]);
  useEffect(() => {
    setSelected(null);
  }, [accountId, domainFilter, providerFilter, categoryParam, folder, search, unreadOnly]);
  useEffect(() => {
    const el = rulesDialog.current;
    if (rulesOpen) el?.showModal();
    else el?.close();
  }, [rulesOpen]);
  const list = useInfiniteQuery({
    queryKey: ["unified-inbox", accountId, domainFilter, providerFilter, categoryParam, folder, search, unreadOnly],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      fabric<InboxData>(
        "/api/inbox?" +
          new URLSearchParams({
            account: accountId,
            folder,
            query: search,
            cursor: pageParam,
            limit: "50",
            ...(unreadOnly ? { unread: "1" } : {}),
            ...(domainFilter ? { domain: domainFilter } : {}),
            ...(categoryParam ? { category: categoryParam } : {}),
            ...(providerFilter ? { provider: providerFilter } : {}),
          }),
      ),
    getNextPageParam: (page) => (page.hasMore ? page.cursor : undefined),
    // Refreshing re-reads every loaded page; after "Load older" that is left to the Refresh button.
    refetchInterval: (query) => ((query.state.data?.pages.length ?? 0) > 1 ? false : 60_000),
  });
  const categoryList = useQuery({
    queryKey: ["categories"],
    queryFn: () => fabric<CategoryList>("/api/categories"),
    refetchInterval: 60_000,
    retry: false,
  });
  const categories = categoryList.data?.categories ?? [];
  const activeCategory = list.data?.pages[0]?.category ?? categories.find((c) => c.id === categoryParam);
  // A described category has already chosen its mail: grouping it again would fold
  // the one message it found into a closed group, so it reads newest first.
  // Spam has no "important": it always reads newest first.
  const view: ListView = folder === "spam" ? "newest" : activeCategory?.kind === "screened" && !params.get("view") ? "newest" : requestedView;
  // Opening a category: what it held until now is no longer "new".
  const seenCategory = useRef("");
  useEffect(() => {
    if (!categoryParam || seenCategory.current === categoryParam || !list.data) return;
    seenCategory.current = categoryParam;
    void fabric(`/api/categories/${categoryParam}/seen`, {}).then(() => client.invalidateQueries({ queryKey: ["categories"] })).catch(() => undefined);
  }, [categoryParam, list.data]);
  const first = list.data?.pages[0];
  const catalog = useRef<InboxData["accounts"]>([]);
  // Unread counts arrive only for the accounts in the current scope; keep the
  // last known count of the others so the sidebar does not lose them.
  const knownUnread = useRef(new Map<string, number>());
  const knownMeta = useRef(new Map<string, { total?: number; catchAll?: boolean }>());
  if (first) {
    for (const a of first.accounts) {
      if (typeof a.unread === "number") knownUnread.current.set(a.id, a.unread);
      if (typeof a.total === "number") knownMeta.current.set(a.id, { total: a.total, catchAll: a.catchAll });
    }
    catalog.current = first.accounts.map((a) => ({ ...a, unread: a.unread ?? knownUnread.current.get(a.id),
      total: a.total ?? knownMeta.current.get(a.id)?.total, catchAll: a.catchAll ?? knownMeta.current.get(a.id)?.catchAll }));
  }
  const accounts = catalog.current,
    active = accounts.find((a) => a.id === accountId);
  // Addresses the operator hid: listed apart, left out of the All inboxes total.
  const hiddenQuery = useQuery({ queryKey: ["hidden-accounts"], queryFn: () => fabric<{ hidden: string[] }>("/api/inbox/hidden"), staleTime: 60_000 });
  const hidden = new Set((hiddenQuery.data?.hidden ?? accounts.filter((a) => a.hidden).map((a) => a.id)).map((x) => x.toLowerCase()));
  const shownAccounts = accounts.filter((a) => !hidden.has(a.id.toLowerCase()));
  const stuck = accounts.filter((a) => a.provider === "cloudflare" && a.stuck && (a.stuck.dead || a.stuck.retrying));
  const messages = pinTriage(Array.from(
    new Map(
      (list.data?.pages.flatMap((p) => p.messages) ?? []).map((m) => [m.id, m]),
    ).values(),
  ), pinned);
  const counts = groupCounts(messages);
  const issues = Array.from(
    new Map(
      (list.data?.pages.flatMap((p) => p.issues) ?? []).map((i) => [
        i.accountId + ":" + i.error,
        i,
      ]),
    ).values(),
  );
  const detail = useQuery({
    queryKey: [
      "unified-message",
      selected?.accountId,
      selected?.providerMessageId,
    ],
    enabled: !!selected,
    queryFn: async () =>
      normalizeMessage(
        await fabric<Email | Mail>(messagePath(selected!)),
        selected!.provider,
      ),
  });
  // Opening an unread message marks it read once the body has loaded, as every
  // mail client does; a failure leaves it unread and says so.
  const markedRead = useRef<string | null>(null);
  useEffect(() => {
    if (!selected || selected.read || !detail.data || detail.data.read || markedRead.current === selected.id) return;
    markedRead.current = selected.id;
    const request = selected.provider === "gmail"
      ? fabric(messagePath(selected) + "/read", { read: true })
      : fabric(messagePath(selected), { read: true }, "PUT");
    const key = ["unified-message", selected.accountId, selected.providerMessageId];
    request
      .then(() => {
        // The reader's own copy says read too, so "Mark as unread" is offered at once.
        client.setQueryData(key, (d: OpenMessage | undefined) => (d ? { ...d, read: true } : d));
        setSelected((current) => (current?.id === selected.id ? { ...current, read: true } : current));
        return client.invalidateQueries({ queryKey: ["unified-inbox"] });
      })
      .catch(() => setNotice("This message could not be marked read. It stays unread."));
  }, [selected, detail.data, client]);
  const owner = accounts.find((a) => a.id === selected?.accountId);
  const scopeName = categoryParam
    ? activeCategory?.name ?? "Category"
    : active?.email || (accountId ? "Selected account" : domainFilter || (providerFilter ? "Gmail" : "All inboxes"));
  /**
   * Changes what the list shows. Changing the order or the group keeps the open message;
   * changing where to look (inbox, folder, category, search) closes it and clears the group.
   */
  function scope(patch: Record<string, string>) {
    const next = new URLSearchParams(params);
    const keys = Object.keys(patch);
    const onlyView = keys.every((k) => k === "view" || k === "group");
    if (!onlyView && !("group" in patch)) next.delete("group");
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!onlyView) setSelected(null);
    setParams(next);
  }
  /** The message below the one leaving the list, so triage goes on without reselecting. */
  function selectNextAfter(id: string) {
    const order = displayOrder(messages, view, group, openGroups);
    const next = nextAfter(order, id);
    setSelected(next);
    if (next) requestAnimationFrame(() => document.querySelector<HTMLElement>(".fi-message.is-selected")?.focus());
  }
  async function refresh() {
    await client.invalidateQueries({ queryKey: ["unified-inbox"] });
  }
  /**
   * Refresh (P1-5): Gmail is read now for the accounts in view (Cloudflare mail arrives by push),
   * then the list and the categories are read again. Says which accounts could not be read.
   */
  async function checkForMail() {
    setChecking(true);
    try {
      const scope = refreshScope({ accountId, domain: domainFilter });
      let summary = { ok: true, text: "Updated just now." };
      if (scope !== null) {
        try {
          const r = await fabric<RefreshResponse>("/api/inbox/refresh", scope ? { accounts: scope } : {});
          summary = refreshSummary(r.accounts);
        } catch (e) {
          summary = { ok: false, text: `Gmail could not be checked: ${(e as Error).message} The list below is what the server had.` };
        }
      }
      await Promise.all([refresh(), client.invalidateQueries({ queryKey: ["categories"] })]);
      setCheckedAt(Date.now());
      setNotice(summary.ok && summary.text === "Updated just now." ? "" : summary.text);
    } finally {
      setChecking(false);
    }
  }
  async function perform(action: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setNotice("");
    try {
      await action();
      await refresh();
      await client.invalidateQueries({ queryKey: ["unified-message"] });
      after?.();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem("fabric-inbox:theme", next);
    } catch {
      setNotice(
        "Theme changed for this window. This device could not save the preference.",
      );
    }
  }
  function compose(mode: Draft["mode"]) {
    const m = detail.data;
    saved.create({
      id: crypto.randomUUID(),
      accountId: mode === "new" ? accountId : (selected?.accountId ?? ""),
      to:
        mode === "reply"
          ? replyRecipient(m?.from ?? "", m?.to ?? "", owner?.email ?? "")
          : "",
      subject:
        mode === "new"
          ? ""
          : (mode === "reply" ? "Re: " : "Fwd: ") + (m?.subject ?? ""),
      text:
        mode === "forward"
          ? "\n\nForwarded message\nFrom: " +
            m?.from +
            "\nSubject: " +
            m?.subject +
            "\n\n" +
            (m?.text || (m?.html ? htmlToPlainText(m.html) : ""))
          : "",
      mode,
      originalId: selected?.providerMessageId,
      forwardSource:
        mode === "forward" && selected && m
          ? {
              accountId: selected.accountId,
              originalId: selected.providerMessageId,
              provider: selected.provider,
              files: m.attachments,
            }
          : undefined,
      threadId: mode === "reply" ? m?.threadId : undefined,
      inReplyTo: mode === "reply" ? m?.rfcMessageId : undefined,
      references: mode === "reply" ? m?.references : undefined,
      idempotencyKey: crypto.randomUUID(),
    });
    setComposeOpen(true);
  }
  async function download(a: OpenMessage["attachments"][number]) {
    if (!selected) return;
    await perform(async () => {
      let blob: Blob;
      if (selected.provider === "gmail") {
        const result = await fabric<{ data: string }>(
          messagePath(selected) + "/attachments/" + encodeURIComponent(a.id),
        );
        blob = new Blob(
          [
            Uint8Array.from(
              atob(result.data.replaceAll("-", "+").replaceAll("_", "/")),
              (c) => c.charCodeAt(0),
            ),
          ],
          { type: a.mimeType },
        );
      } else {
        const response = await fetch(
          messagePath(selected) + "/attachments/" + encodeURIComponent(a.id),
        );
        if (!response.ok)
          throw new Error("Attachment could not be downloaded.");
        blob = await response.blob();
      }
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = a.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  return (
    <main className={"fi-app" + (selected ? " fi-has-selection" : "")}>
      <aside className="fi-sidebar" aria-label="Mailbox navigation">
        <Link to="/" className="fi-brand">
          <img src="/inbox-mark.svg" alt="" />
          <span>
            Fabric Inbox<small>PassionCode toolkit</small>
          </span>
        </Link>
        <button
          className="fi-primary fi-compose-button"
          onClick={() => compose("new")}
          disabled={!accounts.length || !saved.loaded}
        >
          <PencilSimpleIcon size={18} />
          Compose
          <span>↗</span>
        </button>
        <button
          className="fi-nav-item"
          disabled={!saved.loaded}
          onClick={() => {
            saved.refresh();
            setDraftsOpen(true);
          }}
        >
          <PencilSimpleIcon size={18} />
          <span>Drafts</span>
          <span className="fi-counter">{saved.drafts.length}</span>
        </button>
        <div className="fi-section-label">WORKSPACE</div>
        <button
          className={"fi-nav-item" + (!accountId && !domainFilter && !categoryParam && !providerFilter ? " is-active" : "")}
          aria-pressed={!accountId && !domainFilter && !categoryParam && !providerFilter}
          onClick={() => scope({ account: "", domain: "", category: "", provider: "" })}
        >
          <TrayArrowDownIcon
            size={20}
            weight={!accountId ? "fill" : "regular"}
          />
          <span>All inboxes</span>
          {!!totalUnread(shownAccounts) && (
            <span className="fi-counter" aria-label={`${totalUnread(shownAccounts)} unread`}>{totalUnread(shownAccounts)}</span>
          )}
        </button>
        <nav aria-label="Mail folders" className="fi-folders">
          {folders.map(([id, label, Icon]) => (
            <button
              key={id}
              className={"fi-nav-item" + (folder === id ? " is-folder" : "")}
              aria-pressed={folder === id}
              onClick={() => scope({ folder: id === "inbox" ? "" : id })}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <CategorySidebar categories={categories} accounts={accounts} active={categoryParam}
          onOpen={(id) => scope({ category: id, account: "", domain: "", provider: "" })} />
        <AccountSidebar
          accounts={accounts}
          accountId={accountId}
          domain={domainFilter}
          provider={providerFilter}
          loading={list.isPending}
          onScope={(patch) => scope({ ...patch, category: "" })}
          hidden={hidden}
          busy={busy}
          onHidden={(change) => perform(async () => {
            const r = await fabric<{ hidden: string[] }>("/api/inbox/hidden", change, "PUT");
            client.setQueryData(["hidden-accounts"], r);
            const n = (change.hide ?? change.show ?? []).length;
            const one = accounts.find((a) => a.id === (change.hide ?? change.show)?.[0])?.email;
            setNotice(change.hide
              ? `${n === 1 && one ? one : `${n} addresses`} hidden: out of All inboxes and the counts, still receiving. Find ${n === 1 ? "it" : "them"} under Hidden.`
              : `${n === 1 && one ? one : `${n} addresses`} shown again.`);
          }).then(() => undefined)}
        />
        <div className="fi-sidebar-bottom">
          <button className="fi-nav-item" onClick={() => setRulesOpen(true)}>
            <SparkleIcon size={19} />
            <span>Rules & history</span>
            <CaretRightIcon size={14} />
          </button>
          <Link className="fi-nav-item" to="/projects">
            <AtIcon size={19} />
            <span>Domains &amp; addresses</span>
          </Link>
          <Link className="fi-nav-item" to="/ai-agents">
            <RobotIcon size={19} />
            <span>Agents</span>
          </Link>
          <Link className="fi-nav-item" to="/knowledge">
            <BooksIcon size={19} />
            <span>Knowledge</span>
          </Link>
          <Link className="fi-nav-item" to="/agent-access">
            <PlugIcon size={19} />
            <span>Agent access</span>
          </Link>
          <Link className="fi-nav-item" to="/accounts">
            <GearSixIcon size={19} />
            <span>Manage accounts</span>
          </Link>
          <div className="fi-theme-row">
            <a
              href="https://passioncode.ai/inbox/"
              target="_blank"
              rel="noreferrer"
            >
              Part of Fabric ↗
            </a>
            <button
              onClick={toggleTheme}
              className="fi-icon-button"
              aria-label={
                theme === "light"
                  ? "Switch to dark theme"
                  : "Switch to light theme"
              }
            >
              {theme === "light" ? (
                <MoonIcon size={18} />
              ) : (
                <SunIcon size={18} />
              )}
            </button>
          </div>
        </div>
      </aside>
      <section className="fi-workspace" aria-label="Mail workspace">
        <header className="fi-toolbar">
          <div>
            <span className="fi-eyebrow">
              {categoryParam ? "CATEGORY" : accountId ? "ONE ADDRESS" : domainFilter ? "ONE DOMAIN" : providerFilter ? "EVERY GMAIL ACCOUNT" : "YOUR MAIL, TOGETHER"}
            </span>
            <h1>{scopeName}</h1>
            {categoryParam && activeCategory && (
              <p className="fi-category-summary">
                <span title={activeCategory.description || undefined}>{activeCategory.description || scopeSummary(activeCategory, categoryList.data?.projects ?? [])}</span>
                <Link to={`/categories?c=${activeCategory.id}`}>Change</Link>
              </p>
            )}
          </div>
          <label className="fi-folder-select">
            <span className="fi-visually-hidden">Folder</span>
            <select value={folder} onChange={(e) => scope({ folder: e.target.value === "inbox" ? "" : e.target.value })}>
              {folders.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              scope({ query: searchInput.trim() });
            }}
            className="fi-search"
          >
            <MagnifyingGlassIcon size={18} />
            <input
              aria-label="Search cached mail"
              placeholder="Search cached mail"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            <button type="submit" aria-label="Search">
              <span>↵</span>
            </button>
          </form>
          <button
            className="fi-icon-button"
            title="Check for new mail"
            aria-label="Check for new mail"
            onClick={() => void checkForMail()}
            disabled={checking || list.isFetching}
          >
            <ArrowClockwiseIcon size={19} />
          </button>
        </header>
        {notice && (
          <div className="fi-notice" role="status">
            {notice}
            <button onClick={() => setNotice("")} aria-label="Dismiss notice">
              ×
            </button>
          </div>
        )}
        {issues.length > 0 && (
          <div className="fi-provider-errors" role="status">
            <strong>
              {issues.length === 1
                ? `${accounts.find((a) => a.id === issues[0].accountId)?.email ?? issues[0].provider} ${ISSUE_TEXT[issues[0].error] ?? ISSUE_TEXT.account_unavailable}.`
                : `${issues.length} inboxes are unavailable; the rest of your mail is shown.`}
            </strong>
            {issues.length > 1 && (
              <button className="fi-text-button" aria-expanded={issuesOpen} onClick={() => setIssuesOpen(!issuesOpen)}>
                {issuesOpen ? "Hide details" : "Details"}
              </button>
            )}
            {issuesOpen && issues.length > 1 && (
              <ul>
                {issues.map((i, index) => (
                  <li key={index}>{accounts.find((a) => a.id === i.accountId)?.email ?? i.provider} {ISSUE_TEXT[i.error] ?? ISSUE_TEXT.account_unavailable}</li>
                ))}
              </ul>
            )}
            <button className="fi-text-button" disabled={checking} onClick={() => void checkForMail()}>Retry</button>{" "}
            · <Link to="/accounts">Manage connections</Link>
          </div>
        )}
        {stuck.length > 0 && (
          <div className="fi-provider-errors" role="status">
            <strong>
              {stuck.length === 1
                ? `Mail to ${stuck[0].email} did not reach its rules, agents or categories`
                : `Mail to ${stuck.length} addresses did not reach their rules, agents or categories`}
              {" "}({stuck.reduce((n, a) => n + (a.stuck?.dead ?? 0), 0)} set aside, {stuck.reduce((n, a) => n + (a.stuck?.retrying ?? 0), 0)} being retried).
            </strong>
            {stuck[0].stuck?.lastError && <span> Last error: {stuck[0].stuck.lastError}.</span>}
            {" "}The mail itself is in the inbox.{" "}
            <button className="fi-text-button" disabled={busy} onClick={() => void perform(async () => {
              const results = await Promise.all(stuck.map((a) => fabric<{ revived: number }>(`/api/v1/mailboxes/${encodeURIComponent(a.email)}/incoming/retry`, {})));
              setNotice(`${results.reduce((n, r) => n + r.revived, 0)} set-aside message${results.length === 1 ? "" : "s"} sent to rules, agents and categories again.`);
            })}>Retry</button>
          </div>
        )}
        {categoryParam && activeCategory && progressText(activeCategory) && (
          <div className="fi-category-progress" role="status">{progressText(activeCategory)}</div>
        )}
        {folder === "spam" && (
          <SpamBanner busy={busy} empty={!list.isPending && messages.length === 0} onEmpty={() => void perform(async () => {
            const r = await fabric<{ deleted: number; failed: number }>("/api/spam/empty", {});
            setSelected(null);
            setNotice(`Deleted ${r.deleted} message${r.deleted === 1 ? "" : "s"} from Spam.`
              + (r.failed ? ` ${r.failed} address${r.failed === 1 ? "" : "es"} could not be emptied; try again.` : "")
              + " Gmail empties its own Spam after 30 days.");
          })} />
        )}
        <div className="fi-content">
          <section className="fi-message-list" aria-label="Messages">
            <div className="fi-list-heading">
              <strong>
                {search
                  ? "Search results"
                  : folders.find((f) => f[0] === folder)?.[1]}
              </strong>
              <span>
                {checking
                  ? "Checking Gmail…"
                  : list.isFetching
                  ? "Updating…"
                  : checkedAt && Date.now() - checkedAt < 60_000
                    ? "Updated just now"
                  : view === "focus"
                    ? "Important first"
                    : "Newest first"}
              </span>
            </div>
            <div className="fi-filter-bar" role="toolbar" aria-label="List view and filters">
              {folder !== "spam" && <div className="fi-segmented" role="group" aria-label="Order">
                <button type="button" aria-pressed={view === "focus"} onClick={() => scope({ view: "focus" })}>
                  Focus
                </button>
                <button type="button" aria-pressed={view === "newest"} onClick={() => scope({ view: "newest" })}>
                  Newest
                </button>
              </div>}
              <button
                type="button"
                className="fi-chip"
                aria-pressed={unreadOnly}
                onClick={() => scope({ unread: unreadOnly ? "" : "1" })}
              >
                Unread only
              </button>
              {folder !== "spam" && (counts.length > 1 || !!group) && (
                <div className="fi-chip-row" role="group" aria-label="Show one group">
                  <button type="button" className="fi-chip" aria-pressed={!group} onClick={() => scope({ group: "" })}>
                    All
                  </button>
                  {counts.map((c) => (
                    <button
                      type="button"
                      key={c.id}
                      className={"fi-chip tag-" + c.id}
                      aria-pressed={group === c.id}
                      onClick={() => scope({ group: group === c.id ? "" : c.id })}
                    >
                      {c.label} <span>{c.count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {search && (
              <div className="fi-search-summary">
                “{search}”
                <button onClick={() => scope({ query: "" })}>
                  Clear search
                </button>
              </div>
            )}
            {list.isPending ? (
              <div className="fi-empty" role="status">
                <TrayArrowDownIcon size={32} />
                <h2>Loading your mail</h2>
                <p>Bringing your accounts together.</p>
              </div>
            ) : list.isError ? (
              <div className="fi-empty" role="alert">
                <h2>Mail could not load</h2>
                <p>{list.error.message}</p>
                <button className="fi-secondary" onClick={() => void refresh()}>
                  Try again
                </button>
              </div>
            ) : messages.length === 0 ? (
              <div className="fi-empty">
                <TrayArrowDownIcon size={36} />
                <h2>
                  {!accounts.length && issues.length
                    ? "Your inboxes could not be listed"
                    : !accounts.length
                      ? "Your mail, in one place"
                      : search
                        ? "No matching mail"
                        : categoryParam
                          ? "Nothing in this category yet"
                          : unreadOnly
                            ? "No unread mail here"
                            : FOLDER_EMPTY[folder]?.[0] ?? "Nothing here yet"}
                </h2>
                <p>
                  {!accounts.length && issues.length
                    ? "The server could not read the list of inboxes. Retry in a moment."
                    : !accounts.length
                      ? "Connect Gmail and your Cloudflare mailboxes. Then read them together or focus on one."
                      : search
                        ? issues.length ? "Some inboxes could not be searched; the others have no match." : "Try another search or return to your inbox."
                        : categoryParam
                          ? activeCategory?.kind === "screened"
                            ? "Matching mail appears here as it arrives. Recent mail is sorted when the category is created."
                            : "The inboxes this category covers have no mail in this folder."
                          : unreadOnly
                            ? "Everything here has been read."
                            : FOLDER_EMPTY[folder]?.[1] ?? "New messages will appear here after your accounts sync."}
                </p>
                {!accounts.length && !issues.length ? (
                  <Link className="fi-primary" to="/accounts">Connect an account</Link>
                ) : search ? (
                  <button className="fi-secondary" onClick={() => scope({ query: "" })}>Clear search</button>
                ) : unreadOnly ? (
                  <button className="fi-secondary" onClick={() => scope({ unread: "" })}>Show all mail</button>
                ) : !accounts.length ? (
                  <button className="fi-secondary" onClick={() => void refresh()}>Retry</button>
                ) : null}
              </div>
            ) : (
              <TriagedList
                messages={messages}
                accounts={accounts}
                selectedId={selected?.id}
                onSelect={setSelected}
                view={view}
                group={group}
                open={openGroups}
                onToggleGroup={toggleGroup}
                onClearGroup={() => scope({ group: "" })}
                categoryId={categoryParam || undefined}
                inSpam={folder === "spam"}
              />
            )}
            {list.hasNextPage && (
              <button
                className="fi-load-more fi-secondary"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? "Loading…" : "Load older messages"}
              </button>
            )}
            <footer className="fi-list-footer">
              {categoryParam
                ? activeCategory?.kind === "screened"
                  ? `${activeCategory.stats.matched} message${activeCategory.stats.matched === 1 ? "" : "s"} in this category`
                  : `${activeCategory?.accountIds?.length ?? 0} inboxes`
                : accountId
                ? accounts.find((a) => a.id === accountId)?.email ?? "One inbox"
                : domainFilter
                  ? `${accounts.filter((a) => a.provider === "cloudflare" && a.email.toLowerCase().endsWith("@" + domainFilter.toLowerCase())).length} inboxes on ${domainFilter}`
                  : `${accounts.length} inboxes`}{" "}
              · Cached mail
            </footer>
          </section>
          <section className="fi-reader" aria-label="Message reader">
            {!selected ? (
              <div className="fi-reader-empty">
                <div className="fi-empty-mark">
                  <TrayArrowDownIcon size={35} weight="duotone" />
                </div>
                <h2>A little more room to focus.</h2>
                <p>
                  Select a message to read it here.
                  <br />
                  Your accounts stay together on the left.
                </p>
                <span className="fi-micro">FABRIC INBOX</span>
              </div>
            ) : (
              <>
                <div className="fi-reader-toolbar">
                  <button
                    className="fi-icon-button"
                    aria-label="Back to messages"
                    onClick={() => setSelected(null)}
                  >
                    <ArrowLeftIcon size={18} />
                  </button>
                  <span>{owner?.email ?? rawAccount(selected.accountId)}</span>
                  <MessageActions message={selected} folder={folder as InboxFolder}
                    busy={busy || !detail.data} run={perform}
                    onChanged={change => {
                      // Guard: only the message that was acted on moves the selection on.
                      if ("removed" in change) {
                        if (selected.id === change.id) selectNextAfter(change.id);
                        if (change.notice) setNotice(change.notice);
                      }
                      else setSelected(current => applyMessageChange(current, change));
                    }} />
                  <button
                    className="fi-icon-button"
                    aria-label="Archive message"
                    disabled={busy || !detail.data}
                    onClick={() =>
                      void perform(
                        () =>
                          selected.provider === "gmail"
                            ? fabric(messagePath(selected) + "/archive", {})
                            : fabric(messagePath(selected) + "/move", {
                                folderId: "archive",
                              }),
                        () => selectNextAfter(selected.id),
                      )
                    }
                  >
                    <ArchiveIcon size={19} />
                  </button>
                  <button
                    className="fi-icon-button"
                    aria-label={
                      detail.data?.read ? "Mark as unread" : "Mark as read"
                    }
                    disabled={busy || !detail.data}
                    onClick={() =>
                      void perform(() =>
                        selected.provider === "gmail"
                          ? fabric(messagePath(selected) + "/read", {
                              read: !detail.data?.read,
                            })
                          : fabric(
                              messagePath(selected),
                              { read: !detail.data?.read },
                              "PUT",
                            ),
                      )
                    }
                  >
                    <EnvelopeIcon size={19} />
                  </button>
                </div>
                {detail.isPending ? (
                  <div className="fi-empty" role="status">
                    Loading message…
                  </div>
                ) : detail.isError ? (
                  <div className="fi-empty" role="alert">
                    <h2>Message could not load</h2>
                    <p>{detail.error.message}</p>
                    <button
                      className="fi-secondary"
                      onClick={() => void detail.refetch()}
                    >
                      Try again
                    </button>
                  </div>
                ) : (
                  detail.data && (
                    <>
                      <div className="fi-reader-scroll">
                        <header className="fi-message-header">
                          <span className="fi-eyebrow">
                            {selected.provider === "gmail"
                              ? "GMAIL"
                              : "CLOUDFLARE"}
                            <span className="fi-account-pill">
                              {owner?.email ?? rawAccount(selected.accountId)}
                            </span>
                          </span>
                          <h2>{detail.data.subject || "(No subject)"}</h2>
                          <div className="fi-sender">
                            <span className="fi-avatar">
                              {senderName(detail.data.from)
                                .charAt(0)
                                .toUpperCase()}
                            </span>
                            <div>
                              <strong>{detail.data.from}</strong>
                              <p>To {detail.data.to}</p>
                            </div>
                            <time dateTime={detail.data.date}>
                              {time(detail.data.date)}
                            </time>
                          </div>
                        </header>
                        <div className="fi-message-body">
                          {/* HTML when the message has it (sandboxed), the text part otherwise:
                              Gmail sends both, and text-first dropped every layout. */}
                          {detail.data.html ? (
                            <EmailIframe
                              messageKey={selected.id}
                              body={detail.data.html}
                              autoSize
                            />
                          ) : detail.data.text ? (
                            <pre>{detail.data.text}</pre>
                          ) : (
                            <p>No message body.</p>
                          )}
                        </div>
                        {!!detail.data.attachments.length && (
                          <div className="fi-attachments">
                            <h3>Attachments</h3>
                            {detail.data.attachments.map((a) => (
                              <button
                                className="fi-secondary"
                                key={a.id}
                                disabled={busy}
                                onClick={() => void download(a)}
                              >
                                {a.filename} ↓{" "}
                                <small>{Math.ceil(a.size / 1024)} KB</small>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <footer className="fi-reply-bar">
                        <button
                          className="fi-primary"
                          onClick={() => compose("reply")}
                        >
                          <ArrowBendUpLeftIcon size={17} /> Reply
                        </button>
                        <button
                          className="fi-secondary"
                          onClick={() => compose("forward")}
                        >
                          <ArrowBendUpRightIcon size={17} /> Forward
                        </button>
                        {owner && (
                          <Link to={rulesPath(owner)} className="fi-rule-link">
                            <SparkleIcon size={17} /> Rules for this account
                          </Link>
                        )}
                      </footer>
                    </>
                  )
                )}
              </>
            )}
          </section>
        </div>
      </section>
      {saved.notice && (
        <p className="fi-draft-warning" role="alert">
          {saved.notice}
        </p>
      )}
      {draftsOpen && (
        <DraftsDialog
          drafts={saved.drafts}
          accounts={accounts}
          statuses={saved.statuses}
          onClose={() => setDraftsOpen(false)}
          onOpen={(id) => {
            if (saved.open(id)) {
              setDraftsOpen(false);
              setComposeOpen(true);
            }
          }}
          onCompose={() => {
            setDraftsOpen(false);
            compose("new");
          }}
        />
      )}
      {composeOpen && draft && (
        <Composer
          key={draft.id}
          draft={draft}
          storageError={saved.error}
          saving={saved.saving}
          onLock={saved.lock}
          onSettle={saved.settle}
          onDiscard={saved.discard}
          onReopen={saved.reopen}
          accounts={accounts}
          onChange={(d) => void saved.save(d)}
          onAddAttachments={saved.addAttachments}
          onCompleteAttachments={saved.completeAttachments}
          onClose={() => {
            if (activeDraft.current === draft.id) setComposeOpen(false);
          }}
          onSent={() => {
            setNotice(
              "Accepted by the email provider. Recipient delivery is not confirmed.",
            );
            void refresh();
          }}
        />
      )}
      <dialog
        ref={rulesDialog}
        className="fi-rules-dialog"
        onCancel={(e) => {
          e.preventDefault();
          setRulesOpen(false);
        }}
        aria-labelledby="rules-title"
      >
        <header>
          <h2 id="rules-title">Rules & history</h2>
          <button
            className="fi-icon-button"
            aria-label="Close rules chooser"
            onClick={() => setRulesOpen(false)}
          >
            ×
          </button>
        </header>
        <p>Choose the account whose mail the rule can act on.</p>
        {accounts.map((a) => (
          <Link className="fi-rule-account" key={a.id} to={rulesPath(a)}>
            {a.email}
            <CaretRightIcon size={16} />
          </Link>
        ))}
        {!accounts.length && (
          <Link to="/accounts">Connect an account first</Link>
        )}
      </dialog>
    </main>
  );
}

/**
 * Spam's header (SP-4): what happens to it, where its rules are, and Delete all now
 * behind a confirmation. Gmail keeps its own spam for its own 30 days.
 */
function SpamBanner({ busy, empty, onEmpty }: { busy: boolean; empty: boolean; onEmpty: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="fi-category-progress fi-spam-banner" role="note">
      <span>Mail in Spam is deleted after 30 days. Nothing here reaches an agent, a rule or a category.</span>
      <Link to="/spam">Spam rules</Link>
      {confirming ? (
        <span className="fi-spam-confirm" role="alert">
          Delete every message in Spam now, in all your addresses? This cannot be undone.
          <button type="button" className="fi-text-button" disabled={busy} onClick={() => { setConfirming(false); onEmpty(); }}>Delete all</button>
          <button type="button" className="fi-text-button" onClick={() => setConfirming(false)}>Keep</button>
        </span>
      ) : !empty && (
        <button type="button" className="fi-text-button" disabled={busy} onClick={() => setConfirming(true)}>Delete all now…</button>
      )}
    </div>
  );
}

