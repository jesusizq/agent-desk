// File primitives for the store: private permissions, atomic writes, per-record locks.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

/** Write via a temp file in the same directory and rename, so readers never see a partial file. */
export function writeAtomic(file: string, data: string | Uint8Array): void {
  ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    const fd = fs.openSync(tmp, "wx", FILE_MODE);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export function writeJson(file: string, value: unknown): void {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** undefined when the file does not exist; any other failure (including bad JSON) throws with the path. */
export function readJson(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${file}: not valid JSON (${(error as Error).message})`, { cause: error });
  }
}

/** Record files of a directory: visible `*.json` names only (temp and lock files start with "."). */
export function listJson(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
  return names.filter((n) => !n.startsWith(".") && n.endsWith(".json")).sort();
}

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 15_000;
const LOCK_EMPTY_MS = 1_000;

/**
 * Runs `fn` while holding an exclusive lock on `file`, so read-modify-write cycles from
 * concurrent processes (hooks, CLI, server) do not lose updates. The lock file holds a token: an
 * abandoned lock is taken over by renaming it away (only one process can), and a lock is released
 * only by the process whose token it still holds.
 */
export function withLock<T>(file: string, fn: () => T): T {
  ensureDir(path.dirname(file));
  const lock = path.join(path.dirname(file), `.${path.basename(file)}.lock`);
  const token = `${process.pid}.${randomBytes(6).toString("hex")}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx", FILE_MODE);
      try {
        fs.writeFileSync(fd, token);
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      if (isStale(lock)) {
        const away = `${lock}.stale.${token}`;
        try {
          fs.renameSync(lock, away);
          fs.rmSync(away, { force: true });
        } catch (renameError) {
          if (!isCode(renameError, "ENOENT")) throw renameError; // another process took it over first
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`${file}: still locked after ${LOCK_WAIT_MS} ms by ${lock}; remove it if no agent-desk process is running`);
      sleep(10);
    }
  }
  try {
    return fn();
  } finally {
    release(lock, token);
  }
}

function release(lock: string, token: string): void {
  let holder: string;
  try {
    holder = fs.readFileSync(lock, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return; // taken over as stale while held: nothing of ours to remove
    throw error;
  }
  if (holder === token) fs.rmSync(lock, { force: true });
}

/**
 * Abandoned: its holder's process is gone (a hook or status line killed mid-write, which Claude Code
 * does to a status line that runs late), it was never given a token, or it is older than any write.
 */
function isStale(lock: string): boolean {
  let age: number;
  let holder: string;
  try {
    age = Date.now() - fs.statSync(lock).mtimeMs;
    holder = fs.readFileSync(lock, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return false; // released between the failed open and this check
    throw error;
  }
  if (age > LOCK_STALE_MS) return true;
  // A live holder writes its token right after creating the file.
  if (holder === "") return age > LOCK_EMPTY_MS;
  const pid = Number(holder.split(".")[0]);
  return Number.isInteger(pid) && pid > 0 && !isRunning(pid);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isCode(error, "ESRCH"); // EPERM: it runs, as another user
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

export function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
