/** @jsxRuntime automatic @jsxImportSource react */
// ^ pins the automatic JSX runtime so the tests (tsx) render these parts as the app does.
import { useKumoToastManager } from "@cloudflare/kumo";
import { CaretLeftIcon, DotsThreeIcon, XIcon } from "@phosphor-icons/react";
import {
  createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
  type KeyboardEvent, type ReactNode, type RefObject,
} from "react";
import { Link, useBlocker, useNavigate } from "react-router";
import { LIST_KEYS, nextIndex, type ListEntry, type ListGroup, type ListKey } from "./list-model";
import { sectionInfo, type SectionId } from "./paths";

/* ------------------------------------------------------------------ toasts */

/** A toast beside the inline result: the inline line stays, the toast is heard (polite or assertive). */
export function useNotify() {
  const manager = useKumoToastManager();
  return useCallback((title: string, tone: "ok" | "error" = "ok") => {
    manager.add(tone === "error" ? { title, variant: "error", priority: "high" } : { title });
  }, [manager]);
}

/* ---------------------------------------------- one shared confirmation dialog */

export interface ConfirmRequest {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** A destructive confirmation: the confirm button reads as one, and Cancel takes the focus. */
  danger?: boolean;
  /** Why the action cannot run now; the dialog says so and offers only Cancel. */
  blocked?: string;
}

const ConfirmContext = createContext<(request: ConfirmRequest) => Promise<boolean>>(async () => false);

/** Every confirmation in Settings is this one dialog: one look, one keyboard behaviour (Esc cancels). */
export function useConfirm() {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const accept = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const [request, setRequest] = useState<(ConfirmRequest & { resolve: (ok: boolean) => void }) | null>(null);
  const pending = useRef(request);
  pending.current = request;

  const confirm = useCallback((r: ConfirmRequest) => new Promise<boolean>((resolve) => {
    pending.current?.resolve(false);
    returnTo.current = (typeof document !== "undefined" ? document.activeElement : null) as HTMLElement | null;
    setRequest({ ...r, resolve });
  }), []);

  useEffect(() => {
    const el = dialog.current;
    if (!request || !el) return;
    if (!el.open) el.showModal?.();
    (request.danger || request.blocked ? cancel.current : accept.current)?.focus();
  }, [request]);
  // A screen left with a question open answers it "no".
  useEffect(() => () => pending.current?.resolve(false), []);

  const settle = (ok: boolean) => {
    const current = pending.current;
    setRequest(null);
    if (dialog.current?.open) dialog.current.close();
    current?.resolve(ok && !current.blocked);
    const back = returnTo.current;
    if (back && back.isConnected) back.focus();
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <dialog ref={dialog} className="fi-dialog fi-confirm" aria-labelledby={titleId}
        onCancel={(e) => { e.preventDefault(); settle(false); }}>
        {request && (
          <>
            <h2 id={titleId}>{request.title}</h2>
            {request.body && <div className="fi-dialog-body">{request.body}</div>}
            {request.blocked && <p className="fi-dialog-blocked" role="note">{request.blocked}</p>}
            <div className="fi-dialog-actions">
              <button ref={cancel} type="button" className="fi-secondary" onClick={() => settle(false)}>
                {request.cancelLabel ?? "Cancel"}
              </button>
              {!request.blocked && (
                <button ref={accept} type="button" className={request.danger ? "fi-danger" : "fi-primary"} onClick={() => settle(true)}>
                  {request.confirmLabel}
                </button>
              )}
            </div>
          </>
        )}
      </dialog>
    </ConfirmContext.Provider>
  );
}

/**
 * Leaving an editor with unsaved changes asks first, whether by another row, another section,
 * the Back button or Esc. Nothing is lost silently.
 */
export function useDirtyGuard(dirty: boolean, what: string) {
  const confirm = useConfirm();
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && (currentLocation.pathname !== nextLocation.pathname));
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    void confirm({
      title: `Discard your changes to ${what}?`,
      body: <p>They are not saved yet.</p>,
      confirmLabel: "Discard changes", cancelLabel: "Keep editing", danger: true,
    }).then((ok) => (ok ? blocker.proceed?.() : blocker.reset?.()));
  }, [blocker, confirm, what]);
}

/* ------------------------------------------------------------ plain dialogs */

/** A modal for a short task (add an address, connect an account, make a key). Esc closes it. */
export function Dialog({ open, title, onClose, children, wide = false, busy = false }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean;
  /** While a request runs, Esc and Close wait for it. */
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      returnTo.current = document.activeElement as HTMLElement | null;
      el.showModal?.();
      el.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    } else if (!open && el.open) {
      el.close();
      const back = returnTo.current;
      if (back && back.isConnected) back.focus();
    }
  }, [open]);
  return (
    <dialog ref={ref} className={"fi-dialog" + (wide ? " is-wide" : "")} aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
      {open && (
        <>
          <header className="fi-dialog-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="fi-icon-button" aria-label="Close" disabled={busy} onClick={onClose}><XIcon size={16} /></button>
          </header>
          {children}
        </>
      )}
    </dialog>
  );
}

/* ------------------------------------------------------------- the ⋯ menu */

export interface MenuAction {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** More actions for the selected item; destructive ones live here and always confirm. */
export function ActionMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const id = useId();
  const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const outside = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  if (!actions.length) return null;
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === "Tab") { setOpen(false); return; }
    if (!LIST_KEYS.includes(event.key)) return;
    event.preventDefault();
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    all[nextIndex(at, event.key as ListKey, all.length)]?.focus();
  };
  return (
    <div className="fi-menu-wrap">
      <button ref={trigger} type="button" className="fi-icon-button" aria-label={label} aria-haspopup="menu"
        aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
        <DotsThreeIcon size={18} weight="bold" />
      </button>
      {open && (
        <ul ref={menu} id={id} role="menu" aria-label={label} className="fi-menu" onKeyDown={onKey}>
          {actions.map((a) => (
            <li key={a.label} role="none">
              <button type="button" role="menuitem" className={a.danger ? "is-danger" : undefined} disabled={a.disabled}
                onClick={() => { close(); a.onSelect(); }}>
                {a.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------- per-row work and results */

export interface ActionOutcome { tone: "ok" | "error"; text: string }

interface WorkState {
  /** What is running for each row key ("Removing…"). */
  busy: Record<string, string>;
  results: Record<string, ActionOutcome>;
  run: (key: string, label: string, action: () => Promise<string>, slot?: string) => Promise<boolean>;
  clear: (key: string, slot?: string) => void;
}

const resultKey = (key: string, slot = "") => `${key}\u0000${slot}`;

const WorkContext = createContext<WorkState | null>(null);

/**
 * Work in a section is tracked per row: one address being removed never disables another, and
 * the list row shows that its item is busy. Each result stays with its row, inline in the panel,
 * and is also announced as a toast.
 */
export function WorkProvider({ children }: { children: ReactNode }) {
  const notify = useNotify();
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, ActionOutcome>>({});
  const run = useCallback(async (key: string, label: string, action: () => Promise<string>, slot = "") => {
    const at = resultKey(key, slot);
    setBusy((b) => ({ ...b, [key]: label }));
    setResults((r) => { const { [at]: _gone, ...rest } = r; return rest; });
    try {
      const text = await action();
      // An empty answer means the action stopped to ask something; there is nothing to report yet.
      if (text) {
        setResults((r) => ({ ...r, [at]: { tone: "ok", text } }));
        notify(text);
      }
      return true;
    } catch (error) {
      const text = errorText(error);
      setResults((r) => ({ ...r, [at]: { tone: "error", text } }));
      notify(text, "error");
      return false;
    } finally {
      setBusy((b) => { const { [key]: _done, ...rest } = b; return rest; });
    }
  }, [notify]);
  const clear = useCallback((key: string, slot = "") => setResults((r) => { const { [resultKey(key, slot)]: _gone, ...rest } = r; return rest; }), []);
  const value = useMemo(() => ({ busy, results, run, clear }), [busy, results, run, clear]);
  return <WorkContext.Provider value={value}>{children}</WorkContext.Provider>;
}

/**
 * The work on one item (`key`, the row that shows it is busy). `slot` keeps the results of
 * different parts of its panel apart: a routing check is not reported under the signature form.
 */
export function useWork(key: string, slot = "") {
  const work = useContext(WorkContext);
  if (!work) throw new Error("useWork outside a WorkProvider");
  return {
    busy: work.busy[key] ?? null,
    result: work.results[resultKey(key, slot)] ?? null,
    run: (label: string, action: () => Promise<string>) => work.run(key, label, action, slot),
    clear: () => work.clear(key, slot),
  };
}

/** Which rows are busy, for the list's badges. */
export function useBusyRows(): Record<string, string> {
  return useContext(WorkContext)?.busy ?? {};
}

/** The message of a failure, the server's own words when it gave some. */
export function errorText(error: unknown): string {
  const body = (error as { body?: { error?: unknown } } | null)?.body;
  if (body && typeof body.error === "string" && body.error) return body.error;
  return (error as Error)?.message || "Something went wrong. Try again.";
}

/** The last result of the work on one item, in a slot that never moves the content above it. */
export function ActionResult({ result }: { result: ActionOutcome | null }) {
  return (
    <p className={"fi-action-result" + (result?.tone === "error" ? " is-error" : "")} role={result?.tone === "error" ? "alert" : "status"}>
      {result?.text ?? ""}
    </p>
  );
}

/* --------------------------------------------------------- loading & errors */

/** Grey rows the size of the real ones, so nothing moves when they arrive. */
export function SkeletonRows({ rows = 6, label }: { rows?: number; label: string }) {
  return (
    <div className="fi-skeleton-list" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="fi-skeleton-row" aria-hidden="true"><span /><span /></div>
      ))}
    </div>
  );
}

export function SkeletonPanel({ label }: { label: string }) {
  return (
    <div className="fi-skeleton-panel" role="status" aria-label={label}>
      <span /><span /><span /><span />
    </div>
  );
}

export function LoadFailure({ what, error, onRetry, retrying = false }: { what: string; error: unknown; onRetry: () => void; retrying?: boolean }) {
  return (
    <div className="fi-load-failure" role="alert">
      <p><strong>{what} could not load.</strong> {errorText(error)}</p>
      <button type="button" className="fi-secondary" disabled={retrying} onClick={onRetry}>{retrying ? "Retrying…" : "Retry"}</button>
    </div>
  );
}

export function Badge({ tone = "neutral", children, title }: { tone?: "neutral" | "ok" | "warn" | "bad" | "busy"; children: ReactNode; title?: string }) {
  return <span className={`fi-badge is-${tone}`} title={title}>{children}</span>;
}

/* -------------------------------------------------------- the master list */

interface ListProps<T extends ListEntry> {
  label: string;
  groups: ListGroup<T>[];
  selected: string | null;
  hrefFor: (row: T) => string;
  renderRow: (row: T) => ReactNode;
  /** Shown instead of the rows when there are none. */
  empty?: ReactNode;
  /** Rows above the groups that are not data (a pinned "Recent answers"). */
  pinned?: { key: string; href: string; content: ReactNode }[];
}

/**
 * A stable, keyboard-driven list: rows are links (the selection is the address), arrow keys,
 * Home and End move between them, Enter opens one. The selected row is kept in view, and when
 * the panel closes the focus comes back to the row it was opened from.
 */
export function SelectableList<T extends ListEntry>({ label, groups, selected, hrefFor, renderRow, empty, pinned = [] }: ListProps<T>) {
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef<string | null>(selected);
  const busy = useBusyRows();
  const keys = [...pinned.map((p) => p.key), ...groups.flatMap((g) => g.rows.map((r) => r.key))];
  const focusKey = selected && keys.includes(selected) ? selected : keys[0];

  useEffect(() => {
    const was = previous.current;
    previous.current = selected;
    const rowOf = (key: string) => root.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`);
    if (selected) rowOf(selected)?.scrollIntoView?.({ block: "nearest" });
    // Closing the panel (Esc, Back, Close) returns the focus to the row that opened it.
    else if (was) {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected || active.closest(".fi-section-panel")) rowOf(was)?.focus();
    }
  }, [selected]);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!LIST_KEYS.includes(event.key)) return;
    const rows = [...(root.current?.querySelectorAll<HTMLElement>("[data-row-key]") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0 && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    rows[nextIndex(at, event.key as ListKey, rows.length)]?.focus();
  };

  const row = (key: string, href: string, content: ReactNode) => (
    <li key={key}>
      <Link to={href} preventScrollReset replace={selected !== null} data-row-key={key}
        className={"fi-list-row" + (key === selected ? " is-selected" : "") + (busy[key] ? " is-busy" : "")}
        aria-current={key === selected ? "true" : undefined} tabIndex={key === focusKey ? 0 : -1}>
        {content}
        {busy[key] && <span className="fi-row-busy">{busy[key]}</span>}
      </Link>
    </li>
  );

  return (
    <div ref={root} className="fi-list" onKeyDown={onKey} aria-label={label} role="group">
      {pinned.length > 0 && <ul className="fi-list-rows">{pinned.map((p) => row(p.key, p.href, p.content))}</ul>}
      {!groups.length && !pinned.length && empty}
      {groups.map((g) => (
        <section key={g.id} aria-label={g.label}>
          {(groups.length > 1 || g.label) && <h3 className="fi-list-group">{g.label}</h3>}
          <ul className="fi-list-rows">{g.rows.map((r) => row(r.key, hrefFor(r), renderRow(r)))}</ul>
        </section>
      ))}
    </div>
  );
}

/** The search above a list. It never moves the list: it only filters it. */
export function ListSearch({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return (
    <input className="fi-list-search" type="search" value={value} placeholder={placeholder} aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Escape" && value) { e.preventDefault(); e.stopPropagation(); onChange(""); } }} />
  );
}

/* --------------------------------------------------------- layout & panel */

/**
 * A section: the list on the left and the selected item's panel on the right. Below 930px the
 * panel takes the list's place and has a Back button; the list keeps its scroll position.
 */
export function SectionLayout({ section, toolbar, list, panel, hasSelection, footer }: {
  section: SectionId; toolbar?: ReactNode; list: ReactNode; panel: ReactNode; hasSelection: boolean; footer?: ReactNode;
}) {
  const info = sectionInfo(section);
  return (
    <div className={"fi-section" + (hasSelection ? " has-selection" : "")}>
      <div className="fi-section-list">
        <header className="fi-section-head">
          <h1>{info.label}</h1>
          <p>{info.description}</p>
          {toolbar && <div className="fi-section-tools">{toolbar}</div>}
        </header>
        <div className="fi-section-scroll" data-scroll="list">{list}</div>
        {footer && <div className="fi-section-foot">{footer}</div>}
      </div>
      <div className="fi-section-panel">{panel}</div>
    </div>
  );
}

/** What the right side says while nothing is chosen. */
export function PanelPlaceholder({ children }: { children: ReactNode }) {
  return <div className="fi-panel-placeholder">{children}</div>;
}

/**
 * The selected item. Its heading takes the focus when it opens, Esc or Close goes back to the
 * list, and Back does the same in a narrow window.
 */
export function Panel({ title, subtitle, closeTo, menu, children, headingRef, badges }: {
  title: ReactNode; subtitle?: ReactNode; closeTo: string; menu?: ReactNode; children: ReactNode;
  headingRef?: RefObject<HTMLHeadingElement | null>; badges?: ReactNode;
}) {
  const navigate = useNavigate();
  const own = useRef<HTMLHeadingElement>(null);
  const heading = headingRef ?? own;
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [heading]);
  const close = () => navigate(closeTo, { preventScrollReset: true, replace: true });
  return (
    <section className="fi-panel" aria-label={typeof title === "string" ? title : undefined} data-scroll="panel"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        if ((e.target as HTMLElement).closest("dialog")) return;
        e.preventDefault();
        close();
      }}>
      <header className="fi-panel-head">
        <button type="button" className="fi-panel-back" onClick={close}><CaretLeftIcon size={14} /> Back</button>
        <div className="fi-panel-title">
          <h2 ref={heading} tabIndex={-1}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
          {badges && <div className="fi-panel-badges">{badges}</div>}
        </div>
        <div className="fi-panel-actions">
          {menu}
          <button type="button" className="fi-icon-button fi-panel-close" aria-label="Close" onClick={close}><XIcon size={16} /></button>
        </div>
      </header>
      <div className="fi-panel-body">{children}</div>
    </section>
  );
}

/** Tabs of a panel; each tab is an address, so a link can open it. */
export function PanelTabs({ tabs, current, hrefFor, label }: { tabs: { id: string; label: string }[]; current: string; hrefFor: (id: string) => string; label: string }) {
  return (
    <nav className="fi-tabs" aria-label={label}>
      {tabs.map((t) => (
        <Link key={t.id} to={hrefFor(t.id)} replace preventScrollReset aria-current={t.id === current ? "page" : undefined}
          className={t.id === current ? "is-current" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** A titled block inside a panel. */
export function PanelBlock({ title, children, aside }: { title?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="fi-panel-block">
      {(title || aside) && <div className="fi-panel-block-head">{title && <h3>{title}</h3>}{aside}</div>}
      {children}
    </section>
  );
}

/** The same input everywhere in Settings. */
export const inputClass = "fi-input";
