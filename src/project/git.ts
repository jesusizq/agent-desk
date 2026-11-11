// Reads a repository's state with git, read-only: fixed argument lists, no shell, no optional locks
// (so `git status` never refreshes the index), a timeout, and errors that say which command failed where.
import { execFile } from "node:child_process";

export const GIT_TIMEOUT_MS = 10_000;

/** A git command that failed, timed out or could not start; `code` is git's exit code when it ran. */
export class GitError extends Error {
  override name = "GitError";
  readonly code: number | undefined;
  constructor(message: string, code: number | undefined) {
    super(message);
    this.code = code;
  }
}

/** Runs `git -C <dir> --no-optional-locks <args>` and returns its stdout. */
export function git(dir: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", dir, "--no-optional-locks", ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const command = `git ${args.join(" ")} in ${dir}`;
      const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (e.killed) return reject(new GitError(`${command} did not finish within ${timeoutMs / 1000} s and was stopped; a large or busy repository, or a git hook that waits`, undefined));
      if (typeof e.code === "string") return reject(new GitError(`${command} could not start (${e.code}): is git installed and on PATH?`, undefined));
      const said = stderr.trim().split("\n")[0] ?? "";
      reject(new GitError(`${command} failed (exit ${e.code ?? "?"})${said ? `: ${said}` : ""}`, typeof e.code === "number" ? e.code : undefined));
    });
  });
}

/** Whether `ancestor` is in `head`'s history; git answers "no" with exit code 1. */
export async function isAncestor(dir: string, ancestor: string, head: string, timeoutMs?: number): Promise<boolean> {
  try {
    await git(dir, ["merge-base", "--is-ancestor", ancestor, head], timeoutMs);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.code === 1) return false; // the documented "no" answer
    throw error;
  }
}

/** Where `head` stands against `base`: commits only it has (ahead) and commits only base has (behind). */
export async function aheadBehind(dir: string, base: string, head: string, timeoutMs?: number): Promise<{ ahead: number; behind: number }> {
  const out = (await git(dir, ["rev-list", "--left-right", "--count", `${base}...${head}`], timeoutMs)).trim();
  const m = /^(\d+)\s+(\d+)$/.exec(out);
  if (!m) throw new GitError(`git rev-list --left-right --count ${base}...${head} in ${dir} answered ${JSON.stringify(out)}, not two counts`, undefined);
  return { behind: Number(m[1]), ahead: Number(m[2]) };
}

/** The subject and commit time (ISO, UTC) of a commit. */
export async function lastCommit(dir: string, rev: string, timeoutMs?: number): Promise<{ subject: string; committedAt: string }> {
  const out = await git(dir, ["log", "-1", "--no-show-signature", "--format=%ct%x00%s", rev, "--"], timeoutMs);
  const [seconds, subject = ""] = out.replace(/\n$/, "").split("\0");
  const at = Number(seconds);
  if (!Number.isFinite(at) || at <= 0) throw new GitError(`git log -1 ${rev} in ${dir} gave no commit time`, undefined);
  return { subject: subject.length > 200 ? `${subject.slice(0, 199)}…` : subject, committedAt: new Date(at * 1000).toISOString() };
}

/**
 * Changed files of a checkout (staged, unstaged and untracked, ignored ones left out): 0 when clean.
 * `nested`: folders of other checkouts inside it, relative to it, which would show as untracked.
 */
export async function changedFiles(dir: string, nested: readonly string[] = [], timeoutMs?: number): Promise<number> {
  const exclude = nested.length ? ["--", ".", ...nested.map((n) => `:(exclude,literal)${n}`)] : [];
  const out = await git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", ...exclude], timeoutMs);
  // -z: one NUL after each entry; a rename carries its old path as one more NUL-terminated field.
  let n = 0;
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? "";
    if (entry === "") continue;
    n++;
    if (/^[RC]/.test(entry)) i++;
  }
  return n;
}

/**
 * A branch name a session reported, safe to hand git: a ref name that cannot read as an option or a
 * revision range. Undefined for anything else, which no checkout can then match either.
 */
export function branchRef(name: string): string | undefined {
  const ok = /^[A-Za-z0-9._/+-]{1,200}$/.test(name) && !name.startsWith("-") && !name.startsWith("/") && !name.endsWith("/") && !name.endsWith(".lock") && !name.includes("..") && !name.includes("//");
  return ok ? `refs/heads/${name}` : undefined;
}

/** The commit a branch points at, or undefined when there is no such branch. */
export async function branchHead(dir: string, ref: string, timeoutMs?: number): Promise<string | undefined> {
  try {
    return (await git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], timeoutMs)).trim();
  } catch (error) {
    if (error instanceof GitError && error.code === 1) return undefined; // --quiet --verify: no such ref
    throw error;
  }
}
