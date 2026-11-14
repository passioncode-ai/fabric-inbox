import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useT } from "~/lib/i18n";
import { headerFacts, SHOWN_RECIPIENTS, type Recipient } from "./message-header";
import { senderName, type OpenMessage } from "./model";

/**
 * S02 (B-268): who wrote the open message and to whom. From with its address always shown (a name alone is how
 * impersonation works), To with our address marked "you" and the provider beside it, Cc, the Bcc of mail we sent,
 * Reply-To when it differs from From, and the full date. Received mail that does not name our address says so,
 * unless it came from a list or to a catch-all; a Gmail, IMAP or Outlook message's List-Id is read from its headers
 * only in that case.
 */
export default function MessageHeader({ message, own, provider, catchAll, headersPath, fetchJson }: {
  message: OpenMessage;
  /** The account's own address. */
  own?: string;
  /** "Cloudflare", "Gmail", "IMAP"… shown beside our address. */
  provider: string;
  catchAll?: boolean;
  /** A remote message's headers route; absent for Cloudflare rows, whose List-Id is already known. */
  headersPath?: string;
  fetchJson: (url: string) => Promise<unknown>;
}) {
  const t = useT();
  const base = headerFacts({ ...message, own, catchAll });
  const needList = base.notAddressed && message.listId === undefined && !!headersPath;
  const listRead = useQuery({
    queryKey: ["message-headers", headersPath],
    enabled: needList,
    staleTime: Infinity,
    queryFn: async () => {
      const answer = (await fetchJson(headersPath!)) as { headers?: { key: string; value: string }[] };
      return answer.headers?.find((h) => h.key.toLowerCase() === "list-id")?.value ?? null;
    },
  });
  // Until the List-Id is known, nothing is claimed about how the message reached us.
  const listId = message.listId !== undefined ? message.listId : listRead.isSuccess ? listRead.data : headersPath ? "unknown" : null;
  const facts = headerFacts({ ...message, own, catchAll, listId });
  const date = new Date(message.date);
  const validDate = !Number.isNaN(date.valueOf());
  return (
    <div className="fi-sender fi-message-people">
      <span className="fi-avatar" aria-hidden="true">{senderName(message.from).charAt(0).toUpperCase()}</span>
      <dl className="fi-people">
        <div>
          <dt>{t("From")}</dt>
          <dd><Address text={message.from} /></dd>
        </div>
        <Line label={t("To")} list={facts.to} provider={provider} />
        {facts.cc.length > 0 && <Line label={t("Cc")} list={facts.cc} provider={provider} />}
        {facts.bcc.length > 0 && <Line label={t("Bcc")} list={facts.bcc} provider={provider} />}
        {facts.replyTo && (
          <div>
            <dt>{t("Reply to")}</dt>
            <dd><Address text={facts.replyTo} /></dd>
          </div>
        )}
        {facts.notAddressed && <p className="fi-people-note">{t("Your address is not in To or Cc")}</p>}
      </dl>
      {validDate && (
        <time dateTime={message.date} title={t.dateTime(date)}>
          {t.dateTime(date, { dateStyle: "medium", timeStyle: "short" })}
        </time>
      )}
    </div>
  );
}

function Line({ label, list, provider }: { label: string; list: Recipient[]; provider: string }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, SHOWN_RECIPIENTS);
  const more = list.length - shown.length;
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {shown.map((r, i) => (
          <span key={`${r.text}-${i}`} className="fi-recipient">
            <Address text={r.text} />
            {r.you && <span className="fi-you">{t("you")} · {provider}</span>}
            {i < shown.length - 1 || more > 0 ? ", " : ""}
          </span>
        ))}
        {more > 0 && (
          <button type="button" className="fi-more-people" aria-expanded={false} onClick={() => setAll(true)}>
            {t("and {n} more", { n: more })}
          </button>
        )}
      </dd>
    </div>
  );
}

/** An address as written; a click copies its bare address. */
function Address({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const bare = text.match(/<([^<>]+)>/)?.[1] ?? text;
  return (
    <button type="button" className="fi-address" title={t("Copy {address}", { address: bare })}
      onClick={() => {
        void navigator.clipboard?.writeText(bare).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }, () => {});
      }}>
      {text}
      {copied && <span role="status" className="fi-copied">{t("Copied")}</span>}
    </button>
  );
}
