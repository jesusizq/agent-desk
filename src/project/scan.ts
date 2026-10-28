// Measures a project's checkouts: which worktrees exist, their branches, how much disk each one takes
// and whether its work already reached the main branch. Runs git read-only; never writes to the project.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { slug } from "../core/ids.ts";
import type { ProjectScan, Worktree } from "../core/model.ts";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
/** Walking every file is the expensive part (about 2 minutes for 85 GB); branches are cheap. */
const SIZE_EVERY_MS = 60 * 60_000;

/** Stable id of a project in the store: readable name plus a hash of its folder. */
export function projectId(dir: string): string {
  return `${slug(path.basename(dir))}-${createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 8)}`;
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", dir, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

type Listed = { path: string; head: string; branch?: string };

/** `git worktree list --porcelain`: blocks of "worktree", "HEAD", "branch" or "detached" lines. */
export function parseWorktreeList(text: string): Listed[] {
  const out: Listed[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const wt = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    const head = lines.find((l) => l.startsWith("HEAD "))?.slice("HEAD ".length);
    const branch = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length).replace(/^refs\/heads\//, "");
    if (wt && head) out.push(branch ? { path: wt, head, branch } : { path: wt, head });
  }
  return out;
}

/**
 * Bytes under `dir`, not following symlinks and skipping `exclude` (other worktrees nested inside
 * the main checkout, so nothing is counted twice). Unreadable entries go to `problems`.
 */
export async function diskUsage(dir: string, exclude: Set<string>, problems: string[]): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      problems.push(`${current}: ${(error as Error).message}`);
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!exclude.has(full)) stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += (await fs.lstat(full)).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${full}: ${(error as Error).message}`); // ENOENT: removed while walking
        }
      }
    }
  }
  return total;
}

/** Scans a project; `previous` carries the day's starting total forward. */
export async function scanProject(dir: string, previous: ProjectScan | undefined, now = new Date()): Promise<ProjectScan> {
  const listed = parseWorktreeList(await git(dir, "worktree", "list", "--porcelain"));
  const main = listed[0];
  if (!main) throw new Error(`${dir}: git lists no worktree`);
  const problems: string[] = [];
  const paths = new Set(listed.map((w) => path.resolve(w.path)));
  const worktrees: Worktree[] = [];
  const known = new Map((previous?.worktrees ?? []).map((w) => [path.resolve(w.path), w]));
  for (const [i, w] of listed.entries()) {
    const isMain = i === 0;
    const before = known.get(path.resolve(w.path));
    const fresh = before && now.getTime() - Date.parse(before.sizedAt) < SIZE_EVERY_MS;
    const exclude = new Set([...paths].filter((p) => p !== path.resolve(w.path)));
    const bytes = fresh ? before.bytes : await diskUsage(path.resolve(w.path), exclude, problems);
    const sizedAt = fresh ? before.sizedAt : now.toISOString();
    const entry: Worktree = { path: w.path, head: w.head, bytes, sizedAt, main: isMain, ...(w.branch ? { branch: w.branch } : {}) };
    if (!isMain && main.branch) {
      entry.merged = await git(dir, "merge-base", "--is-ancestor", w.head, main.branch).then(
        () => true,
        (error: { code?: number }) => {
          if (error.code === 1) return false; // not an ancestor: the documented "no" answer
          throw error;
        },
      );
      entry.ahead = Number((await git(dir, "rev-list", "--count", `${main.branch}..${w.head}`)).trim());
    }
    worktrees.push(entry);
  }
  const totalBytes = worktrees.reduce((n, w) => n + w.bytes, 0);
  const day = now.toISOString().slice(0, 10);
  return {
    id: projectId(dir),
    name: path.basename(dir),
    dir: path.resolve(dir),
    ...(main.branch ? { baseBranch: main.branch } : {}),
    worktrees,
    totalBytes,
    dayStart: previous && previous.dayStart.day === day ? previous.dayStart : { day, bytes: totalBytes },
    measuredAt: now.toISOString(),
    problems: problems.slice(0, 20),
  };
}
