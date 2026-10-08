import { z } from "zod";
import { textSnippet } from "../lib/inbox-query";
const address = z
  .string()
  .email()
  .max(254)
  .refine((v) => !/[\r\n]/.test(v));
export const RuleSchema = z
  .object({
    id: z.string().min(1).max(100),
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(false),
    mode: z.enum(["approval", "automatic"]).default("approval"),
    conditions: z
      .object({
        from: address.optional(),
        subject: z.string().max(200).optional(),
        ai: z.string().max(1000).optional(),
      })
      .strict(),
    action: z.discriminatedUnion("type", [
      z.object({ type: z.literal("forward"), to: address }).strict(),
      z.object({ type: z.literal("archive") }).strict(),
      z.object({ type: z.literal("mark_read") }).strict(),
      z.object({ type: z.literal("draft") }).strict(),
      z
        .object({
          type: z.literal("mcp"),
          endpoint: z.string().url().max(1000),
          tool: z.string().min(1).max(100),
          arguments: z
            .record(z.unknown())
            .refine(
              (v) =>
                new TextEncoder().encode(JSON.stringify(v)).length <= 16000,
              "Arguments exceed 16 KB",
            )
            .default({}),
          tokenRef: z
            .string()
            .regex(/^[A-Z_][A-Z0-9_]*$/)
            .optional(),
          location: z.enum(["cloud", "device"]).default("cloud"),
        })
        .strict(),
    ]),
    dailyLimit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
export type Rule = z.infer<typeof RuleSchema>;
export type RuleEmail = {
  id: string;
  sender: string;
  subject: string;
  body: string;
  date: string;
  thread_id?: string | null;
  rfcMessageId?: string;
  references?: string;
  hasAttachments?: boolean;
};
export function matchesRule(rule: Rule, email: RuleEmail): boolean {
  return (
    rule.enabled &&
    (!rule.conditions.from ||
      rule.conditions.from.toLowerCase() ===
        (email.sender.match(/<([^<>]+)>/)?.[1] ?? email.sender)
          .trim()
          .toLowerCase()) &&
    (!rule.conditions.subject ||
      email.subject
        .toLowerCase()
        .includes(rule.conditions.subject.toLowerCase()))
  );
}
export function actionFor(rule: Rule): Rule["action"] {
  return structuredClone(rule.action);
}
export function runKey(
  account: string,
  message: string,
  rule: string,
  version: number,
): string {
  return JSON.stringify([account, message, rule, version]);
}
export function validateToolUrl(endpoint: string, allowedHosts: string): URL {
  const url = new URL(endpoint);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.includes(":") ||
    /^\d+(\.\d+)*$/.test(host)
  )
    throw new Error("Tool endpoint must use an approved public HTTPS host");
  if (
    !allowedHosts
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
      .includes(host)
  )
    throw new Error("Tool host is not enabled by the workspace administrator");
  return url;
}
export const AnalysisSchema = z
  .object({
    matches: z.boolean(),
    summary: z.string().max(2000),
    draft: z.string().max(12000),
  })
  .strict();
export type Analysis = z.infer<typeof AnalysisSchema>;
export type RunStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "waiting_device"
  | "succeeded"
  | "skipped"
  | "failed"
  | "unknown"
  | "cancelled";
export type Run = {
  id: string;
  key: string;
  account: string;
  emailId: string;
  subject: string;
  rule: Rule;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  /** How many times the engine began processing this run; 0 while it waits in the queue. */
  attempts?: number;
  /** When a person last checked an uncertain run's outcome (SCN-020); absent if never checked. */
  checkedAt?: string;
  analysis?: Analysis;
  detail?: string;
  approved?: boolean;
  proposal?: { action: Rule["action"]; emailDigest: string };
};
/** Only configured string values are interpolated. Email cannot change argument keys, endpoint or tool. */
export function toolArguments(
  value: Record<string, unknown>,
  email: RuleEmail,
): Record<string, unknown> {
  const fields: Record<string, string> = {
    "email.id": email.id,
    "email.sender": email.sender,
    "email.subject": email.subject,
    "email.body": email.body.slice(0, 16000),
    // The first 300 characters as plain text: what a signal carries instead of the whole message.
    "email.preview": textSnippet(email.body),
  };
  function visit(item: unknown, depth: number): unknown {
    if (depth > 12) throw new Error("Arguments are too deeply nested");
    if (typeof item === "string")
      return item.replace(
        /\{\{(email\.(?:id|sender|subject|body|preview))\}\}/g,
        (_, key) => fields[key],
      );
    if (Array.isArray(item)) return item.map((v) => visit(v, depth + 1));
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, v]) => [key, visit(v, depth + 1)]),
      );
    return item;
  }
  const result = visit(value, 0) as Record<string, unknown>;
  if (new TextEncoder().encode(JSON.stringify(result)).length > 32000)
    throw new Error("Resolved tool arguments exceed 32 KB");
  return result;
}

export async function emailDigest(email: RuleEmail): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(email)),
  );
  return Array.from(new Uint8Array(bytes), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
