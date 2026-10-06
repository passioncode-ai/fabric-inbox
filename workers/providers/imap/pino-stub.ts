/**
 * `imapflow` imports `pino` at module load for its default logger, and `pino`'s `sonic-boom`
 * cannot load in workerd (Vite's dev server stopped with "superCtor.prototype … undefined").
 * Our client passes `logger: false` (client.ts), so the default logger is never asked for; vite.config.ts
 * aliases `pino` to this silent stand-in so the Worker loads in dev and in the build alike.
 */
type Logger = { level: string; child: () => Logger; isLevelEnabled: () => boolean } & Record<"trace" | "debug" | "info" | "warn" | "error" | "fatal", (...args: unknown[]) => void>;

function logger(): Logger {
  const silent = () => {};
  const self: Logger = { level: "silent", trace: silent, debug: silent, info: silent, warn: silent, error: silent, fatal: silent,
    child: () => self, isLevelEnabled: () => false };
  return self;
}

export default function pino(): Logger { return logger(); }
export { pino };
