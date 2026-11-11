// @ts-check
// A session's agents: whether they are stuck, what they do, their rows and the flow between them.
import { h, icon, svgEl } from "./dom.js";
import { TEXT } from "./text.js";
import { ago, hm } from "./format.js";
import { dot } from "./pieces.js";
import { openProject } from "./projects.js";
import { S, agentOf, data, waitingOn } from "./state.js";

/** @typedef {import("../core/protocol.ts").Session} Session */
/** @typedef {import("../core/protocol.ts").Agent} Agent */
/** @typedef {import("../core/protocol.ts").BranchRow} BranchRow */

const ATTENTION = ["failed", "blocked", "idle", "working", "waiting", "done"];

/** At work, but its latest call started a job of its own or waits for one: waiting on it. @param {Agent | Session} x */
const onItsJob = (x) => x.state === "working" && x.waitsForJob === true;
/** One dot per agent says the shape of a session at a glance. `words`: its tooltip holds no tool call. @param {Agent} a @param {boolean} [words] */
export function agentDot(a, words = false) {
  const st = onItsJob(a) ? "waiting" : a.state;
  const mark = dot(st);
  mark.title = [a.name, TEXT.state[st], words ? spoken(a) : a.activity].filter(Boolean).join(" · ");
  return st === "working" ? h("span", { class: "live" }, mark) : mark;
}
/** The session itself at work, before its agents' dots, or waiting on its own job. @param {Session} s */
export function sessionDot(s) {
  if (onItsJob(s)) return dot("waiting");
  const mark = dot("working");
  mark.title = TEXT.sessionWorking;
  return h("span", { class: "live" }, mark);
}
/** The agents a blocked agent still waits for, by their goals, or null when it waits for none. @param {Agent} a */
function waitsLine(a) {
  const waits = waitingOn(a);
  return waits.length ? TEXT.waits(waits.map((n) => agentOf(a.sessionId, n)?.goal ?? n).join(", ")) : null;
}
/** What an agent does now: who it waits for, its latest tool call, or what kind of agent it is. @param {Agent} a */
export function agentDoing(a) {
  return waitsLine(a) ?? a.activity ?? (a.type ? TEXT.agentType(a.type) : "");
}
/**
 * Why an agent is in trouble, in a few words. `words`: only what the session or the adapter wrote,
 * never a tool call. @param {Agent} a @param {boolean} [words]
 */
export function troubleText(a, words = false) {
  if (a.state === "failed") return (words ? spoken(a) : a.activity) ?? TEXT.failedAgent;
  return waitsLine(a) ?? TEXT.idleSince(hm(a.updatedAt));
}
/** Its activity as words someone wrote; of a tool call, only how far it has got ("9/14"). @param {Agent | Session} x */
export const spoken = (x) => (x.activityIsCall ? (progressOf(x.activity) ?? undefined) : x.activity);
/** What an agent is at, for a card that shows no tool calls: why it is in trouble, or what it was said to do. @param {Agent} a */
export function agentGist(a) {
  if (a.state === "failed" || a.state === "blocked" || a.state === "idle") return troubleText(a, true);
  return spoken(a) ?? (onItsJob(a) ? TEXT.state.waiting : "");
}
/** How long it has run, or how long it took. @param {Agent} a */
export const agentAge = (a) => (a.endedAt ? TEXT.tookFor(ago(a.startedAt, a.endedAt)) : ago(a.startedAt));
// An agent or session at work with no tool call for this long, and no job of its own to wait on, may be stuck.
const QUIET_MS = 5 * 60_000;
/** Minutes since `at`, once past QUIET_MS; otherwise 0. @param {string} at */
const quietMinutes = (at) => {
  const ms = Date.now() - Date.parse(at);
  return ms >= QUIET_MS ? Math.floor(ms / 60_000) : 0;
};
/**
 * A working agent quiet for a while: minutes, or 0. Only an agent whose adapter stamps its tool
 * calls can be quiet: an older adapter's agents carry no such stamp, and their last update says nothing.
 * @param {Agent} a
 */
export const agentQuiet = (a) => (a.state === "working" && a.activityAt && !onItsJob(a) ? quietMinutes(a.activityAt) : 0);
/** Its tool calls that failed in a row: any successful call ends the streak. @param {Agent | Session} x */
export const failedInARow = (x) => x.failedAt?.length ?? 0;
/** At work and its calls keep failing: two in a row is a retry, three is a pattern. @param {Agent | Session} x */
export const failing = (x) => x.state === "working" && failedInARow(x) >= 3;
/** The call that keeps failing, kept for a tooltip: it is not printed in the line. @param {Agent | Session} x */
export const failingTip = (x) => (x.failedWhat ? TEXT.lastFailed(x.failedWhat) : undefined);
/**
 * Why a working agent may be stuck (quiet, or failing its calls in a row), with the call that keeps
 * failing for a tooltip; null while it is not. @param {Agent} a
 */
export function stuckNote(a) {
  const quiet = agentQuiet(a);
  const fails = failing(a);
  if (!quiet && !fails) return null;
  return { text: [quiet ? TEXT.quietFor(quiet) : "", fails ? TEXT.failingCalls(failedInARow(a)) : ""].filter(Boolean).join(" · "), tip: fails ? failingTip(a) : undefined };
}
/**
 * It failed, and its session has not ended a turn since: once one has, the session has seen the
 * failure and told the developer, and the agent is one more failed row in its list. Blocked, idle
 * and stuck agents get no such end: they are still open, and may need a look after any turn.
 * @param {Agent} a
 */
export const failedUnseen = (a) => {
  const turnEnded = S(a.sessionId)?.turnEndedAt;
  return a.state === "failed" && (turnEnded === undefined || Date.parse(a.endedAt ?? a.updatedAt) > Date.parse(turnEnded));
};
/** It needs a look: failed since its session's last turn, blocked, idle, or at work and maybe stuck. @param {Agent} a */
export const inTrouble = (a) => failedUnseen(a) || a.state === "blocked" || a.state === "idle" || stuckNote(a) !== null;
/**
 * A working session none of whose own calls nor working agents' has moved for a while: minutes, or 0.
 * Never while it, or one of its working agents, waits on a job of its own. @param {Session} s
 */
export function sessionQuiet(s) {
  if (s.state !== "working" || !s.activityAt || onItsJob(s)) return 0;
  const working = sessionAgents(s.id).filter((a) => a.state === "working");
  if (working.some((a) => !a.activityAt || onItsJob(a))) return 0; // an agent that cannot be timed may well be busy
  const last = [s.activityAt, ...working.map((a) => a.activityAt ?? "")].sort().at(-1);
  return last ? quietMinutes(last) : 0;
}
/** @param {string} sid */
export const sessionAgents = (sid) => data.agents.filter((a) => a.sessionId === sid).sort((a, b) => ATTENTION.indexOf(a.state) - ATTENTION.indexOf(b.state));

/**
 * One row per agent on a common time axis: its goal, the sentence saying what it must deliver, what it
 * does now (or how it ended) and a bar from its start to now or its end. Branch, commit and tokens
 * wait in the tooltip. @param {Session} s
 */
function agentList(s) {
  const rows = sessionAgents(s.id);
  return rows.length ? agentRows(rows, timeAxis(rows)) : h("div", { class: "faint" }, TEXT.noAgents);
}

/**
 * How far an agent's step has got, when its activity says so in a form that means nothing else:
 * "(9/14)", "212/340" or "9 of 14"; never a path, a date or a version. @param {string | undefined} text
 */
export function progressOf(text) {
  const m = /(?<![\w./:-])(\d{1,6})(?:\/| of )(\d{1,6})(?![\w./:-])/.exec(text ?? "");
  const done = Number(m?.[1]);
  const total = Number(m?.[2]);
  return m && total > 0 && done <= total ? `${done}/${total}` : null;
}

/** @typedef {{ from: number, to: number, ticks: number[], open: boolean }} Axis */
// Tick steps in minutes: the smallest that leaves at most five ticks on the axis.
const STEPS = [5, 10, 15, 30, 60, 120, 240, 480, 720, 1440];
/** The span the agents ran in: from the first start to now, or to the last end once all ended. @param {Agent[]} rows @returns {Axis} */
function timeAxis(rows) {
  const open = rows.some((a) => !a.endedAt);
  const from = Math.min(...rows.map((a) => Date.parse(a.startedAt)));
  const to = Math.max(from + 60_000, open ? Date.now() : Math.max(...rows.map((a) => Date.parse(a.endedAt ?? a.startedAt))));
  const step = (STEPS.find((m) => (to - from) / (m * 60_000) <= 5) ?? 1440) * 60_000;
  // On the local clock's round times, kept off the axis' ends, where a label would not fit.
  const zone = new Date(from).getTimezoneOffset() * 60_000;
  const ticks = [];
  for (let t = Math.ceil((from - zone) / step) * step + zone; t < to; t += step) if (t - from > (to - from) * 0.06 && to - t > (to - from) * 0.06) ticks.push(t);
  return { from, to, ticks, open };
}
/** A time's place on the axis, as a CSS percentage. @param {Axis} x @param {number} t */
const along = (x, t) => `${(((t - x.from) / (x.to - x.from)) * 100).toFixed(2)}%`;
/** @param {number} t */
const clock = (t) => hm(new Date(t).toISOString());
/** The axis' clock times over the bars, and where it ends: now, or when the last agent ended. @param {Axis} x */
function axisRow(x) {
  return h(
    "div",
    { class: "arow aaxis", "data-key": "axis", "aria-hidden": "true" },
    h("span", { class: "awhat" }),
    h(
      "span",
      { class: "atrack" },
      x.ticks.map((t) => {
        const tick = h("span", { class: "atick" }, clock(t));
        tick.style.left = along(x, t);
        return tick;
      }),
    ),
    h("span", { class: "num faint" }, x.open ? TEXT.timeline.now(clock(x.to)) : TEXT.timeline.ended(clock(x.to))),
  );
}
/** An agent's bar from its start to now or its end, with how far it has got when its activity says. @param {Agent} a @param {Axis} x */
function agentBar(a, x) {
  const start = Date.parse(a.startedAt);
  const end = a.endedAt ? Date.parse(a.endedAt) : x.to;
  // Only from the activity shown: a blocked agent shows whom it waits for instead.
  const progress = a.endedAt || waitsLine(a) ? null : progressOf(a.activity);
  const bar = h(
    "span",
    { class: `abar st-${a.state}${a.endedAt ? "" : " open"}`, title: TEXT.timeline.bar(hm(a.startedAt), a.endedAt ? hm(a.endedAt) : TEXT.now) },
    progress ? h("span", { class: "aprog" }, progress) : null,
  );
  // Placed from its end, so a bar too short for its progress grows back in time, never past now.
  bar.style.right = `${(((x.to - end) / (x.to - x.from)) * 100).toFixed(2)}%`;
  bar.style.width = `${(((end - start) / (x.to - x.from)) * 100).toFixed(2)}%`;
  return h(
    "span",
    { class: "atrack", "data-key": `bar-${a.name}` },
    x.ticks.map((t) => {
      const line = h("span", { class: "agrid" });
      line.style.left = along(x, t);
      return line;
    }),
    bar,
  );
}

/**
 * One row per agent: its goal, what it was asked, what it does now, and for how long; given an axis,
 * its bar on it too. @param {Agent[]} rows @param {Axis} [axis]
 */
export function agentRows(rows, axis) {
  /** @param {Agent} a */
  const stuck = (a) => {
    const note = stuckNote(a);
    return note ? h("span", { class: "astuck", title: note.tip }, note.text) : null;
  };
  /** @param {Agent} a */
  const tip = (a) => [a.branch && `${a.branch}${a.commit ? ` @ ${a.commit}` : ""}`, a.tokens !== undefined && TEXT.tokens(a.tokens)].filter(Boolean).join(" · ");
  return h(
    "div",
    { class: `alist${axis ? " atimeline" : ""}` },
    axis ? axisRow(axis) : null,
    rows.map((a) =>
      h(
        "div",
        { class: `arow${a.state === "failed" ? " failed" : ""}`, title: tip(a), "data-key": `agent-${a.name}` },
        h(
          "span",
          { class: "awhat" },
          h("span", { class: "aname" }, agentDot(a), h("span", { class: "agoal" }, a.goal ?? a.name)),
          a.summary ? h("span", { class: "asummary" }, a.summary) : null,
          agentDoing(a) ? h("span", { class: "adoing" }, a.state === "working" && a.activity ? TEXT.now_(agentDoing(a)) : agentDoing(a)) : null,
          stuck(a),
        ),
        axis ? agentBar(a, axis) : null,
        h("span", { class: "num faint", title: TEXT.state[a.state] }, agentAge(a)),
      ),
    ),
  );
}

/** Dependencies as a left-to-right flow; only drawn when the session reported any. @param {Session} s */
function flowGraph(s) {
  const as = data.agents.filter((a) => a.sessionId === s.id).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  if (!as.some((a) => a.after.some((n) => agentOf(s.id, n)))) return null;
  /** @type {Map<Agent, number>} */
  const depth = new Map();
  /** @param {Agent} a @returns {number} */
  const deep = (a) => {
    const known = depth.get(a);
    if (known !== undefined) return known;
    depth.set(a, 0); // a cycle ends here instead of looping
    const parents = a.after.map((n) => agentOf(s.id, n)).filter(/** @returns {b is Agent} */ (b) => b !== undefined);
    const d = Math.max(0, ...parents.map((b) => deep(b) + 1));
    depth.set(a, d);
    return d;
  };
  as.forEach(deep);
  /** @type {Agent[][]} */
  const cols = [];
  for (const a of as) (cols[depth.get(a) ?? 0] ??= []).push(a);
  const W = 190, H = 56, GX = 54, GY = 12;
  /** @type {Map<Agent, { x: number, y: number }>} */
  const pos = new Map();
  cols.forEach((col, i) => col.forEach((a, j) => pos.set(a, { x: i * (W + GX), y: j * (H + GY) })));
  const width = cols.length * (W + GX) - GX;
  const height = Math.max(...cols.map((c) => c.length)) * (H + GY) - GY;
  const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true" });
  const defs = svgEl("defs", {});
  for (const k of ["done", "live", "wait"]) {
    const m = svgEl("marker", { id: `arrow-${k}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    m.append(svgEl("path", { d: "M0 1 L9 5 L0 9 z", class: `ah-${k}` }));
    defs.append(m);
  }
  svg.append(defs);
  for (const a of as) {
    for (const n of a.after) {
      const b = agentOf(s.id, n);
      const p = b && pos.get(b);
      const q = pos.get(a);
      if (!b || !p || !q) continue;
      const x1 = p.x + W, y1 = p.y + H / 2, x2 = q.x - 2, y2 = q.y + H / 2;
      const k = a.state === "blocked" ? "wait" : b.state === "working" ? "live" : "done";
      svg.append(svgEl("path", { d: `M${x1} ${y1} C${x1 + GX / 2} ${y1} ${x2 - GX / 2} ${y2} ${x2} ${y2}`, class: `edge e-${k}`, "marker-end": `url(#arrow-${k})` }));
    }
  }
  const flow = h(
    "div",
    { class: "flow" },
    svg,
    as.map((a) => {
      const p = pos.get(a) ?? { x: 0, y: 0 };
      const node = h("div", { class: `fnode st-${a.state}`, title: a.goal ?? a.name }, h("span", { class: "aname" }, agentDot(a), h("span", { class: "agoal" }, a.goal ?? a.name)), h("span", { class: "fact" }, agentDoing(a)));
      node.style.left = `${p.x}px`;
      node.style.top = `${p.y}px`;
      return node;
    }),
  );
  flow.style.width = `${width}px`;
  flow.style.height = `${height}px`;
  return flow;
}

/** Its agents: the flow when they depend on each other, then one row each on a time axis, then where their branches stand. @param {Session} s */
export function agentsPart(s) {
  const flow = flowGraph(s);
  return [flow ? h("div", { class: "rsec flow-sec" }, h("h4", {}, TEXT.flow), h("div", { class: "flow-wrap" }, flow)) : null, h("div", { class: "rsec atl-sec" }, agentList(s)), branchesPart(s)];
}

// Past this age the rows say they may have changed since: a scan runs at the end of each turn and as agents stop.
const STALE_MS = 10 * 60_000;

/**
 * Where the session's branches stand, as its project's last scan read them: one row per checkout or
 * branch, its agent first, with how old the reading is. Null before any scan. @param {Session} s
 */
export function branchesPart(s) {
  const b = data.branches.find((x) => x.sessionId === s.id);
  if (!b || (b.rows.length === 0 && b.hidden === 0 && b.gone === 0)) return null;
  const t = TEXT.branches;
  const stale = Date.now() - Date.parse(b.checkedAt) > STALE_MS;
  return h(
    "div",
    { class: "rsec branches-sec", "data-key": "branches" },
    h("h4", {}, TEXT.branches.title, h("span", { class: `bage${stale ? " stale" : ""}`, title: hm(b.checkedAt) }, (stale ? t.stale : t.read)(ago(b.checkedAt)))),
    h("div", { class: "alist blist" }, b.rows.map((r) => branchRow(s, r, b.baseBranch))),
    b.hidden ? h("button", { class: "linkish faint bhidden", onclick: () => openProject(b.projectId) }, t.hidden(b.hidden)) : null,
    b.gone ? h("div", { class: "faint bgone" }, t.goneAgents(b.gone)) : null,
  );
}

/** A checkout or branch: its name with its state, whose it is and its last commit, and how far it is from the base. @param {Session} s @param {BranchRow} r @param {string | undefined} base */
function branchRow(s, r, base) {
  const t = TEXT.branches;
  const agent = r.agent ? agentOf(s.id, r.agent.name) : undefined;
  const mark = agent ? agentDot(agent, true) : icon("branch", "i bmark");
  const name = r.branch ?? (r.head ? t.detached(r.head.slice(0, 7)) : "?");
  const who = [r.agent ? (r.agent.goal ?? r.agent.name) : r.main ? t.main : r.path ? shortPath(r.path) : "", r.session ? t.you : ""].filter(Boolean).join(" · ");
  const found = r.status === "found" && !r.error;
  const tags = found
    ? [
        r.dirty !== undefined ? h("span", { class: `btag${r.dirty ? " dirty" : ""}` }, r.dirty ? t.changed(r.dirty) : t.clean) : null,
        r.merged ? h("span", { class: "btag" }, t.merged) : null,
        r.busy?.length ? h("span", { class: "btag busy", title: t.inUse(r.busy.join(", ")) }, h("span", { class: "up" }), r.busy.join(", ")) : null,
      ]
    : [h("span", { class: `btag${r.status === "unread" ? "" : " bad"}` }, r.error ? t.error(r.error) : r.status === "missing" ? (r.branch ? t.missing : t.gone) : t.unread)];
  const last = found && r.subject !== undefined && r.committedAt ? t.last(r.subject, ago(r.committedAt)) : "";
  const counts = found && r.ahead !== undefined ? h("span", { class: "num bcounts", title: t.counts(r.ahead, r.behind ?? 0, base ?? "") }, h("span", { class: r.ahead ? "" : "faint" }, `+${r.ahead}`), " ", h("span", { class: "faint" }, `−${r.behind ?? 0}`)) : h("span", { class: "num faint" });
  return h(
    "div",
    { class: `arow brow${found ? "" : " off"}`, title: r.path ?? "", "data-key": `branch-${r.path ?? r.branch ?? r.agent?.name ?? ""}` },
    h("span", { class: "awhat" }, h("span", { class: "aname" }, mark, h("span", { class: "agoal bname" }, name), tags), who || last ? h("span", { class: "adoing" }, [who, last].filter(Boolean).join(" · ")) : null),
    counts,
  );
}

/** A checkout's folder by its last two parts: worktrees sit in deep folders whose start is the project's. @param {string} p */
const shortPath = (p) => p.split("/").filter(Boolean).slice(-2).join("/");
