// Process ancestry, read from /proc on Linux. Used to tie a session to its terminal and the CLI to its session.
import * as fs from "node:fs";
import { isCode } from "../store/fsx.ts";

export type ProcInfo = { pid: number; ppid: number; name: string; start: string };

/** undefined when the process is gone or the platform has no /proc. */
export function procInfo(pid: number): ProcInfo | undefined {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT") || isCode(error, "ESRCH")) return undefined;
    throw error;
  }
  // "pid (name) state ppid … starttime(22nd field) …"; the name may itself contain ") ".
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  const rest = stat.slice(close + 2).split(" ");
  const ppid = Number(rest[1]);
  const start = rest[19];
  if (open < 0 || close < open || !Number.isInteger(ppid) || start === undefined) throw new Error(`/proc/${pid}/stat: unexpected format`);
  return { pid, ppid, name: stat.slice(open + 1, close), start };
}

/** pid's parent, grandparent… nearest first, stopping before pid 1. */
export function ancestors(pid: number, max = 64): ProcInfo[] {
  const out: ProcInfo[] = [];
  let info = procInfo(pid);
  while (info && info.ppid > 1 && out.length < max) {
    const parent = procInfo(info.ppid);
    if (!parent) break;
    out.push(parent);
    info = parent;
  }
  return out;
}

const SHELLS = new Set(["sh", "bash", "dash", "zsh", "fish", "ksh", "tcsh", "csh", "nu", "env"]);

/**
 * The session's own process as seen from a hook it spawned: the nearest ancestor that is not a
 * shell wrapper. Its ancestors include the terminal's shell.
 */
export function sessionProcess(fromPid = process.pid): { pid: number; start: string; ancestors: number[] } | undefined {
  const chain = ancestors(fromPid);
  const index = chain.findIndex((p) => !SHELLS.has(p.name));
  const own = chain[index];
  if (!own) return undefined;
  return { pid: own.pid, start: own.start, ancestors: chain.slice(index + 1).map((p) => p.pid) };
}

/**
 * Asks a session's own process to end (SIGTERM), only while pid is still that very process: the
 * same start time, read from /proc. Without /proc nothing is sent.
 */
export function endProcess(pid: number, start: string): void {
  const info = procInfo(pid);
  if (!info || info.start !== start) throw new Error(`process ${pid} is no longer this session's; nothing was sent`);
  process.kill(pid, "SIGTERM");
}

/** True when pid runs and, if a start time is known, is still the same process (pids get reused). */
export function isAlive(pid: number, start?: string): boolean {
  const info = procInfo(pid);
  if (info) return start === undefined || info.start === start;
  if (fs.existsSync("/proc/self")) return false;
  try {
    process.kill(pid, 0); // signal 0 only checks existence (platforms without /proc)
    return true;
  } catch (error) {
    return isCode(error, "EPERM");
  }
}
