import { useState } from "react";
import { ShieldCheckIcon, ShieldWarningIcon, ShieldSlashIcon, ShieldIcon } from "@phosphor-icons/react";
import { useT } from "~/lib/i18n";
import { CHECKS, type CheckName, type FileEntry, type SafetyColour, type SafetyLikeRecord } from "../../../shared/mail/safety";
import { badgeWords, fileWords, notRunWords, reviewNotRunWords, reviewWords, showsOkLine, signalWords } from "./safety-words";

/**
 * S03 (B-269, B-222): the Okolos badge at the right of the subject line, and its panel. The badge is a button with
 * `aria-expanded`; its colour is never the only signal (an icon and a word each). The panel opens under the header
 * and says what was checked, each file, what did not run and why, the review's codes and quotes, first steps for
 * amber and red, and one line about Okolos. Nothing here is drawn inside the message text.
 */
export interface SafetyBadgeProps {
  colour: SafetyColour;
  record: (SafetyLikeRecord & { checkedAt?: number }) | null;
  /** The record could not be read, or the open-time check failed. */
  failed?: boolean;
  checking?: boolean;
  onReportSpam?: () => void;
  onDiscard?: () => void;
  onSaveAnyway?: (file: FileEntry) => void;
}

const ICONS = { green: ShieldCheckIcon, grey: ShieldIcon, amber: ShieldWarningIcon, red: ShieldSlashIcon } as const;
const CHECK_NAMES: CheckName[] = [...CHECKS];

export default function SafetyBadge({ colour, record, failed, checking, onReportSpam, onDiscard, onSaveAnyway }: SafetyBadgeProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const Icon = ICONS[colour.colour];
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
  const label = badgeWords(colour.label, t);
  const released = colour.released === "person" ? t("Released by you") : colour.released === "review" ? t("Released by the review") : "";
  return (
    <div className={`fi-okolos is-${colour.colour}`}>
      <button type="button" className="fi-okolos-badge" aria-expanded={open} aria-controls="fi-okolos-panel" onClick={() => setOpen((v) => !v)}
        title={t("What Okolos checked in this message")}>
        <Icon size={15} weight="bold" aria-hidden="true" />
        <span>{checking ? t("Checking…") : label}</span>
        {released && <span className="fi-okolos-released">{released}</span>}
      </button>
      {open && (
        <section id="fi-okolos-panel" className="fi-okolos-panel" aria-label={t("Safety check")}>
          {failed && <p role="alert">{t("The safety check could not load. Links ask before they open.")}</p>}
          {!check && !failed && <p>{t("This message has no safety record yet, so its links ask before they open.")}</p>}
          {check && (
            <>
              <h3>{t("What was checked")}</h3>
              <ul className="fi-okolos-lines">
                {CHECK_NAMES.filter((name) => !skipped(name).some((s) => s.why === "inboxNotReceived")).map((name) => {
                  const signals = fired(name).map((s) => signalWords(s, t)).filter(Boolean);
                  if (name === "attachments") return signals.length ? signals.map((w, i) => <li key={`${name}-${i}`} className="is-fired">{w}</li>) : null;
                  if (signals.length) return signals.map((w, i) => <li key={`${name}-${i}`} className="is-fired">{w}</li>);
                  if (!showsOkLine(name, check, colour.linksComplete)) return null;
                  return <li key={name}>{okLine(name)}</li>;
                })}
              </ul>
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
      )}
    </div>
  );
}
