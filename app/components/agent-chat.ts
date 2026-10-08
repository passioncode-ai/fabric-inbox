/**
 * What the AI panel (SCN-013, FLW-04) reads out of a chat: the tool a part called, the draft an
 * answer saved, the messages it read (its sources), the prompt a failed turn can send again, and
 * which Cloudflare address the panel speaks for on the unified inbox. Pure, so the rules are tested
 * without a model or a socket (tests/agent-panel.test.ts).
 */
import type { UIMessage } from "ai";
import type { InboxAccount, InboxMessage } from "./inbox/model";

type Part = UIMessage["parts"][number];
type ToolPart = Part & { toolName?: string; state?: string; input?: unknown; output?: unknown; result?: unknown; args?: unknown };

/** The tool a part called: `tool-<name>` parts (AI SDK 5+) and dynamic tools; null for text and the rest. */
export function toolNameOf(part: Part): string | null {
	if (part.type === "dynamic-tool") return (part as ToolPart).toolName ?? null;
	if (part.type.startsWith("tool-")) return part.type.slice("tool-".length);
	return null;
}

const record = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
/** A tool's result: `output` (AI SDK 5+), `result` in chats saved by older versions. */
const outputOf = (part: ToolPart) => part.output ?? part.result;
const inputOf = (part: ToolPart) => record(part.input ?? part.args);
const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** A draft an answer saved on the server, which "Edit & send in composer" opens. */
export interface SavedDraft {
	draftId: string;
	to: string;
	subject: string;
	/** The draft's text as the agent wrote it (the server copy also carries the quoted original). */
	body: string;
	/** The message it answers, for a reply. */
	originalEmailId?: string;
}

/** The last draft the message's draft_reply or draft_email saved; null when none was saved (or it was refused). */
export function draftOf(message: UIMessage): SavedDraft | null {
	let found: SavedDraft | null = null;
	for (const part of message.parts) {
		const name = toolNameOf(part);
		if (name !== "draft_reply" && name !== "draft_email") continue;
		const out = record(outputOf(part as ToolPart));
		const draftId = text(out?.draftId);
		if (!out || !draftId || out.error) continue;
		const draft = record(out.draft) ?? {};
		const input = inputOf(part as ToolPart) ?? {};
		const originalEmailId = text(draft.originalEmailId) ?? text(input.originalEmailId);
		found = {
			draftId,
			to: text(draft.to) ?? text(input.to) ?? "",
			subject: text(draft.subject) ?? text(input.subject) ?? "",
			body: text(draft.body) ?? text(input.body) ?? "",
			...(originalEmailId ? { originalEmailId } : {}),
		};
	}
	return found;
}

/** Whether the message used a draft tool at all (the action is offered while it runs, disabled). */
export function usesDraftTool(message: UIMessage): boolean {
	return message.parts.some((part) => {
		const name = toolNameOf(part);
		return name === "draft_reply" || name === "draft_email";
	});
}

/** A message the answer read, to open in the reader. */
export interface Source {
	emailId: string;
	subject: string;
	sender: string;
	date?: string;
	threadId?: string;
	read?: boolean;
}

/** Shown under one answer at most; the rest are counted. */
export const MAX_SOURCES = 5;

function sourceOf(value: unknown): Source | null {
	const row = record(value);
	const emailId = text(row?.id);
	if (!row || !emailId) return null;
	return {
		emailId,
		subject: text(row.subject) ?? "",
		sender: text(row.sender) ?? text(row.from) ?? "",
		...(text(row.date) ? { date: text(row.date) } : {}),
		...(text(row.thread_id) ?? text(row.threadId) ? { threadId: text(row.thread_id) ?? text(row.threadId) } : {}),
		...(row.read === undefined || row.read === null ? {} : { read: !!row.read }),
	};
}

/** The rows of a list-shaped result: an array, or an object holding one (`messages`, `emails`, `results`). */
function rowsOf(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	const obj = record(value);
	for (const key of ["messages", "emails", "results"]) if (Array.isArray(obj?.[key])) return obj![key] as unknown[];
	return [];
}

/**
 * The messages an answer read through its tools, in the order it read them, each once: what
 * get_email and get_thread returned, the rows list_emails and search_emails found, and the message
 * a draft_reply answers. A tool that failed or is still running names nothing.
 */
export function sourcesOf(message: UIMessage): Source[] {
	const seen = new Map<string, Source>();
	const add = (source: Source | null) => {
		if (source && !seen.has(source.emailId)) seen.set(source.emailId, source);
	};
	for (const part of message.parts) {
		const name = toolNameOf(part);
		if (!name) continue;
		const tool = part as ToolPart;
		if (tool.state && tool.state !== "output-available" && tool.state !== "result") continue;
		const out = outputOf(tool);
		if (record(out)?.error) continue;
		if (name === "get_email") add(sourceOf(out));
		else if (name === "get_thread" || name === "list_emails" || name === "search_emails") rowsOf(out).forEach((row) => add(sourceOf(row)));
		else if (name === "draft_reply") {
			const original = text(inputOf(tool)?.originalEmailId);
			if (original) add({ emailId: original, subject: "", sender: "" });
		}
	}
	return [...seen.values()];
}

/** The words of the person's last prompt, which Retry sends again; null when there is none to send. */
export function lastPrompt(messages: UIMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "user") continue;
		const words = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("").trim();
		return words || null;
	}
	return null;
}

/**
 * Retry after a failed turn: clears the error and regenerates, which drops the unfinished answer
 * and sends the last prompt again as it was. Does nothing while an answer streams or when there
 * is no prompt to send; a refusal of the retry itself lands in the chat's error state again.
 * Answers whether it sent.
 */
export function retryTurn(chat: {
	streaming: boolean;
	messages: UIMessage[];
	clearError: () => void;
	regenerate: () => Promise<void>;
}): boolean {
	if (chat.streaming || lastPrompt(chat.messages) === null) return false;
	chat.clearError();
	void chat.regenerate().catch(() => {});
	return true;
}

/** A turn that failed: the chat's own error state (a model or connection failure mid-answer). */
export const turnFailed = (status: string, error: unknown) => status === "error" || (!!error && status !== "streaming" && status !== "submitted");

/** A Cloudflare address's mailbox, which is the chat agent's name (workers/agent/index.ts). */
export const mailboxOf = (account: Pick<InboxAccount, "id">) => account.id.slice(account.id.indexOf(":") + 1);

/**
 * The address the AI panel reads (it reads Cloudflare mailboxes only): the open message's when it is
 * on one; else the one the person chose in the panel; else the address the inbox is filtered to;
 * else the first in view, then the first at all. Null when there is no Cloudflare address.
 */
export function agentAccount(options: {
	accounts: InboxAccount[];
	inScope: InboxAccount[];
	openAccountId?: string | null;
	chosenAccountId?: string | null;
	filterAccountId?: string | null;
}): { account: InboxAccount; by: "message" | "choice" | "scope" } | null {
	const cloudflare = options.accounts.filter((a) => a.provider === "cloudflare");
	const find = (id?: string | null) => (id ? cloudflare.find((a) => a.id === id) : undefined);
	const open = find(options.openAccountId);
	if (open) return { account: open, by: "message" };
	const chosen = find(options.chosenAccountId);
	if (chosen) return { account: chosen, by: "choice" };
	const fallback = find(options.filterAccountId) ?? options.inScope.find((a) => a.provider === "cloudflare") ?? cloudflare[0];
	return fallback ? { account: fallback, by: "scope" } : null;
}

/**
 * The reader's message for a source on a Cloudflare address: the row already listed when there is
 * one, else the same identity the server gives that row (workers/lib/inbox-query.ts), so it reads
 * as selected if the list shows it later.
 */
export function sourceMessage(accountId: string, source: Source, listed: InboxMessage[]): InboxMessage {
	const known = listed.find((m) => m.accountId === accountId && m.providerMessageId === source.emailId);
	if (known) return known;
	return {
		id: JSON.stringify([accountId, source.emailId]),
		accountId,
		provider: "cloudflare",
		providerMessageId: source.emailId,
		subject: source.subject,
		sender: source.sender,
		recipient: "",
		date: source.date ?? "",
		read: source.read ?? true,
		starred: false,
		snippet: "",
		...(source.threadId ? { threadId: source.threadId } : {}),
	};
}
