// Which checkouts a live process works in: the working folder of this user's processes, read from /proc.
import * as fs from "node:fs";
import * as path from "node:path";
import { commandName } from "../core/ports.ts";
import { ancestors, SHELLS } from "../core/proc.ts";
import { isCode } from "../store/fsx.ts";

/**
 * For each folder, the command names of the processes whose working folder is in it and in no deeper
 * folder of the list (a worktree nested in the main checkout keeps its own), at most `max` each.
 * Shells are left out (an open terminal is not work), and so are this process and its ancestors.
 * Reads only /proc; another user's processes cannot be read and are not this desk's to show.
 */
export function workingIn(dirs: readonly string[], max: number, proc = "/proc"): Map<string, string[]> {
  const out = new Map(dirs.map((d) => [d, [] as string[]]));
  if (dirs.length === 0 || !fs.existsSync(proc)) return out;
  const roots = dirs.map((d) => ({ dir: d, real: realOr(d) })).sort((a, b) => b.real.length - a.real.length);
  const own = new Set([process.pid, ...ancestors(process.pid).map((p) => p.pid)]);
  for (const entry of fs.readdirSync(proc)) {
    if (!/^\d+$/.test(entry) || own.has(Number(entry))) continue;
    const cwd = read(() => fs.readlinkSync(path.join(proc, entry, "cwd")));
    if (cwd === undefined) continue;
    const root = roots.find((r) => cwd === r.real || cwd.startsWith(`${r.real}/`));
    const names = root && out.get(root.dir);
    if (!names || names.length >= max) continue;
    const name = read(() => fs.readFileSync(path.join(proc, entry, "comm"), "utf8").trim());
    if (name === undefined || SHELLS.has(name)) continue;
    const args = read(() => fs.readFileSync(path.join(proc, entry, "cmdline"), "utf8").split("\0").filter(Boolean)) ?? [];
    const shown = commandName(args) || name;
    if (!names.includes(shown)) names.push(shown);
  }
  return out;
}

/** A /proc read of a process that may have exited meanwhile or belong to another user: undefined then. */
function read<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    if (isCode(error, "ENOENT") || isCode(error, "ESRCH") || isCode(error, "EACCES") || isCode(error, "EPERM")) return undefined;
    throw error;
  }
}

/** /proc gives a working folder with symlinks resolved: so is each folder compared with it. */
function realOr(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch (error) {
    if (isCode(error, "ENOENT")) return path.resolve(dir); // a worktree removed since git listed it: nothing works there
    throw error;
  }
}
