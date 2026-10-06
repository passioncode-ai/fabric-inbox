import { z } from "zod";

/**
 * Categories and projects (CAT-1, CAT-2). Pure definitions: schemas, scope and
 * condition matching. Shared by the store, the routes and the tests; no storage,
 * no network.
 *
 * A category is one of two kinds, decided by its definition:
 * - **scope** — no conditions and no description: every message in its scope, read live;
 * - **screened** — conditions and/or a description: each message in scope gets a
 *   verdict (conditions first, then the model for a description), stored with its reason.
 */
const Id = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const Domain = z.string().trim().toLowerCase().regex(/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Not a domain name");
const Address = z.string().trim().toLowerCase().email().max(254);
const Word = z.string().trim().min(1).max(60);
/** An email address, a domain, or @domain; matched against the sender. */
const SenderPattern = z.string().trim().toLowerCase().min(3).max(254)
  .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^@?[a-z0-9.-]+\.[a-z]{2,63}$/.test(v), "An address, a domain or @domain");
const unique = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z.array(item).max(max).default([]).transform((xs: z.infer<T>[]) => [...new Set(xs)]);

export const ProjectInputSchema = z.object({
  name: z.string().trim().min(1, "A project needs a name").max(80),
  domains: unique(Domain, 50),
  addresses: unique(Address, 100),
}).strict().refine((p) => p.domains.length + p.addresses.length > 0, "Add at least one domain or address");
export type ProjectInput = z.infer<typeof ProjectInputSchema>;
export interface Project extends ProjectInput { id: string; createdAt: string; updatedAt: string }

export const ScopeSchema = z.object({
  /** Every inbox, present and future. */
  all: z.boolean().default(false),
  /** Account ids as the feed uses them: `cloudflare:<address>`, `gmail:<id>`, `imap:<id>`. */
  accounts: unique(z.string().min(3).max(300), 200),
  domains: unique(Domain, 50),
  projects: unique(Id, 20),
}).strict();
export type Scope = z.infer<typeof ScopeSchema>;

export const ConditionsSchema = z.object({
  senders: unique(SenderPattern, 50),
  subjectWords: unique(Word, 20),
  textWords: unique(Word, 20),
}).strict();
export type Conditions = z.infer<typeof ConditionsSchema>;

export const CategoryInputSchema = z.object({
  name: z.string().trim().min(1, "A category needs a name").max(60),
  /** What belongs here, in words; the model reads each message in scope against it. */
  description: z.string().trim().max(1000).default(""),
  scope: ScopeSchema,
  conditions: ConditionsSchema.default({}),
  /** Its messages also rise to Important in Focus, with the category as the reason. */
  promote: z.boolean().default(false),
  enabled: z.boolean().default(true),
}).strict().refine((c) => c.scope.all || c.scope.accounts.length + c.scope.domains.length + c.scope.projects.length > 0,
  "Choose where to look: all inboxes, or projects, domains or addresses");
export type CategoryInput = z.infer<typeof CategoryInputSchema>;
export type CategoryKind = "scope" | "screened";
export interface Category extends CategoryInput {
  id: string;
  kind: CategoryKind;
  /** Increases on every change of what the category selects; verdicts of older versions are discarded. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function kindOf(input: Pick<CategoryInput, "description" | "conditions">): CategoryKind {
  const c = input.conditions;
  return input.description.trim() || c.senders.length || c.subjectWords.length || c.textWords.length ? "screened" : "scope";
}

/** Whether a change alters what the category selects (and so needs a fresh classification). */
export function selectionChanged(a: CategoryInput, b: CategoryInput): boolean {
  const pick = (c: CategoryInput) => JSON.stringify([c.description.trim(), c.scope, c.conditions]);
  return pick(a) !== pick(b);
}

export interface AccountRef { id: string; email: string }
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();
const underDomain = (domain: string, list: string[]) => list.some((d) => domain === d || domain.endsWith("." + d));

/** Whether an account (the inbox a message arrived in) is inside a category's scope. */
export function inScope(scope: Scope, account: AccountRef, projects: Project[]): boolean {
  if (scope.all) return true;
  if (scope.accounts.includes(account.id)) return true;
  const email = account.email.toLowerCase();
  const domain = domainOf(email);
  if (underDomain(domain, scope.domains)) return true;
  return projects.some((p) => scope.projects.includes(p.id) && (p.addresses.includes(email) || underDomain(domain, p.domains)));
}

export interface ClassifiedMessage { sender: string; subject: string; text: string }
const senderAddress = (sender: string) => (sender.match(/<([^<>]+)>/)?.[1] ?? sender).trim().toLowerCase();

/**
 * The plain conditions: each non-empty group must match (senders AND subject words AND
 * text words), any entry inside a group is enough. Words match case-insensitively
 * anywhere; text words also look in the subject.
 */
export function matchesConditions(c: Conditions, m: ClassifiedMessage): { ok: boolean; reason: string } {
  const reasons: string[] = [];
  if (c.senders.length) {
    const from = senderAddress(m.sender);
    const fromDomain = domainOf(from);
    const hit = c.senders.find((p) => (p.includes("@") && !p.startsWith("@") ? from === p : underDomain(fromDomain, [p.replace(/^@/, "")])));
    if (!hit) return { ok: false, reason: "" };
    reasons.push(`from ${hit}`);
  }
  const subject = m.subject.toLowerCase();
  if (c.subjectWords.length) {
    const hit = c.subjectWords.find((w) => subject.includes(w.toLowerCase()));
    if (!hit) return { ok: false, reason: "" };
    reasons.push(`subject has “${hit}”`);
  }
  if (c.textWords.length) {
    const text = (m.subject + "\n" + m.text).toLowerCase();
    const hit = c.textWords.find((w) => text.includes(w.toLowerCase()));
    if (!hit) return { ok: false, reason: "" };
    reasons.push(`mentions “${hit}”`);
  }
  return { ok: true, reason: reasons.join(", ") };
}

export function categoryId(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "category";
}
