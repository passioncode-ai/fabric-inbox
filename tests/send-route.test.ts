import { test } from "node:test";
import assert from "node:assert/strict";
import { handleSendEmail } from "../workers/routes/reply-forward";

// M-6: a send through the app's route (the browser, an outside agent over MCP) never stamps itself
// Auto-Submitted; only the server's own reply agents do, over RPC.
test("M-6: auto_submitted in a send request is dropped before the mailbox sends", async () => {
  const seen: any[] = [];
  const c: any = {
    req: { json: async () => ({ to: "ann@x.invalid", subject: "Hi", text: "Hello", auto_submitted: true }), param: (k: string) => (k === "mailboxId" ? "me@owner.example" : undefined), header: () => undefined },
    var: { mailboxStub: { sendMail: async (command: any) => { seen.push(command); return { status: "accepted" }; } } },
    json: (body: unknown, status = 200) => ({ body, status }),
  };
  const answer: any = await handleSendEmail(c, "send");
  assert.equal(answer.status, 200);
  assert.equal(seen.length, 1);
  assert.equal("auto_submitted" in seen[0].request, false);
});
