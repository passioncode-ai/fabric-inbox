import { CaretDownIcon, CaretRightIcon, EnvelopeIcon, StarIcon } from "@phosphor-icons/react";
import type { InboxAccount, InboxMessage } from "./model";
import { rawAccount, senderName } from "./model";
import { focusSections, listDate, triageOf, type ListView } from "./triage-view";
import { TRIAGE_GROUPS, type Triage, type TriageGroup } from "../../../shared/mail/triage";
import { triageText } from "./triage-text";
import { useT, type T } from "../../lib/i18n";
import { agentRunLabel, agentRunNeedsLook } from "./agent-run";
import { draftWaits, statusRepeatsDraft } from "./draft-card";
import { replyStateLabel, replyStateOpen } from "./reply-state";
import { interleave, showServer, type OtherRow } from "../../lib/other-servers";

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
  /** B-244 D-3: the other servers' inbox rows, read through the desktop app; shown among this server's mail. */
  others?: OtherRow[];
  /** Every page of this server's mail is loaded: the other servers' older rows show too. */
  othersComplete?: boolean;
}

/** A message of another server the app holds: read here, opened on its own server in this window (B-244 D-3). */
function OtherMessageRow({ row }: { row: OtherRow }) {
  const t = useT();
  return (
    <button
      type="button"
      className={"fi-message fi-message-other" + (!row.read ? " is-unread" : "")}
      title={t("Opens on {server}", { server: row.server })}
      onClick={() => showServer(row.origin, row.link)}
    >
      <div className="fi-row-top">
        <strong>
          {!row.read && <span className="fi-unread" aria-hidden="true" />}
          <span className="fi-visually-hidden">{!row.read ? t("Unread.") + " " : ""}</span>
          {senderName(row.sender)}
        </strong>
        <time dateTime={new Date(row.at).toISOString()}>{listDate(new Date(row.at).toISOString(), undefined, t)}</time>
      </div>
      <span className="fi-subject">{row.subject || t("(No subject)")}</span>
      <span className="fi-snippet">{row.snippet.replace(/\s+/g, " ").trim() || t("Open message to read more")}</span>
      <span className="fi-message-account">
        <EnvelopeIcon size={12} aria-hidden="true" />
        {row.to}
        <span className="fi-server-pill">{row.server}</span>
      </span>
    </button>
  );
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
          {(message.threadCount ?? 0) > 1 && (
            <>
              <span className="fi-thread-count" aria-hidden="true" title={t.plural(message.threadCount!, { one: "{n} message in this thread", other: "{n} messages in this thread" })}>
                {message.threadCount}
              </span>
              <span className="fi-visually-hidden">{" " + t.plural(message.threadCount!, { one: "{n} message in this thread", other: "{n} messages in this thread" })}</span>
            </>
          )}
          {/* S06 (B-271): the agent's draft waits under this message for a person. */}
          {draftWaits(message.agentRun) && <span className="fi-agent-tag fi-draft-waiting">{t("Draft waiting")}</span>}
        </strong>
        <time dateTime={message.date}>{listDate(message.date, undefined, t)}</time>
      </div>
      <span className="fi-subject">{message.subject || t("(No subject)")}</span>
      <span className="fi-snippet">{message.snippet.replace(/\s+/g, " ").trim() || t("Open message to read more")}</span>
      {message.categoryReason && <span className="fi-category-reason">{t("Why: {reason}", { reason: t.text(message.categoryReason) })}</span>}
      {message.spamReason && <span className="fi-category-reason fi-spam-reason">{t("Why in Spam: {reason}", { reason: t.text(message.spamReason) })}</span>}
      {message.discardReason && <span className="fi-category-reason fi-spam-reason">{triageText(t).whyDiscarded} {t.text(message.discardReason)}</span>}
      {/* B-178: kept from agents with tools until a person releases it. */}
      {message.held && <span className="fi-category-reason fi-spam-reason">{t("Held for review: {reason}", { reason: t.text(message.held.reason) })}</span>}
      {message.agentState ? (
        // B-138: where the conversation stands; it says more than the agent's run on this one message. A-15: not when it
        // only repeats "Draft waiting" beside the sender.
        <>
          {!statusRepeatsDraft(message) && <span className={"fi-agent-tag" + (replyStateOpen(message.agentState) ? " needs-look" : "")}>{replyStateLabel(message.agentState, t)}</span>}
          {/* B-170: still waiting for someone two days after it came in. */}
          {message.agentAbandoned && <span className="fi-agent-tag needs-look">{t("Abandoned")}</span>}
        </>
      ) : message.agentRun && !statusRepeatsDraft(message) && (
        <span className={"fi-agent-tag" + (agentRunNeedsLook(message.agentRun.status) ? " needs-look" : "")}>{agentRunLabel(message.agentRun.status, t)}</span>
      )}
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
export default function TriagedList({ messages, accounts, selectedId, marked, onSelect, view, group, open, onToggleGroup, onClearGroup, categoryId, inSpam, others = [], othersComplete = false }: ListProps) {
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
  // The other servers' rows carry no triage group: a group filter shows this server's mail only.
  const otherRows = group ? [] : others;
  if (view === "newest") {
    const shown = group ? messages.filter((m) => triageOf(m).group === group) : messages;
    if (!shown.length && !otherRows.length) return <div className="fi-message-rows">{noneInGroup}</div>;
    return (
      <div className="fi-message-rows">
        {interleave(shown, (m) => Date.parse(m.date) || 0, otherRows, othersComplete).map((x) =>
          x.kind === "own" ? row(x.item, true) : <OtherMessageRow key={x.row.origin + x.row.link} row={x.row} />)}
      </div>
    );
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
      {otherRows.length > 0 && (
        <section aria-labelledby="fi-other-servers-heading">
          <h3 id="fi-other-servers-heading" className="fi-section-heading">
            {t("Other servers")} <span>{otherRows.filter((r) => !r.read).length}</span>
          </h3>
          {interleave([], () => 0, otherRows, true).map((x) => x.kind === "other" && <OtherMessageRow key={x.row.origin + x.row.link} row={x.row} />)}
        </section>
      )}
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
