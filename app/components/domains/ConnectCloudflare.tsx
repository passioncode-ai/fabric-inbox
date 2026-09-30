import type { DomainList } from "~/services/domains";

/**
 * SCN-030 without a token: what to create in Cloudflare and where it goes.
 * The desktop app does the saving itself (CF-5); a server run by hand takes
 * it with one wrangler command.
 */
export default function ConnectCloudflare({ list }: { list: DomainList }) {
  return (
    <section className="my-6 rounded-xl border border-kumo-line p-5" aria-labelledby="connect-heading">
      <h2 id="connect-heading" className="text-xl font-medium">Connect your Cloudflare account</h2>
      <p className="mt-2 text-sm">
        {list.problem} With it, this screen lists every domain in your account, turns mail on for the ones you choose and
        creates addresses on them.
      </p>
      <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm">
        <li>
          Open <a className="underline" href={list.tokenUrl} target="_blank" rel="noreferrer">Cloudflare → My Profile → API Tokens</a>,
          choose <strong>Create Token</strong>, then <strong>Create Custom Token</strong>.
        </li>
        <li>
          Add these permissions, and under Account and Zone resources choose your account and <strong>All zones</strong> (or only the
          domains you want here):
          <table className="mt-2 w-full text-left text-sm">
            <thead><tr className="text-kumo-subtle"><th className="py-1 pr-3 font-medium">Type</th><th className="py-1 pr-3 font-medium">Permission</th><th className="py-1 pr-3 font-medium">Access</th><th className="py-1 font-medium">Used to</th></tr></thead>
            <tbody>
              {list.permissions.map((p) => (
                <tr key={p.scope + p.name} className="border-t border-kumo-line">
                  <td className="py-1 pr-3">{p.scope}</td><td className="py-1 pr-3 font-medium">{p.name}</td><td className="py-1 pr-3">{p.level}</td><td className="py-1">{p.for}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </li>
        <li>
          Save the token on this server. In the Mac app choose <strong>Fabric Inbox → Connect Cloudflare account…</strong> and paste it:
          the app saves it on your server (and updates the server if it is older). For a server you deployed yourself, run{" "}
          <code className="rounded bg-kumo-tint px-1">npx wrangler secret put CLOUDFLARE_API_TOKEN</code> in its folder instead. Then
          reload this page.
        </li>
      </ol>
      <p className="mt-4 text-sm text-kumo-subtle">
        The token stays on the server and is never shown again. Without it, addresses on the domains below still receive mail; only
        changing Cloudflare needs it.
      </p>
    </section>
  );
}
