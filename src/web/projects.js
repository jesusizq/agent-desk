// @ts-check
// Projects: their worktrees on disk, what can go and what is still open.
import { dialog, h, icon } from "./dom.js";
import { TEXT } from "./text.js";
import { ago, clockAt, gb } from "./format.js";
import { copy, dialogHead, projectMark } from "./pieces.js";
import { data, ui } from "./state.js";

/** @typedef {import("../core/protocol.ts").Session} Session */
/** @typedef {import("../core/protocol.ts").ProjectScan} ProjectScan */
/** @typedef {import("../core/protocol.ts").Worktree} Worktree */
/** @typedef {import("../core/protocol.ts").ProjectResumes} ProjectResumes */
/** @typedef {import("../core/protocol.ts").ResumeNote} ResumeNote */

const WARN_BYTES = 5e9;
/** @param {Worktree[]} ws */
export const sum = (ws) => ws.reduce((n, w) => n + (w.bytes ?? 0), 0);
/** @param {ProjectScan} p */
export const mergedOf = (p) => p.worktrees.filter((w) => !w.main && w.merged);
export const projectsInView = () => data.projects.filter((p) => ui.project === null || p.name === ui.project);
/** @param {Session} s */
export const projectOf = (s) => data.projects.find((p) => p.dir === s.project.dir);
/** The branch its main checkout is on, which the others are compared against. @param {ProjectScan | undefined} p */
const baseOf = (p) => p?.baseBranch ?? "main";
/** @param {Session} s */
export const baseBranchOf = (s) => baseOf(projectOf(s));
/** Worth a chip: a lot to reclaim, or a lot of growth today. @param {ProjectScan} p */
export const worthWarning = (p) => sum(mergedOf(p)) > WARN_BYTES || p.totalBytes - p.dayStart.bytes > WARN_BYTES;

/** A project's checkouts: what is already merged (and can go), what is not, and the main one. @param {string} projectId */
export function openProject(projectId) {
  const p = data.projects.find((x) => x.id === projectId);
  if (!p) return;
  ui.panelSession = null;
  const d = dialog("session");
  const t = TEXT.worktrees;
  const base = baseOf(p);
  const merged = mergedOf(p).sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  const open = p.worktrees.filter((w) => !w.main && !w.merged).sort((a, b) => (b.ahead ?? 0) - (a.ahead ?? 0));
  const main = p.worktrees.filter((w) => w.main);
  const name = (/** @type {Worktree} */ w) => w.path.split("/").at(-1) ?? w.path;
  /** @param {Worktree[]} ws @param {(w: Worktree) => string} note */
  const rows = (ws, note) =>
    h("div", { class: "alist wt-list" }, ws.map((w) => h("div", { class: "arow", title: w.path }, h("span", { class: "awhat" }, h("span", { class: "agoal" }, w.branch ?? t.detached), h("span", { class: "adoing" }, `${name(w)} · ${note(w)}`)), h("span", { class: "num faint" }, w.bytes === undefined ? t.notMeasured : gb(w.bytes)))));
  const grew = p.totalBytes - p.dayStart.bytes;
  const cleanup = cleanupCommands(p.dir, merged);
  d.replaceChildren(
    dialogHead(d, projectMark(p.name), t.title),
    h(
      "div",
      { class: "dbody" },
      h("div", { class: "status" }, h("span", {}, t.summary(gb(p.totalBytes), grew > 1e8 ? gb(grew) : "", ago(p.measuredAt)))),
      merged.length
        ? h("div", { class: "rsec" }, h("h4", {}, t.merged(base, merged.length, gb(sum(merged)))), rows(merged, (w) => (w.cherryPicked ? t.picked : "")), h("div", { class: "row wt-actions" }, h("button", { class: "secondary", onclick: () => copy(cleanup) }, icon("copy"), t.copyCleanup), h("span", { class: "faint" }, t.cleanupNote)))
        : null,
      open.length ? h("div", { class: "rsec" }, h("h4", {}, t.open(open.length)), rows(open, (w) => (w.ahead !== undefined ? t.ahead(w.ahead) : ""))) : null,
      h("div", { class: "rsec" }, h("h4", {}, t.main), rows(main, (w) => w.branch ?? "")),
      p.problems.length ? h("div", { class: "rsec faint" }, p.problems.join("\n")) : null,
    ),
  );
  if (!d.open) d.showModal();
}

/** A project's notes that can still be loaded: one past its end is hidden even when no hook ran since. @param {ProjectResumes} p */
export const pendingNotes = (p) => p.notes.filter((n) => Date.parse(n.expiresAt) > Date.now());
/**
 * The projects shown that have work left for a new conversation: under a project's filter, those of
 * its name and those its sessions' adapters file their notes under (a subfolder's, its repository's).
 */
export function resumesInView() {
  const filed = new Set(data.sessions.flatMap((s) => (s.project.name === ui.project && s.resumesId ? [s.resumesId] : [])));
  return data.resumes.filter((p) => (ui.project === null || p.name === ui.project || filed.has(p.id)) && pendingNotes(p).length > 0);
}

/**
 * Pending handoffs, newest first: what each is about, its age, until when it is offered, and the
 * command that loads it, copied with a click. Of one project, or without one, of every project in
 * view, each under its name. @param {string} [projectId]
 */
export function openResumes(projectId) {
  const projects = projectId === undefined ? resumesInView() : data.resumes.filter((x) => x.id === projectId);
  const [one] = projects;
  if (!one) return;
  ui.panelSession = null;
  const d = dialog("session");
  const t = TEXT.resumes;
  const single = projects.length === 1;
  /** @param {ProjectResumes} p */
  const list = (p) =>
    h(
      "div",
      { class: "alist resume-list" },
      pendingNotes(p).map((n) =>
        h(
          "div",
          { class: "arow resume" },
          h("span", { class: "awhat" }, h("span", { class: "agoal" }, n.title ?? t.untitled), h("span", { class: "adoing" }, t.written(ago(n.writtenAt), clockAt(n.expiresAt)))),
          h("button", { class: "secondary", title: t.copy, onclick: () => copy(n.command) }, icon("copy"), h("code", {}, n.command)),
        ),
      ),
    );
  d.replaceChildren(
    dialogHead(d, single ? projectMark(one.name) : "", t.title),
    h(
      "div",
      { class: "dbody" },
      h("div", { class: "status" }, h("span", {}, t.note(single ? one.name : undefined))),
      single ? list(one) : projects.map((p) => h("div", { class: "rsec resume-project" }, h("h4", {}, projectMark(p.name)), list(p))),
    ),
  );
  if (!d.open) d.showModal();
}

/**
 * Commands that remove merged checkouts, one line each, every step only once the one before
 * succeeded: a check that the checkout's own HEAD, and its branch when it has one, still point at the
 * head the scan found merged (else the line says on stderr which checkout it kept, and fails), the
 * worktree (git refuses one with changes), then its branch (`branch -D` for one landed by
 * cherry-pick). Paths and names come from git's own listing; quoted for the shell.
 * @param {string} dir @param {Worktree[]} merged
 */
export function cleanupCommands(dir, merged) {
  const q = (/** @type {string} */ s) => `'${s.replace(/'/g, "'\\''")}'`;
  const g = `git -C ${q(dir)}`;
  const at = (/** @type {string} */ tip, /** @type {string} */ head) => `test "$(${tip})" = ${q(head)}`;
  return merged
    .map((w) => {
      const checks = [at(`git -C ${q(w.path)} rev-parse HEAD`, w.head), ...(w.branch ? [at(`${g} rev-parse ${q(`refs/heads/${w.branch}`)}`, w.head)] : [])];
      const kept = `{ printf '%s\\n' ${q(TEXT.worktrees.kept(w.path, w.head))} >&2; false; }`;
      const remove = `${checks.join(" && ")} || ${kept} && ${g} worktree remove ${q(w.path)}`;
      return w.branch ? `${remove} && ${g} branch ${w.cherryPicked ? "-D" : "-d"} ${q(w.branch)}` : remove;
    })
    .join("\n");
}
