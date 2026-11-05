// B-206: how full this server's storage is (docs/app-store/tasks/2026-11-05-storage-capacity.md). Every mailbox,
// every shared store and the per-address automation object is one SQLite-backed Durable Object, and Cloudflare stops
// its writes at 10 GB on Workers Paid (1 GB on Free) with SQLITE_FULL, while reads and deletes go on. Files (R2) have
// no limit and are summed for the record.

/** The per-object limit: STORAGE_LIMIT_GB when set (1 on Workers Free), else Workers Paid's 10 GB. */
export function objectLimitBytes(raw?: unknown): number {
  const gb = Number(raw);
  return (Number.isFinite(gb) && gb > 0 && gb <= 10 ? gb : 10) * 1024 ** 3;
}

export const WARN_PERCENT = 80;
export const FULL_PERCENT = 95;

export type StorageLevel = "ok" | "warn" | "full" | "unknown";

export interface ObjectUsage {
  /** `mailbox:<address>`, `automation:<address>` or `store:<name>`. */
  object: string;
  bytes: number | null;
  percent: number | null;
  level: StorageLevel;
  /** A mailbox's messages per folder. */
  folders?: Record<string, number>;
  error?: string;
}

export interface StorageReport {
  limitBytes: number;
  warnPercent: number;
  fullPercent: number;
  level: StorageLevel;
  /** The fullest objects first; an unreadable one last. */
  objects: ObjectUsage[];
  files: { objects: number; bytes: number; partial: boolean } | null;
}

export function usageOf(object: string, bytes: number | null, limit: number, extra: Partial<ObjectUsage> = {}): ObjectUsage {
  if (bytes === null || !Number.isFinite(bytes)) return { object, bytes: null, percent: null, level: "unknown", ...extra };
  const percent = Math.round((bytes / limit) * 1000) / 10;
  const level: StorageLevel = percent >= FULL_PERCENT ? "full" : percent >= WARN_PERCENT ? "warn" : "ok";
  return { object, bytes, percent, level, ...extra };
}

export function storageReport(objects: ObjectUsage[], files: StorageReport["files"], limit: number): StorageReport {
  const sorted = [...objects].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || (a.object < b.object ? -1 : 1));
  const rank: Record<StorageLevel, number> = { ok: 0, unknown: 1, warn: 2, full: 3 };
  const level = sorted.reduce<StorageLevel>((worst, o) => (rank[o.level] > rank[worst] ? o.level : worst), "ok");
  return { limitBytes: limit, warnPercent: WARN_PERCENT, fullPercent: FULL_PERCENT, level, objects: sorted, files };
}
