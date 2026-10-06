import test from "node:test";
import assert from "node:assert/strict";
import { dotStuff, sendSmtp, verifySmtp, type SmtpOptions } from "../workers/providers/imap/smtp";
import { NotSentError } from "../workers/providers/provider";
import { ProviderError } from "../workers/providers/gmail-client";
import { FakeSmtp, nodeSockets, type FakeSmtpOptions } from "./fake-smtp";

const USER = "ann@example.invalid", PASS = "app-password-1234";
async function fixture(server: FakeSmtpOptions = {}, client: Partial<SmtpOptions> = {}, sockets = nodeSockets()) {
  const smtp = await new FakeSmtp({ users: { [USER]: PASS }, ...server }).start();
  const options: SmtpOptions = { host: "smtp.example.invalid", port: smtp.port, security: "tls", user: USER, password: PASS, socket: sockets, timeoutMs: 2_000, ...client };
  return { smtp, options, sockets };
}
const MESSAGE = "From: ann@example.invalid\r\nTo: bob@example.invalid\r\nSubject: hi\r\n\r\nline one\r\n.starts with a dot\r\n..two dots\r\nend";
const unstuff = (data: string) => data.replace(/(^|\r\n)\./g, "$1");

test("happy path over TLS from the first byte: AUTH PLAIN, envelope, dot-stuffing, accepted", async (t) => {
  const { smtp, options, sockets } = await fixture();
  t.after(() => smtp.stop());
  const result = await sendSmtp(options, { from: USER, recipients: ["bob@example.invalid", "carol@example.invalid"] }, MESSAGE);
  assert.equal(result.response, "250");
  assert.equal(sockets.connections[0]!.secureTransport, "on");
  assert.equal(smtp.received.length, 1);
  const got = smtp.received[0]!;
  assert.deepEqual(got.recipients, ["bob@example.invalid", "carol@example.invalid"]);
  assert.match(got.data, /\r\n\.\.starts with a dot\r\n\.\.\.two dots\r\n/, "lines starting with a dot carry one more");
  assert.equal(unstuff(got.data), MESSAGE + "\r\n", "the server gets back exactly the message");
  assert.equal(got.params, "", "a 7-bit message asks for nothing more");
  assert.ok(smtp.commands.includes("AUTH PLAIN <secret>"));
  assert.ok(!smtp.commands.join("\n").includes(PASS), "the password never appears in a command line logged by the server fixture");
  assert.equal(smtp.commands.at(-1), "QUIT");
});

test("dot-stuffing normalises line ends and terminates the data once", () => {
  assert.equal(dotStuff(".a\nb\r\n.c"), "..a\r\nb\r\n..c\r\n.\r\n");
  assert.equal(dotStuff("x\r\n"), "x\r\n.\r\n");
});

test("STARTTLS on 587: upgrade with the locks released, EHLO again, then AUTH", async (t) => {
  const { smtp, options, sockets } = await fixture({ starttls: true }, { security: "starttls" });
  t.after(() => smtp.stop());
  await sendSmtp(options, { from: USER, recipients: ["bob@example.invalid"] }, MESSAGE);
  assert.equal(sockets.connections[0]!.secureTransport, "starttls");
  assert.equal(sockets.upgrades, 1);
  assert.equal(smtp.upgrades, 1);
  assert.deepEqual(smtp.commands.slice(0, 4), ["EHLO fabric-inbox.invalid", "STARTTLS", "EHLO fabric-inbox.invalid", "AUTH PLAIN <secret>"]);
});

test("a server that does not offer STARTTLS on a STARTTLS port is never spoken to in plain text", async (t) => {
  const { smtp, options } = await fixture({ starttls: false }, { security: "starttls" });
  t.after(() => smtp.stop());
  await assert.rejects(sendSmtp(options, { from: USER, recipients: ["bob@example.invalid"] }, MESSAGE), (e: NotSentError) => e instanceof NotSentError && e.code === "smtp_tls_failed");
  assert.ok(!smtp.commands.some((c) => c.startsWith("AUTH")), "no credentials over an unencrypted connection");
  assert.equal(smtp.received.length, 0);
});

test("a TLS handshake that fails is smtp_tls_failed; a refused connection is smtp_unreachable; port 25 is never tried", async (t) => {
  const { smtp, options } = await fixture({}, {}, nodeSockets({ failTls: true }));
  t.after(() => smtp.stop());
  await assert.rejects(verifySmtp(options), (e: NotSentError) => e instanceof NotSentError && e.code === "smtp_tls_failed");
  await assert.rejects(verifySmtp({ ...options, socket: nodeSockets({ refuse: true }) }), (e: NotSentError) => e.code === "smtp_unreachable");
  const sockets = nodeSockets();
  await assert.rejects(verifySmtp({ ...options, port: 25, socket: sockets }), (e: NotSentError) => e.code === "port_blocked");
  assert.equal(sockets.connections.length, 0);
});

test("AUTH LOGIN when PLAIN is not offered; a wrong password is a definite failure with a public code", async (t) => {
  const { smtp, options } = await fixture({ mechanisms: ["LOGIN"] });
  t.after(() => smtp.stop());
  assert.ok((await verifySmtp(options)).extensions.includes("AUTH"));
  assert.ok(smtp.commands.includes("<user>") && smtp.commands.includes("<pass>"));
  await assert.rejects(sendSmtp({ ...options, password: "wrong" }, { from: USER, recipients: ["b@example.invalid"] }, MESSAGE),
    (e: NotSentError) => e instanceof NotSentError && e.code === "smtp_auth_failed" && e.status === 401 && !e.message.includes("wrong"));
  assert.equal(smtp.received.length, 0);
});

test("Gmail's refusal of a normal password is app_password_required", async (t) => {
  const { smtp, options } = await fixture({ authFailure: "534-5.7.9 Application-specific password required. Learn more at\r\n534 5.7.9 https://support.google.com/mail/?p=InvalidSecondFactor" });
  t.after(() => smtp.stop());
  await assert.rejects(verifySmtp({ ...options, password: "normal" }), (e: NotSentError) => e.code === "app_password_required");
});

test("a refused recipient sends nothing and is safe to retry", async (t) => {
  const { smtp, options } = await fixture({ rejectRecipients: ["nobody@example.invalid"] });
  t.after(() => smtp.stop());
  await assert.rejects(sendSmtp(options, { from: USER, recipients: ["bob@example.invalid", "nobody@example.invalid"] }, MESSAGE),
    (e: NotSentError) => e instanceof NotSentError && e.code === "recipient_rejected");
  assert.equal(smtp.received.length, 0);
});

test("the connection dropping after the data is an unknown outcome, never a failure", async (t) => {
  const { smtp, options } = await fixture({ dropAfterData: true });
  t.after(() => smtp.stop());
  await assert.rejects(sendSmtp(options, { from: USER, recipients: ["bob@example.invalid"] }, MESSAGE),
    (e: Error) => e instanceof ProviderError && !(e instanceof NotSentError) && e.code === "send_outcome_unknown");
  assert.equal(smtp.received.length, 1, "the server had the whole message");
});

test("a message refused after its data is a definite failure", async (t) => {
  const { smtp, options } = await fixture({ dataReply: "554 5.7.1 Message rejected as spam" });
  t.after(() => smtp.stop());
  await assert.rejects(sendSmtp(options, { from: USER, recipients: ["bob@example.invalid"] }, MESSAGE), (e: NotSentError) => e instanceof NotSentError && e.code === "message_rejected");
});

test("8-bit bodies ask for BODY=8BITMIME and UTF-8 addresses for SMTPUTF8, only when offered", async (t) => {
  const { smtp, options } = await fixture();
  t.after(() => smtp.stop());
  await sendSmtp(options, { from: USER, recipients: ["bob@example.invalid"] }, "Subject: x\r\n\r\nПривет");
  assert.equal(smtp.received[0]!.params, "BODY=8BITMIME");
  await sendSmtp(options, { from: USER, recipients: ["пользователь@пример.рф"] }, "Subject: =?UTF-8?B?0J/RgNC40LLQtdGC?=\r\n\r\nhi");
  assert.equal(smtp.received[1]!.params, "SMTPUTF8");
  assert.deepEqual(smtp.received[1]!.recipients, ["пользователь@пример.рф"]);
  const plain = await fixture({ extensions: [] });
  t.after(() => plain.smtp.stop());
  await assert.rejects(sendSmtp(plain.options, { from: USER, recipients: ["пользователь@пример.рф"] }, "Subject: x\r\n\r\nhi"), (e: NotSentError) => e.code === "smtputf8_unsupported");
  assert.equal(plain.smtp.received.length, 0);
});

test("XOAUTH2 signs in with a token; a refused token asks for a reconnect", async (t) => {
  const { smtp, options } = await fixture({ mechanisms: ["XOAUTH2", "PLAIN"], tokens: { [USER]: "ya29.token" } });
  t.after(() => smtp.stop());
  await sendSmtp({ ...options, password: undefined, token: "ya29.token" }, { from: USER, recipients: ["b@example.invalid"] }, MESSAGE);
  assert.ok(smtp.commands.includes("AUTH XOAUTH2 <secret>"));
  await assert.rejects(verifySmtp({ ...options, password: undefined, token: "expired" }), (e: NotSentError) => e.code === "reconnect_required");
});
