/**
 * B-158 (D2 of docs/app-store/tasks/2026-10-27-organizations.md): the context a server belongs to, as contract
 * DEC-0082 writes it: `personal`, or `org:<orgId>` with `orgId` matching `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`,
 * compared exactly as written. A server without FABRIC_CONTEXT is a person's own (`personal`), so every server
 * made before contexts keeps working. A value that is no context is reported, never guessed into one.
 */
export const CONTEXT_PATTERN = /^(?:personal|org:[A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;

export type ServerContext = { context: string; valid: true } | { context: null; valid: false; written: string };

export function contextOf(env: { FABRIC_CONTEXT?: string }): ServerContext {
  const written = env.FABRIC_CONTEXT;
  if (written === undefined || written === "") return { context: "personal", valid: true };
  return CONTEXT_PATTERN.test(written) ? { context: written, valid: true } : { context: null, valid: false, written: written.slice(0, 160) };
}
