import { CaretDownIcon, CaretRightIcon, EnvelopeIcon, StarIcon } from "@phosphor-icons/react";
import type { InboxAccount, InboxMessage } from "./model";
import { rawAccount, senderName } from "./model";
import { focusSections, listDate, triageOf, type ListView } from "./triage-view";
import { TRIAGE_GROUPS, type Triage, type TriageGroup } from "../../../shared/mail/triage";

/** The group, or the specific reason an automated message was raised (e.g. "Payment problem"). */
function tagText(t: Triage): string {
  if (t.importance === "important" && t.group !== "people" && t.reasons.length > 1) return t.reasons[1];
  return TRIAGE_GROUPS.find((g) => g.id === t.group)?.label ?? t.group;
}

interface ListProps {
  messages: InboxMessage[];
  accounts: InboxAccount[];
  selectedId?: string;
  onSelect: (message: InboxMessage) => void;
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

function MessageRow({ message, account, selected, onSelect, showGroup, categoryId, inSpam }: {
  message: InboxMessage; account?: InboxAccount; selected: boolean; onSelect: () => void; showGroup: boolean; categoryId?: string; inSpam?: boolean;
}) {
  const t = triageOf(message);
  const important = !inSpam && t.importance === "important";
  const chips = (message.categories ?? []).filter((c) => c.id !== categoryId);
  return (
    <button
      className={"fi-message" + (selected ? " is-selected" : "") + (!message.read ? " is-unread" : "") + (important ? " is-important" : "")}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <div className="fi-row-top">
        <strong>
          {!message.read && <span className="fi-unread" aria-hidden="true" />}
          <span className="fi-visually-hidden">{important ? "Important. " : ""}{!message.read ? "Unread. " : ""}</span>
          {senderName(message.sender)}
        </strong>
        <time dateTime={message.date}>{listDate(message.date)}</time>
      </div>
      <span className="fi-subject">{message.subject || "(No subject)"}</span>
      <span className="fi-snippet">{message.snippet.replace(/\s+/g, " ").trim() || "Open message to read more"}</span>
      {message.categoryReason && <span className="fi-category-reason">Why: {message.categoryReason}</span>}
      {message.spamReason && <span className="fi-category-reason fi-spam-reason">Why in Spam: {message.spamReason}</span>}
      <span className="fi-message-account">
        <EnvelopeIcon size={12} aria-hidden="true" />
        {account?.email ?? rawAccount(message.accountId)}
        {!!message.alsoIn?.length && (
          <span className="fi-also-in" title={"Also in " + message.alsoIn.map(rawAccount).join(", ")}>+{message.alsoIn.length}</span>
        )}
        {showGroup && !inSpam && (
          <span className={"fi-triage-tag tag-" + t.group} title={t.reasons.join(" · ")}>{tagText(t)}</span>
        )}
        {chips.map((c) => (
          <span key={c.id} className="fi-category-chip" title={c.reason}>{c.name}</span>
        ))}
        {message.starred && <StarIcon size={12} weight="fill" role="img" aria-label="Starred" />}
      </span>
    </button>
  );
}

/**
 * The message list in Focus (important first, the rest grouped and collapsed)
 * or Newest-first order; a group filter narrows both. Collapsing is a view
 * choice: nothing is marked read or moved by it.
 */
export default function TriagedList({ messages, accounts, selectedId, onSelect, view, group, open, onToggleGroup, onClearGroup, categoryId, inSpam }: ListProps) {
  const account = (m: InboxMessage) => accounts.find((a) => a.id === m.accountId);
  const row = (m: InboxMessage, showGroup: boolean) => (
    <MessageRow key={m.id} message={m} account={account(m)} selected={selectedId === m.id} onSelect={() => onSelect(m)} showGroup={showGroup} categoryId={categoryId} inSpam={inSpam} />
  );
  const groupLabel = TRIAGE_GROUPS.find((g) => g.id === group)?.label ?? group;
  const noneInGroup = (
    <div className="fi-section-empty">
      No {groupLabel} mail here. <button type="button" className="fi-text-button" onClick={onClearGroup}>Show all</button>
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
          Important <span>{important.length}</span>
        </h3>
        {important.length ? important.map((m) => row(m, true)) : (
          <p className="fi-section-empty">{groups.length ? "Nothing needs you in the loaded mail. The groups below hold the rest." : "Nothing needs you in the loaded mail."}</p>
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
                {g.label}
                <span className="fi-group-count">
                  {g.messages.length}
                  {g.unread ? ` · ${g.unread} unread` : ""}
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
