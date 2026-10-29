// Validators that read protocol records back from untrusted files and input.
import { bool, compact, fields, int, isoTime, list, localUrl, nonEmpty, num, oneOf, optional, text } from "./check.ts";
import { id } from "./ids.ts";
import {
  AGENT_STATES,
  ANSWER_CHANNELS,
  ATTACHED_IMAGES_MAX,
  QUESTION_KINDS,
  QUESTION_STATUSES,
  SESSION_STATES,
  SUGGESTION_REASONS,
  type Agent,
  type Answer,
  type Check,
  type ConversationEntry,
  type InboxEntry,
  type ProjectScan,
  type Worktree,
  type Metrics,
  type PlanWindow,
  type Question,
  type Result,
  type Seen,
  type Service,
  type Session,
  type SessionProcess,
  type Suggestion,
} from "./protocol.ts";

export * from "./protocol.ts";

const label = (v: unknown, w: string) => nonEmpty(v, w, 200);
const line = (v: unknown, w: string) => text(v, w, 2000);

export function readSession(value: unknown, where = "session"): Session {
  const f = fields(value, where);
  const project = fields(f.project, `${where}.project`);
  return compact({
    id: id(f.id, `${where}.id`),
    provider: label(f.provider, `${where}.provider`),
    project: { name: label(project.name, `${where}.project.name`), dir: nonEmpty(project.dir, `${where}.project.dir`, 4096) },
    title: optional(f.title, `${where}.title`, line),
    state: oneOf(SESSION_STATES)(f.state, `${where}.state`),
    startedAt: isoTime(f.startedAt, `${where}.startedAt`),
    updatedAt: isoTime(f.updatedAt, `${where}.updatedAt`),
    endedAt: optional(f.endedAt, `${where}.endedAt`, isoTime),
    process: optional(f.process, `${where}.process`, readProcess),
    terminal: optional(f.terminal, `${where}.terminal`, label),
    tmux: optional(f.tmux, `${where}.tmux`, readTmux),
    takesMessagesWhileWorking: optional(f.takesMessagesWhileWorking, `${where}.takesMessagesWhileWorking`, bool),
    activity: optional(f.activity, `${where}.activity`, line),
    lastMessage: optional(f.lastMessage, `${where}.lastMessage`, readMessage),
    readAt: optional(f.readAt, `${where}.readAt`, isoTime),
    sentWhileWorking: optional(f.sentWhileWorking, `${where}.sentWhileWorking`, (v, w) => list(v, w, readSent, 20)),
  });
}

function readSent(value: unknown, where: string): { text: string; at: string; turnEndedAt?: string } {
  const f = fields(value, where);
  return compact({ text: text(f.text, `${where}.text`), at: isoTime(f.at, `${where}.at`), turnEndedAt: optional(f.turnEndedAt, `${where}.turnEndedAt`, isoTime) });
}

export const TMUX_PANE = /^%\d{1,6}$/;

function readTmux(value: unknown, where: string): { socket: string; pane: string; clients: number[] } {
  const f = fields(value, where);
  const pane = text(f.pane, `${where}.pane`, 10);
  if (!TMUX_PANE.test(pane)) throw new Error(`${where}.pane: expected a tmux pane id such as %3, got ${JSON.stringify(pane)}`);
  const socket = nonEmpty(f.socket, `${where}.socket`, 1024);
  if (!socket.startsWith("/")) throw new Error(`${where}.socket: expected an absolute path`);
  return { socket, pane, clients: list(f.clients ?? [], `${where}.clients`, (v, w) => int(v, w, 1, 2 ** 31), 16) };
}

function readMessage(value: unknown, where: string): { text: string; at: string } {
  const f = fields(value, where);
  return { text: text(f.text, `${where}.text`), at: isoTime(f.at, `${where}.at`) };
}

function readProcess(value: unknown, where: string): SessionProcess {
  const f = fields(value, where);
  const pid = (v: unknown, w: string) => int(v, w, 1, 2 ** 31);
  return compact({
    pid: pid(f.pid, `${where}.pid`),
    start: optional(f.start, `${where}.start`, label),
    ancestors: list(f.ancestors, `${where}.ancestors`, pid, 64),
  });
}

export function readQuestion(value: unknown, where = "question"): Question {
  const f = fields(value, where);
  return compact({
    id: id(f.id, `${where}.id`),
    sessionId: id(f.sessionId, `${where}.sessionId`),
    kind: oneOf(QUESTION_KINDS)(f.kind, `${where}.kind`),
    text: nonEmpty(f.text, `${where}.text`),
    context: optional(f.context, `${where}.context`, text),
    options: list(f.options ?? [], `${where}.options`, (v, w) => nonEmpty(v, w, 500), 20),
    askedAt: isoTime(f.askedAt, `${where}.askedAt`),
    status: oneOf(QUESTION_STATUSES)(f.status, `${where}.status`),
    answer: optional(f.answer, `${where}.answer`, readAnswer),
    interpretation: optional(f.interpretation, `${where}.interpretation`, text),
    closedAt: optional(f.closedAt, `${where}.closedAt`, isoTime),
    dialog: optional(f.dialog, `${where}.dialog`, bool),
  });
}

function readAnswer(value: unknown, where: string): Answer {
  const f = fields(value, where);
  return compact({
    text: text(f.text, `${where}.text`),
    at: isoTime(f.at, `${where}.at`),
    via: oneOf(ANSWER_CHANNELS)(f.via, `${where}.via`),
    images: optional(f.images, `${where}.images`, imageIds),
  });
}

/** Ids of images attached on the desk. */
export function imageIds(value: unknown, where: string): string[] {
  return list(value, where, id, ATTACHED_IMAGES_MAX);
}

export function readAgent(value: unknown, where = "agent"): Agent {
  const f = fields(value, where);
  return compact({
    sessionId: id(f.sessionId, `${where}.sessionId`),
    name: id(f.name, `${where}.name`),
    type: optional(f.type, `${where}.type`, label),
    ref: optional(f.ref, `${where}.ref`, label),
    goal: optional(f.goal, `${where}.goal`, line),
    summary: optional(f.summary, `${where}.summary`, line),
    state: oneOf(AGENT_STATES)(f.state, `${where}.state`),
    activity: optional(f.activity, `${where}.activity`, line),
    branch: optional(f.branch, `${where}.branch`, label),
    commit: optional(f.commit, `${where}.commit`, label),
    after: list(f.after ?? [], `${where}.after`, id, 50),
    startedAt: isoTime(f.startedAt, `${where}.startedAt`),
    updatedAt: isoTime(f.updatedAt, `${where}.updatedAt`),
    endedAt: optional(f.endedAt, `${where}.endedAt`, isoTime),
    tokens: optional(f.tokens, `${where}.tokens`, (v, w) => int(v, w)),
  });
}

export function readResult(value: unknown, where = "result"): Result {
  const f = fields(value, where);
  const images = list(f.images ?? [], `${where}.images`, readImageRef, 50);
  const compare = optional(f.compare, `${where}.compare`, readCompare);
  if (compare) {
    for (const side of [compare.before, compare.after]) {
      if (!images.some((i) => i.id === side)) throw new Error(`${where}.compare: image ${side} is not in ${where}.images`);
    }
  }
  return compact({
    id: id(f.id, `${where}.id`),
    sessionId: id(f.sessionId, `${where}.sessionId`),
    title: nonEmpty(f.title, `${where}.title`, 300),
    summary: text(f.summary ?? "", `${where}.summary`),
    status: oneOf(["ok", "failed"] as const)(f.status, `${where}.status`),
    at: isoTime(f.at, `${where}.at`),
    url: optional(f.url, `${where}.url`, localUrl),
    images,
    compare,
    assumptions: list(f.assumptions ?? [], `${where}.assumptions`, line, 50),
    decisions: list(f.decisions ?? [], `${where}.decisions`, line, 50),
    checks: list(f.checks ?? [], `${where}.checks`, readCheck, 50),
    seenAt: optional(f.seenAt, `${where}.seenAt`, isoTime),
  });
}

function readImageRef(value: unknown, where: string): { id: string; caption?: string } {
  const f = fields(value, where);
  return compact({ id: id(f.id, `${where}.id`), caption: optional(f.caption, `${where}.caption`, line) });
}

function readCompare(value: unknown, where: string): { before: string; after: string } {
  const f = fields(value, where);
  return { before: id(f.before, `${where}.before`), after: id(f.after, `${where}.after`) };
}

function readCheck(value: unknown, where: string): Check {
  const f = fields(value, where);
  return { criterion: nonEmpty(f.criterion, `${where}.criterion`, 2000), verification: line(f.verification, `${where}.verification`) };
}

export function readService(value: unknown, where = "service"): Service {
  const f = fields(value, where);
  return {
    id: id(f.id, `${where}.id`),
    sessionId: id(f.sessionId, `${where}.sessionId`),
    name: label(f.name, `${where}.name`),
    url: localUrl(f.url, `${where}.url`),
    startedAt: isoTime(f.startedAt, `${where}.startedAt`),
  };
}

export function readMetrics(value: unknown, where = "metrics"): Metrics {
  const f = fields(value, where);
  const pct = (v: unknown, w: string) => num(v, w, 0, 100);
  return compact({
    sessionId: id(f.sessionId, `${where}.sessionId`),
    at: isoTime(f.at, `${where}.at`),
    model: optional(f.model, `${where}.model`, label),
    effort: optional(f.effort, `${where}.effort`, label),
    branch: optional(f.branch, `${where}.branch`, label),
    contextPercent: optional(f.contextPercent, `${where}.contextPercent`, pct),
    contextTokens: optional(f.contextTokens, `${where}.contextTokens`, (v, w) => int(v, w)),
    costUsd: optional(f.costUsd, `${where}.costUsd`, (v, w) => num(v, w, 0)),
    planWindows: optional(f.planWindows, `${where}.planWindows`, (v, w) => list(v, w, readPlanWindow, 10)),
    permissionMode: optional(f.permissionMode, `${where}.permissionMode`, label),
    cacheExpiresAt: optional(f.cacheExpiresAt, `${where}.cacheExpiresAt`, isoTime),
    backgroundShells: optional(f.backgroundShells, `${where}.backgroundShells`, (v, w) => int(v, w)),
    suggestion: optional(f.suggestion, `${where}.suggestion`, readSuggestion),
  });
}

function readSuggestion(value: unknown, where: string): Suggestion {
  const f = fields(value, where);
  return { reason: oneOf(SUGGESTION_REASONS)(f.reason, `${where}.reason`), command: label(f.command, `${where}.command`) };
}

function readPlanWindow(value: unknown, where: string): PlanWindow {
  const f = fields(value, where);
  return compact({
    label: label(f.label, `${where}.label`),
    percent: num(f.percent, `${where}.percent`, 0, 100),
    resetsAt: optional(f.resetsAt, `${where}.resetsAt`, isoTime),
  });
}

export function readConversationEntry(value: unknown, where = "message"): ConversationEntry {
  const f = fields(value, where);
  return compact({
    id: id(f.id, `${where}.id`),
    sessionId: id(f.sessionId, `${where}.sessionId`),
    from: oneOf(["session", "developer"] as const)(f.from, `${where}.from`),
    text: text(f.text, `${where}.text`),
    at: isoTime(f.at, `${where}.at`),
    via: optional(f.via, `${where}.via`, oneOf(ANSWER_CHANNELS)),
    images: optional(f.images, `${where}.images`, imageIds),
  });
}

export function readInboxEntry(value: unknown, where = "inbox entry"): InboxEntry {
  const f = fields(value, where);
  return compact({
    questionId: id(f.questionId, `${where}.questionId`),
    question: text(f.question, `${where}.question`),
    answer: text(f.answer, `${where}.answer`),
    at: isoTime(f.at, `${where}.at`),
    images: optional(f.images, `${where}.images`, imageIds),
  });
}

export function readProjectScan(value: unknown, where = "project"): ProjectScan {
  const f = fields(value, where);
  const day = fields(f.dayStart, `${where}.dayStart`);
  const bytes = (v: unknown, w: string) => int(v, w);
  return compact({
    id: id(f.id, `${where}.id`),
    name: label(f.name, `${where}.name`),
    dir: nonEmpty(f.dir, `${where}.dir`, 4096),
    baseBranch: optional(f.baseBranch, `${where}.baseBranch`, label),
    worktrees: list(f.worktrees, `${where}.worktrees`, readWorktree, 500),
    totalBytes: bytes(f.totalBytes, `${where}.totalBytes`),
    dayStart: { day: label(day.day, `${where}.dayStart.day`), bytes: bytes(day.bytes, `${where}.dayStart.bytes`) },
    measuredAt: isoTime(f.measuredAt, `${where}.measuredAt`),
    problems: list(f.problems ?? [], `${where}.problems`, line, 50),
  });
}

function readWorktree(value: unknown, where: string): Worktree {
  const f = fields(value, where);
  return compact({
    path: nonEmpty(f.path, `${where}.path`, 4096),
    branch: optional(f.branch, `${where}.branch`, label),
    head: label(f.head, `${where}.head`),
    bytes: int(f.bytes, `${where}.bytes`),
    sizedAt: isoTime(f.sizedAt, `${where}.sizedAt`),
    main: f.main === true,
    merged: optional(f.merged, `${where}.merged`, (v, w) => {
      if (typeof v !== "boolean") throw new Error(`${w}: expected true or false`);
      return v;
    }),
    ahead: optional(f.ahead, `${where}.ahead`, (v, w) => int(v, w)),
  });
}

export function readSeen(value: unknown, where = "seen"): Seen {
  return { since: isoTime(fields(value, where).since, `${where}.since`) };
}
