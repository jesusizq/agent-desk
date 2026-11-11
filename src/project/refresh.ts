// Reads a project's checkouts again and keeps the result in the store, one scan of a project at a time.
import * as path from "node:path";
import { sessionBranches } from "../core/branches.ts";
import type { ProjectScan, Session } from "../core/model.ts";
import { liveServices } from "../core/ports.ts";
import { sessionFinished } from "../core/proc.ts";
import type { StatusInput } from "../core/status.ts";
import type { Store } from "../store/store.ts";
import { projectId, scanProject } from "./scan.ts";

export type Refresh = {
  /** Walk the checkouts for their sizes when due; a session waiting for the answer skips it. */
  sizes: boolean;
  /** While another scan of the project runs: `skip` reads nothing, `read` reads git without storing (that scan stores its own). */
  whenBusy: "skip" | "read";
  timeoutMs?: number;
};

/**
 * The project's scan, read now; undefined when another scan runs and `whenBusy` is `skip`. Store
 * records that could not be read while finding the agents' branches go to `problems`.
 */
export async function refreshScan(store: Store, dir: string, how: Refresh, problems: string[]): Promise<{ scan: ProjectScan; stored: boolean } | undefined> {
  const id = projectId(dir);
  const release = store.claimScan(id);
  if (!release && how.whenBusy === "skip") return undefined;
  try {
    const sessions = store.listSessions(problems).flatMap((s) => (s.process && !sessionFinished(s) ? [s.process] : []));
    const scan = await scanProject(dir, store.getProjectScan(id), new Date(), { sizes: how.sizes, branches: agentBranches(store, dir, problems), sessions, ...(how.timeoutMs === undefined ? {} : { timeoutMs: how.timeoutMs }) });
    return { scan: release ? store.putProjectScan(scan) : scan, stored: release !== undefined };
  } finally {
    release?.();
  }
}

/** Branches the agents of the project's sessions were said to work on (`agent-desk agent --branch`). */
function agentBranches(store: Store, dir: string, problems: string[]): string[] {
  const root = path.resolve(dir);
  const sessions = store.listSessions(problems).filter((s) => path.resolve(s.project.dir) === root);
  return [...new Set(sessions.flatMap((s) => store.listAgents(s.id, problems).flatMap((a) => (a.branch ? [a.branch] : []))))];
}

/**
 * Where a session's work stands now: its project's git read again (sizes left for the background
 * scan), or, when git cannot be read, the last scan with the reason; and its agents, open questions,
 * local servers and its project's reviews.
 */
export async function sessionStatus(store: Store, session: Session, timeoutMs: number | undefined, problems: string[]): Promise<StatusInput> {
  const dir = session.project.dir;
  let scan: ProjectScan | undefined;
  let gitError: string | undefined;
  try {
    scan = (await refreshScan(store, dir, { sizes: false, whenBusy: "read", ...(timeoutMs === undefined ? {} : { timeoutMs }) }, problems))?.scan;
  } catch (error) {
    gitError = (error as Error).message;
    scan = store.getProjectScan(projectId(dir));
  }
  const agents = store.listAgents(session.id, problems);
  return {
    session,
    branches: sessionBranches(session, agents, scan),
    ...(gitError === undefined ? {} : { gitError }),
    agents,
    questions: store.openQuestions(session.id, problems),
    services: liveServices(store.listServices(problems), [session], problems),
    reviews: store.listReviews(problems),
    now: new Date(),
  };
}
