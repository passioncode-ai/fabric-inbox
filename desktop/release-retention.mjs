// What a build leaves in release/ (knowledge/lifecycle.md LC-15): the release just built and the
// newest other one, for rollback. The audit found 3.9 GB of fourteen old disk images there
// (raw/fabric-inbox.md §4, F8). The builders call pruneReleases after a successful build, so the
// folder never grows past two releases; nobody has to remember a cleanup.
//
// Release artefacts: `Fabric-Inbox-<version>[-<variant>].dmg` and its `.dmg.sha256`, grouped by
// version (a personal `-owner` image and an `-unsigned` one belong to their version), and store
// build folders `mas-<mode>-<arch>-<build>-<revision>`, kept per mode (a development build never
// removes the distribution package that was uploaded). Receipts (`*.receipt.json`) are small and
// stay as the record of what was built: a store folder's `build-receipt.json` is moved out to
// `<folder>.receipt.json` before the folder goes. Anything else in the folder is left alone, and
// a removal that fails is logged, never fatal: pruning runs after the build is already made.
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

const IMAGE = /^Fabric-Inbox-(\d+\.\d+\.\d+)(?:-[a-z0-9-]+)?\.dmg(?:\.sha256)?$/;
const STORE = /^mas-(development|distribution)-(?:arm64|x64)-(\d+(?:\.\d+){0,2})-[0-9a-f]{12}$/;

/** Compares dotted numeric versions: negative, zero or positive. */
export function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The current key plus the newest other key, from `keys`. */
function keep(keys, current) {
  const others = [...new Set(keys)].filter((k) => k !== current).sort((a, b) => compareVersions(b, a));
  return current ? [current, ...others.slice(0, 1)] : others.slice(0, 2);
}

/**
 * Which entries of release/ to remove. `current` is the image version just built; `currentMas` the
 * store build folder just written. A family whose current build is not named is left as it is.
 */
export function planReleasePrune(names, { current, currentMas } = {}) {
  const remove = [];
  let keepVersions = [];
  if (current) {
    const images = names.map((n) => [n, IMAGE.exec(n)?.[1]]).filter(([, v]) => v);
    keepVersions = keep(images.map(([, v]) => v), current);
    for (const [name, version] of images) if (!keepVersions.includes(version)) remove.push(name);
  }
  if (currentMas) {
    const stores = names.filter((n) => STORE.test(n));
    const currentMode = STORE.exec(currentMas)?.[1];
    const newestFirst = (list) => list.sort((a, b) => compareVersions(STORE.exec(b)[2], STORE.exec(a)[2]) || b.localeCompare(a));
    const sameMode = newestFirst(stores.filter((n) => n !== currentMas && STORE.exec(n)[1] === currentMode));
    const otherMode = newestFirst(stores.filter((n) => STORE.exec(n)[1] !== currentMode));
    // The current build and the one before it in its mode; the newest of the other mode untouched.
    const kept = new Set([currentMas, ...sameMode.slice(0, 1), ...otherMode.slice(0, 1)]);
    for (const name of stores) if (!kept.has(name)) remove.push(name);
  }
  return { remove, keepVersions };
}

/** Removes what planReleasePrune names from `dir`; returns the removed names. Never throws. */
export function pruneReleases(dir, options, log = (line) => console.error(JSON.stringify(line))) {
  let names;
  try { names = readdirSync(dir); }
  catch (error) {
    if (error.code !== 'ENOENT') log({ event: 'release_prune', outcome: 'not_read', code: error.code || 'error' });
    return [];
  }
  const { remove } = planReleasePrune(names, options);
  const removed = [];
  for (const name of remove) {
    try {
      const storeReceipt = path.join(dir, name, 'build-receipt.json');
      if (STORE.test(name) && existsSync(storeReceipt)) renameSync(storeReceipt, path.join(dir, `${name}.receipt.json`));
      rmSync(path.join(dir, name), { recursive: true, force: true });
      removed.push(name);
    } catch (error) {
      log({ event: 'release_prune', outcome: 'not_removed', name, code: error.code || 'error' });
    }
  }
  return removed;
}
