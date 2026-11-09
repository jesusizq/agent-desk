// @ts-check
// A session's agents: whether they are stuck, what they do, their rows and the flow between them.
import { h, svgEl } from "./dom.js";
import { TEXT } from "./text.js";
import { ago, hm } from "./format.js";
import { dot } from "./pieces.js";
import { agentOf, data, waitingOn } from "./state.js";

/** @typedef {import("../core/protocol.ts").Session} Session */
/** @typedef {import("../core/protocol.ts").Agent} Agent */

const ATTENTION = ["failed", "blocked", "idle", "working", "waiting", "done"];

/** One dot per agent says the shape of a session at a glance. @param {Agent} a */
function agentDot(a) {
  const mark = dot(a.state);
  mark.title = [a.name, TEXT.state[a.state], a.activity].filter(Boolean).join(" · ");
  return a.state === "working" ? h("span", { class: "live" }, mark) : mark;
}
/** The session itself at work, before its agents' dots. */
export function sessionDot() {
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
function agentDoing(a) {
  return waitsLine(a) ?? a.activity ?? (a.type ? TEXT.agentType(a.type) : "");
}
/** Why an agent is in trouble, in a few words. @param {Agent} a */
export function troubleText(a) {
  if (a.state === "failed") return a.activity ?? TEXT.failedAgent;
  return waitsLine(a) ?? TEXT.idleSince(hm(a.updatedAt));
}
// An agent or session at work with no tool call for this long, or failing calls this recently, may be stuck.
const QUIET_MS = 5 * 60_000;
const FAILS_MS = 10 * 60_000;
/** Minutes since `at`, once past QUIET_MS; otherwise 0. @param {string} at */
const quietMinutes = (at) => {
  const ms = Date.now() - Date.parse(at);
  return ms >= QUIET_MS ? Math.floor(ms / 60_000) : 0;
};
/** Failed tool calls in the last FAILS_MS. @param {string[] | undefined} failedAt */
export const recentFailures = (failedAt) => (failedAt ?? []).filter((t) => Date.now() - Date.parse(t) < FAILS_MS).length;
/**
 * A working agent quiet for a while: minutes, or 0. Only an agent whose adapter stamps its tool
 * calls can be quiet: an older adapter's agents carry no such stamp, and their last update says nothing.
 * @param {Agent} a
 */
export const agentQuiet = (a) => (a.state === "working" && a.activityAt ? quietMinutes(a.activityAt) : 0);
/** Two failed calls in a row is a retry; three is a pattern. @param {Agent | Session} x */
export const failing = (x) => recentFailures(x.failedAt) >= 3;
/** A working session none of whose own calls nor working agents' has moved for a while: minutes, or 0. @param {Session} s */
export function sessionQuiet(s) {
  if (s.state !== "working" || !s.activityAt) return 0;
  const working = sessionAgents(s.id).filter((a) => a.state === "working");
  if (working.some((a) => !a.activityAt)) return 0; // an agent that cannot be timed may well be busy
  const last = [s.activityAt, ...working.map((a) => a.activityAt ?? "")].sort().at(-1);
  return last ? quietMinutes(last) : 0;
}
/** @param {string} sid */
export const sessionAgents = (sid) => data.agents.filter((a) => a.sessionId === sid).sort((a, b) => ATTENTION.indexOf(a.state) - ATTENTION.indexOf(b.state));

/**
 * One row per agent: its goal, the sentence saying what it must deliver, and what it does now (or
 * how it ended). Branch, commit and tokens wait in the tooltip. @param {Session} s
 */
function agentList(s) {
  const rows = sessionAgents(s.id);
  return rows.length ? agentRows(rows) : h("div", { class: "faint" }, TEXT.noAgents);
}

/** One row per agent: its goal, what it was asked, what it does now, and for how long. @param {Agent[]} rows */
export function agentRows(rows) {
  /** @param {Agent} a */
  const tip = (a) => [a.branch && `${a.branch}${a.commit ? ` @ ${a.commit}` : ""}`, a.tokens !== undefined && TEXT.tokens(a.tokens)].filter(Boolean).join(" · ");
  return h(
    "div",
    { class: "alist" },
    rows.map((a) =>
      h(
        "div",
        { class: `arow${a.state === "failed" ? " failed" : ""}`, title: tip(a) },
        h(
          "span",
          { class: "awhat" },
          h("span", { class: "aname" }, agentDot(a), h("span", { class: "agoal" }, a.goal ?? a.name)),
          a.summary ? h("span", { class: "asummary" }, a.summary) : null,
          agentDoing(a) ? h("span", { class: "adoing" }, a.state === "working" && a.activity ? TEXT.now_(agentDoing(a)) : agentDoing(a)) : null,
          agentQuiet(a) || failing(a)
            ? h("span", { class: "astuck" }, [agentQuiet(a) ? TEXT.quietFor(agentQuiet(a)) : "", failing(a) ? TEXT.failingCalls(recentFailures(a.failedAt)) : ""].filter(Boolean).join(" · "))
            : null,
        ),
        h("span", { class: "num faint", title: TEXT.state[a.state] }, a.endedAt ? TEXT.tookFor(ago(a.startedAt, a.endedAt)) : ago(a.startedAt)),
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

/** Its agents: the flow when they depend on each other, then one row each. @param {Session} s */
export function agentsPart(s) {
  const flow = flowGraph(s);
  return [flow ? h("div", { class: "rsec flow-sec" }, h("h4", {}, TEXT.flow), h("div", { class: "flow-wrap" }, flow)) : null, h("div", { class: "rsec" }, agentList(s))];
}
