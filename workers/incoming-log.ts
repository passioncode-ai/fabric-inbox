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

/** Where the owner sees them (B-40): newest first, the last KEEP kept, without the stack. */
export const FAILURE_PREFIX = "incoming-failures/";
export const KEEP = 50;
export type StoredFailure = Omit<IncomingFailure, "event" | "stack"> & { id: string };

/**
 * Keeps the failure where the owner sees it — Settings → Domains and the agent protocol — so a
 * message nothing could take is not found only by searching the Worker's logs (2026-09-28: a lost
 * message was found that way three days later). Never throws: the delivery's own error is what
 * Email Routing must see.
 */
export async function recordIncomingFailure(bucket: R2Bucket, failure: IncomingFailure): Promise<void> {
	try {
		// Keys sort by time: an inverted timestamp puts the newest first in a listing.
		const id = `${(9_999_999_999_999 - Date.parse(failure.at)).toString().padStart(13, "0")}-${crypto.randomUUID().slice(0, 8)}`;
		const stored: StoredFailure = { id, to: failure.to, at: failure.at, size: failure.size, error: failure.error };
		await bucket.put(FAILURE_PREFIX + id + ".json", JSON.stringify(stored));
		const page = await bucket.list({ prefix: FAILURE_PREFIX, limit: KEEP + 20 });
		const stale = page.objects.slice(KEEP).map((o) => o.key);
		if (stale.length) await bucket.delete(stale);
	} catch (error) {
		console.error(JSON.stringify({ event: "incoming_failure_unrecorded", error: (error as Error).message?.slice(0, 200) }));
	}
}

/** The kept failures, newest first. */
export async function listIncomingFailures(bucket: R2Bucket): Promise<StoredFailure[]> {
	const page = await bucket.list({ prefix: FAILURE_PREFIX, limit: KEEP });
	const values = await Promise.all(page.objects.map(async (o) => (await bucket.get(o.key))?.json<StoredFailure>().catch(() => null)));
	return values.filter((v): v is StoredFailure => !!v?.id);
}

/** The owner has seen them: every kept failure, or those of one domain, is removed. */
export async function clearIncomingFailures(bucket: R2Bucket, domain?: string): Promise<number> {
	const all = await listIncomingFailures(bucket);
	const gone = all.filter((f) => !domain || (f.to ?? "").endsWith("@" + domain.toLowerCase()));
	if (gone.length) await bucket.delete(gone.map((f) => FAILURE_PREFIX + f.id + ".json"));
	return gone.length;
}
