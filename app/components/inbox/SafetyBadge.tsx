import { CheckIcon, ShieldCheckIcon, ShieldWarningIcon, ShieldSlashIcon, ShieldIcon, WarningIcon } from "@phosphor-icons/react";
import { useT } from "~/lib/i18n";
import { CHECKS, type CheckName, type FileEntry, type SafetyColour, type SafetyLikeRecord } from "../../../shared/mail/safety";
import { badgeWords, domainHeading, domainLines, domainNotRunWords, fileWords, notRunWords, reviewNotRunWords, reviewWords, showsOkLine, signalWords } from "./safety-words";

/**
 * S03 (B-269, B-222): the Okolos badge at the right of the subject line, and its panel. The badge is a button with
 * `aria-expanded`; its colour is never the only signal (an icon and a word each). The panel opens under the header,
 * the header's full width (A-2: the reader draws `SafetyPanel` after the people, never beside the subject), and says
 * what was checked, each file, what did not run and why, the review's codes and quotes, first steps for amber and red,
 * and one line about Okolos. Nothing here is drawn inside the message text.
 */
export interface SafetyBadgeProps {
  colour: SafetyColour;
  checking?: boolean;
  /** The panel is open (the reader holds it, so the panel can sit under the header). */
  open: boolean;
  onToggle: () => void;
}

export interface SafetyPanelProps {
  colour: SafetyColour;
  record: (SafetyLikeRecord & { checkedAt?: number }) | null;
  /** The record could not be read, or the open-time check failed. */
  failed?: boolean;
  onReportSpam?: () => void;
  onDiscard?: () => void;
  onSaveAnyway?: (file: FileEntry) => void;
  /** S03c (B-288): look up the sender's domains (absent: this reader cannot, so no button). */
  onLookUpDomains?: (refresh: boolean) => void;
  lookingUp?: boolean;
  /** The lookup failed, or the day's lookups are spent: its words. */
  lookupError?: string;
}

const ICONS = { green: ShieldCheckIcon, grey: ShieldIcon, amber: ShieldWarningIcon, red: ShieldSlashIcon } as const;
const CHECK_NAMES: CheckName[] = [...CHECKS];

export default function SafetyBadge({ colour, checking, open, onToggle }: SafetyBadgeProps) {
  const t = useT();
  const Icon = ICONS[colour.colour];
  const label = badgeWords(colour.label, t);
  const released = colour.released === "person" ? t("Released by you") : colour.released === "review" ? t("Released by the review") : "";
  return (
    <div className={`fi-okolos is-${colour.colour}`}>
      <button type="button" className="fi-okolos-badge" aria-expanded={open} aria-controls="fi-okolos-panel" onClick={onToggle}
        title={t("What Okolos checked in this message")}>
        <Icon size={15} weight="bold" aria-hidden="true" />
        <span>{checking ? t("Checking…") : label}</span>
        {/* A-18: the release note sits apart from the badge's word, after a separator. */}
        {released && <span className="fi-okolos-released"><span aria-hidden="true">·</span> {released}</span>}
      </button>
    </div>
  );
}

export function SafetyPanel({ colour, record, failed, onReportSpam, onDiscard, onSaveAnyway, onLookUpDomains, lookingUp, lookupError }: SafetyPanelProps) {
  const t = useT();
  const check = record?.findings.check;
  const fired = (name: CheckName) => check?.signals.filter((s) => s.check === name) ?? [];
  const skipped = (name: CheckName) => check?.notRun.filter((n) => n.check === name) ?? [];
  const okLine = (name: CheckName): string => {
    switch (name) {
      case "senderAuth": return t("The sender's own server confirmed it sent this (DMARC, SPF, DKIM).");
      case "senderIdentity": return t("The sender's address does not imitate a known name.");
      case "replyPath": return t("Replies go back to the sender's own domain.");
      case "links": return t("Links: {n} checked, none on the phishing list.", { n: check?.links.length ?? 0 });
      case "hidden": return t("No orders to an AI in the text, its hidden text or its documents.");
      case "attachments": return check?.files.length ? t("Files: {n} checked by what they are.", { n: check.files.length }) : t("No attached files.");
    }
  };
  return (
        <section id="fi-okolos-panel" className={`fi-okolos-panel is-${colour.colour}`} aria-label={t("Safety check")}>
          {failed && <p role="alert">{t("The safety check could not load. Links ask before they open.")}</p>}
          {!check && !failed && <p>{t("This message has no safety record yet, so its links ask before they open.")}</p>}
          {check && (
            <>
              <h3>{t("What was checked")}</h3>
              <ul className="fi-okolos-lines">
                {CHECK_NAMES.filter((name) => !skipped(name).some((s) => s.why === "inboxNotReceived")).map((name) => {
                  const signals = fired(name).map((s) => signalWords(s, t)).filter(Boolean);
                  if (name === "attachments") return signals.length ? signals.map((w, i) => <li key={`${name}-${i}`} className="is-fired"><Fired />{w}</li>) : null;
                  if (signals.length) return signals.map((w, i) => <li key={`${name}-${i}`} className="is-fired"><Fired />{w}</li>);
                  if (!showsOkLine(name, check, colour.linksComplete)) return null;
                  return <li key={name} className="is-clean"><CheckIcon size={13} weight="bold" aria-hidden="true" className="fi-okolos-mark" />{okLine(name)}</li>;
                })}
              </ul>
              <SenderDomains record={record} received={check.scope === "received"} onLookUp={onLookUpDomains} busy={lookingUp} error={lookupError} />
              {!!check.files.length && (
                <>
                  <h3>{t("Files")}</h3>
                  <ul className="fi-okolos-files">
                    {check.files.map((f) => (
                      <li key={f.id} className={`is-${f.colour}`}>
                        <span className="fi-okolos-chip" aria-hidden="true" />
                        <span>{f.filename}: {fileWords(f, t)}</span>
                        {f.colour === "red" && onSaveAnyway && (
                          <button type="button" className="fi-secondary fi-okolos-save" onClick={() => onSaveAnyway(f)}>{t("Save anyway")}</button>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {(!!check.notRun.length || !colour.linksComplete) && (
                <>
                  <h3>{t("What did not run here, and why")}</h3>
                  <ul className="fi-okolos-lines">
                    {check.notRun.map((n, i) => { const w = notRunWords(n.why, t); return w ? <li key={i}>{w}</li> : null; })}
                    {!colour.linksComplete && !check.notRun.some((n) => n.check === "links") && <li>{t("Links were checked against an older phishing list.")}</li>}
                  </ul>
                </>
              )}
              {check.review && (
                <>
                  <h3>{t("The review")}</h3>
                  {check.review.ran
                    ? check.review.codes.length
                      ? <ul className="fi-okolos-lines">{check.review.codes.map((c) => <li key={c}>{reviewWords(c, t)}</li>)}</ul>
                      : <p>{t("The review named nothing.")}</p>
                    : <p>{reviewNotRunWords(check.review.why, t)}</p>}
                  {check.review.quotes.map((q, i) => <blockquote key={i}>{q}</blockquote>)}
                </>
              )}
              {(colour.colour === "amber" || colour.colour === "red") && (
                <>
                  <h3>{t("First steps")}</h3>
                  <ul className="fi-okolos-lines">
                    <li>{t("Don't open its links: they ask before they open.")}</li>
                    {check.scope === "received" && !record?.findings.domains && onLookUpDomains && <li>{t("Look up who registered the sender's domains (the button above).")}</li>}
                  </ul>
                  <p className="fi-okolos-actions">
                    {onReportSpam && <button type="button" className="fi-secondary" onClick={onReportSpam}>{t("Report spam")}</button>}
                    {onDiscard && <button type="button" className="fi-secondary" onClick={onDiscard}>{t("Discard")}</button>}
                  </p>
                </>
              )}
              <p className="fi-okolos-when">
                {t("Checked {time}", { time: t.dateTime(new Date(check.checkedAt), { dateStyle: "medium", timeStyle: "short" }) })}
              </p>
            </>
          )}
          <p className="fi-okolos-about">{t("Okolos is PassionCode's browser security. In your mail it checks senders, links and files on your own server.")}</p>
          <p className="fi-okolos-note">{t("No antivirus engine runs on this server; files are checked by what they are, not against virus signatures.")}</p>
          <p className="fi-okolos-note">{t("Okolos never draws inside the message text: a badge there is part of the message, not a check.")}</p>
        </section>
  );
}

/** A-17: a line that fired carries a warning mark, a clean one a check; the words already say which. */
function Fired() {
  return <WarningIcon size={13} weight="bold" aria-hidden="true" className="fi-okolos-mark" />;
}

/**
 * S03c (B-288): the sender's domains, looked up on request: who registered each From and Reply-To domain and when,
 * whether it takes mail, what its site's main page does. Before a lookup, what it does and its button; after, one
 * block per domain, fired lines first with the warning mark.
 */
function SenderDomains({ record, received, onLookUp, busy, error }: { record: SafetyPanelProps["record"]; received: boolean;
  onLookUp?: (refresh: boolean) => void; busy?: boolean; error?: string }) {
  const t = useT();
  const lookup = record?.findings.domains;
  if (!received || (!lookup && !onLookUp)) return null;
  return (
    <div className="fi-okolos-domains">
      <h3>{t("The sender's domains")}</h3>
      {!lookup && <p>{t("Looks up who registered the sender's domains, whether they take mail and what their site does. The site is visited from your server, at its main page only.")}</p>}
      {lookup?.domains.map((d) => (
        <div key={d.domain} className="fi-okolos-domain">
          <h4>{domainHeading(d, t)}</h4>
          <ul className="fi-okolos-lines">
            {domainLines(d, t).map((l, i) => l.fired
              ? <li key={i} className="is-fired"><Fired />{l.text}</li>
              : <li key={i}>{l.text}</li>)}
          </ul>
        </div>
      ))}
      {!!lookup?.notRun.length && (
        <ul className="fi-okolos-lines">
          {lookup.notRun.map((n, i) => { const w = domainNotRunWords(n, t); return w ? <li key={i}>{w}</li> : null; })}
        </ul>
      )}
      {error && <p role="alert">{error}</p>}
      {lookup && <p className="fi-okolos-when">{t("Looked up {time}", { time: t.dateTime(new Date(lookup.at), { dateStyle: "medium", timeStyle: "short" }) })}</p>}
      {onLookUp && (
        <p className="fi-okolos-actions">
          <button type="button" className="fi-secondary" disabled={busy} onClick={() => onLookUp(!!lookup)}>
            {busy ? t("Looking up…") : lookup ? t("Look up again") : t("Look up the domains")}
          </button>
        </p>
      )}
    </div>
  );
}
