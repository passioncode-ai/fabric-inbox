/**
 * B-246 W2c, the cut-over (`GRANTS_DECIDE=on`): each tool's reach under a caller's grants. `domain:` entries become today's
 * addresses (B-36) and the call is kept to the mailboxes a narrowing header names. A key's own level and accounts are among
 * its grants (`grantsOfKey`), so a key with no stored grant reaches exactly what it reaches today; an approved access
 * request (W3) widens the key in place, with no new secret (R-3).
 */
import { grantScope, type Grant } from "./grants";
import { expandDomains, namesDomain, narrowPrincipal, scopedApi } from "./scope";
import { TOOL_NEEDS } from "./tool-capabilities";
import type { Principal } from "./keys";
import type { Api, ToolContext, ToolDef } from "./protocol";

export async function scopeFromGrants(grants: readonly Grant[], base: Api, header: string | null,
  addressesOf: () => Promise<string[]>): Promise<NonNullable<ToolContext["scope"]>> {
  const domains = grants.some((g) => namesDomain(g.mailboxes)) || /domain:/i.test(header ?? "");
  const addresses = domains ? await addressesOf() : [];
  const everything = { kind: "owner", label: "", level: "admin", send: "send", dailySendLimit: null, keyId: null, accounts: null } as Principal;
  const narrowed = header === null ? null : narrowPrincipal(everything, header, addresses)?.accounts ?? [];
  const reach = (tool: Pick<ToolDef, "name" | "routes">) => {
    const { allowed, accounts, viaOwner } = grantScope(tool, grants);
    if (TOOL_NEEDS[tool.name] === "self") return { allowed, accounts, viaOwner: false };
    const concrete = accounts === null ? null : expandDomains(accounts, addresses);
    const kept = narrowed === null ? concrete : concrete === null ? narrowed : concrete.filter((a) => narrowed.includes(a));
    // A tool that needs a mailbox needs one left after narrowing.
    return { allowed: allowed && (kept === null || kept.length > 0), accounts: kept, viaOwner: !!viaOwner };
  };
  return {
    allowed: (tool) => reach(tool).allowed,
    api: (tool) => { const { accounts } = reach(tool); return accounts === null ? base : scopedApi(base, accounts); },
    // B-246 W5a: the owner's approval stands in for a send the grants do not give.
    viaOwner: (tool) => reach(tool).viaOwner,
  };
}
