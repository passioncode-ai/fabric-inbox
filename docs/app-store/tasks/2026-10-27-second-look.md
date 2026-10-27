# B-153: a second look at messages an agent was not sure of (task packet)

Status: decided 2026-10-27, built in 0.75.0 (the second look) and 0.77.0 (answering again when a gap is closed). Board row: B-153 in [the board](../../evidence/backlog.md).

## Why

Board thread `e68f363c` (2026-10-24, the operator's directive to every agent that answers people): cheap
models first, a strong look only when they fail, to tell a real gap in the knowledge from a search or
drafting failure; for every turn left unanswered, a background second look that searches wider, drafts
again through the same checks, names the cause (`retrieval`, `draft-or-check`, `data`, `person`), sends a
checked answer, and reports the gap with that cause. 0.74.0 (B-162) put the turn's own reading on the
events feed as `support.diagnosed`; this packet adds the second look.

## What is there (0.74.0, `563ad5e`)

- A message the agent was not sure of is held (`holdUnsure`, `workers/agents/runner.ts` `hold`), its
  question reported as a gap when the knowledge lacks it, and answered again every 12 hours for a week,
  then daily for a month (`AgentRegistryDO.retryHeld`, `HELD_RETRY_MS`).
- The writer is `xiaomi/mimo-v2.6-pro`, the strongest model on the operator's list
  (`synthesis/llm-models.md`), with reasoning off (B-174: reasoning made a third of the calls time out),
  and a checker of another vendor approves every answer before it leaves.
- `support.diagnosed` names the turn's cause once per run and cause (`workers/agents/learning-events.ts`).

## Decisions (agent, 2026-10-27; by the operator's directive and the safest reversible option)

1. **Which messages:** a run that ends `held` on an address whose agent sends on its own and holds what it
   is not sure of (`mode: auto`, `holdUnsure`). Not a hand-off (a person acts), not the safe reply (the
   person already has a reply), not a failure (retried as before), not a message the safety check held.
2. **When:** once per message, 30 minutes after it was held (`SECOND_LOOK_AFTER_MS`), inside the first
   week; at most 20 a day per server (`SECOND_LOOKS_PER_DAY`), oldest first. The 12-hour retries go on
   after it as before.
3. **The stronger look is the same writer thinking:** the operator's list has no model above the writer,
   so the second look asks it with reasoning `medium` (the first turn has it off for speed), and a checker
   of another vendor still approves the answer. Wider: the agent's collections are searched with twice as
   many passages, and every prefetched knowledge tool is also asked about the topic alone (the words the
   first turn named the message by), as the other channel's bot does since its 2.8.2.
4. **Cause and rescue:** a second look that sends is `rescued`. Its cause is `retrieval` when it cites a
   knowledge item the first turn did not, else `draft-or-check`. One that holds again is `data` when the
   question is still unanswered by the knowledge, else `draft-or-check`; a hand-off is `person`; a failed
   knowledge lookup names no cause. The run keeps it as `secondLook` {at, state, cause, rescued, cited
   first}, and `support.diagnosed` carries it once with `look: "second"`.
5. **Off switch:** `replyPolicy.secondLook` (default on). Settings → Agents shows it under the hold option
   as "Take a second look before waiting"; `update_agent` carries it.
6. **Nothing new leaves without the checks:** the second look runs through `runAgent` like any attempt:
   the prefilter (a person who answered meanwhile ends it), the safety scans, the policy, the checker, the
   daily send limit and the same idempotency key, so the message is never answered twice.

## Requirements

| REQ | What | Verified by |
|---|---|---|
| REQ-1 | A held message on an eligible agent gets one second look 30 minutes later, never a second one | `tests/agents-registry.test.ts` B-153 |
| REQ-2 | The second look writes with reasoning `medium`, searches wider and skips the unchanged-knowledge shortcut | `tests/agents-runner.test.ts` B-153 |
| REQ-3 | Sent: `rescued`, cause `retrieval` with a new cited item, else `draft-or-check`; held again: `data` or `draft-or-check` | `tests/learning-events.test.ts`, `tests/agents-runner.test.ts` B-153 |
| REQ-4 | `support.diagnosed` once with `look: "second"`; the schema names the field | `tests/learning-events.test.ts` B-153 |
| REQ-5 | Off when `secondLook: false`, for draft agents, without `holdUnsure`, past the daily cap | `tests/agents-registry.test.ts` B-153 |

## Answering again when a gap is closed (0.77.0)

7. **The signal:** a gap grant may name its endpoint's list of reports (`gaps.list`, for example the
   knowledge agent's `kb.gaps.list`, which carries each report's `requestId` and its state from the
   owner's gap ledger). Our request id is the run id and a hash of the kind (`gapRequestId`), so a closed
   report maps back to its held run (`runOfRequest`, `workers/agents/gap-closures.ts`).
8. **When:** every 15 minutes while a held run has a reported gap, the list is asked for its
   `ledgerRevision` (one call); only when it moved are the reports read (at most 10 pages of 200). A held
   run whose report is `closed` or `answered` is answered again at once (`answerAgain`, the knowledge
   comparison dropped), once per run (`gapClosed` {at, item, revision}). A list that refuses (the key may not
   read it, the endpoint fails) is left alone for 6 hours, logged as `agent_gaps_unavailable`.
9. **The key:** the knowledge agent lists only the reports of a consumer allowed to read its own
   (`gaps-reader`, scope `own`); until it allows ours, the list refuses and the held retry on a revision
   change (B-141) goes on as before.

| REQ | What | Verified by |
|---|---|---|
| REQ-6 | A held run whose gap is closed or answered is answered again once; one still open is not; another consumer's report moves nothing | `tests/agents-registry.test.ts` B-153 |
| REQ-7 | The list is read again only on a new ledger revision, at most every 15 minutes; a refusing list waits 6 hours | `tests/agents-registry.test.ts` B-153 |
| REQ-8 | A report's run is its request id without the kind's hash, as the runner builds it | `tests/gap-closures.test.ts` B-153 |
