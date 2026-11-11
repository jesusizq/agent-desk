// Validators that read protocol records back from untrusted files and input.
import { bool, compact, type Fields, fields, InputError, int, isoTime, list, localUrl, nonEmpty, num, oneOf, optional, text } from "./check.ts";
import { id } from "./ids.ts";
import type { PlanHistory, PlanWindowHistory } from "./limits.ts";
import {
  AGENT_STATES,
  ANSWER_CHANNELS,
  ANSWER_SOURCES,
  ATTACHED_IMAGES_MAX,
  GROUP_SIZE_MAX,
  QUESTION_KINDS,
  QUESTION_STATUSES,
  REVIEW_KEY_MAX,
  REVIEW_NOTE_MAX,
  REVIEW_REASON_MAX,
  REVIEW_STATE_MAX,
  REVIEW_SUMMARY_MAX,
  REVIEW_TITLE_MAX,
  SESSION_STATES,
  SUGGESTION_REASONS,
  type Agent,
  type Answer,
  type Check,
  type ConversationEntry,
  type InboxEntry,
  type BranchState,
  type Handoff,
  type PastDecision,
  type ProjectScan,
  type Worktree,
  PAST_SHOWN,
  type Metrics,
  type PlanWindow,
  type Question,
  type QuestionGroup,
  type Result,
  type Review,
  type ReviewProgress,
  type ReviewRound,
  type ReviewSend,
  type ReviewState,
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
    project: compact({
      name: label(project.name, `${where}.project.name`),
      dir: nonEmpty(project.dir, `${where}.project.dir`, 4096),
      worktree: optional(project.worktree, `${where}.project.worktree`, (v, w) => nonEmpty(v, w, 4096)),
    }),
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
    activityIsCall: optional(f.activityIsCall, `${where}.activityIsCall`, bool),
    activityAt: optional(f.activityAt, `${where}.activityAt`, isoTime),
    failedAt: optional(f.failedAt, `${where}.failedAt`, (v, w) => list(v, w, isoTime, FAILURES_KEPT)),
    failedWhat: optional(f.failedWhat, `${where}.failedWhat`, line),
    waitsForJob: optional(f.waitsForJob, `${where}.waitsForJob`, bool),
    turnEndedAt: optional(f.turnEndedAt, `${where}.turnEndedAt`, isoTime),
    lastMessage: optional(f.lastMessage, `${where}.lastMessage`, readMessage),
    messageCount: optional(f.messageCount, `${where}.messageCount`, int),
    readAt: optional(f.readAt, `${where}.readAt`, isoTime),
    endedAsking: optional(f.endedAsking, `${where}.endedAsking`, bool),
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
    writing: optional(f.writing, `${where}.writing`, bool),
    context: optional(f.context, `${where}.context`, text),
    options: list(f.options ?? [], `${where}.options`, (v, w) => nonEmpty(v, w, 500), 20),
    askedAt: isoTime(f.askedAt, `${where}.askedAt`),
    status: oneOf(QUESTION_STATUSES)(f.status, `${where}.status`),
    answer: optional(f.answer, `${where}.answer`, readAnswer),
    interpretation: optional(f.interpretation, `${where}.interpretation`, text),
    closedAt: optional(f.closedAt, `${where}.closedAt`, isoTime),
    setAside: optional(f.setAside, `${where}.setAside`, (v, w) => list(v, w, readAnswer, SET_ASIDE_KEPT)),
    dialog: optional(f.dialog, `${where}.dialog`, bool),
    several: optional(f.several, `${where}.several`, bool),
    group: optional(f.group, `${where}.group`, readGroup),
    review: optional(f.review, `${where}.review`, readReviewRef),
    past: optional(f.past, `${where}.past`, (v, w) => list(v, w, readPastDecision, PAST_SHOWN)),
  });
}

function readPastDecision(value: unknown, where: string): PastDecision {
  const f = fields(value, where);
  return compact({
    questionId: id(f.questionId, `${where}.questionId`),
    text: nonEmpty(f.text, `${where}.text`),
    answer: text(f.answer, `${where}.answer`),
    at: isoTime(f.at, `${where}.at`),
    probable: optional(f.probable, `${where}.probable`, bool),
  });
}

/** `note`: the question holds the developer's note sent with that round, not the page's answers. */
function readReviewRef(value: unknown, where: string): { id: string; round: number; note?: boolean } {
  const f = fields(value, where);
  return compact({ id: id(f.id, `${where}.id`), round: int(f.round, `${where}.round`, 1), note: f.note === undefined || f.note === false ? undefined : bool(f.note, `${where}.note`) });
}

function readGroup(value: unknown, where: string): QuestionGroup {
  const f = fields(value, where);
  const size = int(f.size, `${where}.size`, 2, GROUP_SIZE_MAX);
  return { id: id(f.id, `${where}.id`), index: int(f.index, `${where}.index`, 0, size - 1), size };
}

function readAnswer(value: unknown, where: string): Answer {
  const f = fields(value, where);
  return compact({
    text: text(f.text, `${where}.text`),
    at: isoTime(f.at, `${where}.at`),
    via: oneOf(ANSWER_SOURCES)(f.via, `${where}.via`),
    images: optional(f.images, `${where}.images`, imageIds),
    probable: optional(f.probable, `${where}.probable`, bool),
  });
}

/** How many replies set aside a question keeps. */
export const SET_ASIDE_KEPT = 20;

/** How many failed tool calls in a row a session or an agent keeps. */
export const FAILURES_KEPT = 10;

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
    launch: optional(f.launch, `${where}.launch`, label),
    launchedBy: optional(f.launchedBy, `${where}.launchedBy`, label),
    resumedAt: optional(f.resumedAt, `${where}.resumedAt`, isoTime),
    goal: optional(f.goal, `${where}.goal`, line),
    summary: optional(f.summary, `${where}.summary`, line),
    state: oneOf(AGENT_STATES)(f.state, `${where}.state`),
    activity: optional(f.activity, `${where}.activity`, line),
    activityIsCall: optional(f.activityIsCall, `${where}.activityIsCall`, bool),
    activityAt: optional(f.activityAt, `${where}.activityAt`, isoTime),
    failedAt: optional(f.failedAt, `${where}.failedAt`, (v, w) => list(v, w, isoTime, FAILURES_KEPT)),
    failedWhat: optional(f.failedWhat, `${where}.failedWhat`, line),
    waitsForJob: optional(f.waitsForJob, `${where}.waitsForJob`, bool),
    branch: optional(f.branch, `${where}.branch`, label),
    commit: optional(f.commit, `${where}.commit`, label),
    worktree: optional(f.worktree, `${where}.worktree`, (v, w) => nonEmpty(v, w, 4096)),
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
  return compact({
    id: id(f.id, `${where}.id`),
    sessionId: id(f.sessionId, `${where}.sessionId`),
    name: label(f.name, `${where}.name`),
    url: localUrl(f.url, `${where}.url`),
    startedAt: isoTime(f.startedAt, `${where}.startedAt`),
    detected: optional(f.detected, `${where}.detected`, bool),
  });
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
    step: optional(f.step, `${where}.step`, bool),
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
    branches: optional(f.branches, `${where}.branches`, (v, w) => list(v, w, readBranchState, 500)),
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
    bytes: optional(f.bytes, `${where}.bytes`, (v, w) => int(v, w)),
    sizedAt: optional(f.sizedAt, `${where}.sizedAt`, isoTime),
    main: f.main === true,
    ...gitState(f, where),
    busy: optional(f.busy, `${where}.busy`, (v, w) => list(v, w, label, BUSY_KEPT)),
  });
}

/** How many processes working in a checkout are named. */
export const BUSY_KEPT = 5;

/** Where a head stands against the main branch, as both a checkout and a branch carry it. */
function gitState(f: Fields, where: string) {
  const count = (v: unknown, w: string) => int(v, w);
  return {
    merged: optional(f.merged, `${where}.merged`, bool),
    ahead: optional(f.ahead, `${where}.ahead`, count),
    behind: optional(f.behind, `${where}.behind`, count),
    dirty: optional(f.dirty, `${where}.dirty`, count),
    subject: optional(f.subject, `${where}.subject`, line),
    committedAt: optional(f.committedAt, `${where}.committedAt`, isoTime),
    error: optional(f.error, `${where}.error`, line),
  };
}

function readBranchState(value: unknown, where: string): BranchState {
  const f = fields(value, where);
  const { dirty: _dirty, ...state } = gitState(f, where);
  return compact({
    name: label(f.name, `${where}.name`),
    exists: bool(f.exists, `${where}.exists`),
    head: optional(f.head, `${where}.head`, label),
    ...state,
  });
}

export function readHandoff(value: unknown, where = "handoff"): Handoff {
  const f = fields(value, where);
  return {
    sessionId: id(f.sessionId, `${where}.sessionId`),
    at: isoTime(f.at, `${where}.at`),
    trigger: oneOf(["manual", "auto"] as const)(f.trigger, `${where}.trigger`),
    text: text(f.text, `${where}.text`, HANDOFF_MAX),
  };
}

/** The most a handoff says, in characters: what a compacted session reads first stays short. */
export const HANDOFF_MAX = 3000;

export function readSeen(value: unknown, where = "seen"): Seen {
  return { since: isoTime(fields(value, where).since, `${where}.since`) };
}

/** The plan windows' history (src/core/limits.ts), checked; a label holding one window is the format before past windows were kept. */
export function readPlanHistory(value: unknown, where: string): PlanHistory {
  const history: PlanHistory = {};
  for (const [label, entry] of Object.entries(fields(value, where))) {
    const at = `${where}.${label}`;
    history[label] = Array.isArray(entry) ? list(entry, at, readPlanWindowHistory, 20) : [readPlanWindowHistory(entry, at)];
  }
  return history;
}

function readPlanWindowHistory(value: unknown, where: string): PlanWindowHistory {
  const f = fields(value, where);
  return compact({
    resetsAt: optional(f.resetsAt, `${where}.resetsAt`, isoTime),
    samples: list(f.samples, `${where}.samples`, (v, w) => {
      const sample = fields(v, w);
      return { at: isoTime(sample.at, `${w}.at`), percent: num(sample.percent, `${w}.percent`, 0, 100) };
    }, 200),
  });
}

// The title names a review on one line of the desk, of the CLI and of the line sent to a session.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** One line of at most `max` characters, no control characters, no spaces at its ends. */
function oneLine(value: unknown, where: string, max: number): string {
  const t = nonEmpty(value, where, max);
  if (CONTROL.test(t)) throw new InputError(`${where}: one line without control characters, got ${JSON.stringify(t)}`);
  if (t !== t.trim()) throw new InputError(`${where}: no spaces at its start or end, got ${JSON.stringify(t)}`);
  return t;
}

/** A review's title: one line of at most 120 characters, no control characters. */
export function reviewTitle(value: unknown, where: string): string {
  return oneLine(value, where, REVIEW_TITLE_MAX);
}

/** Why a review was closed: one line of at most 300 characters, no control characters. */
export function reviewReason(value: unknown, where: string): string {
  return oneLine(value, where, REVIEW_REASON_MAX);
}

export function readReview(value: unknown, where = "review"): Review {
  const f = fields(value, where);
  const project = fields(f.project, `${where}.project`);
  const rounds = list(f.rounds, `${where}.rounds`, readReviewRound, 10_000);
  if (rounds.length === 0) throw new InputError(`${where}.rounds: a review has at least one round`);
  return compact({
    id: id(f.id, `${where}.id`),
    title: reviewTitle(f.title, `${where}.title`),
    project: { name: label(project.name, `${where}.project.name`), dir: nonEmpty(project.dir, `${where}.project.dir`, 4096) },
    sessionId: id(f.sessionId, `${where}.sessionId`),
    rounds,
    progress: optional(f.progress, `${where}.progress`, readProgress),
    updatedAt: optional(f.updatedAt, `${where}.updatedAt`, isoTime),
    updatedFrom: optional(f.updatedFrom, `${where}.updatedFrom`, oneOf(["local", "remote"] as const)),
    hasSummary: bool(f.hasSummary ?? false, `${where}.hasSummary`),
    sends: list(f.sends ?? [], `${where}.sends`, readReviewSend, 10_000),
    collected: optional(f.collected, `${where}.collected`, readCollected),
    openedAt: optional(f.openedAt, `${where}.openedAt`, isoTime),
    closedAt: optional(f.closedAt, `${where}.closedAt`, isoTime),
    closedReason: optional(f.closedReason, `${where}.closedReason`, reviewReason),
    closedBy: optional(f.closedBy, `${where}.closedBy`, id),
  });
}

function readReviewRound(value: unknown, where: string): ReviewRound {
  const f = fields(value, where);
  return { n: int(f.n, `${where}.n`, 1), at: isoTime(f.at, `${where}.at`), sessionId: id(f.sessionId, `${where}.sessionId`), bytes: int(f.bytes, `${where}.bytes`) };
}

export function readProgress(value: unknown, where: string): ReviewProgress {
  const f = fields(value, where);
  const total = int(f.total, `${where}.total`, 1, 1_000_000);
  return { done: int(f.done, `${where}.done`, 0, total), total };
}

function readReviewSend(value: unknown, where: string): ReviewSend {
  const f = fields(value, where);
  return compact({
    at: isoTime(f.at, `${where}.at`),
    to: f.to === null ? null : id(f.to, `${where}.to`),
    round: int(f.round, `${where}.round`, 1),
    progress: optional(f.progress, `${where}.progress`, readProgress),
    note: optional(f.note, `${where}.note`, reviewNote),
  });
}

/** The developer's note sent with a review: their own words, any lines, at most REVIEW_NOTE_MAX characters, not blank. */
export function reviewNote(value: unknown, where: string): string {
  const t = nonEmpty(value, where, REVIEW_NOTE_MAX);
  if (t.trim() === "") throw new InputError(`${where}: empty; leave it out to send without a note`);
  return t;
}

function readCollected(value: unknown, where: string): { at: string; sessionId: string; round: number } {
  const f = fields(value, where);
  return { at: isoTime(f.at, `${where}.at`), sessionId: id(f.sessionId, `${where}.sessionId`), round: int(f.round, `${where}.round`, 1) };
}

/** A review's saved state; its data is checked against the same limits as a write to it. */
export function readReviewState(value: unknown, where = "review state"): ReviewState {
  const f = fields(value, where);
  // fromEntries defines each key, so one such as "__proto__" stays a key.
  const data: Record<string, string> = Object.fromEntries(
    Object.entries(fields(f.data ?? {}, `${where}.data`)).map(([key, v]) => [reviewKey(key, `${where}.data key`), text(v, `${where}.data[${JSON.stringify(key.slice(0, 40))}]`, REVIEW_STATE_MAX)]),
  );
  if (stateBytes(data) > REVIEW_STATE_MAX) throw new InputError(`${where}.data: larger than ${REVIEW_STATE_MAX} bytes`);
  return compact({ data, summary: optional(f.summary, `${where}.summary`, (v, w) => text(v, w, REVIEW_SUMMARY_MAX)), rev: int(f.rev ?? 0, `${where}.rev`) });
}

export function reviewKey(value: unknown, where: string): string {
  return text(value, where, REVIEW_KEY_MAX);
}

/** The size a review's saved data counts against its limit: its JSON, in UTF-8 bytes. */
export function stateBytes(data: Record<string, string>): number {
  return Buffer.byteLength(JSON.stringify(data));
}

/** The page counter's text as done and total: "12/97", "12 of 97", "12 de 97"; undefined when it says neither. */
export function parseProgress(counter: string): ReviewProgress | undefined {
  const m = /(\d{1,7})\s*(?:\/|of|de)\s*(\d{1,7})/i.exec(counter);
  if (!m) return undefined;
  const done = Number(m[1]);
  const total = Number(m[2]);
  return total >= 1 && total <= 1_000_000 && done <= total ? { done, total } : undefined;
}

/**
 * The line a review's send hands over: built from the review's validated fields only, never from
 * what its page wrote. `to`: delivered to the session that published it, or copied for another one.
 */
export function reviewLine(review: Pick<Review, "id" | "title">, round: number, progress: ReviewProgress | undefined, to: "session" | "other", note?: string): string {
  const reviewed = progress ? `, ${progress.done} of ${progress.total} reviewed` : "";
  const line =
    to === "session"
      ? `Review «${review.title}» sent from agent-desk (round ${round}${reviewed}). Read the answers with: agent-desk review ${review.id}`
      : `Pick up the review «${review.title}» from agent-desk (round ${round}${reviewed}): agent-desk review ${review.id}`;
  // The developer's own words follow, verbatim, in the same message.
  return note === undefined ? line : `${line}\n\n${note}`;
}

export const REVIEW_STATUSES = ["open", "sent, not read", "read", "closed"] as const;

/** The send no session has read since, if any: the latest, when it came after the last read. */
export function unreadSend(review: Review): ReviewSend | undefined {
  const last = review.sends.at(-1);
  return last && (review.collected === undefined || review.collected.at < last.at) ? last : undefined;
}

/** Where a review stands for the sessions that read it. A review sent and closed but not read yet is still unread. */
export function reviewStatus(review: Review): (typeof REVIEW_STATUSES)[number] {
  if (unreadSend(review)) return "sent, not read";
  if (review.closedAt) return "closed";
  return review.collected ? "read" : "open";
}
