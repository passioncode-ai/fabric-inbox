import type { Store } from "../workers/providers/google-oauth";

/**
 * An in-memory `Store` with the ordering Durable Object storage gives (keys compared as strings,
 * not by locale), fast enough for caches of tens of thousands of rows: keys are kept sorted in
 * small blocks, so a write costs a short splice and a list a binary search. `transaction` runs its
 * writes as one unit: a callback that throws leaves nothing behind, as a Durable Object
 * transaction does.
 */
const BLOCK = 256;
export class MemoryStore implements Store {
  data = new Map<string, unknown>();
  /** The keys, sorted, in blocks of at most 2 * BLOCK; null until first listed. */
  private blocks: string[][] | null = null;
  ops = { get: 0, put: 0, delete: 0, list: 0, listed: 0 };
  async get<T>(key: string): Promise<T | undefined> {
    this.ops.get++;
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T) {
    this.ops.put++;
    if (!this.data.has(key) && this.blocks) this.insert(key);
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.ops.delete++;
    const had = this.data.delete(key);
    if (had && this.blocks) {
      const [b, i] = this.locate(key, false);
      this.blocks[b].splice(i, 1);
      if (!this.blocks[b].length) this.blocks.splice(b, 1);
    }
    return had;
  }
  private index() {
    if (!this.blocks) {
      const keys = [...this.data.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      this.blocks = [];
      for (let i = 0; i < keys.length; i += BLOCK) this.blocks.push(keys.slice(i, i + BLOCK));
    }
    return this.blocks;
  }
  /** The block and position of the first key past `key` (`after`) or at or past it. */
  private locate(key: string, after: boolean): [number, number] {
    const blocks = this.index();
    const past = (k: string) => (after ? k > key : k >= key);
    let lo = 0, hi = blocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (past(blocks[mid][blocks[mid].length - 1])) hi = mid;
      else lo = mid + 1;
    }
    if (lo === blocks.length) return [lo, 0];
    const block = blocks[lo];
    let a = 0, b = block.length;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (past(block[mid])) b = mid;
      else a = mid + 1;
    }
    return [lo, a];
  }
  private insert(key: string) {
    const blocks = this.blocks!;
    let [b, i] = this.locate(key, false);
    if (b === blocks.length) {
      if (!blocks.length) { blocks.push([key]); return; }
      b = blocks.length - 1;
      i = blocks[b].length;
    }
    blocks[b].splice(i, 0, key);
    if (blocks[b].length > 2 * BLOCK) blocks.splice(b, 1, blocks[b].slice(0, BLOCK), blocks[b].slice(BLOCK));
  }
  async list<T>({ prefix = "", limit, startAfter }: { prefix?: string; limit?: number; startAfter?: string } = {}): Promise<Map<string, T>> {
    this.ops.list++;
    const after = startAfter !== undefined && startAfter >= prefix;
    const blocks = this.index();
    let [b, i] = this.locate(after ? startAfter! : prefix, after);
    const out = new Map<string, T>();
    for (; b < blocks.length; b++, i = 0) {
      for (; i < blocks[b].length; i++) {
        const key = blocks[b][i];
        if ((limit !== undefined && out.size >= limit) || !key.startsWith(prefix)) { this.ops.listed += out.size; return out; }
        out.set(key, structuredClone(this.data.get(key)) as T);
      }
    }
    this.ops.listed += out.size;
    return out;
  }
  private tail: Promise<unknown> = Promise.resolve();
  transaction<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    const run = async () => {
      // The value each key had before its first write in this transaction, to put back on failure.
      const journal = new Map<string, { had: boolean; value: unknown }>();
      const remember = (key: string) => {
        if (!journal.has(key)) journal.set(key, { had: this.data.has(key), value: this.data.get(key) });
      };
      const tx: Store = {
        get: this.get.bind(this),
        list: this.list.bind(this),
        put: async (key, value) => { remember(key); await this.put(key, value); },
        delete: async (key) => { remember(key); return this.delete(key); },
        transaction: (inner) => inner(tx),
      };
      try {
        return await fn(tx);
      } catch (error) {
        for (const [key, { had, value }] of journal) {
          if (had) this.data.set(key, value);
          else this.data.delete(key);
        }
        this.blocks = null;
        throw error;
      }
    };
    const p = this.tail.then(run);
    this.tail = p.catch(() => {});
    return p;
  }
}
