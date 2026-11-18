/** @jsxRuntime automatic @jsxImportSource react */
// B-293 (U4, SCN-105; docs/ux/plans/2026-11-18-ui-fixes/README.md): what I reach on this server and who gave it to me.
// The operator, 2026-11-18: «где шаренные аккаунты, которые поделятся мне, как вот это происходит делегация».
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { fabric } from "../../services/fabric";
import { useT } from "../../lib/i18n";
import { msg, type T } from "../../../shared/i18n";
import { settingsPath } from "./paths";
import { LoadFailure, SkeletonRows } from "./ui";

type Level = "read" | "send" | "agents";
type Role = "admin" | "member" | "architect" | "none";
interface PersonGrant { id: string; mailboxes: string[]; can: string[]; expiresAt: string | null; grantedBy: string; grantedAt: string; why: string }
/** `GET /api/my-access` as a signed-in person reads it (workers/routes/access-requests.ts). */
export interface MyAccess { person: { email: string; role: Role; mailboxes: { id: string; level: Level }[] | null }; grants: PersonGrant[] }
export const MY_ACCESS_KEY = ["my-access"];
/** A grant's capabilities by the names Agent access gives them (GrantsPanel). */
const CAPABILITY: Record<string, string> = {
  read: msg("Read"), draft: msg("[capability] Draft"), send: msg("[capability] Send"), organize: msg("Organize"), delete: msg("[capability] Delete"),
  create: msg("[capability] Create addresses"), remove: msg("Remove addresses"), agents: msg("Reply agents"), campaign: msg("[capability] Campaigns"),
};
const capabilityText = (id: string, t: T) => (CAPABILITY[id] ? t.text(CAPABILITY[id]) : id);

/** A mailbox id as a person reads it: a Cloudflare address without its prefix, a provider account as it is. */
export const mailboxName = (id: string) => id.replace(/^cloudflare:/, "");
export function levelText(level: Level, t: T): string {
  return level === "read" ? t("Read only") : level === "agents" ? t("Read, send and choose its agent") : t("Read and send");
}
export function roleText(role: Role, t: T): string {
  return role === "admin" ? t("Administrator") : role === "architect" ? t("Architect") : role === "member" ? t("Member") : t("Not on this server's list");
}
/** A member's answer to their own access; null in a browser or on a server before B-293 (the route answers 400 there). */
export function readMyAccess(value: unknown): MyAccess | null {
  const v = value as Partial<MyAccess> | null;
  if (!v || !v.person || typeof v.person.email !== "string" || typeof v.person.role !== "string") return null;
  return { person: { email: v.person.email, role: v.person.role, mailboxes: Array.isArray(v.person.mailboxes) ? v.person.mailboxes : null }, grants: Array.isArray(v.grants) ? v.grants : [] };
}

/** Who I am on this server, what I reach and who gave it to me, and how sharing works here. */
export function YourAccess() {
  const t = useT();
  const q = useQuery({ queryKey: MY_ACCESS_KEY, queryFn: async () => readMyAccess(await fabric<unknown>("/api/my-access")) });
  if (q.isPending) return <SkeletonRows rows={3} label={t("Loading your access…")} />;
  if (q.isError) return <LoadFailure what={t("your access")} error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const me = q.data;
  if (!me) return <p className="fi-hint">{t("This server does not say yet what you reach. Ask its administrator.")}</p>;
  const { person, grants } = me;
  return (
    <div className="fi-your-access">
      <p>{t("You are {email} here: {role}.", { email: person.email, role: roleText(person.role, t) })}</p>
      {person.role === "admin" && <p>{t("You reach every mailbox of this server.")} <Link to={settingsPath("people")}>{t("Share mailboxes with people")}</Link></p>}
      {person.role === "architect" && <p>{t("You reach every mailbox: you read and sort mail and set up addresses and agents; you never send.")}</p>}
      {person.mailboxes && (
        <>
          <h3>{t("Shared with you")}</h3>
          {person.mailboxes.length ? (
            <ul className="fi-your-access-list">
              {person.mailboxes.map((m) => <li key={m.id}><strong>{mailboxName(m.id)}</strong> <span className="fi-hint">{levelText(m.level, t)}</span></li>)}
            </ul>
          ) : <p className="fi-hint">{t("No mailbox is shared with you yet.")}</p>}
        </>
      )}
      {grants.length > 0 && (
        <>
          <h3>{t("Given to you by name")}</h3>
          <ul className="fi-your-access-list">
            {grants.map((g) => (
              <li key={g.id}>
                <strong>{t.list(g.mailboxes.map((m) => (m === "*" ? t("every mailbox") : mailboxName(m))))}</strong>{" "}
                <span className="fi-hint">{t("{can}; by {who} on {when}", { can: t.list(g.can.map((c) => capabilityText(c, t))), who: g.grantedBy, when: new Date(g.grantedAt).toLocaleDateString() })}
                  {g.expiresAt ? " · " + t("until {date}", { date: new Date(g.expiresAt).toLocaleDateString() }) : ""}</span>
                {g.why && <div className="fi-hint">{g.why}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>{t("How sharing works")}</h3>
      <p className="fi-hint">{t("An administrator of a server shares its mailboxes with you in Settings → People: your address, the mailboxes and a level for each. Add that server to your Fabric Inbox app (Account → Add Another Server) and sign in with that address: the mailboxes appear under Shared with you. For another mailbox, ask that server's administrator.")}</p>
    </div>
  );
}
