// Which checkouts a session's work runs in: the working folder of the commands sessions and their
// agents started through a shell, read only from fixed /proc files of each session's own process tree.
import * as fs from "node:fs";
import * as path from "node:path";
import { commandLine, processName, startedThroughShell } from "../core/ports.ts";
import { procInfo, type ProcInfo, SHELLS } from "../core/proc.ts";
import { isCode } from "../store/fsx.ts";

/** This install of the desk: a process running one of its scripts is the desk's own helper. */
const DESK_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DESK_PARTS = ["src", "adapters", "bin"].map((p) => `${path.join(DESK_ROOT, p)}${path.sep}`);
const DESK_COMMANDS = new Set(["agent-desk", "agent-desk-claude"]);
/** `agent-desk-claude hook` as a command of a shell script: at its start, after a separator or `exec`, maybe with a path. */
const DESK_IN_SCRIPT = /(?:^|[;&|(\n]|\$\(|\b(?:then|do|else)\b)\s*(?:exec\s+)?(?:\S*\/)?agent-desk(?:-claude)?(?=\s|$|[;&|)])/;

/**
 * Whether a command line is one of the desk's own helpers: its CLI, its adapter (hooks, the waiter,
 * the scan) or a hook's shell that runs them, so that neither they nor what they start is counted as work.
 */
export function deskHelper(args: readonly string[]): boolean {
  const [program, ...rest] = args;
  if (program === undefined) return false;
  if (DESK_COMMANDS.has(path.basename(program))) return true;
  if (args.some((a) => path.isAbsolute(a) && DESK_PARTS.some((part) => path.resolve(a).startsWith(part)))) return true;
  const script = SHELLS.has(path.basename(program)) ? rest[rest.indexOf("-c") + 1] : undefined;
  return rest.includes("-c") && script !== undefined && DESK_IN_SCRIPT.test(script);
}

/**
 * For each folder, the command names of the processes working in it and in no deeper folder of the
 * list (a worktree nested in the main checkout keeps its own), at most `max` each. Only what a live
 * session started through a shell counts (its commands and its agents', the rule src/core/ports.ts
 * follows for servers): not the tool servers its provider runs for itself, not processes outside its
 * tree, not shells, and not the desk's own helpers (this scan among them). Reads only the trees' own
 * `stat`, `task/<tid>/children`, `cmdline` and `cwd`.
 */
export function workingIn(dirs: readonly string[], sessions: readonly { pid: number; start?: string }[], max: number): Map<string, string[]> {
  const out = new Map(dirs.map((d) => [d, [] as string[]]));
  if (dirs.length === 0) return out;
  const roots = dirs.map((d) => ({ dir: d, real: realOr(d) })).sort((a, b) => b.real.length - a.real.length);
  const helper = (p: ProcInfo) => p.pid === process.pid || deskHelper(commandLine(p.pid) ?? []);
  for (const session of sessions) {
    const info = procInfo(session.pid);
    if (!info || (session.start !== undefined && info.start !== session.start)) continue; // gone, or its pid reused
    for (const proc of startedThroughShell(session.pid, helper)) {
      if (SHELLS.has(proc.name)) continue;
      const cwd = read(() => fs.readlinkSync(`/proc/${proc.pid}/cwd`));
      if (cwd === undefined) continue;
      const root = roots.find((r) => cwd === r.real || cwd.startsWith(`${r.real}/`));
      const names = root && out.get(root.dir);
      if (!names || names.length >= max) continue;
      const name = processName(proc);
      if (!names.includes(name)) names.push(name);
    }
  }
  return out;
}

/** A /proc read of a process that may have exited meanwhile or belong to another user (a sudo child): undefined then. */
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
