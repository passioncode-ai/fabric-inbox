'use strict';
// The app's log (LC-12, LC-16): one JSON line per event in `~/Library/Logs/<app name>/`
// (`app.getPath('logs')`), codes and versions only — never mail, addresses, tokens or paths of the
// person's files. The file is capped: past 1 MB it becomes `<name>.1.log` (the previous one is
// dropped), so the log never holds more than about 2 MB. Every line also goes to stderr, where a
// development run shows it.
const path = require('node:path');

const MAX_BYTES = 1024 * 1024;

/** deps: { fs (node:fs/promises), dir, name ('fabric-inbox'), now, echo } → log(event) */
function createLog({ fs, dir, name = 'fabric-inbox', now = Date.now, echo = (line) => process.stderr.write(line) }) {
  const file = path.join(dir, `${name}.log`);
  const previous = path.join(dir, `${name}.1.log`);
  let queue = Promise.resolve();
  let ready = false;

  async function write(line) {
    if (!ready) { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); ready = true; }
    let size = 0;
    try { size = (await fs.stat(file)).size; } catch { size = 0; }
    if (size + Buffer.byteLength(line) > MAX_BYTES && size > 0) await fs.rename(file, previous);
    await fs.appendFile(file, line, { mode: 0o600 });
  }

  function log(event) {
    const line = JSON.stringify({ ts: new Date(now()).toISOString(), ...event }) + '\n';
    try { echo(line); } catch { /* no terminal */ }
    // Lines are written in order; a write that fails (disk full, folder removed) is dropped, never thrown.
    queue = queue.then(() => write(line)).catch(() => { ready = false; });
    return queue;
  }
  log.file = file;
  log.flush = () => queue;
  return log;
}

module.exports = { createLog, MAX_BYTES };
