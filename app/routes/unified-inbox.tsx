import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams, type MetaArgs } from "react-router";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  ArrowUUpLeftIcon,
  ArrowBendUpLeftIcon,
  ArrowBendDoubleUpLeftIcon,
  ArrowBendUpRightIcon,
  CaretRightIcon,
  EnvelopeIcon,
  GearSixIcon,
  KeyboardIcon,
  TrayArrowDownIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PaperPlaneTiltIcon,
  PencilSimpleIcon,
  PlusIcon,
  RobotIcon,
  SparkleIcon,
  StarIcon,
  SunIcon,
  TrayIcon,
  TrashIcon,
  XCircleIcon,
  WarningOctagonIcon,
} from "@phosphor-icons/react";
import { fabric } from "~/services/fabric";
import type { Mail } from "~/services/fabric";
import type { Email } from "~/types";
import { htmlToPlainText } from "~/lib/utils";
import EmailIframe from "~/components/EmailIframe";
import { replyAllRecipients, replyRecipient } from "~/components/inbox/send-state";
import Composer, { type Draft } from "~/components/inbox/Composer";
import {
  isRemote,
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
import DraftsDialog, { draftRows } from "~/components/inbox/DraftsDialog";
import { listServerDrafts, signatureFor } from "~/components/inbox/server-drafts";
import MessageActions, { applyMessageChange } from "~/components/inbox/MessageActions";
import TriagedList from "~/components/inbox/TriagedList";
import AccountSidebar from "~/components/inbox/AccountSidebar";
import CategorySidebar from "~/components/inbox/CategorySidebar";
import { progressText, scopeSummary, type CategoryList } from "~/services/categories";
import { totalUnread } from "~/components/inbox/account-groups";
import { displayOrder, groupCounts, isTriageGroup, listDate, nextAfter, pinTriage, triageOf, type ListView } from "~/components/inbox/triage-view";
import type { Triage, TriageGroup } from "../../shared/mail/triage";
import type { InboxFolder } from "../../shared/mail/inbox";
import { showFeedChange, mergeHead, refreshScope, refreshSummary, WakeRefresh, type FeedChange, type RefreshOutcome, type RefreshResponse } from "~/lib/mail-refresh";
import SyncStatus from "~/components/inbox/SyncStatus";
import UndoToast from "~/components/inbox/UndoToast";
import ShortcutsDialog from "~/components/inbox/ShortcutsDialog";
import { isMacPlatform, escapeCancelsConfirmation, mailKeyAction } from "~/lib/mail-keys";
import { archiveMessages, canAct, discardMessages, doneText, learnedNotice, undoDone, type Done } from "~/components/inbox/triage-actions";
import { triageText } from "~/components/inbox/triage-text";
import { metaT, useT, type T } from "~/lib/i18n";
import { msg } from "../../shared/i18n";
import { useWindowActive } from "~/hooks/useWindowActive";
import { outlookSecretSetupPath, settingsPath } from "~/components/settings/paths";
import { GMAIL_REASON_TEXT, isGmailReason } from "../../shared/mail/gmail-reasons";
import type { SecretExpiry } from "../../shared/mail/microsoft-setup";
import { pollInterval, subscribeWindowActivity } from "~/lib/window-activity";
import AgentDock, { useWideAgentLayout } from "~/components/inbox/AgentDock";
import { agentAccount, sourceMessage, type SavedDraft, type Source } from "~/components/agent-chat";
/** How often the list in view is read again while the window is active. */
const INBOX_POLL_MS = 60_000;
/** The product's name as the empty reader shows it: the same in every language. */
const BRAND_MARK = "FABRIC INBOX";
/** The keys as the platform labels them (Delete/Backspace archive, ⌘⌫ or Ctrl+Backspace discard): never translated. */
const triageKeys = (mac: boolean) => ({ archiveKey: mac ? "⌫" : "Delete", discardKey: mac ? "⌘⌫" : "Ctrl+Backspace" });
/** The folders, with their names marked for translation (shown through `t.text`). */
const folders = [
  ["inbox", msg("Inbox"), TrayArrowDownIcon],
  ["starred", msg("Starred"), StarIcon],
  ["sent", msg("Sent"), PaperPlaneTiltIcon],
  ["archive", msg("Archive"), TrayIcon],
  ["trash", msg("Trash"), TrashIcon],
  ["spam", msg("Spam"), WarningOctagonIcon],
  ["discarded", msg("Discarded"), XCircleIcon],
] as const;
export function meta({ matches }: MetaArgs) {
  const t = metaT(matches);
  return [{ title: t("All inboxes · Fabric Inbox") }];
}
/** What an empty folder means, in its own words (the inbox keeps the sync sentence). */
function folderEmpty(folder: string, t: T): [string, string] | undefined {
  switch (folder) {
    case "spam": return [t("No spam"), t("Mail judged spam lands here with the reason, and is deleted after 30 days.")];
    case "discarded": { const TT = triageText(t); return [TT.emptyTitle, TT.emptyBody]; }
    case "trash": return [t("Trash is empty"), t("Deleted mail waits here until you delete it for good.")];
    case "sent": return [t("Nothing sent yet"), t("Mail you send from these inboxes appears here.")];
    case "archive": return [t("Nothing archived"), t("Archive a message to keep it out of the inbox without deleting it.")];
    case "starred": return [t("No starred mail"), t("Star a message to find it here.")];
    default: return undefined;
  }
}
/** Plain words for a provider problem, instead of its code; an account's own reason says more. */
function issueText(issue: { error: string; reason?: string }, t: T): string {
  if (isGmailReason(issue.reason)) return t.text(GMAIL_REASON_TEXT[issue.reason].short);
  switch (issue.error) {
    case "reconnect_required": return t("needs to be connected again");
    case "gmail_api_disabled": return t.text(GMAIL_REASON_TEXT.gmail_api_disabled.short);
    case "google_client_rejected": return t.text(GMAIL_REASON_TEXT.client_rejected.short);
    case "rate_limited": return t("is busy right now; its mail loads on the next refresh");
    case "cache_scan_limit": return t("has more cached mail than one read can scan");
    case "account_not_found": return t("is no longer here");
    case "message_store_unavailable": return t("could not read its stored mail");
    case "account_limit": return t("is beyond the 100 inboxes one view reads");
    default: return t("could not be read");
  }
}
/** An issue a sign-in on Google's page fixes: the banner offers it in one click. An IMAP account's new app password is entered in Settings instead. */
const needsReconnect = (issue: { error: string; reason?: string; provider?: string }) => issue.provider !== "imap" &&
  (isGmailReason(issue.reason) ? GMAIL_REASON_TEXT[issue.reason].action === "reconnect" : issue.error === "reconnect_required");
const needsPassword = (issue: { error: string; provider?: string }) => issue.provider === "imap" && issue.error === "reconnect_required";
/** Where a sign-in fixes an account: Microsoft's for an Outlook account, Google's for a Gmail one. */
const reconnectPath = (issue: { provider?: string }) => (issue.provider === "outlook" ? "/api/accounts/outlook/connect" : "/api/accounts/gmail/connect");
const OPEN_GROUPS_KEY = "fabric-inbox:open-groups";
function readOpenGroups(): Set<TriageGroup> {
  try {
    const raw = sessionStorage.getItem(OPEN_GROUPS_KEY);
    return new Set((raw ? JSON.parse(raw) : []).filter((g: string) => isTriageGroup(g)));
  } catch { return new Set(); }
}
export default function UnifiedInbox() {
  const t = useT();
  const TT = triageText(t);
  const [params, setParams] = useSearchParams();
  const accountId = params.get("account") ?? "",
    folder = folders.some((f) => f[0] === params.get("folder"))
      ? params.get("folder")!
      : "inbox",
    search = params.get("query") ?? "";
  const domainFilter = params.get("domain") ?? "";
  const categoryParam = params.get("category") ?? "";
  const providerParam = params.get("provider");
  const providerFilter = providerParam === "gmail" || providerParam === "imap" || providerParam === "outlook" ? providerParam : "";
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
    [outcomes, setOutcomes] = useState<RefreshOutcome[] | undefined>(undefined),
    [busy, setBusy] = useState(false),
    // Messages chosen together (⌘/Ctrl-click, Shift-click, Shift+↓), and where a range starts.
    [marked, setMarked] = useState<Set<string>>(() => new Set()),
    [anchor, setAnchor] = useState<string | null>(null),
    // The last archive or discard, with Undo, and the once-only notice of a rule it taught.
    [toast, setToast] = useState<{ done?: Done; text: string; notice?: string; ruleIds?: string[]; undoing?: boolean } | null>(null),
    [shortcutsOpen, setShortcutsOpen] = useState(false),
    [mac, setMac] = useState(false),
    // After Not discarded: the rules that would discard such mail again, to stop.
    [restoredRules, setRestoredRules] = useState<{ ruleId: string; label: string }[]>([]),
    [composeOpen, setComposeOpen] = useState(false),
    [draftsOpen, setDraftsOpen] = useState(false),
    [rulesOpen, setRulesOpen] = useState(false),
    // The attachment whose download is in flight; its button says Downloading… (B6-04).
    [downloading, setDownloading] = useState<string | null>(null),
    // The AI panel (SCN-013, B11-01): closed until asked for, so no chat socket opens before then;
    // and the Cloudflare address the person picked in it, when no open message decides.
    [agentOpen, setAgentOpen] = useState(false),
    [agentChoice, setAgentChoice] = useState<string | null>(null);
  const agentToggle = useRef<HTMLButtonElement>(null);
  const agentWide = useWideAgentLayout();
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
    setMarked(new Set());
    setRestoredRules([]);
  }, [accountId, domainFilter, providerFilter, categoryParam, folder, search, unreadOnly]);
  useEffect(() => { setMac(isMacPlatform(navigator as unknown as { platform?: string })); }, []);
  // A toast stays 10 seconds; the next action replaces it.
  useEffect(() => {
    if (!toast || toast.undoing) return;
    const timer = setTimeout(() => setToast(null), 10_000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const el = rulesDialog.current;
    if (rulesOpen) el?.showModal();
    else el?.close();
  }, [rulesOpen]);
  const { archiveKey, discardKey } = triageKeys(mac);
  const windowActive = useWindowActive();
  const listKey = ["unified-inbox", accountId, domainFilter, providerFilter, categoryParam, folder, search, unreadOnly];
  const readPage = (pageParam: string) =>
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
      );
  const list = useInfiniteQuery({
    queryKey: listKey,
    initialPageParam: "",
    queryFn: ({ pageParam }) => readPage(pageParam),
    getNextPageParam: (page) => (page.hasMore ? page.cursor : undefined),
    // One page: it is read again every minute while the window is active. After "Load older" the
    // first page alone is read (below) and joined to the rest, never every loaded page (P1-3).
    refetchInterval: (query) => ((query.state.data?.pages.length ?? 0) > 1 ? false : pollInterval(windowActive, INBOX_POLL_MS)),
  });
  const olderLoaded = (list.data?.pages.length ?? 0) > 1;
  const head = useQuery({
    queryKey: ["unified-inbox-head", ...listKey.slice(1)],
    queryFn: () => readPage(""),
    enabled: olderLoaded,
    refetchInterval: olderLoaded ? pollInterval(windowActive, INBOX_POLL_MS) : false,
  });
  useEffect(() => {
    const fresh = head.data;
    if (!fresh || !olderLoaded) return;
    client.setQueryData(listKey, (data: { pages: InboxData[]; pageParams: unknown[] } | undefined) => mergeHead(data, fresh));
  }, [head.dataUpdatedAt]);
  /** Reads what is in view again: the one page, or the first page joined to older ones. */
  function readAgain() {
    void (olderLoaded ? head.refetch() : list.refetch());
  }
  // Coming back to the window, or the Mac waking from sleep, reads the list at once instead of up
  // to a minute later (P1-4). The desktop app signals a wake through its narrow bridge.
  const wake = useRef(new WakeRefresh());
  const readAgainRef = useRef(readAgain);
  readAgainRef.current = readAgain;
  useEffect(() => {
    if (list.dataUpdatedAt) wake.current.read(list.dataUpdatedAt);
  }, [list.dataUpdatedAt]);
  useEffect(() => {
    const stop = subscribeWindowActivity(window, document, (now) => { if (wake.current.activity(now)) readAgainRef.current(); });
    const bridge = (window as unknown as { fabricDesktop?: { onResume?(callback: () => void): (() => void) | undefined } }).fabricDesktop;
    const stopResume = bridge?.onResume?.(() => { if (wake.current.resume()) readAgainRef.current(); });
    return () => { stop(); stopResume?.(); };
  }, []);
  // Categories and their counts are read with the list, not on a clock of their own, so the
  // sidebar's numbers and the messages always come from the same moment (P2-11).
  const categoryList = useQuery({
    queryKey: ["categories"],
    queryFn: () => fabric<CategoryList>("/api/categories"),
    retry: false,
  });
  const listReadAt = useRef(0);
  useEffect(() => {
    if (!list.dataUpdatedAt || listReadAt.current === list.dataUpdatedAt) return;
    const first = listReadAt.current === 0;
    listReadAt.current = list.dataUpdatedAt;
    if (!first) void categoryList.refetch();
  }, [list.dataUpdatedAt]);
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
    enabled: !!selected && marked.size < 2,
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
    if (!selected || marked.size > 1 || selected.read || !detail.data || detail.data.read || markedRead.current === selected.id) return;
    markedRead.current = selected.id;
    const key = ["unified-message", selected.accountId, selected.providerMessageId];
    // The row reads as read at once; it goes back to unread if the server refuses (P3-12).
    let undo: (() => void) | undefined;
    void showChange({ id: selected.id, patch: { read: true } }).then((rollback) => { undo = rollback; })
      .then(() => isRemote(selected.provider)
        ? fabric(messagePath(selected) + "/read", { read: true })
        : fabric(messagePath(selected), { read: true }, "PUT"))
      .then(() => {
        // The reader's own copy says read too, so "Mark as unread" is offered at once.
        client.setQueryData(key, (d: OpenMessage | undefined) => (d ? { ...d, read: true } : d));
        setSelected((current) => (current?.id === selected.id ? { ...current, read: true } : current));
        return client.invalidateQueries({ queryKey: ["unified-inbox"] });
      })
      .catch(() => {
        undo?.();
        setNotice(t("This message could not be marked read. It stays unread."));
      });
  }, [selected, detail.data, client]);
  const owner = accounts.find((a) => a.id === selected?.accountId);
  /** Everyone a Reply all would reach, or null when the account is the only participant (the button is then not offered, B10-06). */
  const replyAll = detail.data && owner ? replyAllRecipients(detail.data.from, detail.data.to, detail.data.cc ?? "", owner.email) : null;
  // Drafts on the server, every account's (B-52): read afresh each time Drafts opens.
  const serverDrafts = useQuery({
    queryKey: ["server-drafts", accounts.map((a) => a.id).join(",")],
    queryFn: () => listServerDrafts(accounts.map((a) => a.id), fabric),
    enabled: draftsOpen && accounts.length > 0,
    staleTime: 0,
  });
  // The Outlook client secret's end date is the server's own setting: read it once an Outlook
  // account is connected, so the inbox warns as Settings does before sync stops (B5-01).
  const outlookSetup = useQuery({
    queryKey: ["microsoft-setup"],
    queryFn: () => fabric<{ secretExpiry: SecretExpiry | null }>("/api/microsoft-setup"),
    enabled: accounts.some((a) => a.provider === "outlook"),
    staleTime: 60_000,
  });
  const secretSoon = outlookSetup.data?.secretExpiry?.state === "soon" ? outlookSetup.data.secretExpiry : null;
  const scopeName = categoryParam
    ? activeCategory?.name ?? t("Category")
    : active?.email || (accountId ? t("Selected account") : domainFilter || (providerFilter === "imap" ? t("Other mail") : providerFilter === "outlook" ? "Outlook" : providerFilter ? "Gmail" : t("All inboxes")));
  /** The accounts the list in view reads: the status beside Refresh speaks for these. */
  const inScope = accounts.filter((a) => accountId ? a.id === accountId
    : domainFilter ? a.provider === "cloudflare" && a.email.toLowerCase().endsWith("@" + domainFilter.toLowerCase())
    : providerFilter ? a.provider === providerFilter
    : categoryParam && activeCategory?.accountIds ? activeCategory.accountIds.includes(a.id)
    : !hidden.has(a.id.toLowerCase()));
  /** The address the AI panel reads (it reads Cloudflare mailboxes): the open message's, the person's pick, the view's. */
  const agentReading = agentAccount({ accounts, inScope, openAccountId: selected?.accountId, chosenAccountId: agentChoice, filterAccountId: accountId });
  const agentFocus = agentReading?.by === "message" && selected ? { emailId: selected.providerMessageId, subject: detail.data?.subject ?? selected.subject } : null;
  /** Closes the AI panel (its chat and socket go with it) and gives the keyboard back to its toggle. */
  function closeAgent() {
    setAgentOpen(false);
    requestAnimationFrame(() => agentToggle.current?.focus());
  }
  /** A message the AI read, opened in the reader (B11-03); on a narrow window the sheet steps aside. */
  function openAgentSource(source: Source) {
    if (!agentReading) return;
    setMarked(new Set());
    setSelected(sourceMessage(agentReading.account.id, source, messages));
    if (!agentWide) setAgentOpen(false);
  }
  /** "Edit & send in composer": the draft the AI saved opens from the server, as Drafts opens it. */
  function editAgentDraft(d: SavedDraft) {
    if (!agentReading) return;
    void saved.openServer({ accountId: agentReading.account.id, serverId: d.draftId, revision: 0, to: d.to, subject: d.subject, date: "", snippet: "", files: 0 })
      .then((opened) => {
        if (!opened) return;
        setComposeOpen(true);
        if (!agentWide) setAgentOpen(false);
      });
  }
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
      let summary = { ok: true, text: t("Updated just now.") };
      if (scope !== null) {
        try {
          const r = await fabric<RefreshResponse>("/api/inbox/refresh", scope ? { accounts: scope } : {});
          summary = refreshSummary(r.accounts, t);
          setOutcomes(r.accounts);
        } catch (e) {
          summary = { ok: false, text: t("Gmail, IMAP and Outlook accounts could not be checked: {error} The list below is what the server had.", { error: t.text((e as Error).message) }) };
        }
      }
      await Promise.all([refresh(), client.invalidateQueries({ queryKey: ["categories"] })]);
      // The status beside Refresh says how each account went; the notice only what needs reading.
      setNotice(summary.ok ? "" : summary.text);
    } finally {
      setChecking(false);
    }
  }
  /**
   * Shows `change` in every cached list (the pages and the first page read after Load older) before
   * the server answers; the returned function puts them back as they were (P3-12).
   */
  function showChange(change: FeedChange) {
    return showFeedChange(client, change);
  }
  async function perform(action: () => Promise<unknown>, after?: () => void, change?: FeedChange) {
    setBusy(true);
    setNotice("");
    const undo = change ? await showChange(change) : undefined;
    try {
      await action();
      after?.();
      await refresh();
      await client.invalidateQueries({ queryKey: ["unified-message"] });
    } catch (e) {
      undo?.();
      setNotice(t.text((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  /** The messages an action is for: the ones chosen together, else the one open, in the order shown. */
  function targets(): InboxMessage[] {
    const order = displayOrder(messages, view, group, openGroups);
    if (marked.size) return order.filter((m) => marked.has(m.id));
    return selected ? [selected] : [];
  }
  /**
   * Archive (Delete/Backspace: also marks read) or discard (⌘⌫): the rows leave at once, the next
   * message opens, and a toast offers Undo; a refusal puts every row back and says why.
   */
  async function triageAction(kind: "archive" | "discard", list = targets()) {
    if (!list.length || busy) return;
    const owners = list.map((m) => accounts.find((a) => a.id === m.accountId));
    const why = owners.map((o) => canAct(kind, folder, o?.capabilities, t)).find((x) => x);
    if (why) { setNotice(why); return; }
    setBusy(true);
    setNotice("");
    setRestoredRules([]);
    const undo: (() => void)[] = [];
    for (const m of list) undo.push(await showChange({ id: m.id, removed: true }));
    const order = displayOrder(messages, view, group, openGroups);
    const leaving = new Set(list.map((m) => m.id));
    const after = order.slice(order.findIndex((m) => m.id === list[list.length - 1]!.id) + 1).find((m) => !leaving.has(m.id))
      ?? [...order].reverse().find((m) => !leaving.has(m.id)) ?? null;
    setMarked(new Set());
    setSelected(after);
    if (after) requestAnimationFrame(() => document.querySelector<HTMLElement>(".fi-message.is-selected")?.focus());
    try {
      const done = kind === "archive" ? await archiveMessages(list) : await discardMessages(list);
      // What did not move comes back into the list.
      for (const f of done.failed) undo[list.indexOf(f.message as InboxMessage)]?.();
      if (!done.items.length) throw new Error(done.failed[0]?.error ?? t("Nothing changed."));
      const learned = learnedNotice(done, t);
      setToast({ done, text: doneText(done, t), ...(learned ? { notice: learned.text, ruleIds: learned.ruleIds } : {}) });
      if (kind === "discard") void client.invalidateQueries({ queryKey: ["discard-rules"] });
    } catch (e) {
      for (const u of undo) u();
      setSelected(list[0] ?? null);
      setNotice(t.text((e as Error).message));
    } finally {
      setBusy(false);
      await refresh();
      void client.invalidateQueries({ queryKey: ["categories"] });
    }
  }
  /** Undo (the toast's button, ⌘Z): every message back where and as it was. */
  async function undoLast() {
    const done = toast?.done;
    if (!done || toast?.undoing) return;
    setToast({ ...toast!, undoing: true });
    const result = await undoDone(done).catch((e: Error) => ({ restored: 0, failed: [e.message] }));
    setToast(result.failed.length ? null : { text: TT.undone(result.restored) });
    if (result.failed.length) setNotice(TT.undoFailed(result.restored, result.failed.length, result.failed[0]!));
    await refresh();
    void client.invalidateQueries({ queryKey: ["discard-rules"] });
  }
  /** Don't (the once-only notice): the rules that discard just taught are removed. */
  async function forgetRules(ruleIds: string[], label?: string) {
    try {
      for (const id of ruleIds) await fabric(`/api/discard/rules/${encodeURIComponent(id)}`, undefined, "DELETE");
      setToast((current) => (current ? { ...current, notice: undefined, ruleIds: undefined, text: current.text } : current));
      setRestoredRules([]);
      setNotice(TT.ruleRemoved(label));
      void client.invalidateQueries({ queryKey: ["discard-rules"] });
    } catch (e) {
      setNotice(TT.ruleNotRemoved((e as Error).message));
    }
  }
  /** Not discarded: back to the inbox; names the rules that would discard it again. */
  async function restore(message: InboxMessage) {
    await perform(async () => {
      const r = await fabric<{ moved: number; rules: { ruleId: string; label: string }[] }>("/api/discard/restore", { messages: [{ accountId: message.accountId, providerMessageId: message.providerMessageId }] });
      setRestoredRules(r.rules ?? []);
      setNotice(r.rules?.length ? "" : TT.backInInbox);
    }, () => selectNextAfter(message.id), { id: message.id, removed: true });
  }
  /** One click or key on a row: open it, add it to the selection (⌘/Ctrl), or select up to it (Shift). */
  function choose(m: InboxMessage, how: { add?: boolean; range?: boolean } = {}) {
    if (how.range) {
      const order = displayOrder(messages, view, group, openGroups);
      const from = order.findIndex((x) => x.id === (anchor ?? selected?.id ?? m.id));
      const to = order.findIndex((x) => x.id === m.id);
      const [a, b] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
      setMarked(new Set(order.slice(a, b + 1).map((x) => x.id)));
      setSelected(m);
      return;
    }
    if (how.add) {
      const next = new Set(marked.size ? marked : selected ? [selected.id] : []);
      if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
      setMarked(next);
      setAnchor(m.id);
      if (next.size === 1) setSelected(messages.find((x) => next.has(x.id)) ?? null);
      else setSelected(m);
      return;
    }
    setMarked(new Set());
    setAnchor(m.id);
    setSelected(m);
  }
  /** ↓/↑ (j/k): the next or previous row in the order shown; with Shift it joins the selection. */
  function step(by: 1 | -1, extend: boolean) {
    const order = displayOrder(messages, view, group, openGroups);
    if (!order.length) return;
    const at = order.findIndex((m) => m.id === selected?.id);
    const next = order[at < 0 ? (by > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, at + by))]!;
    if (extend) {
      const set = new Set(marked.size ? marked : selected ? [selected.id] : []);
      set.add(next.id);
      setMarked(set);
      setSelected(next);
    } else choose(next);
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`.fi-message[data-message-id="${CSS.escape(next.id)}"]`);
      row?.focus();
      row?.scrollIntoView({ block: "nearest" });
    });
  }
  // The list's keyboard (app/lib/mail-keys.ts): read through a ref so the listener is added once.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    // A dialog (the composer, Drafts, Rules, this help, the AI sheet) owns the keyboard while it is
    // open, and so does the AI column: Delete there must not archive the open message.
    if (composeOpen || document.querySelector("dialog[open]")) return;
    if ((e.target as Element | null)?.closest?.(".fi-agent-panel")) return;
    const action = mailKeyAction({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, isComposing: e.isComposing,
      target: e.target as unknown as Parameters<typeof mailKeyAction>[0]["target"] }, mac);
    if (!action) return;
    e.preventDefault();
    if (action === "archive" || action === "discard") void triageAction(action);
    else if (action === "next" || action === "previous") step(action === "next" ? 1 : -1, false);
    else if (action === "extendNext" || action === "extendPrevious") step(action === "extendNext" ? 1 : -1, true);
    else if (action === "undo") void undoLast();
    else if (action === "help") setShortcutsOpen(true);
    else if (action === "refresh") { if (!checking) void checkForMail(); }
    else if (action === "clear") { if (marked.size) setMarked(new Set()); else if (selected) setSelected(null); }
  };
  useEffect(() => {
    const listen = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", listen);
    return () => window.removeEventListener("keydown", listen);
  }, []);
  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem("fabric-inbox:theme", next);
    } catch {
      setNotice(
        t("Theme changed for this window. This device could not save the preference."),
      );
    }
  }
  async function compose(mode: Draft["mode"], all = false) {
    const m = detail.data;
    const from = mode === "new" ? accountId : (selected?.accountId ?? "");
    // A Cloudflare address's signature goes into the text once, where the person sees and edits it;
    // the draft is then sent as it is (B-52), so nothing adds it a second time.
    let signature = "";
    try {
      signature = from ? await signatureFor(from, fabric) : "";
    } catch {
      setNotice(t("The sender's signature could not be loaded; add it to the message if you need it."));
    }
    const signed = signature ? "\n\n" + signature : "";
    saved.create({
      id: crypto.randomUUID(),
      accountId: from,
      ...(signature ? { signature } : {}),
      to:
        mode === "reply"
          ? all && replyAll
            ? replyAll.to
            : replyRecipient(m?.from ?? "", m?.to ?? "", owner?.email ?? "")
          : "",
      // Reply all is the reply draft with the other participants kept (B10-06), not a new mode:
      // the thread fields and the sender stay exactly the reply's.
      ...(mode === "reply" && all && replyAll?.cc ? { cc: replyAll.cc } : {}),
      subject:
        mode === "new"
          ? ""
          : (mode === "reply" ? "Re: " : "Fwd: ") + (m?.subject ?? ""),
      text:
        mode === "forward"
          ? signed + "\n\n" + t("Forwarded message") + "\n" + t("From:") + " " +
            m?.from +
            "\n" + t("Subject:") + " " +
            m?.subject +
            "\n\n" +
            (m?.text || (m?.html ? htmlToPlainText(m.html) : ""))
          : signed,
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
    if (!selected || downloading) return;
    setDownloading(a.id);
    try {
      await perform(async () => {
        let blob: Blob;
        if (isRemote(selected.provider)) {
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
            throw new Error(t("{name} could not be downloaded.", { name: a.filename }));
          blob = await response.blob();
        }
        const url = URL.createObjectURL(blob),
          link = document.createElement("a");
        link.href = url;
        link.download = a.filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    } finally {
      setDownloading(null);
    }
  }
  // A read that failed — the first load, or a background one (list.isRefetchError, and the first
  // page read after Load older). With mail already shown it costs the list a one-line bar (B6-01);
  // with nothing to show it keeps the full panel.
  const refreshFailed = list.isError || list.isRefetchError || (olderLoaded && (head.isError || head.isRefetchError));
  return (
    <main className={"fi-app" + (selected ? " fi-has-selection" : "") + (agentOpen && agentWide ? " fi-agent-open" : "")}>
      <aside className="fi-sidebar" aria-label={t("Mailbox navigation")}>
        <Link to="/" className="fi-brand">
          <img src="/inbox-mark.svg" alt="" />
          <span>
            Fabric Inbox<small>{t("PassionCode toolkit")}</small>
          </span>
        </Link>
        <button
          className="fi-primary fi-compose-button"
          onClick={() => void compose("new")}
          disabled={!accounts.length || !saved.loaded}
        >
          <PencilSimpleIcon size={18} />
          {t("Compose")}
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
          <span>{t("Drafts")}</span>
          <span className="fi-counter">{draftRows(saved.drafts, serverDrafts.data?.drafts ?? []).length}</span>
        </button>
        <div className="fi-section-label">{t("WORKSPACE")}</div>
        <button
          className={"fi-nav-item" + (!accountId && !domainFilter && !categoryParam && !providerFilter ? " is-active" : "")}
          aria-pressed={!accountId && !domainFilter && !categoryParam && !providerFilter}
          onClick={() => scope({ account: "", domain: "", category: "", provider: "" })}
        >
          <TrayArrowDownIcon
            size={20}
            weight={!accountId ? "fill" : "regular"}
          />
          <span>{t("All inboxes")}</span>
          {!!totalUnread(shownAccounts) && (
            <span className="fi-counter" aria-label={t.plural(totalUnread(shownAccounts)!, { one: "{n} unread", other: "{n} unread" })}>{totalUnread(shownAccounts)}</span>
          )}
        </button>
        <nav aria-label={t("Mail folders")} className="fi-folders">
          {folders.map(([id, label, Icon]) => (
            <button
              key={id}
              className={"fi-nav-item" + (folder === id ? " is-folder" : "")}
              aria-pressed={folder === id}
              onClick={() => scope({ folder: id === "inbox" ? "" : id })}
            >
              <Icon size={18} />
              <span>{t.text(label)}</span>
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
              ? n === 1 && one
                ? t("{address} hidden: out of All inboxes and the counts, still receiving. Find it under Hidden.", { address: one })
                : t.plural(n, {
                  one: "{n} address hidden: out of All inboxes and the counts, still receiving. Find it under Hidden.",
                  other: "{n} addresses hidden: out of All inboxes and the counts, still receiving. Find them under Hidden.",
                })
              : n === 1 && one
                ? t("{address} shown again.", { address: one })
                : t.plural(n, { one: "{n} address shown again.", other: "{n} addresses shown again." }));
          }).then(() => undefined)}
        />
        <div className="fi-sidebar-bottom">
          <button className="fi-nav-item" onClick={() => setRulesOpen(true)}>
            <SparkleIcon size={19} />
            <span>{t("Rules & history")}</span>
            <CaretRightIcon size={14} />
          </button>
          <Link className="fi-nav-item" to="/settings">
            <GearSixIcon size={19} />
            <span>{t("Settings")}</span>
          </Link>
          <button className="fi-nav-item" onClick={() => setShortcutsOpen(true)} aria-keyshortcuts="?">
            <KeyboardIcon size={19} />
            <span>{TT.shortcutsNav}</span>
            <kbd>?</kbd>
          </button>
          <div className="fi-theme-row">
            <a
              href="https://passioncode.ai/inbox/"
              target="_blank"
              rel="noreferrer"
            >
              {t("Part of Fabric ↗")}
            </a>
            <button
              onClick={toggleTheme}
              className="fi-icon-button"
              aria-label={t(
                theme === "light"
                  ? "Switch to dark theme"
                  : "Switch to light theme",
              )}
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
      <section className="fi-workspace" aria-label={t("Mail workspace")}>
        <header className="fi-toolbar">
          <div>
            <span className="fi-eyebrow">
              {t(categoryParam ? "CATEGORY" : accountId ? "ONE ADDRESS" : domainFilter ? "ONE DOMAIN" : providerFilter === "imap" ? "EVERY IMAP ACCOUNT" : providerFilter === "outlook" ? "EVERY OUTLOOK ACCOUNT" : providerFilter ? "EVERY GMAIL ACCOUNT" : "YOUR MAIL, TOGETHER")}
            </span>
            <h1>{scopeName}</h1>
            <SyncStatus accounts={inScope} checking={checking} fetching={list.isFetching || head.isFetching} outcomes={outcomes} mac={mac}
              onRefresh={() => void checkForMail()} />
            {categoryParam && activeCategory && (
              <p className="fi-category-summary">
                <span title={activeCategory.description || undefined}>{activeCategory.description || scopeSummary(activeCategory, categoryList.data?.projects ?? [], t)}</span>
                <Link to={`/categories?c=${activeCategory.id}`}>{t("Change")}</Link>
              </p>
            )}
          </div>
          <label className="fi-folder-select">
            <span className="fi-visually-hidden">{t("Folder")}</span>
            <select value={folder} onChange={(e) => scope({ folder: e.target.value === "inbox" ? "" : e.target.value })}>
              {folders.map(([id, label]) => <option key={id} value={id}>{t.text(label)}</option>)}
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
              aria-label={t("Search cached mail")}
              placeholder={t("Search cached mail")}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            <button type="submit" aria-label={t("Search")}>
              <span>↵</span>
            </button>
          </form>
          <button ref={agentToggle} type="button" className={"fi-icon-button fi-agent-toggle" + (agentOpen ? " is-active" : "")}
            aria-label={t("AI panel")} title={t("Ask AI about your mail")} aria-expanded={agentOpen} aria-controls="fi-agent-panel"
            onClick={() => (agentOpen ? closeAgent() : setAgentOpen(true))}>
            <RobotIcon size={19} weight={agentOpen ? "fill" : "regular"} />
          </button>
        </header>
        {notice && (
          <div className="fi-notice" role="status">
            {notice}
            <button onClick={() => setNotice("")} aria-label={t("Dismiss notice")}>
              ×
            </button>
          </div>
        )}
        {issues.length > 0 && (
          <div className="fi-provider-errors" role="status">
            <strong>
              {issues.length === 1
                ? t("{account} {problem}.", { account: accounts.find((a) => a.id === issues[0].accountId)?.email ?? issues[0].provider, problem: issueText(issues[0], t) })
                : t.plural(issues.length, { one: "{n} inbox is unavailable; the rest of your mail is shown.", other: "{n} inboxes are unavailable; the rest of your mail is shown." })}
            </strong>
            {issues.length > 1 && (
              <button className="fi-text-button" aria-expanded={issuesOpen} onClick={() => setIssuesOpen(!issuesOpen)}>
                {t(issuesOpen ? "Hide details" : "Details")}
              </button>
            )}
            {issuesOpen && issues.length > 1 && (
              <ul>
                {issues.map((i, index) => (
                  <li key={index}>{t("{account} {problem}", { account: accounts.find((a) => a.id === i.accountId)?.email ?? i.provider, problem: issueText(i, t) })}</li>
                ))}
              </ul>
            )}
            {issues.some(needsPassword) && (
              <><Link className="fi-text-button" to={`/settings/accounts/${encodeURIComponent(issues.find(needsPassword)!.accountId ?? "")}`}>{t("Enter a new app password")}</Link>{" "}· </>
            )}
            {issues.some(needsReconnect) && (
              <><a className="fi-text-button" href={reconnectPath(issues.find(needsReconnect)!)} target="_blank" rel="noreferrer">{t("Reconnect in browser ↗")}</a>{" "}· </>
            )}
            <button className="fi-text-button" disabled={checking} onClick={() => void checkForMail()}>{t("Retry")}</button>{" "}
            · <Link to={settingsPath("accounts", issues.length === 1 ? issues[0].accountId : null)}>{t("Why, and what to do")}</Link>
          </div>
        )}
        {secretSoon && (
          <div className="fi-provider-errors" role="status">
            <strong>
              {t.plural(secretSoon.daysLeft, {
                one: "The client secret on your server ends on {date}, in {n} day. Outlook accounts stop syncing that day.",
                other: "The client secret on your server ends on {date}, in {n} days. Outlook accounts stop syncing that day.",
              }, { date: secretSoon.date })}
            </strong>{" "}
            <Link className="fi-text-button" to={outlookSecretSetupPath()}>{t("Open the Outlook setup")}</Link>
          </div>
        )}
        {stuck.length > 0 && (
          <div className="fi-provider-errors" role="status">
            <strong>
              {stuck.length === 1
                ? t("Mail to {address} did not reach its rules, agents or categories ({dead} set aside, {retrying} being retried).", {
                  address: stuck[0].email,
                  dead: stuck.reduce((n, a) => n + (a.stuck?.dead ?? 0), 0),
                  retrying: stuck.reduce((n, a) => n + (a.stuck?.retrying ?? 0), 0),
                })
                : t.plural(stuck.length, {
                  one: "Mail to {n} address did not reach its rules, agents or categories ({dead} set aside, {retrying} being retried).",
                  other: "Mail to {n} addresses did not reach their rules, agents or categories ({dead} set aside, {retrying} being retried).",
                }, {
                  dead: stuck.reduce((n, a) => n + (a.stuck?.dead ?? 0), 0),
                  retrying: stuck.reduce((n, a) => n + (a.stuck?.retrying ?? 0), 0),
                })}
            </strong>
            {stuck[0].stuck?.lastError && <span> {t("Last error: {error}.", { error: t.text(stuck[0].stuck.lastError) })}</span>}
            {" "}{t("The mail itself is in the inbox.")}{" "}
            <button className="fi-text-button" disabled={busy} onClick={() => void perform(async () => {
              const results = await Promise.all(stuck.map((a) => fabric<{ revived: number }>(`/api/v1/mailboxes/${encodeURIComponent(a.email)}/incoming/retry`, {})));
              setNotice(t.plural(results.reduce((n, r) => n + r.revived, 0), {
                one: "{n} set-aside message sent to rules, agents and categories again.",
                other: "{n} set-aside messages sent to rules, agents and categories again.",
              }));
            })}>{t("Retry")}</button>
          </div>
        )}
        {categoryParam && activeCategory && progressText(activeCategory, t) && (
          <div className="fi-category-progress" role="status">{progressText(activeCategory, t)}</div>
        )}
        {folder === "spam" && (
          <SpamBanner busy={busy} empty={!list.isPending && messages.length === 0} onEmpty={() => void perform(async () => {
            const r = await fabric<{ deleted: number; failed: number }>("/api/spam/empty", {});
            setSelected(null);
            setNotice([
              t.plural(r.deleted, { one: "Deleted {n} message from Spam.", other: "Deleted {n} messages from Spam." }),
              ...(r.failed ? [t.plural(r.failed, { one: "{n} address could not be emptied; try again.", other: "{n} addresses could not be emptied; try again." })] : []),
              t("Gmail and IMAP accounts keep their own Spam, which their provider empties."),
            ].join(" "));
          })} />
        )}
        {folder === "discarded" && (
          <div className="fi-category-progress fi-spam-banner" role="note">
            <span>{TT.banner}</span>
            <Link to={settingsPath("discard")}>{TT.bannerLink}</Link>
          </div>
        )}
        {restoredRules.length > 0 && (
          <div className="fi-notice" role="status">
            <span>{TT.stillDiscarding(t.list(restoredRules.map((r) => r.label)))}{" "}
              <button type="button" className="fi-text-button" onClick={() => void forgetRules(restoredRules.map((r) => r.ruleId), t.list(restoredRules.map((r) => r.label)))}>
                {TT.stopDiscarding}
              </button>
            </span>
            <button onClick={() => setRestoredRules([])} aria-label={TT.dismiss}>×</button>
          </div>
        )}
        <div className="fi-content">
          <section className="fi-message-list" aria-label={t("Messages")}>
            <div className="fi-list-heading">
              <strong>
                {search
                  ? t("Search results")
                  : t.text(folders.find((f) => f[0] === folder)?.[1] ?? "")}
              </strong>
              <span>
                {marked.size > 1 ? TT.selected(marked.size) : t(view === "focus" ? "Important first" : "Newest first")}
              </span>
            </div>
            <div className="fi-filter-bar" role="toolbar" aria-label={t("List view and filters")}>
              {folder !== "spam" && <div className="fi-segmented" role="group" aria-label={t("Order")}>
                <button type="button" aria-pressed={view === "focus"} onClick={() => scope({ view: "focus" })}>
                  {t("Focus")}
                </button>
                <button type="button" aria-pressed={view === "newest"} onClick={() => scope({ view: "newest" })}>
                  {t("Newest")}
                </button>
              </div>}
              <button
                type="button"
                className="fi-chip"
                aria-pressed={unreadOnly}
                onClick={() => scope({ unread: unreadOnly ? "" : "1" })}
              >
                {t("Unread only")}
              </button>
              {folder !== "spam" && (counts.length > 1 || !!group) && (
                <div className="fi-chip-row" role="group" aria-label={t("Show one group")}>
                  <button type="button" className="fi-chip" aria-pressed={!group} onClick={() => scope({ group: "" })}>
                    {t("All")}
                  </button>
                  {counts.map((c) => (
                    <button
                      type="button"
                      key={c.id}
                      className={"fi-chip tag-" + c.id}
                      aria-pressed={group === c.id}
                      onClick={() => scope({ group: group === c.id ? "" : c.id })}
                    >
                      {t.text(c.label)} <span>{c.count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {search && (
              <div className="fi-search-summary">
                {t("“{query}”", { query: search })}
                <button onClick={() => scope({ query: "" })}>
                  {t("Clear search")}
                </button>
              </div>
            )}
            {refreshFailed && messages.length > 0 && (
              <div className="fi-notice" role="alert">
                <span>{t("The list could not be refreshed; the mail shown may be older.")}</span>
                <button type="button" className="fi-text-button" onClick={() => readAgain()}>
                  {t("Retry")}
                </button>
              </div>
            )}
            {list.isPending ? (
              <div className="fi-empty" role="status">
                <TrayArrowDownIcon size={32} />
                <h2>{t("Loading your mail")}</h2>
                <p>{t("Bringing your accounts together.")}</p>
              </div>
            ) : list.isError && !messages.length ? (
              <div className="fi-empty" role="alert">
                <h2>{t("Mail could not load")}</h2>
                <p>{t.text(list.error.message)}</p>
                <button className="fi-secondary" onClick={() => void refresh()}>
                  {t("Try again")}
                </button>
              </div>
            ) : messages.length === 0 ? (
              <div className="fi-empty">
                <TrayArrowDownIcon size={36} />
                <h2>
                  {!accounts.length && issues.length
                    ? t("Your inboxes could not be listed")
                    : !accounts.length
                      ? t("Your mail, in one place")
                      : search
                        ? t("No matching mail")
                        : categoryParam
                          ? t("Nothing in this category yet")
                          : unreadOnly
                            ? t("No unread mail here")
                            : folderEmpty(folder, t)?.[0] ?? t("Nothing here yet")}
                </h2>
                <p>
                  {!accounts.length && issues.length
                    ? t("The server could not read the list of inboxes. Retry in a moment.")
                    : !accounts.length
                      ? t("Connect Gmail and your Cloudflare mailboxes. Then read them together or focus on one.")
                      : search
                        ? t(issues.length ? "Some inboxes could not be searched; the others have no match." : "Try another search or return to your inbox.")
                        : categoryParam
                          ? t(activeCategory?.kind === "screened"
                            ? "Matching mail appears here as it arrives. Recent mail is sorted when the category is created."
                            : "The inboxes this category covers have no mail in this folder.")
                          : unreadOnly
                            ? t("Everything here has been read.")
                            : folderEmpty(folder, t)?.[1] ?? t("New messages will appear here after your accounts sync.")}
                </p>
                {!accounts.length && !issues.length ? (
                  <Link className="fi-primary" to="/accounts">{t("Connect an account")}</Link>
                ) : search ? (
                  <button className="fi-secondary" onClick={() => scope({ query: "" })}>{t("Clear search")}</button>
                ) : unreadOnly ? (
                  <button className="fi-secondary" onClick={() => scope({ unread: "" })}>{t("Show all mail")}</button>
                ) : !accounts.length ? (
                  <button className="fi-secondary" onClick={() => void refresh()}>{t("Retry")}</button>
                ) : null}
              </div>
            ) : (
              <TriagedList
                messages={messages}
                accounts={accounts}
                selectedId={selected?.id}
                marked={marked}
                onSelect={choose}
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
                {t(list.isFetchingNextPage ? "Loading…" : "Load older messages")}
              </button>
            )}
            <footer className="fi-list-footer">
              {categoryParam
                ? activeCategory?.kind === "screened"
                  ? t.plural(activeCategory.stats.matched, { one: "{n} message in this category", other: "{n} messages in this category" })
                  : t.plural(activeCategory?.accountIds?.length ?? 0, { one: "{n} inbox", other: "{n} inboxes" })
                : accountId
                ? accounts.find((a) => a.id === accountId)?.email ?? t("One inbox")
                : domainFilter
                  ? t.plural(accounts.filter((a) => a.provider === "cloudflare" && a.email.toLowerCase().endsWith("@" + domainFilter.toLowerCase())).length,
                    { one: "{n} inbox on {domain}", other: "{n} inboxes on {domain}" }, { domain: domainFilter })
                  : t.plural(accounts.length, { one: "{n} inbox", other: "{n} inboxes" })}{" "}
              · {t("Cached mail")}
            </footer>
          </section>
          <section className="fi-reader" aria-label={t("Message reader")}>
            {marked.size > 1 ? (
              <div className="fi-reader-empty">
                <div className="fi-empty-mark"><TrayArrowDownIcon size={35} weight="duotone" /></div>
                <h2>{TT.selectedTitle(marked.size)}</h2>
                <p>{TT.selectedBody}</p>
                <div className="fi-buttons">
                  {canAct("archive", folder, undefined) === null && (
                    <button type="button" className="fi-secondary" disabled={busy} onClick={() => void triageAction("archive")}>
                      <ArchiveIcon size={17} /> {TT.archive} <kbd>{archiveKey}</kbd>
                    </button>
                  )}
                  {canAct("discard", folder, undefined) === null && (
                    <button type="button" className="fi-secondary" disabled={busy} onClick={() => void triageAction("discard")}>
                      <XCircleIcon size={17} /> {TT.discard} <kbd>{discardKey}</kbd>
                    </button>
                  )}
                  <button type="button" className="fi-text-button" onClick={() => setMarked(new Set())}>{TT.clearSelection}</button>
                </div>
              </div>
            ) : !selected ? (
              <div className="fi-reader-empty">
                <div className="fi-empty-mark">
                  <TrayArrowDownIcon size={35} weight="duotone" />
                </div>
                <h2>{t("A little more room to focus.")}</h2>
                <p>
                  {t("Select a message to read it here.")}
                  <br />
                  {t("Your accounts stay together on the left.")}
                </p>
                <span className="fi-micro">{BRAND_MARK}</span>
              </div>
            ) : (
              <>
                <div className="fi-reader-toolbar">
                  <button
                    className="fi-icon-button"
                    aria-label={t("Back to messages")}
                    onClick={() => setSelected(null)}
                  >
                    <ArrowLeftIcon size={18} />
                  </button>
                  <span>{owner?.email ?? rawAccount(selected.accountId)}</span>
                  <MessageActions message={selected} folder={folder as InboxFolder} capabilities={owner?.capabilities}
                    busy={busy || !detail.data}
                    run={(action, after, change) => perform(action, after, change && ("removed" in change ? { id: change.id, removed: true } : { id: change.id, patch: { starred: change.starred } }))}
                    onChanged={change => {
                      // Guard: only the message that was acted on moves the selection on.
                      if ("removed" in change) {
                        if (selected.id === change.id) selectNextAfter(change.id);
                        if (change.notice) setNotice(t.text(change.notice));
                      }
                      else setSelected(current => applyMessageChange(current, change));
                    }} />
                  {owner?.capabilities?.archive !== false && folder !== "discarded" && folder !== "sent" && <button
                    className="fi-icon-button"
                    aria-label={t("Archive message")}
                    title={TT.archiveTitle(archiveKey)}
                    disabled={busy || !detail.data}
                    onClick={() =>
                      folder === "inbox" || folder === "starred"
                        ? void triageAction("archive", [selected])
                        : void perform(
                          () =>
                            isRemote(selected.provider)
                              ? fabric(messagePath(selected) + "/archive", {})
                              : fabric(messagePath(selected) + "/move", { folderId: "archive" }),
                          () => selectNextAfter(selected.id),
                          { id: selected.id, removed: true },
                        )
                    }
                  >
                    <ArchiveIcon size={19} />
                  </button>}
                  {folder === "discarded" ? (
                    <button className="fi-icon-button" aria-label={TT.notDiscarded} title={TT.notDiscardedTitle}
                      disabled={busy || !detail.data} onClick={() => void restore(selected)}>
                      <ArrowUUpLeftIcon size={19} />
                    </button>
                  ) : folder !== "sent" && (
                    <button className="fi-icon-button" aria-label={TT.discardButton} title={TT.discardTitle(discardKey)}
                      disabled={busy || !detail.data} onClick={() => void triageAction("discard", [selected])}>
                      <XCircleIcon size={19} />
                    </button>
                  )}
                  <button
                    className="fi-icon-button"
                    aria-label={t(
                      detail.data?.read ? "Mark as unread" : "Mark as read",
                    )}
                    disabled={busy || !detail.data}
                    onClick={() =>
                      void perform(() =>
                        isRemote(selected.provider)
                          ? fabric(messagePath(selected) + "/read", {
                              read: !detail.data?.read,
                            })
                          : fabric(
                              messagePath(selected),
                              { read: !detail.data?.read },
                              "PUT",
                            ),
                        undefined,
                        { id: selected.id, patch: { read: !detail.data?.read } },
                      )
                    }
                  >
                    <EnvelopeIcon size={19} />
                  </button>
                </div>
                {detail.isPending ? (
                  <div className="fi-empty" role="status">
                    {t("Loading message…")}
                  </div>
                ) : detail.isError ? (
                  <div className="fi-empty" role="alert">
                    <h2>{t("Message could not load")}</h2>
                    <p>{t.text(detail.error.message)}</p>
                    <button
                      className="fi-secondary"
                      onClick={() => void detail.refetch()}
                    >
                      {t("Try again")}
                    </button>
                  </div>
                ) : (
                  detail.data && (
                    <>
                      <div className="fi-reader-scroll">
                        <header className="fi-message-header">
                          <span className="fi-eyebrow">
                            {selected.provider === "cloudflare"
                              ? "CLOUDFLARE"
                              : (owner?.providerName ?? (selected.provider === "gmail" ? "Gmail" : "IMAP")).toUpperCase()}
                            <span className="fi-account-pill">
                              {owner?.email ?? rawAccount(selected.accountId)}
                            </span>
                          </span>
                          <h2>{detail.data.subject || t("(No subject)")}</h2>
                          {selected.discardReason && (
                            <p className="fi-category-reason fi-spam-reason">
                              {TT.whyDiscarded} {t.text(selected.discardReason)}{" "}
                              {restoredRules.length === 0 && <Link to={settingsPath("discard")}>{TT.bannerLink}</Link>}
                            </p>
                          )}
                          <div className="fi-sender">
                            <span className="fi-avatar">
                              {senderName(detail.data.from)
                                .charAt(0)
                                .toUpperCase()}
                            </span>
                            <div>
                              <strong>{detail.data.from}</strong>
                              <p>{t("To {to}", { to: detail.data.to })}</p>
                            </div>
                            <time dateTime={detail.data.date}>
                              {listDate(detail.data.date, undefined, t)}
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
                            <p>{t("No message body.")}</p>
                          )}
                        </div>
                        {!!detail.data.attachments.length && (
                          <div className="fi-attachments">
                            <h3>{t("Attachments")}</h3>
                            {detail.data.attachments.map((a) => (
                              <button
                                className="fi-secondary"
                                key={a.id}
                                disabled={busy || downloading === a.id}
                                onClick={() => void download(a)}
                              >
                                {downloading === a.id ? (
                                  <span role="status">{t("Downloading…")}</span>
                                ) : (
                                  <>
                                    {a.filename} ↓{" "}
                                    <small>{t("{size} KB", { size: Math.ceil(a.size / 1024) })}</small>
                                  </>
                                )}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <footer className="fi-reply-bar">
                        <button
                          className="fi-primary"
                          onClick={() => void compose("reply")}
                        >
                          <ArrowBendUpLeftIcon size={17} /> {t("Reply")}
                        </button>
                        {replyAll && (
                          <button
                            className="fi-secondary"
                            onClick={() => void compose("reply", true)}
                          >
                            <ArrowBendDoubleUpLeftIcon size={17} /> {t("Reply all")}
                          </button>
                        )}
                        <button
                          className="fi-secondary"
                          onClick={() => void compose("forward")}
                        >
                          <ArrowBendUpRightIcon size={17} /> {t("Forward")}
                        </button>
                        {owner && (
                          <Link to={rulesPath(owner)} className="fi-rule-link">
                            <SparkleIcon size={17} /> {t("Rules for this account")}
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
      <AgentDock open={agentOpen} wide={agentWide} onClose={closeAgent}
        addresses={accounts.filter((a) => a.provider === "cloudflare")} reading={agentReading} onChoose={setAgentChoice}
        unreadableOpen={selected && selected.provider !== "cloudflare" ? (owner?.email ?? rawAccount(selected.accountId)) : null}
        focus={agentFocus} onOpenSource={openAgentSource} onEditDraft={editAgentDraft} />
      {saved.notice && (
        <p className="fi-draft-warning" role="alert">
          {t.text(saved.notice)}
        </p>
      )}
      {draftsOpen && (
        <DraftsDialog
          drafts={saved.drafts}
          server={serverDrafts.data?.drafts ?? []}
          serverState={{ loading: serverDrafts.isFetching && !serverDrafts.data, failed: serverDrafts.data?.failed ?? [] }}
          accounts={accounts}
          statuses={saved.statuses}
          onClose={() => setDraftsOpen(false)}
          onOpen={(id) => {
            if (saved.open(id)) {
              setDraftsOpen(false);
              setComposeOpen(true);
            }
          }}
          onOpenServer={(row) => {
            void saved.openServer(row).then((opened) => {
              if (opened) {
                setDraftsOpen(false);
                setComposeOpen(true);
              }
            });
          }}
          onCompose={() => {
            setDraftsOpen(false);
            void compose("new");
          }}
        />
      )}
      {composeOpen && draft && (
        <Composer
          key={draft.id}
          draft={draft}
          storageError={saved.error}
          saving={saved.saving}
          sync={saved.sync}
          onFlush={saved.flush}
          onResync={saved.resync}
          onResolve={saved.resolve}
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
              t("Accepted by the email provider. Recipient delivery is not confirmed."),
            );
            void refresh();
          }}
        />
      )}
      {toast && (
        <UndoToast text={toast.text} undoing={toast.undoing} undoKey={mac ? "⌘Z" : "Ctrl+Z"}
          onUndo={toast.done ? () => void undoLast() : undefined}
          notice={toast.notice} onDont={toast.ruleIds ? () => void forgetRules(toast.ruleIds!, toast.done?.learned.find((l) => l.created)?.label) : undefined}
          onClose={() => setToast(null)} />
      )}
      <ShortcutsDialog open={shortcutsOpen} mac={mac} onClose={() => setShortcutsOpen(false)} />
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
          <h2 id="rules-title">{t("Rules & history")}</h2>
          <button
            className="fi-icon-button"
            aria-label={t("Close rules chooser")}
            onClick={() => setRulesOpen(false)}
          >
            ×
          </button>
        </header>
        <p>{t("Choose the account whose mail the rule can act on.")}</p>
        {accounts.map((a) => (
          <Link className="fi-rule-account" key={a.id} to={rulesPath(a)}>
            {a.email}
            <CaretRightIcon size={16} />
          </Link>
        ))}
        {!accounts.length && (
          <Link to="/accounts">{t("Connect an account first")}</Link>
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
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  // Escape cancels the confirmation (B8-02): a capture listener, so the list's own keydown
  // (clearing the selection) never sees this key.
  useEffect(() => {
    if (!confirming) return;
    const cancel = (e: KeyboardEvent) => {
      if (!escapeCancelsConfirmation({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, isComposing: e.isComposing,
        target: e.target as unknown as Parameters<typeof escapeCancelsConfirmation>[0]["target"] })) return;
      e.stopPropagation();
      setConfirming(false);
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [confirming]);
  return (
    <div className="fi-category-progress fi-spam-banner" role="note">
      <span>{t("Mail in Spam is deleted after 30 days. Nothing here reaches an agent, a rule or a category.")}</span>
      <Link to="/spam">{t("Spam rules")}</Link>
      {confirming ? (
        <span className="fi-spam-confirm" role="alert">
          {t("Delete every message in Spam now, in all your addresses? This cannot be undone.")}
          <button type="button" className="fi-text-button" disabled={busy} onClick={() => { setConfirming(false); onEmpty(); }}>{t("Delete all")}</button>
          <button type="button" className="fi-text-button" onClick={() => setConfirming(false)}>{t("Keep")}</button>
        </span>
      ) : !empty && (
        <button type="button" className="fi-text-button" disabled={busy} onClick={() => setConfirming(true)}>{t("Delete all now…")}</button>
      )}
    </div>
  );
}

