'use strict';
// Who accepted a loopback connection: this OS account, or another one (B-217). Loopback is one per computer, so
// another account (or a guest a forwarder relays) can listen on the port a hub named, and a key sent there is theirs.
// The contract's rule (fabric-agent-contract DEC-0154 HA-2, DEC-0155 RT-1 and RT-2, tag v0.1.0+2026-11-07.5): before
// a credential is written to http://127.0.0.1:<port>, the server end of THIS connection is found in the computer's
// socket table and its owner compared with ours; another account's, or one that cannot be told, is `foreign-user`
// and nothing is sent. A list of listeners read earlier says nothing about who accepted this connection.
//
// `ownerWith(exec, platform, fs)` returns `check(conn)`, where conn is the client socket's own view
// ({ localAddress, localPort, remoteAddress, remotePort }), answering { owner: 'self' } or
// { owner: 'foreign-user', reason } with reason `other-account`, `table-restricted: <detail>` (macOS, RT-1) or
// `owner-unknown: <detail>`. Tools are the ones each system ships; `exec(file, args)` and `fs` are injected for tests.

/** One form for an address, whatever the source wrote: '127.0.0.1', '::1', '0.0.0.0', '::'. */
function normal(address) {
  let a = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (a.startsWith('::ffff:') && a.includes('.')) a = a.slice(7);
  if (a === '0:0:0:0:0:0:0:1') a = '::1';
  if (a === '0:0:0:0:0:0:0:0' || a === '*') a = '::';
  return a;
}
const WILDCARD = new Set(['0.0.0.0', '::']);

const reasonOf = (owner, detail) => (owner === 'self' ? { owner } : { owner: 'foreign-user', reason: detail });

/**
 * A setuid reader proves nothing (DEC-0155): its real and effective uid differ. Electron never runs so; a check that
 * finds it says so instead of trusting a table read under another identity.
 */
const setuid = () => typeof process.getuid === 'function' && typeof process.geteuid === 'function' && process.getuid() !== process.geteuid();

// ---- macOS ----------------------------------------------------------------------------------------------------------

/** `netstat -anv -p tcp` rows: local, remote, pid. The process column is `name:pid`, a name may hold spaces. */
function netstatDarwinRows(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = /^tcp(?:4|6|46)?\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+\S+\s+.*?:(\d+)\s+[0-9a-f]{5}\s+[0-9a-f]{8}\s/i.exec(line);
    if (!m) continue;
    const split = (v) => { const i = v.lastIndexOf('.'); return i < 0 ? null : { address: normal(v.slice(0, i)), port: Number(v.slice(i + 1)) }; };
    const local = split(m[1]), remote = split(m[2]);
    if (local && remote) rows.push({ local, remote, pid: Number(m[3]) });
  }
  return rows;
}

const same = (end, address, port) => end.port === port && end.address === normal(address);

function darwinOwner(exec, self) {
  const uidOf = async (pid) => {
    try { const out = String((await exec('/bin/ps', ['-o', 'uid=', '-p', String(pid)])).stdout).trim(); return /^\d+$/.test(out) ? Number(out) : null; } catch { return null; }
  };
  /** RT-2: the server end among this account's own descriptors (lsof lists only what this account may read). */
  const accepted = async (conn) => {
    let out = '';
    try { out = String((await exec('/usr/sbin/lsof', ['-nP', `-iTCP:${conn.remotePort}`, '-sTCP:ESTABLISHED', '-F', 'pun'])).stdout); } catch { return false; }
    let uid = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('u')) uid = Number(line.slice(1));
      else if (line.startsWith('n')) {
        const m = /^n(.+):(\d+)->(.+):(\d+)$/.exec(line);
        if (m && normal(m[1]) === normal(conn.remoteAddress) && Number(m[2]) === conn.remotePort
          && normal(m[3]) === normal(conn.localAddress) && Number(m[4]) === conn.localPort && uid === self.uid) return true;
      }
    }
    return false;
  };
  return async (conn) => {
    if (setuid()) return reasonOf('foreign-user', 'owner-unknown: setuid reader');
    let rows = null, failure = '';
    try { rows = netstatDarwinRows((await exec('/usr/sbin/netstat', ['-anv', '-p', 'tcp'])).stdout); }
    catch (error) { failure = `netstat ${error && error.code !== undefined ? `exit ${error.code}` : 'failed'}`; }
    // The server end: local = the port we called, remote = our own ephemeral port.
    const server = rows && rows.find((r) => same(r.local, conn.remoteAddress, conn.remotePort) && same(r.remote, conn.localAddress, conn.localPort));
    const restricted = !rows ? failure : !rows.length ? 'no rows' : !rows.some((r) => r.pid !== self.pid) ? 'own rows only' : !server ? 'no row for this connection' : '';
    if (!restricted) {
      const uid = await uidOf(server.pid);
      if (uid === null) return reasonOf('foreign-user', 'owner-unknown: process gone');
      return reasonOf(uid === self.uid ? 'self' : 'foreign-user', 'other-account');
    }
    // RT-1: a restricted table proves nothing by a missing row; RT-2 may still prove this account, a few times while
    // the server end is not yet accepted.
    for (let i = 0; i < 3; i++) {
      if (await accepted(conn)) return { owner: 'self' };
      await new Promise((r) => setTimeout(r, 100));
    }
    return reasonOf('foreign-user', `table-restricted: ${restricted}`);
  };
}

// ---- Linux ----------------------------------------------------------------------------------------------------------

/** A /proc/net/tcp{,6} address in hex (each 32-bit word little-endian) as a normal address. */
function procAddress(raw) {
  const hex = String(raw).toLowerCase();
  if (hex.length === 8) return normal(hex.match(/../g).reverse().map((b) => parseInt(b, 16)).join('.'));
  const words = hex.match(/.{8}/g).map((w) => w.match(/../g).reverse().join(''));
  const groups = words.join('').match(/.{4}/g).map((g) => g.replace(/^0+(?=.)/, ''));
  if (groups.slice(0, 5).every((g) => g === '0') && groups[5] === 'ffff') {
    const v4 = words[3].match(/../g).map((b) => parseInt(b, 16)).join('.');
    return normal(v4);
  }
  // Compress the longest run of zero groups, as Node writes an address.
  let best = [-1, 0];
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') { i++; continue; }
    let j = i; while (j < 8 && groups[j] === '0') j++;
    if (j - i > best[1]) best = [i, j - i];
    i = j;
  }
  if (best[1] < 2) return groups.join(':');
  return normal(`${groups.slice(0, best[0]).join(':')}::${groups.slice(best[0] + best[1]).join(':')}`);
}

function procRows(text) {
  const rows = [];
  for (const line of String(text).split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const [la, lp] = f[1].split(':'), [ra, rp] = f[2].split(':');
    if (!la || !ra) continue;
    rows.push({ local: { address: procAddress(la), port: parseInt(lp, 16) }, remote: { address: procAddress(ra), port: parseInt(rp, 16) }, state: f[3], uid: Number(f[7]), inode: f[9] });
  }
  return rows;
}

function linuxOwner(fs, self) {
  return async (conn) => {
    if (setuid()) return reasonOf('foreign-user', 'owner-unknown: setuid reader');
    const rows = [];
    let read = 0;
    for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
      try { rows.push(...procRows(await fs.readFile(table, 'utf8'))); read++; } catch { /* a kernel without IPv6 has no tcp6 */ }
    }
    if (!read) return reasonOf('foreign-user', 'owner-unknown: /proc/net unreadable');
    const server = rows.find((r) => same(r.local, conn.remoteAddress, conn.remotePort) && same(r.remote, conn.localAddress, conn.localPort));
    if (!server) return reasonOf('foreign-user', 'owner-unknown: no row for this connection');
    // Accepted: the row carries the accepting process's uid.
    if (server.inode !== '0' && server.state === '01') return reasonOf(server.uid === self.uid ? 'self' : 'foreign-user', 'other-account');
    // Not yet accepted (inode 0, its uid is not an owner) or already closed: the listener on the port, the one on the
    // connection's local address first, a wildcard only when none listens there; two uids there cannot be told apart.
    if (server.state !== '01') return reasonOf('foreign-user', 'owner-unknown: server end closed');
    const listening = rows.filter((r) => r.state === '0A' && r.local.port === conn.remotePort);
    const exact = listening.filter((r) => r.local.address === normal(conn.remoteAddress));
    const counted = exact.length ? exact : listening.filter((r) => WILDCARD.has(r.local.address));
    const uids = [...new Set(counted.map((r) => r.uid))];
    if (uids.length !== 1) return reasonOf('foreign-user', `owner-unknown: ${uids.length ? 'listeners of several accounts' : 'no listener'}`);
    return reasonOf(uids[0] === self.uid ? 'self' : 'foreign-user', 'other-account');
  };
}

// ---- Windows --------------------------------------------------------------------------------------------------------

const system32 = (tool) => `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\${tool}`;

/** `netstat -ano` TCP rows: local, remote, pid. The state's word is translated, so it is not read. */
function netstatWindowsRows(text) {
  const rows = [];
  const end = (v) => { const m = /^(.*):(\d+)$/.exec(v); return m ? { address: normal(m[1]), port: Number(m[2]) } : null; };
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+)\s+(\S+)\s+\S+\s+(\d+)\s*$/i.exec(line);
    if (!m) continue;
    const local = end(m[1]), remote = end(m[2]);
    if (local && remote) rows.push({ local, remote, pid: Number(m[3]) });
  }
  return rows;
}

function windowsOwner(exec, self) {
  /** The process's user from `tasklist /V`: another account's reads N/A without elevation, an owner not told. */
  const userOf = async (pid) => {
    try {
      const csv = String((await exec(system32('tasklist.exe'), ['/V', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])).stdout).trim();
      const cells = [...csv.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]);
      const user = cells[6] || '';
      return user && !/^n\/?a$/i.test(user) ? user.toLowerCase() : null;
    } catch { return null; }
  };
  return async (conn) => {
    let rows;
    try { rows = netstatWindowsRows((await exec(system32('netstat.exe'), ['-ano'])).stdout); } catch { return reasonOf('foreign-user', 'owner-unknown: netstat failed'); }
    const server = rows.find((r) => same(r.local, conn.remoteAddress, conn.remotePort) && same(r.remote, conn.localAddress, conn.localPort));
    if (!server) return reasonOf('foreign-user', 'owner-unknown: no row for this connection');
    const [theirs, ours] = await Promise.all([userOf(server.pid), userOf(self.pid)]);
    if (!ours) return reasonOf('foreign-user', 'owner-unknown: own user not read');
    if (!theirs) return reasonOf('foreign-user', 'owner-unknown: process cannot be opened');
    return reasonOf(theirs === ours ? 'self' : 'foreign-user', 'other-account');
  };
}

function ownerWith(exec, platform = process.platform, fs = require('node:fs/promises'), self = { pid: process.pid, uid: typeof process.getuid === 'function' ? process.getuid() : null }) {
  if (platform === 'win32') return windowsOwner(exec, self);
  if (platform === 'linux') return linuxOwner(fs, self);
  return darwinOwner(exec, self);
}

module.exports = { ownerWith, normal, netstatDarwinRows, netstatWindowsRows, procRows, procAddress };
