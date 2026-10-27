// Loads desktop/*.cjs with `node:path` answering in POSIX form, for the tests that drive desktop/main.cjs
// against a fixture profile keyed by "/fixture/…" paths. With the platform's own path module those keys
// read back as "\fixture\…" on Windows and every fixture lookup missed, so the Windows runner skipped
// desktop-profile and desktop-policy; with this loader they run there too. The modules are evaluated
// once per loader, each with its own `require`, so a test's fakes never leak into another test's modules.
import { createRequire } from "node:module";
import path from "node:path";
import { readFileSync } from "node:fs";

export function posixRequire(from: string | URL) {
  const nodeRequire = createRequire(from);
  const cache = new Map<string, { exports: any }>();
  const load = (file: string): any => {
    const known = cache.get(file);
    if (known) return known.exports;
    if (!file.endsWith(".cjs")) return nodeRequire(file);
    const module = { exports: {} as any };
    cache.set(file, module);
    const own = createRequire(file);
    const req = Object.assign((name: string) => resolveIn(file, name), { resolve: own.resolve });
    const body = new Function("exports", "require", "module", "__filename", "__dirname", readFileSync(file, "utf8"));
    body(module.exports, req, module, file, path.dirname(file));
    return module.exports;
  };
  const resolveIn = (file: string, name: string): any => {
    if (name === "node:path" || name === "path") return path.posix;
    if (name.startsWith("./") || name.startsWith("../")) return load(path.resolve(path.dirname(file), name));
    return createRequire(file)(name);
  };
  return (name: string) => {
    if (name === "node:path" || name === "path") return path.posix;
    return name.startsWith("./") || name.startsWith("../") ? load(nodeRequire.resolve(name)) : nodeRequire(name);
  };
}
