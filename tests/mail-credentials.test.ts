import test from "node:test";
import assert from "node:assert/strict";
import { credentialKeys, hasCredentialKey, keyId, openCredentials, sealCredentials, type CredentialEnvelope } from "../workers/providers/credentials";
import { seal } from "../workers/providers/google-oauth";

const KEY_A = Buffer.alloc(32, 1).toString("base64url");
const KEY_B = Buffer.alloc(32, 2).toString("base64url");
const KEY_C = Buffer.alloc(32, 3).toString("base64");

test("the credential key is MAIL_CREDENTIAL_KEY, falling back to GMAIL_TOKEN_ENCRYPTION_KEY", async () => {
  assert.equal(await credentialKeys({}), null, "no key: no credential store");
  assert.equal(hasCredentialKey({}), false);
  assert.equal(hasCredentialKey({ GMAIL_TOKEN_ENCRYPTION_KEY: KEY_A }), true);
  assert.equal(hasCredentialKey({ MAIL_CREDENTIAL_KEY: "typo", GMAIL_TOKEN_ENCRYPTION_KEY: KEY_A }), false, "a malformed new key never falls back silently");
  assert.equal(await credentialKeys({ MAIL_CREDENTIAL_KEY: "short" }), null, "a key that is not 32 bytes is no key");
  const fallback = (await credentialKeys({ GMAIL_TOKEN_ENCRYPTION_KEY: KEY_A }))!;
  assert.equal(fallback.current.secret, KEY_A);
  const both = (await credentialKeys({ MAIL_CREDENTIAL_KEY: KEY_B, GMAIL_TOKEN_ENCRYPTION_KEY: KEY_A }))!;
  assert.equal(both.current.secret, KEY_B, "the new name wins");
  assert.deepEqual(both.previous.map((k) => k.secret), [KEY_A], "the old key still opens what it sealed");
  const rotated = await credentialKeys({ MAIL_CREDENTIAL_KEY: KEY_C, MAIL_CREDENTIAL_KEY_PREVIOUS: `${KEY_B}, ${KEY_A}` })!;
  assert.deepEqual(rotated.previous.map((k) => k.secret), [KEY_B, KEY_A]);
  assert.equal(rotated.current.id, await keyId(KEY_C));
  assert.notEqual(await keyId(KEY_A), await keyId(KEY_B));
  assert.ok(!(await keyId(KEY_A)).includes(KEY_A.slice(0, 8)), "a key id is a fingerprint, not part of the key");
});

test("a version 2 envelope names its key, binds its context and never carries the plaintext", async () => {
  const keys = (await credentialKeys({ MAIL_CREDENTIAL_KEY: KEY_A }))!;
  const envelope = await sealCredentials(keys, "imap:acct-1", { password: "app-password-secret" });
  assert.equal(envelope.version, 2);
  assert.equal(envelope.kid, await keyId(KEY_A));
  assert.ok(!JSON.stringify(envelope).includes("app-password-secret"));
  const opened = await openCredentials<{ password: string }>(keys, "imap:acct-1", envelope);
  assert.deepEqual(opened, { value: { password: "app-password-secret" }, stale: false });
  await assert.rejects(openCredentials(keys, "imap:acct-2", envelope), /credential_store_unavailable/);
  await assert.rejects(openCredentials(keys, "imap:acct-1", { ...envelope, ciphertext: "AAAA" }), /credential_store_unavailable/);
});

test("version 1 envelopes keep opening and are reported stale so they are sealed again", async () => {
  const v1 = await seal(KEY_A, "acct-a", { refreshToken: "r" });
  const keys = (await credentialKeys({ MAIL_CREDENTIAL_KEY: KEY_B, GMAIL_TOKEN_ENCRYPTION_KEY: KEY_A }))!;
  const opened = await openCredentials<{ refreshToken: string }>(keys, "acct-a", v1);
  assert.deepEqual(opened, { value: { refreshToken: "r" }, stale: true });
  // A v1 envelope under the current key is still stale: it carries no key id.
  const same = (await credentialKeys({ MAIL_CREDENTIAL_KEY: KEY_A }))!;
  assert.equal((await openCredentials(same, "acct-a", v1)).stale, true);
});

test("rotation: an envelope sealed with a previous key opens and is stale; an unknown key does not open", async () => {
  const old = (await credentialKeys({ MAIL_CREDENTIAL_KEY: KEY_A }))!;
  const envelope = await sealCredentials(old, "ctx", { password: "p" });
  const rotated = (await credentialKeys({ MAIL_CREDENTIAL_KEY: KEY_B, MAIL_CREDENTIAL_KEY_PREVIOUS: KEY_A }))!;
  assert.deepEqual(await openCredentials(rotated, "ctx", envelope), { value: { password: "p" }, stale: true });
  const resealed = await sealCredentials(rotated, "ctx", { password: "p" });
  assert.equal(resealed.kid, await keyId(KEY_B));
  const lost = (await credentialKeys({ MAIL_CREDENTIAL_KEY: KEY_B }))!;
  await assert.rejects(openCredentials(lost, "ctx", envelope), /credential_store_unavailable/);
  await assert.rejects(openCredentials(lost, "ctx", { version: 3 } as unknown as CredentialEnvelope), /credential_store_unavailable/);
});
