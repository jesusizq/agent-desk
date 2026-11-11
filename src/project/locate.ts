// Which project a session's folder belongs to: a linked git worktree belongs to its repository's main
// checkout. Reads git's own files, read-only; runs no git command and never writes to the project.
import * as fs from "node:fs";
import * as path from "node:path";
import { branchRef } from "./git.ts";

export type ProjectLocation = { name: string; dir: string; worktree?: string };

/**
 * The project of `dir`: the folder itself, or, inside a linked worktree, the same folder of the
 * repository's main checkout, with `worktree` the folder the session works in.
 */
export function locateProject(dir: string): ProjectLocation {
  const own = path.resolve(dir);
  const main = mainCheckoutOf(own);
  if (main === undefined || main === own) return { name: path.basename(dir) || dir, dir };
  return { name: path.basename(main) || main, dir: main, worktree: own };
}

/**
 * The main checkout's counterpart of `dir` when the nearest `.git` above it is a linked worktree's
 * (a file naming `<common>/worktrees/<name>`, which holds `commondir`); undefined for anything else:
 * a main checkout, a submodule (its gitdir has no `commondir`), a worktree of a bare repository (no
 * main checkout), or git files that are missing, unreadable or inconsistent.
 */
function mainCheckoutOf(dir: string): string | undefined {
  for (let at = dir; ; at = path.dirname(at)) {
    const dotGit = path.join(at, ".git");
    const stat = statOrUndefined(dotGit);
    if (stat?.isDirectory()) return undefined;
    if (stat?.isFile()) {
      const main = linkedMain(at, dotGit);
      return main === undefined ? undefined : path.join(main, path.relative(at, dir));
    }
    if (stat || path.dirname(at) === at) return undefined;
  }
}

/**
 * The branch checked out in the checkout holding `dir`, as its git HEAD names it (`ref:
 * refs/heads/<name>`); undefined when its head is detached (a rebase, a bisect), its git files cannot
 * be read, or the name is not a plain branch name.
 */
export function checkedOutBranch(dir: string): string | undefined {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    const dotGit = path.join(at, ".git");
    const stat = statOrUndefined(dotGit);
    if (stat) {
      const pointer = stat.isFile() ? /^gitdir: (.+)$/m.exec(readSmall(dotGit) ?? "")?.[1]?.trim() : dotGit;
      if (!pointer) return undefined;
      const name = /^ref: refs\/heads\/(\S+)\s*$/.exec(readSmall(path.join(path.resolve(at, pointer), "HEAD")) ?? "")?.[1];
      return name !== undefined && branchRef(name) !== undefined ? name : undefined;
    }
    if (path.dirname(at) === at) return undefined;
  }
}

function linkedMain(worktree: string, dotGit: string): string | undefined {
  const pointer = /^gitdir: (.+)$/m.exec(readSmall(dotGit) ?? "")?.[1]?.trim();
  if (!pointer) return undefined;
  const gitdir = path.resolve(worktree, pointer);
  const common = readSmall(path.join(gitdir, "commondir"))?.trim();
  if (!common) return undefined;
  const commonDir = path.resolve(gitdir, common);
  const back = readSmall(path.join(gitdir, "gitdir"))?.trim();
  // The worktree's gitdir lives in the common dir and points back at this very worktree.
  if (!back || !samePlace(path.dirname(gitdir), path.join(commonDir, "worktrees"))) return undefined;
  if (!samePlace(path.resolve(gitdir, back), dotGit)) return undefined;
  // A main checkout's common dir is its `.git` folder; any other (a bare repository) has no checkout.
  if (path.basename(commonDir) !== ".git") return undefined;
  const main = path.dirname(commonDir);
  if (!statOrUndefined(path.join(main, ".git"))?.isDirectory() || !samePlace(path.join(main, ".git"), commonDir)) return undefined;
  return real(main);
}

const SMALL_MAX = 4096;

// Every git file read here is optional evidence: one that cannot be read means "not a linked
// worktree", and the session's own folder stays its project.
function readSmall(file: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return undefined; // missing or unreadable: not a linked worktree (see above)
  }
  try {
    const buffer = Buffer.alloc(SMALL_MAX);
    const length = fs.readSync(fd, buffer, 0, SMALL_MAX, 0);
    return buffer.toString("utf8", 0, length);
  } catch {
    return undefined; // a folder or a vanished file in place of git's file: not a linked worktree
  } finally {
    fs.closeSync(fd);
  }
}

function statOrUndefined(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined; // absent (or a dangling link): look further up, or give up at the root
  }
}

/** Both paths exist and resolve to the same place, symlinks followed. */
function samePlace(a: string, b: string): boolean {
  const ra = real(a);
  return ra !== undefined && ra === real(b);
}

function real(file: string): string | undefined {
  try {
    return fs.realpathSync(file);
  } catch {
    return undefined; // does not resolve: samePlace fails, and the folder stays its own project
  }
}
