# Unified workbench — 2026-09-26

Owner request: see all accounts and their messages together, filter one account in place, improve UI/UX, support white and dark Fabric themes, and add the product to the toolkit website and GitHub documentation.

## Decisions and acceptance

- SCN-004 is the primary job: account navigation stays visible; All inboxes merges messages by date; each row and open message retain their owning account. A provider failure is shown alongside usable results.
- Three-column desktop workbench: accounts/folders, message list, reader. Narrow view uses a Back to messages action. Search and account/folder scope are URL-addressable. No numeric unread claim derived from a partial page.
- Canonical design source: PassionCode website `design-system/tokens.css`, per Fabric ADR-0070. Vendor exact tokens with provenance; white default and persistent dark option; gold selection/action, quiet surfaces and product-specific inbox mark. No extra font dependency.
- Compose always shows sender. Replies keep their original account. Local draft and immutable send key survive closing; uncertain sends remain locked to that attempt. Existing provider detail routes remain available.
- Rules stay account-scoped. All-accounts view offers a chooser, never guesses which account owns an automation.
- Empty, loading, failure and partially available states have separate copy. Real mail requires configured provider credentials; UI verification uses a local synthetic fixture, never claims real provider delivery.

## Rubric / falsifiers

Reject if a row can open another account's message with the same provider ID; if a provider failure blanks other accounts; if account switching changes sender on an existing draft; if any light/dark text pair falls below 4.5:1; if keyboard focus is hidden or dialog Escape discards a draft; if a 1280px desktop window needs horizontal scrolling.

## Ownership

Backend: `codex/unified-mail-api`; website/tokens: `codex/inbox-product-site`; Fabric documentation: `codex/inbox-product-links`; UI/integration: `codex/unified-workbench`. All have separate worktrees. Existing website storytelling changes and Fabric desktop test changes are unrelated and preserved.
