// Measures a project's checkouts: which worktrees exist, their branches, how much disk each one takes
// and whether its work already reached the main branch. Runs git read-only; never writes to the project.
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { slug } from "../core/ids.ts";
import { BUSY_KEPT, type BranchState, type ProjectScan, type Worktree } from "../core/model.ts";
import { aheadBehind, branchHead, branchRef, changedFiles, git, isAncestor, lastCommit } from "./git.ts";
import { workingIn } from "./busy.ts";

/** Walking every file is the expensive part (about 2 minutes for 85 GB); branches are cheap. */
const SIZE_EVERY_MS = 60 * 60_000;

/** Stable id of a project in the store: readable name plus a hash of its folder. */
export function projectId(dir: string): string {
  return `${slug(path.basename(dir))}-${createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 8)}`;
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

export type ScanOptions = {
  /** Walk the checkouts' files for their sizes when due (hourly); without it, known sizes are kept and new checkouts wait. */
  sizes?: boolean;
  /** Branches the project's agents were said to work on: where each stands when no checkout has it. */
  branches?: readonly string[];
  /** Per git command. */
  timeoutMs?: number;
};

/**
 * Scans a project: its checkouts with their branch, where each stands against the main branch, its
 * uncommitted changes, last commit and the processes working in it, and their sizes; `previous`
 * carries the sizes and the day's starting total forward. A checkout whose git state cannot be read
 * says why in its `error`, and the scan goes on with the others.
 */
export async function scanProject(dir: string, previous: ProjectScan | undefined, now = new Date(), options: ScanOptions = {}): Promise<ProjectScan> {
  const { sizes = true, timeoutMs } = options;
  const listed = parseWorktreeList(await git(dir, ["worktree", "list", "--porcelain"], timeoutMs));
  const main = listed[0];
  if (!main) throw new Error(`${dir}: git lists no worktree`);
  const base = main.branch;
  const problems: string[] = [];
  const paths = new Set(listed.map((w) => path.resolve(w.path)));
  const known = new Map((previous?.worktrees ?? []).map((w) => [path.resolve(w.path), w]));
  const busy = workingIn([...paths], BUSY_KEPT);
  const worktrees: Worktree[] = [];
  for (const [i, w] of listed.entries()) {
    const isMain = i === 0;
    const before = known.get(path.resolve(w.path));
    const due = !before?.sizedAt || now.getTime() - Date.parse(before.sizedAt) >= SIZE_EVERY_MS;
    const exclude = new Set([...paths].filter((p) => p !== path.resolve(w.path)));
    const size = sizes && due ? { bytes: await diskUsage(path.resolve(w.path), exclude, problems), sizedAt: now.toISOString() } : { bytes: before?.bytes, sizedAt: before?.sizedAt };
    const entry: Worktree = { path: w.path, head: w.head, main: isMain, ...(w.branch ? { branch: w.branch } : {}) };
    if (size.bytes !== undefined && size.sizedAt !== undefined) Object.assign(entry, size);
    try {
      Object.assign(entry, await headState(dir, w.head, isMain ? undefined : base, timeoutMs));
      const own = path.resolve(w.path);
      const nested = [...paths].filter((p) => p.startsWith(`${own}/`)).map((p) => path.relative(own, p));
      entry.dirty = await changedFiles(w.path, nested, timeoutMs);
    } catch (error) {
      entry.error = (error as Error).message;
      problems.push(entry.error);
    }
    const working = busy.get(path.resolve(w.path)) ?? [];
    if (working.length) entry.busy = working;
    worktrees.push(entry);
  }
  const checkedOut = new Set(worktrees.flatMap((w) => (w.branch ? [w.branch] : [])));
  const branches: BranchState[] = [];
  for (const name of new Set(options.branches ?? [])) {
    if (checkedOut.has(name)) continue;
    branches.push(await branchState(dir, name, base, timeoutMs));
  }
  const totalBytes = worktrees.reduce((n, w) => n + (w.bytes ?? 0), 0);
  const day = now.toISOString().slice(0, 10);
  return {
    id: projectId(dir),
    name: path.basename(dir),
    dir: path.resolve(dir),
    ...(base ? { baseBranch: base } : {}),
    worktrees,
    ...(branches.length ? { branches } : {}),
    totalBytes,
    dayStart: previous && previous.dayStart.day === day ? previous.dayStart : { day, bytes: totalBytes },
    measuredAt: now.toISOString(),
    problems: problems.slice(0, 20),
  };
}

/** A head's last commit and, against the main branch when given, whether it is merged and how far ahead and behind it is. */
async function headState(dir: string, head: string, base: string | undefined, timeoutMs: number | undefined) {
  const last = await lastCommit(dir, head, timeoutMs);
  if (base === undefined) return last;
  return { ...last, merged: await isAncestor(dir, head, base, timeoutMs), ...(await aheadBehind(dir, base, head, timeoutMs)) };
}

/** Where a branch no checkout has stands; one whose name git could not take, or that is gone, does not exist. */
async function branchState(dir: string, name: string, base: string | undefined, timeoutMs: number | undefined): Promise<BranchState> {
  const ref = branchRef(name);
  if (ref === undefined) return { name, exists: false, error: `${JSON.stringify(name)} is not a branch name git takes` };
  try {
    const head = await branchHead(dir, ref, timeoutMs);
    return head === undefined ? { name, exists: false } : { name, exists: true, head, ...(await headState(dir, head, base, timeoutMs)) };
  } catch (error) {
    return { name, exists: false, error: (error as Error).message };
  }
}
