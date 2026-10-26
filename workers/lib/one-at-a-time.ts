/**
 * Calls of `fn` one after another, never side by side: a call made while one runs waits for it, then runs
 * itself. A failure is the caller's; the next call still runs (M-4, the accounts' event drain).
 */
export function oneAtATime(fn: () => Promise<void>): () => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return () => {
    const run = tail.catch(() => {}).then(fn);
    tail = run;
    return run;
  };
}
