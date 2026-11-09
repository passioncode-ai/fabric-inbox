'use strict';
/**
 * B-236: the profile's switch files take effect while the app runs. An agent (or a person in a terminal) writing
 * `auto-update`, `new-mail-notifications` or `console-permissions` in the profile used to wait for a restart; now
 * one watcher on the profile folder (no timer) calls the file's handler, once per burst of events. The profile
 * folder belongs to this OS account (mode 0700), so only this account's processes can change what it holds.
 *
 * deps: { watch(dir, listener) → { close() } (node:fs watch), dir, handlers: { [file]: async () => void },
 * debounceMs, setTimer, clearTimer, log }.
 */
function watchProfile(deps) {
  const { watch, dir, handlers, debounceMs = 300, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} } = deps;
  const pending = new Map();
  let watcher = null;
  const fire = (file) => {
    if (pending.has(file)) clearTimer(pending.get(file));
    const timer = setTimer(() => {
      pending.delete(file);
      Promise.resolve().then(() => handlers[file]()).then(
        () => log({ event: 'profile_switch', outcome: 'applied', file }),
        () => log({ event: 'profile_switch', outcome: 'failed', file }));
    }, debounceMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    pending.set(file, timer);
  };
  try {
    watcher = watch(dir, (_event, name) => {
      const file = name ? String(name) : '';
      if (Object.hasOwn(handlers, file)) fire(file);
    });
    // The watcher never keeps the process alive by itself (Electron does; a test that loads main.cjs must end).
    if (watcher && typeof watcher.unref === 'function') watcher.unref();
  } catch (error) {
    log({ event: 'profile_switch', outcome: 'not_watched', code: (error && error.code) || 'error' });
    return { close() {} };
  }
  return {
    close() {
      for (const t of pending.values()) clearTimer(t);
      pending.clear();
      try { watcher.close(); } catch { /* already closed */ }
    },
  };
}

module.exports = { watchProfile };
