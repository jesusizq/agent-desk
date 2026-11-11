// @ts-check
// Projects: their worktrees on disk, what can go and what is still open.
import { dialog, h, icon } from "./dom.js";
import { TEXT } from "./text.js";
import { ago, gb } from "./format.js";
import { copy, dialogHead, projectMark } from "./pieces.js";
import { data, ui } from "./state.js";

/** @typedef {import("../core/protocol.ts").Session} Session */
/** @typedef {import("../core/protocol.ts").ProjectScan} ProjectScan */
/** @typedef {import("../core/protocol.ts").Worktree} Worktree */

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
  // Paths come from git's own listing; quoted for the shell the developer pastes them into.
  const cleanup = merged.map((w) => `git -C '${p.dir.replace(/'/g, "'\\''")}' worktree remove '${w.path.replace(/'/g, "'\\''")}'`).join("\n");
  d.replaceChildren(
    dialogHead(d, projectMark(p.name), t.title),
    h(
      "div",
      { class: "dbody" },
      h("div", { class: "status" }, h("span", {}, t.summary(gb(p.totalBytes), grew > 1e8 ? gb(grew) : "", ago(p.measuredAt)))),
      merged.length
        ? h("div", { class: "rsec" }, h("h4", {}, t.merged(base, merged.length, gb(sum(merged)))), rows(merged, () => ""), h("div", { class: "row wt-actions" }, h("button", { class: "secondary", onclick: () => copy(cleanup) }, icon("copy"), t.copyCleanup), h("span", { class: "faint" }, t.cleanupNote)))
        : null,
      open.length ? h("div", { class: "rsec" }, h("h4", {}, t.open(open.length)), rows(open, (w) => (w.ahead !== undefined ? t.ahead(w.ahead) : ""))) : null,
      h("div", { class: "rsec" }, h("h4", {}, t.main), rows(main, (w) => w.branch ?? "")),
      p.problems.length ? h("div", { class: "rsec faint" }, p.problems.join("\n")) : null,
    ),
  );
  if (!d.open) d.showModal();
}
