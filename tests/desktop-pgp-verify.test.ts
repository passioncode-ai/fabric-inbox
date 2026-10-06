// The OpenPGP check behind automatic updates (LC-16): the release's SHA256SUMS must carry a valid
// signature by the organization's pinned release key. Fixtures are the real 0.11.0 release files
// and a signature by a throwaway key; no private key is in the repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pgp = require("../desktop/pgp-verify.cjs");

const dir = "tests/fixtures/release-signing";
const read = (name: string) => readFileSync(`${dir}/${name}`);
const ORG = read("passioncode-release-signing.asc").toString("utf8");
const SUMS = read("SHA256SUMS-0.11.0");
const SIG = read("SHA256SUMS-0.11.0.asc").toString("utf8");

test("the organization's key is read, and its fingerprint is the pinned one", () => {
  const key = pgp.readPublicKey(ORG);
  assert.equal(key.fingerprint, "63B30DC324BD697487AA31944FAFB8AEC803B6A7");
  assert.equal(pgp.RELEASE_KEY_FINGERPRINT, key.fingerprint);
});

test("the app carries exactly the organization's published release key", () => {
  assert.equal(readFileSync("desktop/release-key.asc", "utf8").trim(), ORG.trim());
});

test("a real release's SHA256SUMS verifies against the pinned key", () => {
  const out = pgp.verifyDetached({ data: SUMS, signature: SIG, key: ORG, fingerprint: pgp.RELEASE_KEY_FINGERPRINT });
  assert.equal(out.fingerprint, pgp.RELEASE_KEY_FINGERPRINT);
  assert.equal(new Date(out.created * 1000).toISOString().slice(0, 10), "2026-10-06");
});

test("a changed byte, another key's signature or another pinned fingerprint is refused", () => {
  const tampered = Buffer.from(SUMS);
  tampered[0] = tampered[0] === 0x30 ? 0x31 : 0x30;
  assert.throws(() => pgp.verifyDetached({ data: tampered, signature: SIG, key: ORG, fingerprint: pgp.RELEASE_KEY_FINGERPRINT }), /signature/i);
  const other = read("SHA256SUMS-0.11.0.other-key.asc").toString("utf8");
  assert.throws(() => pgp.verifyDetached({ data: SUMS, signature: other, key: ORG, fingerprint: pgp.RELEASE_KEY_FINGERPRINT }), /not made by the release key/);
  // A signature that is valid for its own key is still refused when that key is not the pinned one.
  const otherKey = read("other-key.asc").toString("utf8");
  assert.throws(() => pgp.verifyDetached({ data: SUMS, signature: other, key: otherKey, fingerprint: pgp.RELEASE_KEY_FINGERPRINT }), /not the pinned release key/);
});

test("malformed armor, a broken checksum and unsupported packets are refused, never skipped", () => {
  assert.throws(() => pgp.verifyDetached({ data: SUMS, signature: "not armor", key: ORG, fingerprint: pgp.RELEASE_KEY_FINGERPRINT }), /armor/i);
  const lines = SIG.split("\n");
  const crc = lines.findIndex((l) => l.startsWith("="));
  lines[crc] = "=AAAA";
  assert.throws(() => pgp.verifyDetached({ data: SUMS, signature: lines.join("\n"), key: ORG, fingerprint: pgp.RELEASE_KEY_FINGERPRINT }), /checksum/i);
  const swapped = SIG.replace("BEGIN PGP SIGNATURE", "BEGIN PGP MESSAGE").replace("END PGP SIGNATURE", "END PGP MESSAGE");
  assert.throws(() => pgp.verifyDetached({ data: SUMS, signature: swapped, key: ORG, fingerprint: pgp.RELEASE_KEY_FINGERPRINT }), /armor/i);
  // A key block passed off as a signature: its only signature packet is the key's self-signature.
  assert.throws(() => pgp.verifyDetached({ data: SUMS, signature: ORG.replace(/PUBLIC KEY BLOCK/g, "SIGNATURE"), key: ORG, fingerprint: pgp.RELEASE_KEY_FINGERPRINT }), /binary document/i);
  const two = SIG.replace(/\n=[A-Za-z0-9+/]{4}\n/, "\n");
  const body = two.split("\n").filter((l) => /^[A-Za-z0-9+/]+=*$/.test(l)).join("");
  const doubled = Buffer.concat([Buffer.from(body, "base64"), Buffer.from(body, "base64")]).toString("base64");
  assert.throws(() => pgp.verifyDetached({ data: SUMS, signature: `-----BEGIN PGP SIGNATURE-----\n\n${doubled}\n-----END PGP SIGNATURE-----\n`, key: ORG, fingerprint: pgp.RELEASE_KEY_FINGERPRINT }), /one OpenPGP signature packet/);
});

test("SHA256SUMS is read strictly: one hex digest and one file name per line", () => {
  const sums = pgp.parseSums(SUMS.toString("utf8"));
  assert.equal(sums.get("Fabric-Inbox-0.11.0-mac.zip"), "f3b91a4c18be38d3fd8aacbffa97092dd5dc5507d4ddaa7abf91ebfe4996e3ee");
  assert.equal(sums.get("update-mac.json"), "5e2846c21bffb65c2845362af01382f2f5d5e66d30dcdce1ffb9d767a9885a6b");
  assert.throws(() => pgp.parseSums("zz  a.zip\n"), /SHA256SUMS/);
  assert.throws(() => pgp.parseSums(`${"a".repeat(64)}  a.zip\n${"b".repeat(64)}  a.zip\n`), /twice/);
});
