# Run brief 2026-10-11: reply agents call a shared knowledge base (B-85, items 1–3)

The operator asked on 2026-10-11 for the Nicegram support agent to be connected to the shared Nicegram
knowledge base, with one solution across the agents. The base is the `nicegram` domain of the
operator's Research Agent (KB1 = (a); ssheleg/research-agent BL-099,
`docs/integrations/knowledge-bases.md`, which already names Fabric Inbox as a cloud consumer). Its
cloud read node (M9) does not exist yet. This run makes Inbox's side ready, independent of M9.

## Source ledger

| Source | Read | What it gave |
|---|---|---|
| Code | `workers/agents/{definition,model,runner,policy,registry,tool-schema}.ts`, `workers/automation/mcp.ts` | Tools reach the model as `{arguments: record}` (`model.ts`). The schema is read at save time and thrown away (`registry.ts` `validate`). Collections are searched before the model (`runner.ts`), granted tools are not. A failed tool call keeps the answer a draft (`policy.ts`). |
| Live server | `list_agents`, `list_knowledge`, `list_agent_runs` (MCP, 2026-10-11) | `nicegram-support` v2: `tools: []`; collections `nicegram-help` (Wiki @0c2a727, 20 docs) and `nicegram-product` (19 docs); 3 runs, 1 sent |
| Retro | `docs/evidence/retro.md`, standing instructions 1–10 | Instruction 8: a changed route needs its tool, `npm run mcp:docs` and the skill to agree. Instruction 7: the gate is the exit code. Recent log 2026-09-29: test the model adapter with a model that misbehaves |
| Scenarios | `docs/ux/scenarios.md` SCN-022, SCN-024 | SCN-022 still reads "Tool schemas are not read from the server yet" (stale: they are read at save time) |
| Peers | nicegramappbot-35, mobile-publisher-agent-61, nicegram-business-7b | One source (Research Agent domain), no copy per consumer. Support replies cite class `public` only. Business is a separate product |
| Graph, wiki | none built for this repository | — |
| Board | `docs/evidence/backlog.md` | B-85 filed (PR #73) |

## Decisions (resolved at stage 0 with the recommended answer; the operator may overrule)

- **D1, the schema.** On save, the registry stores each grant's `inputSchema` as read from the
  endpoint, as JSON text (an object-typed field is not RPC-serializable and broke the registry's
  types at stage 6). Whatever the editor sent in that field is replaced. At run time the model is offered that
  schema, minus the fixed arguments. A grant saved before this change, or a schema that is not a JSON
  object schema or is over 8 KB, falls back to today's `{arguments}` wrapper.
- **D2, fixed arguments.** `fixed` (string, number or boolean values, at most 10) is merged into
  every call and overrides the model. This is how the operator pins `domain: "nicegram"` and
  `allow_web: false`. A key the schema does not list is refused at save.
- **D3, the call before the model.** `prefetch: { argument }` calls the tool once before the model.
  It passes the message's subject and opening (600 characters) as that argument, plus the fixed
  arguments. The output goes into the system prompt beside the collections' passages and is recorded
  as a tool call. The argument must be a string property of the schema; that is checked at save.
- **D4, public only.** With `publicOnly: true`, an output is used only if it parses as JSON and every
  value in it sits inside an object whose `class` is the string `public`: a `class` covers everything
  inside its object, an inner `class` overrides an outer one, and a value under no `class` (a
  top-level `answer` beside public `results`, a sibling item without one) is not public. A `class`
  that is not exactly the string `public` (`"PUBLIC"`, an object) counts as not public, and so does
  nesting deeper than 20 levels. Otherwise the whole output is withheld from the model and the call
  counts as failed, so the answer stays a draft (`policy.ts`; `publicOnlyProblem` in
  `workers/agents/definition.ts`, `tests/agents-tool-grant-rules.test.ts`; aligned 2026-10-12, FI-3:
  this paragraph first said "at least one object carrying `class`", which the code never did). There is no partial filtering: a synthesized answer next to a confidential source
  could carry it. The Research Agent's consumer token is expected to scope `public` on its side; this
  is the second line.
- **D5, the surface.** The agent editor gets three fields per tool: fixed arguments (JSON), "call
  before answering with the message as" (an argument name), and "only public passages". SCN-022 and
  SCN-024 are updated, every string is translated (ru), and the MCP tool `save_agent`, its reference
  and the skill agree.

## REQ table

| REQ | Requirement | Verified by |
|---|---|---|
| REQ-1 | The model is offered a granted tool's real input schema, without the fixed keys; old grants fall back | `tests/agents-model.test.ts` |
| REQ-2 | The registry stores the endpoint's schema on save and ignores a client-sent one; a fixed key or prefetch argument the schema lacks is refused | `tests/agents-registry.test.ts` |
| REQ-3 | Fixed arguments are merged into every call and the model cannot override them | `tests/agents-runner.test.ts` |
| REQ-4 | A prefetch grant is called before the model with the message; its output reaches the system prompt and the run's tool calls; a failed prefetch keeps the answer a draft | `tests/agents-runner.test.ts` |
| REQ-5 | `publicOnly`: an output whose every value sits under `class: "public"` is used; a non-public, unclassified or non-JSON output is withheld and the answer is a draft | `tests/agents-runner.test.ts`, `tests/agents-tool-grant-rules.test.ts` |
| REQ-6 | The editor shows and saves the three fields; strings are in the dictionary (ru) | `tests/agents-ui` (source-reading) + `scripts/check-locale.mjs` |
| REQ-7 | Scenarios SCN-022 and SCN-024 say what the code does; MCP reference and skill agree | `python3 docs/ux/lint.py`, `npm run mcp:docs`, `tests/mcp-*.test.ts` |

## Carry-over

| Item | Home |
|---|---|
| Connecting `nicegram-support` to the Research Agent (needs M9, the consumer token, the filled domain) | B-85 |
| An unanswered support question as a signal for the knowledge base (B-85 item 4) | B-85 |

## Close-out

| REQ | Evidence |
|---|---|
| REQ-1 | `tests/agents-model.test.ts` "B-85 REQ-1" and "arguments that do not fit" (planted: validator removed → fails) |
| REQ-2 | `tests/agents-registry.test.ts` "B-85 REQ-2"; `tests/agents-tool-grant-rules.test.ts` |
| REQ-3 | `tests/agents-runner.test.ts` "B-85 REQ-3" |
| REQ-4 | `tests/agents-runner.test.ts` "B-85 REQ-4" ×2 |
| REQ-5 | `tests/agents-runner.test.ts` "B-85 REQ-5" ×4; `tests/agents-tool-grant-rules.test.ts` (unlabelled sibling, top-level field, numbers, depth) |
| REQ-6 | `tests/agents-tool-grants-ui.test.ts` (planted: publicOnly not saved → fails); `scripts/check-locale.mjs` all in Russian |
| REQ-7 | `docs/ux/lint.py`, `doctor.py` exit 0; `npm run mcp:docs` exit 0; live `save_agent` schema lists `fixed`, `prefetch`, `publicOnly` |

Merged as `2a4d89c` (PR #74); the owner's server runs it (Worker `a3e133d9`). Not observed: the editor fields in a running app, and a real knowledge tool (none exists until the Research Agent's cloud node). Open: B-85 (connection, item 4).

## Dataroom receipts (FI-1…FI-5, 2026-10-12)

The Nicegram dataroom tracks this work as FI-1…FI-5; each closes here with its receipt.

| Item | State | Receipt |
|---|---|---|
| FI-1 (canary C-09) and GAPS-1 | waits for a person | one external mail to support@nicegram.me; then the draft id and the first gap's `requestId` (the run id) are recorded here, with the data agent's log line (`event: tool, consumer: fabric-inbox`) |
| FI-3 (D4 vs `publicOnlyProblem`) | done | D4 above now states the code's rule: every value under `class: "public"`, inherited, an inner class overriding; a class that is not exactly the string (`"PUBLIC"`, an object) is not public. The code did not change; `tests/agents-tool-grant-rules.test.ts` "publicOnly (FI-3)" pins the top-level class, no class, a class object, the exact value, an inner override and non-JSON |
| FI-4 (live hosts and token) | done | measured on Worker `435c6e49` (0.16.2, `e50fd8f`) through the Cloudflare settings API: `AUTOMATION_MCP_HOSTS` = `sshlg-fabric-877b6ee889db.herokuapp.com,nicegram-data-agent-52cc996f302f.herokuapp.com`, `AUTOMATION_TOOL_TOKENS` a secret binding (name only read). The handshake (initialize, tools/list) was seen by the data agent at 09:57:59Z from Worker `9335b210`; the call path since (`workers/automation/mcp.ts`, `workers/agents/tool-schema.ts`) is unchanged (`git diff 2971aa2 e50fd8f` on them is empty), only the runner's abstain handling changed (#90) |
| FI-5 (hand-loaded collections) | wallet lines done; deletion waits for FI-1 | the decided fact `wallet-retired`: six `nicegram-product` documents (01, 02, 04, 15, 16, 17) no longer present the wallet as a feature. Feature mentions were removed, the table rows were dropped, and 01 and 16 now say it is retired. Anti-scam advice keeps seed phrases without naming the wallet. `put_knowledge_documents` → `updated: 6`; a re-read of all 18 finds no wallet claim (06 warns about connecting a wallet on a phishing site, 12 says Wallet-to-Earn was removed). `nicegram-help` and `nicegram-product` are deleted after C-09 (`delete_knowledge_collection`, two steps) |
