/**
 * The last-resort record of an incoming message the server could not take (SCN-025, B12-03).
 *
 * When neither rejecting nor storing worked, this line in the Worker's log is all that is left of
 * the message, so it names whom the mail was for and when it came: the envelope recipient, the
 * time, the size and the failure. It never carries the sender, the subject, the body or any header
 * — the same rule as the unknown-recipients record — and the failure text is cut short.
 */
export interface IncomingFailure {
	event: "incoming_failed";
	/** The SMTP envelope recipient, lower-cased; null for a synthetic event without one. */
	to: string | null;
	/** When the failure was logged, ISO 8601 UTC. */
	at: string;
	/** The message's declared size in bytes. */
	size: number | null;
	error: string;
	/** The top of the stack: code locations only, never message content. */
	stack?: string;
}

const ERROR_LIMIT = 300;
const STACK_LIMIT = 800;

export function incomingFailure(
	message: { to?: string; rawSize?: number },
	error: unknown,
	now: Date = new Date(),
): IncomingFailure {
	const to = message.to?.trim().toLowerCase() || null;
	const size = typeof message.rawSize === "number" && Number.isFinite(message.rawSize) ? message.rawSize : null;
	const text = error instanceof Error ? error.message : String(error ?? "unknown error");
	const stack = error instanceof Error && error.stack ? error.stack.slice(0, STACK_LIMIT) : undefined;
	return {
		event: "incoming_failed",
		to,
		at: now.toISOString(),
		size,
		error: (text || "unknown error").slice(0, ERROR_LIMIT),
		...(stack ? { stack } : {}),
	};
}
