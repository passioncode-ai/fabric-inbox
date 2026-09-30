# Deployments

A deployment is one owner's Fabric Inbox server: its Cloudflare account, Worker address, Access
team, domains and addresses. Those values are that owner's own, so **a deployment's files never
enter Git**: `deployments/<name>/` is ignored (`.gitignore`), and only this README and the
`*.example.json` files beside it are committed. Keep a copy of your deployment directory
somewhere safe (a private repository, an encrypted backup): a fresh clone does not have it.

Most owners need none of this: **Create my server on Cloudflare** in the Mac app creates the
server and its settings in your account ([setup](../docs/desktop-mail/setup.md#your-own-server-created-by-the-mac-app-recommended)).
A deployment directory is for an owner who deploys by hand, keeps ops receipts, or makes a
personal build that carries their setup.

## Create yours

```sh
mkdir -p deployments/<name>            # e.g. deployments/owner; lower-case letters, digits, dashes
cp deployments/deployment.example.json deployments/<name>/deployment.json
```

Replace every `<placeholder>` in `deployment.json`:

| Field | What it holds |
|---|---|
| `accountId` | your Cloudflare account id (dashboard → the account → Account ID) |
| `origin` | your server's address, e.g. `https://fabric-inbox.<your-workers-subdomain>.workers.dev` |
| `setupName` | the name the setup file shows in the app |
| `vars` | the Worker vars `POLICY_AUD`, `TEAM_DOMAIN` (your `https://<team>.cloudflareaccess.com`) and `DOMAINS`; apply them once with the `wrangler deploy --var …` line in `_comment` |
| `identifiers` | anything else of yours that must never appear in a committed app or server file (your Workers subdomain, your Access team) |
| `cloudflareToken` | where the server's API token came from — its name and date, never its value |

`tests/no-owner-data.test.ts` reads every local `deployments/*/deployment.json` and
`setup.json` and fails when a committed app, server or desktop file names one of their
domains, addresses, account id, vars or identifiers. On a clone with no deployment it checks
nothing of yours, and says so.

## A setup file from Cloudflare Email Routing

The server derives a setup from Email Routing itself (**Setup → Read from Cloudflare Email Routing**, or
`GET /api/setup/from-cloudflare`). To make one offline from a read-only capture instead, save
the capture as `deployments/<name>/cloudflare-inventory.json` in the shape of
[`cloudflare-inventory.example.json`](cloudflare-inventory.example.json) — rules as
`[address, type, value]` with type `forward`, `forward-disabled`, `worker` or `drop`, the
catch-all as `[type, value]`, and domains of other accounts under `otherAccounts` — then:

```sh
npx tsx scripts/deployment-setup.ts <name>     # writes deployments/<name>/setup.json
```

A dated capture (`cloudflare-inventory-<date>.json`) is used when there is no undated one; the
newest wins. [`setup.example.json`](setup.example.json) is the script's output for the two
examples:

```sh
npx tsx scripts/deployment-setup.ts --deployment deployments/deployment.example.json \
  --inventory deployments/cloudflare-inventory.example.json --out deployments/setup.example.json
```

## A personal build

`npm run desktop:dmg -- --setup <name>` bundles `deployments/<name>/setup.json` into
`release/Fabric-Inbox-<version>-<name>.dmg`, for that owner only. The file is read from this
machine (it is not in any commit), checked the way the app checks a setup file, and its SHA-256
is written into the image's receipt. The public build (no `--setup`) carries no setup at all.
