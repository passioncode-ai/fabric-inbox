/** The tables a rename copies, in the order their references need (B-27). Kept apart so routes import no Durable Object. */
export const RENAME_TABLES = ["folders", "emails", "attachments"] as const;
export type RenameTable = (typeof RENAME_TABLES)[number];
/** A row as SQLite stores it: text, numbers, null or bytes, which an RPC carries as they are. */
export type RenameRow = Record<string, string | number | null | ArrayBuffer>;
