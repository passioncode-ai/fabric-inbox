// Removes build caches that are not releases (knowledge/lifecycle.md LC-15; AGENTS.md → Lifecycle):
// the Worker and app build, the server bundle the desktop app uploads, Wrangler's temporary files
// and node_modules/.cache. Each is rebuilt by the command that needs it. Local Miniflare data
// (.wrangler/state) and release/ (pruned by the builders) are left alone.
//
//   npm run clean     prints one JSON line: what was removed and how many bytes it held
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CACHES = ['build', 'desktop/server-bundle', '.wrangler/tmp', 'node_modules/.cache'];

function bytes(target) {
  const stat = lstatSync(target);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(target).reduce((sum, name) => sum + bytes(path.join(target, name)), 0);
}

/** Removes CACHES under `root`; returns { removed, bytes }. */
export function clean(root) {
  const removed = [];
  let total = 0;
  for (const relative of CACHES) {
    const target = path.join(root, relative);
    if (!existsSync(target)) continue;
    total += bytes(target);
    rmSync(target, { recursive: true, force: true });
    removed.push(relative);
  }
  return { removed, bytes: total };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(clean(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))));
}
