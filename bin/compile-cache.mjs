// Preloaded by run-ts before any TypeScript: keeps Node's compiled code, its type stripping included,
// between runs, so each hook does not strip every file again. Plain JavaScript importing no
// TypeScript: one stripped file would load the stripper the cache saves. The folder is the store's
// (storeHome in src/store/paths.ts); unlike NODE_COMPILE_CACHE, nothing the desk runs inherits it.
import { mkdirSync } from "node:fs";
import { constants, enableCompileCache } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const override = process.env.AGENT_DESK_HOME;
// A relative override is refused by the store itself, with its own message: no cache then.
const home = override ? (isAbsolute(override) ? resolve(override) : undefined) : join(homedir(), ".cache", "agent-desk");
if (home !== undefined) {
  const dir = join(home, "compile-cache");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const result = enableCompileCache(dir);
  if (result.status === constants.compileCacheStatus.FAILED) process.stderr.write(`agent-desk: Node's compile cache in ${dir} is off, every run strips the TypeScript again: ${result.message}\n`);
}
