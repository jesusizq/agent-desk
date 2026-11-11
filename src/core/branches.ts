// A session's branches: its agents' checkouts and branches, and its project's other checkouts, as the
// project's last scan read them. Pure: the page, `agent-desk status` and the handoff show the same rows.
import * as path from "node:path";
import type { Agent, BranchRow, BranchState, ProjectScan, Session, SessionBranches, Worktree } from "./protocol.ts";

/**
 * Rows, in order: the main checkout, each agent that has a worktree or a branch (oldest first), then
 * the other checkouts of the project. A checkout already merged, clean and with nothing working in it
 * is counted in `hidden` rather than shown, unless an agent's row names it. A finished agent whose
 * branch or checkout is gone (integrated and deleted) is history, counted in `gone`: "branch not found"
 * is shown only for an agent still open, where it is a problem. Undefined without a scan.
 */
export function sessionBranches(session: Session, agents: readonly Agent[], scan: ProjectScan | undefined): SessionBranches | undefined {
  if (!scan) return undefined;
  const own = agents.filter((a) => a.sessionId === session.id && (a.worktree !== undefined || a.branch !== undefined)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const used = new Set<Worktree>();
  const here = session.project.worktree === undefined ? undefined : path.resolve(session.project.worktree);
  const at = (w: Worktree) => here !== undefined && (here === path.resolve(w.path) || here.startsWith(`${path.resolve(w.path)}/`));
  const row = (w: Worktree, agent?: Agent): BranchRow => {
    used.add(w);
    return fromCheckout(w, agent, at(w) || (w.main && here === undefined));
  };
  const rows: BranchRow[] = [];
  let gone = 0;
  const main = scan.worktrees.find((w) => w.main);
  if (main) rows.push(row(main));
  for (const a of own) {
    const w = (a.worktree === undefined ? undefined : holding(scan.worktrees.filter((x) => !x.main), a.worktree)) ?? scan.worktrees.find((x) => a.branch !== undefined && x.branch === a.branch);
    // An agent on the main checkout's branch works in the main checkout: its row is that one.
    if (w?.main && rows[0] && !rows[0].agent) rows[0] = row(w, a);
    else if (w) rows.push(row(w, a));
    else {
      const r = fromBranch(a, scan.branches?.find((b) => b.name === a.branch), scan.measuredAt > a.updatedAt);
      if (r.status === "missing" && !r.error && ENDED.has(a.state)) gone++;
      else rows.push(r);
    }
  }
  let hidden = 0;
  const others = scan.worktrees.filter((w) => !used.has(w)).sort((a, b) => (b.ahead ?? 0) - (a.ahead ?? 0));
  for (const w of others) {
    if (w.merged === true && w.dirty === 0 && !w.busy?.length && !w.error && !at(w)) hidden++;
    else rows.push(row(w));
  }
  return { sessionId: session.id, projectId: scan.id, ...(scan.baseBranch ? { baseBranch: scan.baseBranch } : {}), checkedAt: scan.measuredAt, rows, hidden, gone };
}

const ENDED: ReadonlySet<Agent["state"]> = new Set(["done", "failed"]);

/** The deepest checkout holding `folder` (an agent may work in a subfolder of its worktree); a linked worktree is never the main checkout, which may hold its folder after it is removed. */
function holding(worktrees: readonly Worktree[], folder: string): Worktree | undefined {
  const f = path.resolve(folder);
  const inside = worktrees.filter((w) => f === path.resolve(w.path) || f.startsWith(`${path.resolve(w.path)}/`));
  return inside.sort((a, b) => b.path.length - a.path.length)[0];
}

const agentOf = (a: Agent) => ({ name: a.name, ...(a.goal ? { goal: a.goal } : {}), state: a.state });

function fromCheckout(w: Worktree, agent: Agent | undefined, session: boolean): BranchRow {
  const { bytes: _b, sizedAt: _s, ...state } = w;
  return { ...(agent ? { agent: agentOf(agent) } : {}), ...state, ...(session ? { session } : {}), status: "found" };
}

/**
 * An agent whose checkout the scan did not list: its branch as the scan found it; else gone, when the
 * scan ran after the agent last changed (`scannedSince`), or not read yet.
 */
function fromBranch(a: Agent, b: BranchState | undefined, scannedSince: boolean): BranchRow {
  const agent = agentOf(a);
  if (!b) return { agent, ...(a.branch ? { branch: a.branch } : {}), ...(a.worktree ? { path: a.worktree } : {}), status: scannedSince ? "missing" : "unread" };
  const { name, exists, ...state } = b;
  return { agent, branch: name, ...state, status: exists || b.error ? "found" : "missing" };
}
