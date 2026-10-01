/**
 * The relay Worker's source (MA-6, MA-7). Email Routing sends a zone's mail only to a Worker in the
 * zone's own account, so a domain in another account routes to this small Worker there, which hands
 * the message to the server unchanged and applies its answer:
 *
 *  POST {SERVER_URL}/relay/incoming   body: the raw message; X-Fabric-Envelope-From / -To
 *    → { outcome: "stored" | "duplicate" | "rejected", reject?, forwardTo?, mailboxId?, emailId? }
 *  POST {SERVER_URL}/relay/forwarded  { mailboxId, emailId, target, ok, error? } after a copy
 *
 * Both calls carry the relay's Access service token (CF-Access-Client-Id / -Secret). A server that
 * cannot be reached, or answers with anything but 2xx, makes the handler throw: the platform then
 * records a failure instead of a delivery, as the server's own email handler does, and the message
 * is never dropped here. It keeps nothing: no mail, no log of senders or subjects.
 *
 * It is plain JavaScript with no imports, uploaded as one module by workers/relay/install.ts, and
 * run in workerd by tests/cloudflare-relay.test.ts.
 */
export const RELAY_MODULE = "relay.js";
export const RELAY_COMPATIBILITY_DATE = "2026-09-01";

// The version is the source's own fingerprint (FNV-1a, 32 bits): a change to the relay is a new
// version with no number to remember, and the server upgrades relays that report an older one.
const VERSION_MARK = "__RELAY_VERSION__";
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, "0");
}

const TEMPLATE = `// Fabric Inbox relay __RELAY_VERSION__: carries this account's mail to its server. Managed by the server; do not edit.
const auth = (env) => ({ "CF-Access-Client-Id": env.ACCESS_CLIENT_ID, "CF-Access-Client-Secret": env.ACCESS_CLIENT_SECRET });
const log = (event, detail) => console.log(JSON.stringify({ event, relay: "__RELAY_VERSION__", ...detail }));

async function call(env, path, init) {
  let response;
  try {
    // No redirects: Access answers a refused sign-in with its login page, which must not receive the secret.
    response = await fetch(new URL(path, env.SERVER_URL), { ...init, redirect: "manual", signal: AbortSignal.timeout(60000) });
  } catch (error) {
    throw new Error("The Fabric Inbox server could not be reached: " + (error && error.message || error));
  }
  if (response.status >= 300 && response.status < 400)
    throw new Error("The Fabric Inbox server refused the relay's sign-in (" + response.status + " to its login page); install the relay again from Domains & addresses.");
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error("The Fabric Inbox server answered " + response.status + (text ? ": " + text : ""));
  }
  return response.json();
}

export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const answer = await call(env, "/relay/incoming", {
      method: "POST",
      headers: { ...auth(env), "Content-Type": "message/rfc822",
        "X-Fabric-Envelope-From": message.from || "", "X-Fabric-Envelope-To": message.to || "", "X-Fabric-Relay-Version": "__RELAY_VERSION__" },
      body: raw,
    });
    if (answer.outcome === "rejected") {
      log("relay_rejected", {});
      // Synchronous at the edge; awaited so a runtime that carries it over RPC has applied it before the handler returns.
      await message.setReject(answer.reject || "Address not found");
      return;
    }
    if (answer.forwardTo) {
      let ok = true, error;
      try { await message.forward(answer.forwardTo); } catch (e) { ok = false; error = String(e && e.message || e).slice(0, 300); }
      // The copy is owed on the server until this report arrives; a lost report leaves it owed, never lost.
      await call(env, "/relay/forwarded", {
        method: "POST", headers: { ...auth(env), "Content-Type": "application/json" },
        body: JSON.stringify({ mailboxId: answer.mailboxId, emailId: answer.emailId, target: answer.forwardTo, ok, ...(error ? { error } : {}) }),
      }).catch((e) => log("relay_forward_unreported", { error: String(e && e.message || e).slice(0, 300) }));
    }
    log("relay_delivered", { outcome: answer.outcome });
  },
  async fetch() {
    return new Response("This Worker carries mail for Fabric Inbox and serves nothing.", { status: 404 });
  },
};
`;

export const RELAY_VERSION = fingerprint(TEMPLATE);
export const RELAY_SOURCE = TEMPLATE.split(VERSION_MARK).join(RELAY_VERSION);
