# S06. The agent's draft right under the message it answers (B-271; B-224 in part)

**Asked:** «вот есть у меня письмо, мне пришло ... там у меня есть agents draft, и чтобы его открыть ... мне надо его
сразу же увидеть ... сначала первое письмо, под ним уже сразу драфт, уже сразу же вся мета информация для драфта,
откуда информация получена ... в драфте сразу есть отправить ... он уже editable, либо открыть консоль ... чтобы
затюнить агента, ... открываем ... агента ... этот сбоку, и там ... сразу же есть контекст уже этого письма, и сразу
же ... видно, что мы хотим предложить, что мы хотим сделать с этим письмом».

## Today

- A reply agent saves an ordinary draft with id `<run id>-draft` (`workers/agents/runner.ts:1190-1195`); the run keeps
  the metadata: agent and version, status, reason, intent, grounded, sources, tools, model, checker
  (`workers/agents/run.ts:28-110`).
- The person sees an `AgentRunPanel` card at the top of the open message (`app/components/inbox/AgentRunPanel.tsx:45-80`,
  `unified-inbox.tsx:942`) with "Open the agent's draft", which opens the composer; in the thread the draft is a cell
  with a "Draft" chip (`ConversationList.tsx:106`). The draft's text is not visible until it is opened.
- The agent panel takes the open message only as `{emailId, subject}` and two suggested prompts
  (`app/components/AgentPanel.tsx:356-369`); there is no "tune this agent" entry from a message.

## Target

### The draft card

In the thread, directly under the message the draft answers (the draft's `in_reply_to`), a card replaces the "Draft"
cell:

- **Header:** "Draft by <agent name> v<version>" («Черновик агента <name> v<version>»), and why it is a draft and not
  sent, in one line from the run's reason ("Waits for you: the agent's policy sends nothing by itself", "Waits for
  you: the answer was not grounded in the knowledge", "Daily limit reached").
- **Where the facts came from:** the run's sources as links ("Answered from: <title>", opening the knowledge entry or
  the message it cites), the tools it called, the model and the checker, folded under "Details" when more than three.
- **The text, editable in place:** the draft's body in an editor with the same send states as the composer
  (`app/components/inbox/send-state.ts`); edits are saved as the draft's next revision (the B-52 revision guard).
  Recipients and subject in one line above it, editable through "Edit recipients" which opens the full composer on the
  same draft.
- **Actions:** "Send" (`sendSavedDraft`, the same path as the composer, so the server deletes the draft once accepted,
  `workers/durableObject/index.ts:1043-1053`); "Discard draft"; "Tune the agent" («Настроить агента»).
- A draft that is already being sent, or whose send is uncertain, shows that state instead of Send (the composer's
  states).

### Tune the agent

"Tune the agent" opens the agent panel on the right (AgentDock) with a context block at its top:

- the message (sender, subject, a link to it), the draft's text, the run's reason, sources and agent version;
- a first prompt prepared, not sent: "This draft from <agent> v<version> answers <sender>'s message. What should it
  have said instead?" («Этот черновик агента ... Что он должен был ответить?»); the person edits or sends it;
- a link "Open <agent> settings" to Settings → Agents → that agent, where a save is a new version (R28).

The panel's agent receives the message id, the run id and the draft id as data (the existing `focus` grows from
`{emailId, subject}` to `{emailId, subject, runId?, draftId?}`); it reads them with its existing read tools. What it
proposes for the agent is shown as a proposal; changing the agent stays a save in Settings (a new version), never a
silent edit.

### Sent by the agent

When the agent's policy sent the reply (Q5), the reply is a sent cell in the thread with "Sent by <agent> v<version>"
and the same sources line, folded.

## Data and API

- The thread route returns the agent's draft rows with their `agent_run` (it already joins `agent_run` to rows,
  `workers/index.ts:400-420`); the card needs the run's sources, reason and policy reason, added to that join.
- MCP: `read_thread` returns the run beside the draft (agents read the same card); no new write route (send and save are
  existing tools).

## Words

All through copywriting and the copy check; the reasons come from the run's catalogue keys, not free text.

## Acceptance

- Unit: the card renders under the message named by `in_reply_to`; a draft with no matching message renders at the end
  of the thread with "Answers a message not in this thread".
- Unit: edit then Send uses the saved revision; a newer revision saved elsewhere keeps the draft (the B-52 path).
- Unit: "Tune the agent" passes `{emailId, runId, draftId}` and the prepared prompt is not sent until the person sends.
- WebKit walk: a received message with an agent draft; edit, send, the card turns into a sent cell.
- SCN-013 and a new SCN row "Check and send the agent's draft in the thread".

## Out of scope

Changing a reply agent's prompt or mode (R28: a save in Settings makes a new version); B-224's other chips
(Summarize, Translate) stay in B-224.
