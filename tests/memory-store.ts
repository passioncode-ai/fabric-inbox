import type { Store } from "../workers/providers/google-oauth";

/**
 * An in-memory `Store` with the ordering Durable Object storage gives (keys compared as strings,
 * not by locale), fast enough for caches of tens of thousands of rows: the sorted key list is
 * rebuilt only after a key is added or removed. `transaction` runs its writes as one unit: a
 * callback that throws leaves nothing behind, as a Durable Object transaction does.
 */
export class MemoryStore implements Store {
  data = new Map<string, unknown>();
  private sorted: string[] | null = null;
  ops = { get: 0, put: 0, delete: 0, list: 0, listed: 0 };
  async get<T>(key: string): Promise<T | undefined> {
    this.ops.get++;
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T) {
    this.ops.put++;
    if (!this.data.has(key)) this.sorted = null;
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.ops.delete++;
    const had = this.data.delete(key);
    if (had) this.sorted = null;
    return had;
  }
  private keys() {
    if (!this.sorted) this.sorted = [...this.data.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return this.sorted;
  }
  async list<T>({ prefix = "", limit, startAfter }: { prefix?: string; limit?: number; startAfter?: string } = {}): Promise<Map<string, T>> {
    this.ops.list++;
    const keys = this.keys();
    const after = startAfter !== undefined && startAfter >= prefix;
    const from = after ? startAfter! : prefix;
    // The first key past `startAfter`, or the first key at or past the prefix.
    let lo = 0, hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] < from || (after && keys[mid] === from)) lo = mid + 1;
      else hi = mid;
    }
    const out = new Map<string, T>();
    for (let i = lo; i < keys.length && (limit === undefined || out.size < limit); i++) {
      if (!keys[i].startsWith(prefix)) break;
      out.set(keys[i], structuredClone(this.data.get(keys[i])) as T);
    }
    this.ops.listed += out.size;
    return out;
  }
  private tail: Promise<unknown> = Promise.resolve();
  transaction<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    const run = async () => {
      const before = new Map(this.data);
      try {
        return await fn({
          get: this.get.bind(this), put: this.put.bind(this), delete: this.delete.bind(this),
          list: this.list.bind(this), transaction: <U>(inner: (s: Store) => Promise<U>) => inner(this),
        });
      } catch (error) {
        this.data = before;
        this.sorted = null;
        throw error;
      }
    };
    const p = this.tail.then(run);
    this.tail = p.catch(() => {});
    return p;
  }
}
