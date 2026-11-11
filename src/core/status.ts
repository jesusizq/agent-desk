// Where a session's work stands, as plain text for the session itself: its branches and agents, what it
// asked the developer, its local servers and its project's open reviews. `agent-desk status` prints it
// live; the handoff before a compaction records it.
import * as path from "node:path";
import { type Agent, type BranchRow, type Question, type Review, reviewStatus, type Service, type Session, type SessionBranches } from "./model.ts";

export type StatusInput = {
  session: Session;
  branches: SessionBranches | undefined;
  /** Why git could not be read now, when it could not. */
  gitError?: string;
  agents: readonly Agent[];
  questions: readonly Question[];
  services: readonly Service[];
  reviews: readonly Review[];
  now: Date;
};

/** Rows of each part named before the rest is counted: the text stays short. */
const SHOWN = { branches: 12, agents: 12, questions: 8, services: 8, reviews: 5 } as const;
const OPEN: ReadonlySet<Agent["state"]> = new Set(["working", "waiting", "blocked", "idle"]);

/** The session's state in short lines, part by part; a part with nothing in it is left out. */
export function statusLines(input: StatusInput): string[] {
  const { session, branches, now } = input;
  const out: string[] = [];
  const dir = session.project.dir;
  if (branches) {
    out.push(`Branches (git read ${since(branches.checkedAt, now)} ago${branches.baseBranch ? `; compared with ${branches.baseBranch}` : ""}):`);
    out.push(...capped(branches.rows.map((r) => `- ${branchLine(r, dir, now)}`), SHOWN.branches, "branches"));
    if (branches.hidden > 0) out.push(`  (${branches.hidden} more checkout${branches.hidden === 1 ? "" : "s"} merged, clean and idle, not listed)`);
    if (branches.gone > 0) out.push(`  (${branches.gone} finished agent${branches.gone === 1 ? "'s branch is" : "s' branches are"} gone, integrated or deleted; not listed)`);
  } else {
    out.push(`Branches: none read for ${dir}${input.gitError ? ` (${oneLine(input.gitError, 200)})` : ""}`);
  }
  if (branches && input.gitError) out.push(`  (git could not be read now, so this is the last scan: ${oneLine(input.gitError, 200)})`);
  const open = input.agents.filter((a) => a.sessionId === session.id && (OPEN.has(a.state) || a.state === "failed"));
  if (open.length) {
    out.push("Agents not finished:");
    out.push(...capped(open.map((a) => `- ${a.name} (${a.state}${a.state === "failed" ? "" : `, ${since(a.startedAt, now)}`})${a.goal && a.goal !== a.name ? `: ${oneLine(a.goal, 100)}` : ""}${a.activity && !a.activityIsCall ? ` · ${oneLine(a.activity, 100)}` : ""}${a.after.length ? ` · after ${a.after.join(", ")}` : ""}`), SHOWN.agents, "agents"));
  }
  const asked = input.questions.filter((q) => q.sessionId === session.id && q.status === "open");
  if (asked.length) {
    out.push("Open on the desk, waiting for the developer:");
    out.push(...capped(asked.map((q) => `- ${q.kind === "question" ? "" : `[${q.kind}] `}${oneLine(q.text, 160)} (asked ${since(q.askedAt, now)} ago)`), SHOWN.questions, "questions"));
  }
  const services = input.services.filter((v) => v.sessionId === session.id);
  if (services.length) {
    out.push("Local servers:");
    out.push(...capped(services.map((v) => `- ${oneLine(v.name, 80)} ${v.url}`), SHOWN.services, "servers"));
  }
  const reviews = input.reviews.filter((r) => path.resolve(r.project.dir) === path.resolve(dir) && !r.closedAt);
  if (reviews.length) {
    out.push("Reviews open in To review (titles written by sessions):");
    out.push(...capped(reviews.map((r) => `- ${JSON.stringify(oneLine(r.title, 60))} ${r.id}, round ${r.rounds.at(-1)?.n ?? 1}${r.progress ? `, ${r.progress.done} of ${r.progress.total} reviewed` : ""}, ${reviewStatus(r)}`), SHOWN.reviews, "reviews"));
  }
  return out;
}

/** "agent summary (working) · agent/summary · .claude/worktrees/a · 3 ahead, 1 behind · 2 changed files · last «Fix x» 5 min ago · in use: vitest". */
export function branchLine(r: BranchRow, projectDir: string, now: Date): string {
  const who = r.agent ? `agent ${r.agent.name} (${r.agent.state})` : r.main ? "main checkout" : "checkout";
  const parts = [r.session ? `${who}, this session's` : who, r.branch ?? (r.head ? `detached at ${r.head.slice(0, 9)}` : undefined)];
  if (r.path && !r.main) parts.push(relative(r.path, projectDir));
  if (r.status === "missing") parts.push(r.branch ? "branch not found" : "checkout gone");
  else if (r.status === "unread") parts.push("not read yet");
  if (r.error) parts.push(`could not read git: ${oneLine(r.error, 160)}`);
  if (r.status === "found" && !r.error) {
    if (r.ahead !== undefined) parts.push(`${r.ahead} ahead, ${r.behind ?? 0} behind${r.merged ? ", merged" : ""}`);
    if (r.dirty !== undefined) parts.push(r.dirty === 0 ? "clean" : `${r.dirty} changed file${r.dirty === 1 ? "" : "s"}`);
    if (r.subject !== undefined && r.committedAt) parts.push(`last «${oneLine(r.subject, 80)}» ${since(r.committedAt, now)} ago`);
    if (r.busy?.length) parts.push(`in use: ${r.busy.join(", ")}`);
  }
  return parts.filter(Boolean).join(" · ");
}

/** Joins lines and cuts them at `max` characters, at a line's end, saying so. */
export function fitText(lines: readonly string[], max: number, cutNote: string): string {
  const whole = lines.join("\n");
  if (whole.length <= max) return whole;
  const room = max - cutNote.length - 1;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > room) break;
    kept.push(line);
    used += line.length + 1;
  }
  // A single line longer than the room is cut inside it.
  if (kept.length === 0) kept.push(whole.slice(0, room));
  return [...kept, cutNote].join("\n");
}

/** "<1 min", "12 min", "3 h", "2 d": how long before `now`. */
export function since(at: string, now: Date): string {
  const min = Math.max(0, Math.floor((now.getTime() - Date.parse(at)) / 60_000));
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h`;
  return `${Math.floor(min / 1440)} d`;
}

const capped = (lines: string[], max: number, what: string) => (lines.length > max ? [...lines.slice(0, max), `- … ${lines.length - max} more ${what}`] : lines);

/** Session text on one line, cut: it is data inside a list, never a block of its own. */
function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function relative(p: string, dir: string): string {
  const rel = path.relative(dir, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
}
