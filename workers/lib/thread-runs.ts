import type { AgentRun } from "../agents/run";

/**
 * A reply agent's run as the thread shows it (B-138; S06, B-271): what the draft card and the sent cell read (who wrote
 * it, why it waits, where its facts came from, and how the conversation ended), never the run's tool results or texts.
 */
export function threadRunView(run: AgentRun) {
	return {
		id: run.id, status: run.status, ...(run.agentId ? { agentId: run.agentId } : {}), ...(run.agentVersion ? { agentVersion: run.agentVersion } : {}),
		...(run.draftId ? { draftId: run.draftId } : {}), ...(run.personDraftId ? { personDraftId: run.personDraftId } : {}),
		...(run.reason ? { reason: run.reason } : {}), ...(run.limited ? { limited: true } : {}), ...(run.grounded !== undefined ? { grounded: run.grounded } : {}),
		...(run.sources?.length ? { sources: run.sources.map((x) => ({ ref: x.ref, title: x.title })) } : {}),
		...(run.sentMessageId ? { sentMessageId: run.sentMessageId } : {}), ...(run.outcome ? { outcome: run.outcome } : {}),
		...(run.draftText !== undefined ? { draftKept: run.draftTextComplete === true } : {}),
	};
}
