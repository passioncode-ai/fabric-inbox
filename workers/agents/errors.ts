// Error classes do not survive Durable Object RPC; the code travels as a message prefix.
export type RegistryErrorCode = "agent_conflict" | "agent_not_found" | "agent_invalid";
export class RegistryError extends Error {
  constructor(code: RegistryErrorCode, detail: string) { super(`${code}: ${detail}`); }
}
export class AgentConflict extends RegistryError { constructor(detail: string) { super("agent_conflict", detail); } }
export class AgentNotFound extends RegistryError { constructor(detail: string) { super("agent_not_found", detail); } }
export class AgentInvalid extends RegistryError { constructor(detail: string) { super("agent_invalid", detail); } }

/** Reads the code and the operator-facing detail of an error thrown by the registry over RPC. */
export function registryError(error: unknown): { code: RegistryErrorCode; detail: string } | null {
  const match = /^(agent_conflict|agent_not_found|agent_invalid): ([\s\S]*)$/.exec(error instanceof Error ? error.message : "");
  return match ? { code: match[1] as RegistryErrorCode, detail: match[2] } : null;
}
