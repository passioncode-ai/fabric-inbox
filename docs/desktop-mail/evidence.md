# Baseline state — 2026-09-26

Scope: a limited reconnaissance of the baseline for a new desktop product, not a full security/project audit.

All source references below point to the existing commit `93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c`.

| Fact | Receipt |
|---|---|
| The web app uses React Router SSR | [react-router.config.ts L8](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/react-router.config.ts#L8), [package.json L15](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/package.json#L15) |
| The mail APIs work by mailboxId; reply and forward are already routed | [workers/index.ts L145](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/workers/index.ts#L145), [L271](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/workers/index.ts#L271) |
| Receiving through the email handler, storing the message, starting the auto-draft | [workers/app.ts L119](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/workers/app.ts#L119), [workers/index.ts L395](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/workers/index.ts#L395) |
| One shared Cloudflare Access trust boundary; everyone who passes it sees all mailboxes | [workers/app.ts L45](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/workers/app.ts#L45), [L78](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/workers/app.ts#L78) |
| The built-in agent has draft/organize tools and a 5-step limit; send is absent from its map | [workers/agent/index.ts L113](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/workers/agent/index.ts#L113), [L288](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/workers/agent/index.ts#L288) |
| MCP is an inbound server and separately provides send_email; confirmation is described in text, and the handler accepts no verifiable approval | [workers/mcp/index.ts L59](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/workers/mcp/index.ts#L59), [L356](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/workers/mcp/index.ts#L356) |
| The send API saves Sent before the transport; it returns 202 status sent; a transport error is only logged | [workers/index.ts L187](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/workers/index.ts#L187), [L204](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/workers/index.ts#L204) |
| Inbound messages are assigned a randomUUID; this section does not check for a repeated delivery before createEmail | [workers/index.ts L366](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/workers/index.ts#L366) |
| HTML goes through DOMPurify and a sandbox; external https images are allowed by the current CSP | [app/components/EmailIframe.tsx L63](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/app/components/EmailIframe.tsx#L63), [L94](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/app/components/EmailIframe.tsx#L94) |
| The examined baseline has no provider account/cursor model and no desktop application | Full `git ls-files` (72 tracked files), [workers/db/schema.ts L13](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/workers/db/schema.ts#L13), [package.json](https://github.com/passioncode-ai/fabric-inbox/blob/93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c/package.json) |

## Deployment receipt

Cloudflare API read-only, 2026-09-26:

- `GET /accounts/{account}/workers/scripts`: match `agentic-inbox`, handlers `fetch`, `email`, modified_on `2026-08-16T23:07:58.371086Z`.
- `GET /accounts/{account}/workers/subdomain`: `<account-subdomain>`.
- `GET /accounts/{account}/workers/scripts/agentic-inbox/subdomain`: `enabled: true`, `previews_enabled: true`.
- `GET /accounts/{account}/workers/scripts/agentic-inbox/deployments`: current deployment `2b730ad6-0a23-4d07-81e3-04bcdd82e6d2`, created `2026-08-16T23:08:00.762669Z`, version `29a63a94-43c3-4d9a-911b-7c8f49facad3`, traffic `100`, source `dash`.
- Browser navigation to `https://agentic-inbox.<account-subdomain>.workers.dev`: observed the `Sign in · Cloudflare Access` screen, title `Log in to agentic-inbox - Cloudflare Workers`, fields Email and Send login code. The form was not submitted.

This confirms that the Worker exists and the sign-in boundary, but not working mail delivery and not that the deployed version matches the original Git SHA. Login query parameters, cookies, tokens and mailbox contents are not kept in the receipt.

## Checks

In a checkout at the original commit, before the product was changed:

| Command | Result | Boundary |
|---|---|---|
| `git rev-list --count HEAD..origin/main` | `0` after clone | The original branch was not behind at the time of reading |
| `npm ci --ignore-scripts --no-audit --no-fund` | exit 0, 514 packages installed | Not a security audit; lifecycle scripts disabled |
| `npm run typecheck` | exit 0 | Wrangler types + React Router typegen + TypeScript |
| `npm run build` | exit 0 | Client and SSR bundles; not a deployment |
| `git ls-files` and package scripts | 72 files; no test command declared | No claim of a passed behavioral suite |

Build/typecheck report a Node module.register deprecation; build reports the experimental Vite Environment API. These commands returned no fatal errors.

Not checked: the real authenticated UI, receiving/sending, bounce, repeated delivery, OAuth, IMAP/SMTP, background rules, external tools, the desktop artifact. This intake did not fix the source code. The absence of hosted CI is not green CI; the full hosted suite was not run.
