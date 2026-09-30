# Knowledge for agents — 2026-09-29

Request (paraphrased): check how creating handler agents works and how to
give them a knowledge base they can search, ideally the single PassionCode/Fabric knowledge base.

## What the check found (live, owner's server, 2026-09-29)

- No agent existed; all 36 addresses were Off. A throwaway agent with inline knowledge, a new
  address and a real message from one of the owner's addresses produced the first live model run:
  `drafted`, `grounded: true`, intent `question`, a correct answer from the knowledge only
  ("free during the preview … weekdays, 10:00–18:00 CET"). Agent, address and rule removed after.
- "Knowledge" was one plain-text field (≤ 50,000 characters) pasted into every prompt: no search,
  no sources, no sharing between agents, no sync from anywhere.
- The single knowledge base the operator means is **Fabric's project memory**
  ([ADR-0069](https://github.com/passioncode-ai/fabric/blob/main/docs/adr/0069-project-memory-is-source-addressed-and-authority-bounded.md),
  source-addressed, authority-bounded; search is its package MEM-P2). On 2026-09-29 it is a plan:
  no MEM package is delivered, so there is nothing to connect to yet.

## Decisions (operator, 2026-09-29)

| Question | Answer |
|---|---|
| Source of the single knowledge base | **Fabric memory** — wait for it; do not adopt the projects wiki as the source |
| Where agents search | **On the Fabric Inbox server** (lexical full-text first, as ADR-0069 R0 does) |
| What a customer-facing agent may read | **Only the collections granted to it** |

So this change builds the search and the grant boundary now, with collections filled by hand, and
a document shape that Fabric memory's search results can land in unchanged (source URI + revision
+ title + text), so connecting MEM-P2 later is a sync, not a redesign.

## Requirements (frozen; adding is free)

| REQ | Requirement | Verified by |
|---|---|---|
| KN-1 | Knowledge collections on the server: documents chunked and searched with SQLite FTS5 (bm25, snippets), RU and EN; idempotent upsert by source URI and revision; bounded sizes | `tests/knowledge.test.ts` in workerd |
| KN-2 | API: collections CRUD, documents add/list/delete, a batch sync that can prune, search; errors say what to do | route tests |
| KN-3 | An agent names the collections it may read; unknown ones are refused; a collection in use cannot be deleted | registry and route tests |
| KN-4 | A run retrieves from the agent's collections only, gives the passages with their source to the model, offers `search_knowledge` for follow-ups within the same collections, and records the sources in the run; a failed search never lets an answer be sent | runner tests |
| KN-5 | Screens: Knowledge (collections, documents, paste or upload `.md`/`.txt`, try a search); the agent editor grants collections | browser check in the installed app |
| KN-6 | The Fabric seam: a collection's source is `manual` or `fabric` (project + scope); the batch sync is the endpoint a Fabric sync will call; recorded as the next step for MEM-P2 | docs, board row |
| KN-7 | Docs, scenarios, deploy, and one live run of an agent answering from a collection | live run record |

## Done (0.4.0)

| REQ | Result | Evidence |
|---|---|---|
| KN-1 | `KnowledgeDO`: collections, documents by source URI + revision, chunks at paragraphs/headings, FTS5 (porter + unicode61) with bm25 and snippets; quoted-term queries | `tests/knowledge.test.ts` (7; the scoping and draft-on-failure tests seen failing with the check removed) |
| KN-2 | `/api/knowledge/*`: collections CRUD, documents add/list/read/delete, batch with `prune`, search | same |
| KN-3 | `collections` on an agent (≤ 10), only existing ones; a used collection cannot be deleted; `search_knowledge` and `submit_answer` reserved | same |
| KN-4 | Passages from the agent's collections only, `search_knowledge` (repeats refused), `run.sources`, draft when search fails | `tests/knowledge.test.ts`, `tests/agents-runner.test.ts` |
| KN-5 | Knowledge screen (SCR-12), editor grants, agent card and run card show collections and passages | installed app, CDP screenshots 2026-09-29 |
| KN-6 | Source `manual` / `fabric` (read-only on screen); batch + prune is the sync endpoint | docs; board B-20 |
| KN-7 | Docs, SCN-034/035, SCR-12; live run | below |

**Live, 2026-09-29, owner's server.** A throwaway collection (4 documents, EN + RU) and an
"internal" one; an agent granted only the first; a Russian message asking the price, where mail
lives, and the margin. First run: the model searched twice with the same words and never submitted
— recorded as *skipped: no answer*. Fixed: the last step offers `submit_answer` alone, one extra
turn can only submit, repeated searches are refused, and no answer at all is **failed**, left for
the operator (`tests/agents-model.test.ts`, a scripted model). Second run: *drafted*, grounded,
intent `pricing`, answered in Russian from `faq/pricing.md` and `faq/data.md`; the margin was
passed on ("Вопрос о марже я передам команде" — "I will pass the question about the margin to
the team") because only the ungranted collection held it.
Everything test-made was removed.

## Release 0.4.0 (2026-09-29)

| Image | Receipt | sha256 (first 16) |
|---|---|---|
| `Fabric-Inbox-0.4.0.dmg` (public; 0 owner identifiers in `app.asar`; server bundle carries `KnowledgeDO` and `fabric-v3`) | notarized, stapled, Gatekeeper accepted | `f1a016e52712d54a` |
| `Fabric-Inbox-0.4.0-owner.dmg` (installed in /Applications) | notarized, stapled, Gatekeeper accepted | `ea8cf5fab8052bbc` |

Server 0.4.0 deployed (version `d715be89`), migration tag `fabric-v3`.

**Correction (2026-09-29, 0.5.0):** "0 owner identifiers" above was measured against the
nine hand-picked identifiers in `deployments/owner/deployment.json`. The 0.4.0 public image
did carry one owner domain: the Knowledge screen's placeholder named it ("Public answers for
<owner domain> customers"). The scan (`tests/no-owner-data.test.ts`) now also takes every domain and address in
`deployments/owner/setup.json`, and failed on that line before it was replaced in 0.5.0. The
0.4.0 public image was never published; it stays a local file only. Full hashes are in the
receipts beside the images in `release/`.
