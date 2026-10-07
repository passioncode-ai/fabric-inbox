import { CaretDownIcon, CaretRightIcon, EnvelopeIcon, StarIcon } from "@phosphor-icons/react";
import type { InboxAccount, InboxMessage } from "./model";
import { rawAccount, senderName } from "./model";
import { focusSections, listDate, triageOf, type ListView } from "./triage-view";
import { TRIAGE_GROUPS, type Triage, type TriageGroup } from "../../../shared/mail/triage";
import { triageText } from "./triage-text";
import { useT, type T } from "../../lib/i18n";

/** The group, or the specific reason an automated message was raised (e.g. "Payment problem"). */
function tagText(tri: Triage, t: T): string {
  if (tri.importance === "important" && tri.group !== "people" && tri.reasons.length > 1) return t.text(tri.reasons[1]);
  return t.text(TRIAGE_GROUPS.find((g) => g.id === tri.group)?.label ?? tri.group);
}

interface ListProps {
  messages: InboxMessage[];
  accounts: InboxAccount[];
  selectedId?: string;
  /** Messages chosen together (⌘/Ctrl-click, Shift-click, Shift+↓): the keys and the actions act on all of them. */
  marked?: ReadonlySet<string>;
  /** `how.add` toggles a message in the selection (⌘/Ctrl-click), `how.range` selects up to it (Shift-click). */
  onSelect: (message: InboxMessage, how?: { add?: boolean; range?: boolean }) => void;
  view: ListView;
  group?: TriageGroup;
  /** Groups the operator opened; kept by the page for the session. */
  open: Set<TriageGroup>;
  onToggleGroup: (id: TriageGroup) => void;
  onClearGroup: () => void;
  /** Inside a category's own view the chip for that category is left out. */
  categoryId?: string;
  /** In Spam, triage says nothing: no group tag, nothing marked important. */
  inSpam?: boolean;
}

function MessageRow({ message, account, selected, marked, onSelect, showGroup, categoryId, inSpam }: {
  message: InboxMessage; account?: InboxAccount; selected: boolean; marked: boolean; onSelect: (how?: { add?: boolean; range?: boolean }) => void; showGroup: boolean; categoryId?: string; inSpam?: boolean;
}) {
  const t = useT();
  const tri = triageOf(message);
  const important = !inSpam && tri.importance === "important";
  const chips = (message.categories ?? []).filter((c) => c.id !== categoryId);
  return (
    <button
      className={"fi-message" + (selected ? " is-selected" : "") + (marked ? " is-marked" : "") + (!message.read ? " is-unread" : "") + (important ? " is-important" : "")}
      aria-current={selected ? "true" : undefined}
      data-message-id={message.id}
      onClick={(e) => onSelect({ add: e.metaKey || e.ctrlKey, range: e.shiftKey })}
    >
      <div className="fi-row-top">
        <strong>
          {!message.read && <span className="fi-unread" aria-hidden="true" />}
          <span className="fi-visually-hidden">{[marked && t("Selected."), important && t("Important."), !message.read && t("Unread.")].filter(Boolean).map((s) => s + " ").join("")}</span>
          {senderName(message.sender)}
        </strong>
        <time dateTime={message.date}>{listDate(message.date, undefined, t)}</time>
      </div>
      <span className="fi-subject">{message.subject || t("(No subject)")}</span>
      <span className="fi-snippet">{message.snippet.replace(/\s+/g, " ").trim() || t("Open message to read more")}</span>
      {message.categoryReason && <span className="fi-category-reason">{t("Why: {reason}", { reason: t.text(message.categoryReason) })}</span>}
      {message.spamReason && <span className="fi-category-reason fi-spam-reason">{t("Why in Spam: {reason}", { reason: t.text(message.spamReason) })}</span>}
      {message.discardReason && <span className="fi-category-reason fi-spam-reason">{triageText(t).whyDiscarded} {t.text(message.discardReason)}</span>}
      <span className="fi-message-account">
        <EnvelopeIcon size={12} aria-hidden="true" />
        {account?.email ?? rawAccount(message.accountId)}
        {!!message.alsoIn?.length && (
          <span className="fi-also-in" title={t("Also in {addresses}", { addresses: message.alsoIn.map(rawAccount).join(", ") })}>+{message.alsoIn.length}</span>
        )}
        {showGroup && !inSpam && (
          <span className={"fi-triage-tag tag-" + tri.group} title={tri.reasons.map((r) => t.text(r)).join(" · ")}>{tagText(tri, t)}</span>
        )}
        {chips.map((c) => (
          <span key={c.id} className="fi-category-chip" title={t.text(c.reason)}>{c.name}</span>
        ))}
        {message.starred && <StarIcon size={12} weight="fill" role="img" aria-label={t("Starred")} />}
      </span>
    </button>
  );
}

/**
 * The message list in Focus (important first, the rest grouped and collapsed)
 * or Newest-first order; a group filter narrows both. Collapsing is a view
 * choice: nothing is marked read or moved by it.
 */
export default function TriagedList({ messages, accounts, selectedId, marked, onSelect, view, group, open, onToggleGroup, onClearGroup, categoryId, inSpam }: ListProps) {
  const t = useT();
  const account = (m: InboxMessage) => accounts.find((a) => a.id === m.accountId);
  const row = (m: InboxMessage, showGroup: boolean) => (
    <MessageRow key={m.id} message={m} account={account(m)} selected={selectedId === m.id} marked={!!marked?.has(m.id)} onSelect={(how) => onSelect(m, how)} showGroup={showGroup} categoryId={categoryId} inSpam={inSpam} />
  );
  const groupLabel = t.text(TRIAGE_GROUPS.find((g) => g.id === group)?.label ?? group ?? "");
  const noneInGroup = (
    <div className="fi-section-empty">
      {t.rich("No {group} mail here. {showAll}", {
        group: groupLabel,
        showAll: <button key="show-all" type="button" className="fi-text-button" onClick={onClearGroup}>{t("Show all")}</button>,
      })}
    </div>
  );
  if (view === "newest") {
    const shown = group ? messages.filter((m) => triageOf(m).group === group) : messages;
    return <div className="fi-message-rows">{shown.length ? shown.map((m) => row(m, true)) : noneInGroup}</div>;
  }

  const { important, groups } = focusSections(messages, group);
  if (group && !important.length && !groups.length) return <div className="fi-message-rows">{noneInGroup}</div>;
  return (
    <div className="fi-message-rows">
      <section aria-labelledby="fi-important-heading">
        <h3 id="fi-important-heading" className="fi-section-heading">
          {t("Important")} <span>{important.length}</span>
        </h3>
        {important.length ? important.map((m) => row(m, true)) : (
          <p className="fi-section-empty">{t(groups.length ? "Nothing needs you in the loaded mail. The groups below hold the rest." : "Nothing needs you in the loaded mail.")}</p>
        )}
      </section>
      {groups.map((g) => {
        const expanded = !!group || open.has(g.id);
        return (
          <section key={g.id} aria-labelledby={"fi-group-" + g.id}>
            <h3 className="fi-group-heading" id={"fi-group-" + g.id}>
              <button type="button" aria-expanded={expanded} aria-controls={"fi-group-list-" + g.id} onClick={() => onToggleGroup(g.id)} disabled={!!group}>
                {expanded ? <CaretDownIcon size={13} aria-hidden="true" /> : <CaretRightIcon size={13} aria-hidden="true" />}
                <span className={"fi-group-dot tag-" + g.id} aria-hidden="true" />
                {t.text(g.label)}
                <span className="fi-group-count">
                  {g.messages.length}
                  {g.unread ? " · " + t.plural(g.unread, { one: "{n} unread", other: "{n} unread" }) : ""}
                </span>
              </button>
            </h3>
            <div id={"fi-group-list-" + g.id} hidden={!expanded}>
              {expanded && g.messages.map((m) => row(m, false))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
