// The developer's pending handoffs (the `ahorro` plugin's `/ahorro:handoff`), as resume notes of
// their project: read-only, only the objective's first line of each leaves the file.
import * as fs from "node:fs";
import * as path from "node:path";
import { CONTROL } from "../../src/core/check.ts";
import { RESUME_NOTES_MAX, RESUME_TITLE_MAX, type ResumeNote } from "../../src/core/model.ts";
import { gitDirs, locateProject } from "../../src/project/locate.ts";
import { projectId } from "../../src/project/scan.ts";
import { isCode } from "../../src/store/fsx.ts";
import type { Store } from "../../src/store/store.ts";

/** The plugin offers a handoff while it is younger than this, by its file's modification time. */
export const HANDOFF_PENDING_MS = 48 * 3600_000;
/** What loads a pending handoff; with several, followed by its number, newest first from 1. */
export const LOAD_COMMAND = "/ahorro:handoff-load";
/** The objective sits in the first lines; the rest of a handoff is never read. */
const HEAD_BYTES = 16 * 1024;

/** `<XDG_CACHE_HOME or ~/.cache>/claude-handoffs`, as the plugin resolves it; undefined without an absolute base. */
export function handoffRoot(env: NodeJS.ProcessEnv): string | undefined {
  const xdg = env.XDG_CACHE_HOME;
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, "claude-handoffs");
  return env.HOME && path.isAbsolute(env.HOME) ? path.join(env.HOME, ".cache", "claude-handoffs") : undefined;
}

/** Whether `file` lies inside the handoff folders: a write there may have added one. */
export function inHandoffs(file: string, env: NodeJS.ProcessEnv): boolean {
  const root = handoffRoot(env);
  if (!root) return false;
  const rel = path.relative(root, path.resolve(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** The first line with text after the heading that names the objective, or else the first line with text, as the plugin reads it. */
export function objective(head: string): string | undefined {
  const lines = head.split(/\r?\n/).map((l) => l.trim());
  const body = (l: string) => l !== "" && !l.startsWith("#");
  const heading = lines.findIndex((l) => l.startsWith("#") && fold(l).includes("objetivo"));
  const found = (heading >= 0 ? lines.slice(heading + 1).find(body) : undefined) ?? lines.find(body);
  if (found === undefined) return undefined;
  const one = found.replace(new RegExp(CONTROL.source, "gu"), " ").trim();
  return one.length > RESUME_TITLE_MAX ? `${one.slice(0, RESUME_TITLE_MAX - 1)}…` : one || undefined;
}

function readHead(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.subarray(0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0)).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The project's pending handoffs, newest first, numbered as the plugin numbers them: unused (`.md`;
 * a loaded one is renamed `.md.usado`) and younger than 48 h. A file that cannot be read is reported.
 */
export function pendingHandoffs(root: string, project: string, now: Date, problems: string[]): ResumeNote[] {
  // The project's name becomes one path segment: nothing that could climb out of the handoff folder.
  if (project === "" || project === "." || project === ".." || /[/\\\0]/.test(project)) return [];
  const dir = path.join(root, project);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return []; // no handoff was ever written for it
    problems.push(`could not list the handoffs in ${dir}: ${(error as Error).message}`);
    return [];
  }
  const found: { file: string; mtime: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(dir, name);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(file, { throwIfNoEntry: false });
    } catch (error) {
      problems.push(`could not read the handoff ${file}: ${(error as Error).message}`);
      continue;
    }
    if (!stat?.isFile()) continue; // loaded (renamed) or removed since the listing, or not a file
    if (now.getTime() - stat.mtimeMs < HANDOFF_PENDING_MS) found.push({ file, mtime: stat.mtimeMs });
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const several = found.length > 1;
  return found.slice(0, RESUME_NOTES_MAX).flatMap(({ file, mtime }, i): ResumeNote[] => {
    let title: string | undefined;
    try {
      title = objective(readHead(file));
    } catch (error) {
      problems.push(`could not read the handoff ${file}: ${(error as Error).message}`);
    }
    const note = { writtenAt: new Date(mtime).toISOString(), expiresAt: new Date(mtime + HANDOFF_PENDING_MS).toISOString(), command: several ? `${LOAD_COMMAND} ${i + 1}` : LOAD_COMMAND };
    return [title ? { title, ...note } : note];
  });
}

/**
 * The folder a session working in `dir` keeps its handoffs under, named as the plugin names it from
 * git: the main checkout, when git's common dir is its `.git` folder (from a subfolder or a linked
 * worktree too), else the checkout itself (a bare repository's worktree, a submodule), symlinks
 * resolved as git resolves them; outside git, the folder itself as given.
 */
export function handoffHome(dir: string): string {
  const git = gitDirs(dir);
  if (git === undefined) return path.resolve(dir);
  return path.basename(git.common) === ".git" ? path.dirname(git.common) : git.top;
}

/** The handoff folder's name for a session working in `dir`. */
export const handoffFolder = (dir: string): string => path.basename(handoffHome(dir));

/** The id of the record a session working in `dir` files its pending handoffs under. */
export const resumesIdOf = (dir: string): string => projectId(handoffHome(dir));

/**
 * Records the pending handoffs a session working in `dir` can load as the resume notes of the folder
 * they are named after, one record per handoff folder whichever subfolder or worktree the session
 * works in, so each has one list, numbered as now. Writes only when they changed, so an unchanged list
 * costs the page nothing. The page hides a note once it expires, with no hook running.
 */
export function refreshResumes(dir: string, store: Store, env: NodeJS.ProcessEnv, problems: string[], now = new Date()): void {
  const root = handoffRoot(env);
  if (!root) return;
  const home = handoffHome(dir);
  const folder = path.basename(home);
  const id = projectId(home);
  store.refreshResumes({ id, name: folder || home, dir: home }, () => pendingHandoffs(root, folder, now, problems), problems, now);
  // A record under the session's own project (a subfolder, a path through a symlink) listing this
  // folder keeps its numbering from before a later load, so its "load 1" loads another: emptied, so removed.
  const own = locateProject(dir);
  if (projectId(own.dir) === id) return;
  store.refreshResumes({ id: projectId(own.dir), name: own.name, dir: own.dir }, (stale) => (stale && handoffHome(stale.dir) !== home ? stale.notes : []), problems, now);
}
