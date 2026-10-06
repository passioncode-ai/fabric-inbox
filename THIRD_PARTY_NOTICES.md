# Third-party notices

Fabric Inbox's own code is licensed as the [README](README.md#license) says:
`AGPL-3.0-only OR LicenseRef-PassionCode-Commercial`. The material below came from other projects
and stays under its own licence. The [LICENSE](LICENSE) file does not change the licence of any of
it.

## Cloudflare Agentic Inbox (Apache-2.0)

- **Upstream:** [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) at commit
  `48039bb6785a` (2026-04-17), a Cloudflare template.
- **How it arrived:** commit `93b86c6` ("source repo import", author `cloudflare[bot]`,
  2026-08-12), made by Cloudflare's deploy button. Its 72 files are the upstream tree at
  `48039bb6785a` byte for byte, except `wrangler.jsonc`, which the deploy button fills in. Checked
  2026-09-30 by comparing blob hashes of `git ls-tree -r 93b86c6` with the upstream tree through
  the GitHub API.
- **Licence:** Apache License 2.0, copyright (c) 2026 Cloudflare, Inc. The full text as upstream
  ships it is [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt) (it was this repository's
  `LICENSE` in every release up to 0.7.1). Upstream ships no `NOTICE` file, so there is none to carry.
- **Where it is:** the files imported in `93b86c6` that are still here (70 of 72;
  `workers/mcp/index.ts` and `app/routes/home.tsx` were removed): `app/components/{AgentPanel,AgentSidebar,ComposeEmail,ComposePanel,EmailAttachmentList,EmailIframe,EmailPanel,Header,MCPPanel,MailboxSplitView,RichTextEditor,Sidebar}.tsx`,
  `app/components/email-panel/{EmailPanelDialogs,EmailPanelHeader,EmailPanelToolbar,SingleMessageView,ThreadMessage}.tsx`, `app/entry.server.tsx`, `app/root.tsx`,
  `app/routes.ts`, `app/routes/{email-list,mailbox-index,mailbox,not-found,search-results,settings}.tsx`,
  `app/hooks/{useComposeForm,useUIStore}.ts`, `app/lib/{search-parser,utils}.ts`,
  `app/queries/{emails,folders,keys,mailboxes,search}.ts`, `app/services/api.ts`,
  `app/types/index.ts`, `app/index.css`, `shared/{dates,folders}.ts`,
  `workers/{app,index,email-sender,types}.ts`, `workers/agent/index.ts`, `workers/db/schema.ts`,
  `workers/durableObject/{index,migrations}.ts`, `workers/lib/{ai,attachments,email-helpers,mailbox,schemas,tools}.ts`,
  `workers/routes/reply-forward.ts`, `public/favicon.{ico,svg}`, `demo_app.png` (the template's screenshot, removed 2026-10-05), and the
  configuration files `package.json`, `package-lock.json`, `vite.config.ts`,
  `react-router.config.ts`, `tsconfig*.json`, `wrangler.jsonc`, `.gitignore`,
  `.dev.vars.example`, `README.md`.
- **Notices kept:** every file that carries the header `Copyright (c) 2026 Cloudflare, Inc.` /
  `Licensed under the Apache 2.0 license` keeps it (68 files at this commit:
  `git grep -l "Licensed under the Apache 2.0 license" -- ':!THIRD_PARTY_NOTICES.md'`). Eleven of them were added on 2026-09-28
  (`9d922fd`), partly with code moved out of imported files (`AgentMarkdown.tsx` out of
  `AgentPanel.tsx`, for example); they keep the header as it was written. In 0.11 (Settings as one screen) `app/routes/home.tsx`
  (the Mailboxes screen) was removed: its creation of the configured addresses moved to
  `app/components/settings/sections/ConfiguredAddresses.tsx`, and the mailbox settings form of
  `app/routes/settings.tsx` moved to `app/components/settings/sections/SignatureForm.tsx`; both keep
  the header, and `app/routes/settings.tsx`, now the Settings screen, keeps its own. Where a header
  says "the LICENSE file", read [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).
- **Changes:** PassionCode.ai has modified these files since the import; `git log` records every
  change. The modifications are PassionCode.ai's work under the project's licence; the
  Cloudflare material in them stays under Apache-2.0.

Apache-2.0 code may be combined into a work distributed under the AGPL-3.0 (the Free Software
Foundation lists Apache-2.0 as compatible with version 3 of the GNU licences); this material keeps
its own licence and notices inside the combined work.

## super-ux scripts (MIT)

- **Upstream:** [ssheleg/super-ux](https://github.com/ssheleg/super-ux) v0.56.2,
  `plugins/super-ux/scripts/`.
- **Files:** `docs/ux/lint.py` (`ux_lint.py`) and `docs/ux/doctor.py` (`ux_doctor.py`),
  unmodified — their blob hashes equal the upstream files at `v0.56.2` (checked 2026-09-30);
  `docs/brand/lint.py` (`brand_lint.py`, upstream blob `c7b6884`), modified on 2026-09-30 in four
  comments only, which named a personal website as the place a rule misfired and now say "one
  site"; its code is unchanged (the Python token stream without comments equals upstream's).
- **Licence:** MIT, copyright (c) 2026 ssheleg; the text is
  [LICENSES/MIT-super-ux.txt](LICENSES/MIT-super-ux.txt).

## Dependencies

npm packages are installed from `package-lock.json` and keep the licences their packages
declare. This repository vendors none of them. A generated list of the packages bundled into the
macOS app is not produced yet.
