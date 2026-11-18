// Which checkouts a session's work runs in: the working folder of the commands sessions and their
// agents started through a shell, and which wait at the load gate, read only from fixed /proc files of
// each session's own process tree.
import * as fs from "node:fs";
import * as path from "node:path";
import type { BranchRow } from "../core/protocol.ts";
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
export function workingIn(dirs: readonly string[], sessions: readonly LiveProcess[], max: number): Map<string, string[]> {
  const out = new Map(dirs.map((d) => [d, [] as string[]]));
  for (const { dir, proc } of placed(dirs, sessions, (p) => !SHELLS.has(p.name))) {
    const names = out.get(dir);
    if (!names || names.length >= max) continue;
    const name = processName(proc);
    if (!names.includes(name)) names.push(name);
  }
  return out;
}

/** The script an orchestration runs before a heavy command: it blocks, sleeping, while the machine is loaded. */
export const LOAD_GATE = "load-gate.sh";

/** Whether a command line runs the load gate: the program itself, or a shell given it as its script file. */
export function runsLoadGate(args: readonly string[]): boolean {
  const [program, ...rest] = args;
  if (program === undefined) return false;
  if (path.basename(program) === LOAD_GATE) return true;
  if (!SHELLS.has(path.basename(program)) || path.basename(program) === "env") return false; // env execs what it runs: /proc then shows that
  const script = scriptOf(rest);
  return script !== undefined && path.basename(script) === LOAD_GATE;
}

/** Long options of the shells that take the next argument as their value. */
const LONG_WITH_VALUE = new Set(["--rcfile", "--init-file", "--init-command", "--config", "--env-config"]);
/** Short options that take the next argument as their value, in a cluster too (`-o pipefail`, `-eo pipefail`, `+O extglob`). */
const SHORT_WITH_VALUE = new Set(["o", "O"]);

/**
 * The script file a shell's arguments give it, past its options and their values; undefined when it has
 * none, or when it runs a command string (`-c`, in any option cluster) or reads its commands from its input (`-s`):
 * then its other arguments are only words of that command.
 */
function scriptOf(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--" || arg === "-") return args[i + 1];
    if (arg.startsWith("--")) {
      const name = arg.split("=", 1)[0] ?? arg;
      if (name === "--command" || name === "--commands") return undefined;
      if (LONG_WITH_VALUE.has(name) && !arg.includes("=")) i++;
      continue;
    }
    if (!/^[-+]./.test(arg)) return arg;
    const flags = arg.slice(1);
    if (flags.includes("c") || flags.includes("s")) return undefined;
    i += [...flags].filter((f) => SHORT_WITH_VALUE.has(f)).length;
  }
  return undefined;
}

/**
 * The folders of `dirs` where a process of these sessions runs the load gate, each process placed in
 * the deepest folder holding it, by the rules of workingIn but for shells, since a shell runs the script.
 */
export function gatedIn(dirs: readonly string[], sessions: readonly LiveProcess[]): Set<string> {
  return new Set([...placed(dirs, sessions, (p) => runsLoadGate(commandLine(p.pid) ?? []))].map((x) => x.dir));
}

/**
 * The working agents of a session's rows whose checkout holds a process of the session's own tree
 * running the load gate, by name: they wait for the machine's load. `checkouts`: every checkout of
 * the project, so that a process is placed in the deepest one, as `busy` places it.
 */
export function agentsAtLoadGate(session: LiveProcess | undefined, rows: readonly BranchRow[], checkouts: readonly string[]): string[] {
  const candidates = rows.filter((r): r is BranchRow & { agent: NonNullable<BranchRow["agent"]>; path: string } => r.agent?.state === "working" && r.path !== undefined && r.status === "found");
  if (!session || candidates.length === 0) return [];
  const gated = gatedIn(checkouts, [session]);
  return candidates.filter((r) => gated.has(r.path)).map((r) => r.agent.name);
}

type LiveProcess = { pid: number; start?: string };

/**
 * Each process a live session started through a shell that `want` keeps (never the desk's helpers,
 * nor what they start), with the folder of `dirs` deepest holding its working folder.
 */
function* placed(dirs: readonly string[], sessions: readonly LiveProcess[], want: (proc: ProcInfo) => boolean): Generator<{ dir: string; proc: ProcInfo }> {
  if (dirs.length === 0) return;
  const roots = dirs.map((d) => ({ dir: d, real: realOr(d) })).sort((a, b) => b.real.length - a.real.length);
  const helper = (p: ProcInfo) => p.pid === process.pid || deskHelper(commandLine(p.pid) ?? []);
  for (const session of sessions) {
    const info = procInfo(session.pid);
    if (!info || (session.start !== undefined && info.start !== session.start)) continue; // gone, or its pid reused
    for (const proc of startedThroughShell(session.pid, helper)) {
      if (!want(proc)) continue;
      const cwd = read(() => fs.readlinkSync(`/proc/${proc.pid}/cwd`));
      if (cwd === undefined) continue;
      const root = roots.find((r) => cwd === r.real || cwd.startsWith(`${r.real}/`));
      if (root) yield { dir: root.dir, proc };
    }
  }
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
