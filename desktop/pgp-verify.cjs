'use strict';
// Verifies the release's SHA256SUMS against the organization's pinned OpenPGP release key before an
// update is installed (LC-16, docs/desktop-data-and-updates.md). Only what that key produces is
// accepted: a v4 Ed25519 (EdDSA) key and a v4 binary-document signature with SHA-256/384/512.
// Anything else — another algorithm, a critical subpacket we do not know, a second packet — is
// refused, never skipped. Node's own Ed25519 does the cryptography; no OpenPGP library is bundled.
const crypto = require('node:crypto');

/** The organization's release key (passioncode-ai/.github release-signing/), as published. */
const RELEASE_KEY_FINGERPRINT = '63B30DC324BD697487AA31944FAFB8AEC803B6A7';
const ED25519_OID = Buffer.from('2b06010401da470f01', 'hex');
const HASHES = { 8: 'sha256', 9: 'sha384', 10: 'sha512' };
const KNOWN_CRITICAL = new Set([2, 3, 16, 33]);

function crc24(bytes) {
  let crc = 0xb704ce;
  for (const byte of bytes) {
    crc ^= byte << 16;
    for (let i = 0; i < 8; i++) { crc <<= 1; if (crc & 0x1000000) crc ^= 0x1864cfb; }
  }
  return crc & 0xffffff;
}

/** The bytes inside an ASCII-armored block of the given kind, with its checksum checked. */
function dearmor(text, kind) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const begin = lines.indexOf(`-----BEGIN PGP ${kind}-----`);
  const end = lines.indexOf(`-----END PGP ${kind}-----`);
  if (begin < 0 || end < begin) throw new Error(`The armor is not a PGP ${kind} block.`);
  let i = begin + 1;
  while (i < end && lines[i].trim() !== '' && /^[A-Za-z][A-Za-z0-9-]*: /.test(lines[i])) i++;
  if (i < end && lines[i].trim() === '') i++;
  let body = ''; let checksum = null;
  for (; i < end; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^=[A-Za-z0-9+/]{4}$/.test(line)) { checksum = line.slice(1); continue; }
    if (!/^[A-Za-z0-9+/]+=*$/.test(line)) throw new Error(`The armor of the PGP ${kind} is malformed.`);
    body += line;
  }
  const bytes = Buffer.from(body, 'base64');
  if (!bytes.length) throw new Error(`The armor of the PGP ${kind} is empty.`);
  if (checksum !== null && Buffer.from(checksum, 'base64').readUIntBE(0, 3) !== crc24(bytes)) {
    throw new Error(`The armor checksum of the PGP ${kind} does not match.`);
  }
  return bytes;
}

/** OpenPGP packets: [{ tag, body }]. Partial and indeterminate lengths are refused. */
function packets(bytes) {
  const out = [];
  let at = 0;
  while (at < bytes.length) {
    const head = bytes[at++];
    if (!(head & 0x80)) throw new Error('Not an OpenPGP packet.');
    let tag; let length;
    if (head & 0x40) {
      tag = head & 0x3f;
      const first = bytes[at++];
      if (first < 192) length = first;
      else if (first < 224) length = ((first - 192) << 8) + bytes[at++] + 192;
      else if (first === 255) { length = bytes.readUInt32BE(at); at += 4; }
      else throw new Error('Partial OpenPGP packet lengths are not accepted.');
    } else {
      tag = (head >> 2) & 0x0f;
      const type = head & 0x03;
      if (type === 3) throw new Error('Indeterminate OpenPGP packet lengths are not accepted.');
      const size = [1, 2, 4][type];
      length = bytes.readUIntBE(at, size); at += size;
    }
    if (at + length > bytes.length) throw new Error('A truncated OpenPGP packet.');
    out.push({ tag, body: bytes.subarray(at, at + length) });
    at += length;
  }
  return out;
}

/** A multiprecision integer at `at`: { value, next }. */
function mpi(body, at) {
  if (at + 2 > body.length) throw new Error('A truncated OpenPGP number.');
  const bytes = Math.ceil(body.readUInt16BE(at) / 8);
  if (at + 2 + bytes > body.length) throw new Error('A truncated OpenPGP number.');
  return { value: body.subarray(at + 2, at + 2 + bytes), next: at + 2 + bytes };
}

/** The primary key of an armored public key block: { fingerprint, keyObject }. */
function readPublicKey(armored) {
  const primary = packets(dearmor(armored, 'PUBLIC KEY BLOCK')).find((p) => p.tag === 6);
  if (!primary) throw new Error('No public key in the key block.');
  const body = primary.body;
  if (body[0] !== 4) throw new Error('Only a version 4 OpenPGP key is accepted.');
  if (body[5] !== 22) throw new Error('Only an Ed25519 (EdDSA) release key is accepted.');
  const oidLength = body[6];
  if (!body.subarray(7, 7 + oidLength).equals(ED25519_OID)) throw new Error('Only an Ed25519 (EdDSA) release key is accepted.');
  const point = mpi(body, 7 + oidLength).value;
  if (point.length !== 33 || point[0] !== 0x40) throw new Error('The Ed25519 key point is malformed.');
  const head = Buffer.from([0x99, body.length >> 8, body.length & 0xff]);
  const fingerprint = crypto.createHash('sha1').update(head).update(body).digest('hex').toUpperCase();
  const keyObject = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: point.subarray(1).toString('base64url') }, format: 'jwk' });
  return { fingerprint, keyObject };
}

function subpackets(area) {
  const out = [];
  let at = 0;
  while (at < area.length) {
    const first = area[at++];
    let length;
    if (first < 192) length = first;
    else if (first < 255) length = ((first - 192) << 8) + area[at++] + 192;
    else { length = area.readUInt32BE(at); at += 4; }
    if (length < 1 || at + length > area.length) throw new Error('A malformed signature subpacket.');
    out.push({ type: area[at] & 0x7f, critical: !!(area[at] & 0x80), data: area.subarray(at + 1, at + length) });
    at += length;
  }
  return out;
}

/**
 * Checks a detached armored signature over `data` (a Buffer) with the armored public `key`, which
 * must be the key with `fingerprint`. Returns { fingerprint, created } or throws, naming why.
 */
function verifyDetached({ data, signature, key, fingerprint, now = Date.now() }) {
  const release = readPublicKey(key);
  if (release.fingerprint !== String(fingerprint).toUpperCase()) throw new Error('The key is not the pinned release key.');
  const all = packets(dearmor(signature, 'SIGNATURE'));
  const signatures = all.filter((p) => p.tag === 2);
  if (signatures.length !== 1 || all.length !== 1) throw new Error('Expected one OpenPGP signature packet and nothing else.');
  const body = signatures[0].body;
  if (body[0] !== 4) throw new Error('Only a version 4 OpenPGP signature is accepted.');
  if (body[1] !== 0x00) throw new Error('Only a signature over a binary document is accepted.');
  if (body[2] !== 22) throw new Error('Only an Ed25519 (EdDSA) signature is accepted.');
  const hash = HASHES[body[3]];
  if (!hash) throw new Error('The signature uses a hash that is not accepted.');
  const hashedLength = body.readUInt16BE(4);
  const hashedEnd = 6 + hashedLength;
  const hashed = subpackets(body.subarray(6, hashedEnd));
  const unhashedLength = body.readUInt16BE(hashedEnd);
  const unhashed = subpackets(body.subarray(hashedEnd + 2, hashedEnd + 2 + unhashedLength));
  let at = hashedEnd + 2 + unhashedLength;
  const left16 = body.subarray(at, at + 2); at += 2;
  const r = mpi(body, at); const s = mpi(body, r.next);
  if (s.next !== body.length) throw new Error('The signature packet has trailing bytes.');

  for (const sub of hashed) if (sub.critical && !KNOWN_CRITICAL.has(sub.type)) throw new Error('The signature carries a critical subpacket that is not understood.');
  const createdSub = hashed.find((sub) => sub.type === 2);
  if (!createdSub || createdSub.data.length !== 4) throw new Error('The signature has no creation time.');
  const created = createdSub.data.readUInt32BE(0);
  const expirySub = hashed.find((sub) => sub.type === 3);
  if (expirySub && expirySub.data.readUInt32BE(0) && (created + expirySub.data.readUInt32BE(0)) * 1000 < now) throw new Error('The signature has expired.');
  const issuerFpr = hashed.find((sub) => sub.type === 33);
  const issuerId = [...hashed, ...unhashed].find((sub) => sub.type === 16);
  const issuer = issuerFpr ? issuerFpr.data.subarray(1).toString('hex').toUpperCase() : null;
  if (issuer ? issuer !== release.fingerprint : !(issuerId && release.fingerprint.endsWith(issuerId.data.toString('hex').toUpperCase()))) {
    throw new Error('The signature was not made by the release key.');
  }

  const trailer = Buffer.alloc(6);
  trailer[0] = 0x04; trailer[1] = 0xff; trailer.writeUInt32BE(hashedEnd, 2);
  const digest = crypto.createHash(hash).update(data).update(body.subarray(0, hashedEnd)).update(trailer).digest();
  const pad = (b) => (b.length > 32 ? null : Buffer.concat([Buffer.alloc(32 - b.length), b]));
  const rs = [pad(r.value), pad(s.value)];
  if (!rs[0] || !rs[1] || !digest.subarray(0, 2).equals(left16) || !crypto.verify(null, digest, release.keyObject, Buffer.concat(rs))) {
    throw new Error('The signature does not match the data.');
  }
  return { fingerprint: release.fingerprint, created };
}

/** SHA256SUMS as written by `sha256sum`: Map(file name → hex digest). */
function parseSums(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) [ *]([^/\\\0]+)$/.exec(line.replace(/\r$/, ''));
    if (!match) throw new Error('SHA256SUMS has a line that is not "<sha256>  <file>".');
    if (out.has(match[2])) throw new Error(`SHA256SUMS names ${match[2]} twice.`);
    out.set(match[2], match[1]);
  }
  return out;
}

module.exports = { verifyDetached, readPublicKey, parseSums, dearmor, RELEASE_KEY_FINGERPRINT };
