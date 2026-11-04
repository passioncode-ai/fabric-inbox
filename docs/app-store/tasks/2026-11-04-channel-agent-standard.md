# B-199: the channel-agent standard in Fabric Inbox

**State:** step 1 in 0.85.0, steps 2 and 3 in 0.86.0; step 4 planned. **Source:** board thread `30c45b9c` (the operator's words relayed
2026-11-04: agents finish the work, an improvement loop, no question left unanswered, fresh sources; then «давай делай
и не тормозите»), request `553bdd5f`; the standard's neutral copy (v1, a release candidate) is the channel side's
`docs/template/copies/channel-agent-standard.neutral.md`. Row: [B-199](../../evidence/backlog.md).

Fabric Inbox is the runtime of the mail agents, so it gives every agent what the standard measures; each agent keeps
its own policy, knowledge and texts.

## What Inbox had before

| Standard | Inbox | Where |
|---|---|---|
| a gap reported to the fact's owner, the held message answered once the fact arrives (6) | yes | B-141, B-153: `reportGap`, `answerClosedGaps` (`workers/agents/runner.ts`, `workers/agents/registry.ts`) |
| a judge of another vendor over the day's answers (5.2) | yes, up to 30 a day | B-132, `workers/agents/judge.ts` |
| a replay of real messages through another writer (5, on request) | by hand | B-174, `preview_agent_answer` with `model` |
| a holding reply, a final reply at the final limit | yes: 24 hours, 30 days | B-131, B-141 |
| one sender per message across addresses (6.5) | yes | B-22, `workers/agents/dedupe.ts` |
| the outcome of every ticket (3), the four numbers (5.1) | no | step 1 |
| each source's age and limit (7.1) | no: documents keep `updatedAt` only | step 2 |
| a weekly list of open gaps with age, an alarm past 7 days (6) | no: gaps live on runs only | step 3 |
| invented eval tickets from every wrong answer, run after each change (5.3) | no | step 4 |

## Steps

1. **Outcomes and the four numbers (0.85.0).** `workers/agents/ticket-outcome.ts` reads each run as one of the
   standard's outcomes: `answered`, `answered_after_question` (answered after a held turn, `gapClosed` or a later
   attempt), `closed_by_person` (a draft a person answered), `answered_elsewhere` (prefilter `already_answered`: the
   operator replied first), `referred` (the policy's hand-off reply, which tells the customer where to write and
   brings no signal back), `expired` (the safe reply, or the closing reply at 30 days), `unanswered` (a refused send,
   a draft or a person's hand-off past 30 days, a closing that could not go out), `no_reply_owed`; open `received`,
   `handed_open` (passed to a person before the model, or held back by the safety check), `question_open`,
   `awaiting_approval`; `not_a_ticket` for mail no one wrote to be answered. `GET /api/agent-outcomes` and the tool
   `get_agent_outcomes` count a period per address with the four numbers as shares of the ended ones; every run in
   `list_agent_runs` carries its `ticketOutcome`. `customer_silent`, `awaiting_customer`, `expired_by_decision` and
   promotions are named in `notMeasured`. Tests: `tests/ticket-outcome.test.ts`, `B-199` in
   `tests/agents-registry.test.ts`.
2. **Source age (0.86.0, collections).** A collection declares `maxAgeHours` (`save_knowledge_collection`);
   `list_knowledge` shows its `syncedAt` (the last batch, unchanged documents included: their source was read),
   `ageHours` and `stale`, and each document's `checkedAt`; the registry's hourly look writes one `knowledge.stale`
   event per collection and episode (a new batch ends it; schema `docs/agents/knowledge-event.schema.json`). Tests:
   `B-199` in `tests/knowledge.test.ts` and `tests/knowledge-events.test.ts`. Left for a later step: a knowledge
   endpoint's own age (the data agent's revision; Inbox records only the newest revision it saw, `agent_facts`), and
   the age on the Settings screen.
3. **Open questions (0.86.0).** `GET /api/agent-questions` and `list_open_questions` list the questions still open
   (no answer in the knowledge and the gap not closed, or held), oldest first, with age, gap kinds and `reportedTo`
   (the hosts the gap went to); the hourly look writes one `agent.question_overdue` per question open 7 days. Tests:
   `B-199` in `tests/agents-registry.test.ts`, `tests/ticket-outcome.test.ts`.
4. **Eval tickets (by 2026-11-10).** Every run judged unhelpful, unanswered, expired or handed off with knowledge that
   could answer becomes an invented eval ticket (no customer words), kept per agent; they run through
   `preview_agent_answer` after every agent change, and a failure notifies once per episode.

## What in the standard's copy does not fit mail as it stands

- `support-quality-daily/1` (5.1) is named but not published in section 13; Inbox's `support.quality_daily` is the
  shared v2 schema, closed (`additionalProperties: false`), so the new fields wait for the schema. Until then the
  same counts are read with `get_agent_outcomes`.
- `referred` is most of the mail hand-offs today (32 of 59 messages on the owner's server over 2026-10-09 to 11-03):
  the hand-off reply names another address. When that address is on Inbox too, its reply in the thread is the
  answered signal (7.5) Inbox can read; that is a recommendation to each agent's owner, not a runtime default.
- `awaiting_customer` and `customer_silent`: mail agents do not ask the customer a question today.
- `firstReplyLate` (3, rule 6) with the mail limit of 24 hours: the day already carries `firstReplyP50Ms` and
  `firstReplyP90Ms`; the count follows with the schema.
