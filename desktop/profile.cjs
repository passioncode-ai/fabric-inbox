'use strict';
// What Fabric Inbox keeps in its profile, and what it removes (knowledge/lifecycle.md LC-12).
//
// Each server gets its own persistent Chromium partition, `persist:fabric-<sha256(origin)[:24]>`
// (policy.partitionFor), stored as `<userData>/Partitions/fabric-<hash>`: cookies (the Cloudflare
// Access session), cache, local storage. Before this module a changed server address left the old
// partition behind forever; the audit measured 62 MB of them (raw/fabric-inbox.md §4, F3).
//
// - retirePartition: when the server changes, the old partition's storage and cache are cleared
//   through its session and its directory removed, once its window is gone (main.cjs loadMail).
// - sweepProfile: at start, before any window, every server partition other than the configured
//   one is removed, with leftovers of server.json / pending-setup.json (`*.tmp` from an interrupted
//   atomic write, backups). Chromium may write a few bytes into a retired directory before it exits;
//   the next start's sweep removes them.
//
// Only directories this app names (fabric-<24 hex>) and files next to its own two settings files
// are ever touched. Every outcome is one structured line on stderr; nothing here stops the app.
const path = require('node:path');

const PARTITION = /^persist:(fabric-[0-9a-f]{24})$/;
const PARTITION_DIR = /^fabric-[0-9a-f]{24}$/;
const LEFTOVER = /^(?:server|pending-setup)\.json\..+$/;

function defaultLog(event) { console.error(JSON.stringify(event)); }

/** The Partitions/ directory name of a server partition, or null for anything else. */
function partitionDirName(partition) {
  const match = PARTITION.exec(String(partition));
  return match ? match[1] : null;
}

async function entries(fs, dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

/**
 * Removes every server partition except `keepPartition` (null keeps none) and the leftovers of the
 * app's settings files. Returns what it removed; a failure is logged and returns what was done.
 */
async function sweepProfile({ fs, userData, keepPartition, log = defaultLog }) {
  const keep = keepPartition ? partitionDirName(keepPartition) : null;
  const removed = { partitions: [], files: [] };
  try {
    for (const entry of await entries(fs, path.join(userData, 'Partitions'))) {
      if (!entry.isDirectory() || !PARTITION_DIR.test(entry.name) || entry.name === keep) continue;
      await fs.rm(path.join(userData, 'Partitions', entry.name), { recursive: true, force: true });
      removed.partitions.push(entry.name);
    }
    for (const entry of await entries(fs, userData)) {
      if (!entry.isFile() || !LEFTOVER.test(entry.name)) continue;
      await fs.rm(path.join(userData, entry.name), { force: true });
      removed.files.push(entry.name);
    }
    log({ event: 'profile_sweep', outcome: 'ok', partitions: removed.partitions.length, files: removed.files.length });
  } catch (error) {
    log({ event: 'profile_sweep', outcome: 'failed', code: error.code || 'error', partitions: removed.partitions.length, files: removed.files.length });
  }
  return removed;
}

/**
 * Clears a server partition that is no longer used: its storage and cache through `session`, then
 * its directory. Call it only after every window on that partition is destroyed.
 */
async function retirePartition({ fs, userData, partition, session, log = defaultLog }) {
  const dir = partitionDirName(partition);
  if (!dir) throw new Error(`${String(partition).slice(0, 80)} is not a server partition.`);
  let outcome = { event: 'partition_retired', outcome: 'ok' };
  try {
    await session.clearStorageData();
    await session.clearCache();
  } catch (error) {
    outcome = { event: 'partition_retired', outcome: 'storage_not_cleared', reason: String(error && error.message || error).slice(0, 200) };
  }
  try { await fs.rm(path.join(userData, 'Partitions', dir), { recursive: true, force: true }); }
  catch (error) { outcome = { event: 'partition_retired', outcome: 'directory_not_removed', code: error.code || 'error' }; }
  log(outcome);
}

module.exports = { partitionDirName, sweepProfile, retirePartition };
