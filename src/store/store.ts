// The store: one JSON file per record under the desk's home, shared by hooks, the CLI and the server.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { compact, fields, InputError, int, isoTime, list, oneOf, optional, text } from "../core/check.ts";
import { id, newId } from "../core/ids.ts";
import { addSamples, type PlanHistory } from "../core/limits.ts";
import { isAlive, procInfo, sessionFinished } from "../core/proc.ts";
import {
  type Agent,
  type Answer,
  type InboxEntry,
  type Metrics,
  type ConversationEntry,
  type ProjectScan,
  type Question,
  type QuestionGroup,
  type QuestionKind,
  type Result,
  type Review,
  type ReviewState,
  type Seen,
  type Service,
  type Session,
  readAgent,
  readInboxEntry,
  readMetrics,
  readPlanHistory,
  type PlanWindow,
  readConversationEntry,
  readProjectScan,
  readQuestion,
  readResult,
  readReview,
  readReviewState,
  readSeen,
  readService,
  readSession,
  SET_ASIDE_KEPT,
  parseProgress,
  REVIEW_PAGE_MAX,
  REVIEW_PROGRESS_MAX,
  REVIEW_ROUNDS_KEPT,
  REVIEW_STATE_MAX,
  REVIEW_SUMMARY_MAX,
  reviewKey,
  reviewLine,
  reviewTitle,
  stateBytes,
} from "../core/model.ts";
import { ensureDir, isCode, listJson, readJson, withLock, writeAtomic, writeJson } from "./fsx.ts";
import { StorePaths } from "./paths.ts";

export type Clock = () => Date;

/** Everything the page shows, plus the files that could not be read (never silently skipped). */
export type Snapshot = {
  projects: ProjectScan[];
  sessions: Session[];
  questions: Question[];
  agents: Agent[];
  results: Result[];
  services: Service[];
  metrics: Metrics[];
  reviews: Review[];
  seen: Seen | undefined;
  problems: string[];
};

/** A change to a review's saved state from its page: localStorage operations, in order, as the page made them. */
export type ReviewOp = { op: "set"; key: string; value: string } | { op: "remove"; key: string } | { op: "clear" };
export type ReviewChange = { ops: ReviewOp[]; progress?: string; summary?: string };

/** A review's line could not reach the session that published it; the message says why. */
export class Undeliverable extends InputError {
  override name = "Undeliverable";
}

/** A review was sent from a view of it older than its saved state: what the developer saw is not what would be recorded. */
export class StaleReview extends InputError {
  override name = "StaleReview";
  readonly rev: number;
  constructor(message: string, rev: number) {
    super(message);
    this.rev = rev;
  }
}

/** Fields to merge into an agent; one given as undefined is removed from it. */
export type AgentFields = { [K in keyof Omit<Agent, "sessionId" | "name">]?: Agent[K] | undefined };

export type NewSession = Pick<Session, "id" | "provider" | "project"> & Partial<Omit<Session, "id" | "provider" | "project">>;

export type ResultInput = {
  sessionId: string;
  title: string;
  summary?: string;
  status?: "ok" | "failed";
  url?: string;
  /** Paths of image files to copy into the store. */
  images?: { path: string; caption?: string }[];
  /** Indexes into `images` to compare with a slider. */
  compare?: { before: number; after: number };
  assumptions?: string[];
  decisions?: string[];
  checks?: { criterion: string; verification: string }[];
};

export type DecisionQuery = {
  /** A folder (the recorded project it is in, with every project folder inside that) or a project's name. */
  project: { dir: string } | { name: string };
  /** Words that must all occur, ignoring case and accents. */
  search?: string;
  permissions?: boolean;
  /** Also questions closed without an answer (dismissed, or the session moved on). */
  unanswered?: boolean;
  limit: number;
};

export type DecisionSession = { id: string; title?: string; project: Session["project"] };

/** An answered question, or the decisions a session reported with a result. `at`: when it was decided. */
export type Decision =
  | { source: "question"; at: string; session: DecisionSession; question: Question }
  | { source: "result"; at: string; session: DecisionSession; result: Result };

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as const;
export type ImageExt = keyof typeof IMAGE_TYPES;

/** How long a question asked during a turn waits for that turn's end before it shows anyway. */
const WRITING_MAX_MS = 5 * 60_000;

export class Store {
  readonly paths: StorePaths;
  private readonly now: Clock;

  constructor(home: string, now: Clock = () => new Date()) {
    this.paths = new StorePaths(home);
    this.now = now;
    ensureDir(this.paths.home);
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  // ── Secret ──────────────────────────────────────────────────────────────

  /** Per-install secret required by every state-changing HTTP request. */
  secret(): string {
    const file = this.paths.secret;
    return withLock(file, () => {
      try {
        const existing = fs.readFileSync(file, "utf8").trim();
        if (/^[0-9a-f]{64}$/.test(existing)) return existing;
        throw new Error(`${file}: malformed secret; delete the file and restart the desk to create a new one`);
      } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
      }
      const created = randomBytes(32).toString("hex");
      writeAtomic(file, `${created}\n`);
      return created;
    });
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  getSession(sessionId: string): Session | undefined {
    const file = this.paths.session(sessionId);
    const raw = readJson(file);
    return raw === undefined ? undefined : readSession(raw, file);
  }

  /** Creates the session or merges `fields` into it. */
  upsertSession(input: NewSession): Session {
    const file = this.paths.session(input.id);
    return withLock(file, () => {
      const at = this.stamp();
      const current = this.getSession(input.id);
      const next = readSession(
        compact({
          ...current,
          ...input,
          state: input.state ?? current?.state ?? "working",
          startedAt: current?.startedAt ?? input.startedAt ?? at,
          updatedAt: at,
        }),
        file,
      );
      writeJson(file, next);
      return next;
    });
  }

  updateSession(sessionId: string, change: (s: Session) => Session): Session {
    const file = this.paths.session(sessionId);
    return withLock(file, () => {
      const current = this.getSession(sessionId);
      if (!current) throw new InputError(`no session ${sessionId} in the store; it registers when its first hook runs`);
      const next = readSession({ ...change(current), updatedAt: this.stamp() }, file);
      writeJson(file, next);
      return next;
    });
  }

  /** The developer read the session's conversation on the desk: its last message is no longer new. */
  markSessionRead(sessionId: string): Session {
    return this.updateSession(sessionId, (s) => ({ ...s, readAt: this.stamp() }));
  }

  /** The developer wants to come back to it: its last message is new again, until it is opened. */
  markSessionUnread(sessionId: string): Session {
    return this.updateSession(sessionId, ({ readAt: _readAt, ...s }) => s);
  }

  /**
   * The developer forgets a session that ended or whose process is gone: it leaves the desk now.
   * It is marked ended and read, what it still asked is dismissed (answers waiting in its inbox
   * included), and its results not seen yet are marked seen; its record, decisions and results stay
   * for the history, until the archive takes them. Refused for a session still running. Only what
   * existed when it was forgotten is closed, and running it again finishes what a failure left.
   */
  forgetSession(sessionId: string): { session: Session; dismissed: number; seen: number } {
    let at = "";
    const session = this.updateSession(sessionId, (s) => {
      if (!sessionFinished(s)) throw new InputError(`session ${sessionId} is still running; end it first, then forget it`);
      at = this.stamp();
      const { endedAsking: _endedAsking, ...rest } = s;
      return { ...rest, state: "ended", endedAt: s.endedAt ?? at, readAt: at };
    });
    const before = (iso: string) => iso <= at;
    const dismissed = [
      ...this.withdrawInbox(sessionId),
      ...this.closeOpen(sessionId, { status: "dismissed", which: (q) => before(q.askedAt) }),
    ];
    const unseen = this.listResults().filter((r) => r.sessionId === sessionId && !r.seenAt && before(r.at));
    for (const r of unseen) this.markResultSeen(r.id);
    return { session, dismissed: dismissed.length, seen: unseen.length };
  }

  listSessions(problems?: string[]): Session[] {
    return this.readAll(this.paths.sessionsDir, readSession, problems).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // ── Questions ───────────────────────────────────────────────────────────
  // Open questions live in questions/open/, closed ones in questions/closed/, so hooks that only
  // need what is open never read the whole history.

  getQuestion(questionId: string): Question | undefined {
    for (const file of [this.paths.question(questionId, "closed"), this.paths.question(questionId, "open")]) {
      const raw = readJson(file);
      if (raw !== undefined) return readQuestion(raw, file);
    }
    return undefined;
  }

  ask(input: { sessionId: string; kind: QuestionKind; text: string; context?: string; options?: string[]; dialog?: boolean; several?: boolean; group?: QuestionGroup; writing?: boolean }): Question {
    this.requireSession(input.sessionId);
    const question = readQuestion({
      id: newId("q"),
      sessionId: input.sessionId,
      kind: input.kind,
      text: input.text,
      context: input.context,
      options: input.options ?? [],
      askedAt: this.stamp(),
      status: "open",
      dialog: input.dialog || undefined,
      several: input.several || undefined,
      group: input.group,
      writing: input.writing || undefined,
    });
    writeJson(this.paths.question(question.id, "open"), question);
    return question;
  }

  /** The session's turn ended: what it asked during the turn is complete, and can be shown. */
  releaseQuestions(sessionId: string, problems?: string[]): void {
    for (const q of this.openQuestions(sessionId, problems)) {
      if (q.writing) this.changeQuestion(q.id, ({ writing: _writing, ...rest }) => rest);
    }
  }

  /**
   * Questions still being written, not to be shown yet. A session that died, or a turn that never
   * ends, must not hide what it asked: past a few minutes it shows as it is.
   */
  heldQuestions(now = this.now().getTime()): Set<string> {
    const sessions = new Map(this.listSessions().map((s) => [s.id, s]));
    const held = this.openQuestions().filter((q) => {
      const s = sessions.get(q.sessionId);
      const live = s !== undefined && !sessionFinished(s);
      return q.writing === true && live && now - Date.parse(q.askedAt) < WRITING_MAX_MS;
    });
    return new Set(held.map((q) => q.id));
  }

  openQuestions(sessionId?: string, problems?: string[]): Question[] {
    return this.readAll(this.paths.questionDir("open"), readQuestion, problems)
      .filter((q) => q.status === "open" && (sessionId === undefined || q.sessionId === sessionId))
      .sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  }

  listQuestions(problems?: string[]): Question[] {
    const byId = new Map<string, Question>();
    for (const where of ["open", "closed"] as const) {
      // A question moving between the two folders can be seen in both; the later read wins.
      for (const q of this.readAll(this.paths.questionDir(where), readQuestion, problems)) byId.set(q.id, q);
    }
    return [...byId.values()].sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  }

  private changeQuestion(questionId: string, change: (q: Question) => Question): Question {
    return withLock(this.paths.questionLock(questionId), () => {
      const current = this.getQuestion(questionId);
      if (!current) throw new InputError(`no question ${questionId} in the store`);
      const where = (q: Question) => (q.status === "open" ? "open" : "closed");
      const next = readQuestion(change(current), this.paths.question(questionId, where(current)));
      writeJson(this.paths.question(questionId, where(next)), next);
      if (where(next) !== where(current)) fs.rmSync(this.paths.question(questionId, where(current)), { force: true });
      return next;
    });
  }

  /**
   * The session moved on (the developer typed in its terminal, a tool ran, the session ended):
   * every open item of that session is closed. `answer` is recorded on questions it answers, marked
   * `probable` when it is only what the developer wrote next.
   */
  closeOpen(
    sessionId: string,
    how: { answer?: string; probable?: boolean; kinds?: readonly QuestionKind[]; which?: (q: Question) => boolean; status?: "answered" | "dismissed"; problems?: string[] },
  ): Question[] {
    const closed: Question[] = [];
    // One time for all one event closes, so the questions one reply closed are told by it.
    const at = this.stamp();
    for (const q of this.openQuestions(sessionId, how.problems)) {
      if (how.kinds && !how.kinds.includes(q.kind)) continue;
      if (how.which && !how.which(q)) continue;
      closed.push(
        this.changeQuestion(q.id, (cur) => {
          if (cur.status !== "open") return cur;
          const status = how.status ?? "answered";
          const answer: Answer | undefined =
            status === "answered" && how.answer !== undefined && cur.kind !== "permission"
              ? compact({ text: bounded(how.answer), at, via: "terminal" as const, probable: how.probable || undefined })
              : undefined;
          return compact({ ...cur, status, closedAt: at, answer });
        }),
      );
    }
    return closed;
  }

  /** Adds what the session said around a question it asked, when the question has no context yet. */
  addContext(questionId: string, context: string): Question {
    return this.changeQuestion(questionId, (q) => (q.context === undefined && context.trim() !== "" ? { ...q, context } : q));
  }

  dismiss(questionId: string): Question {
    return this.changeQuestion(questionId, (q) => (q.status === "open" ? { ...q, status: "dismissed", closedAt: this.stamp() } : q));
  }

  /**
   * Records how the session understood the answer of the turn now running: the latest one given
   * since its previous turn ended. An older answer is never taken for it.
   */
  interpret(sessionId: string, interpretation: string): Question {
    const session = this.getSession(sessionId);
    if (!session) throw new InputError(`no session ${sessionId} in the store; it registers when its first hook runs`);
    const since = session.turnEndedAt ?? session.lastMessage?.at ?? session.startedAt;
    const answered = this.readAll(this.paths.questionDir("closed"), readQuestion)
      .filter((q) => q.sessionId === sessionId && q.answer !== undefined)
      .sort((a, b) => (a.answer?.at ?? "").localeCompare(b.answer?.at ?? ""));
    const latest = answered.at(-1);
    if (!latest?.answer || latest.answer.at <= since) {
      const before = latest ? `: the latest answer, to ${JSON.stringify(headline(latest.text))}, was given before this turn began` : "";
      throw new InputError(`no question was answered this turn${before}; the interpretation was not recorded`);
    }
    return this.changeQuestion(latest.id, (q) => ({ ...q, interpretation }));
  }

  /**
   * The session says the developer's reply did not answer what it asked: the question opens again, in
   * its place among the open ones (by when it was asked), and the reply is set aside (it stays in the
   * conversation, and in `setAside`), never kept as its answer, so it is no decision. Without
   * `questionId`: the questions the session's latest answer closed, refused when that answer is
   * certain. A question already open is left as it is, so running it again changes nothing.
   */
  unanswered(sessionId: string, questionId?: string): { reopened: Question[]; alreadyOpen: Question[] } {
    this.requireSession(sessionId);
    const targets = questionId === undefined ? this.lastReplied(sessionId) : [this.replied(sessionId, questionId)];
    const reopened: Question[] = [];
    const alreadyOpen: Question[] = [];
    for (const target of targets) {
      if (target.status === "open") {
        alreadyOpen.push(target);
        continue;
      }
      const reply = target.answer;
      let opened = false;
      const now = this.changeQuestion(target.id, (cur) => {
        if (cur.status === "open") return cur; // opened again meanwhile, or never closed
        if (cur.answer === undefined || cur.answer.at !== reply?.at) {
          throw new InputError(`question ${cur.id} was ${cur.answer === undefined ? cur.status : "answered again"} while this ran, so nothing changed; run it again if its answer now is not one either`);
        }
        opened = true;
        const { answer, closedAt: _closed, interpretation: _understood, ...rest } = cur;
        return { ...rest, status: "open", setAside: [...(cur.setAside ?? []), answer].slice(-SET_ASIDE_KEPT) };
      });
      (opened ? reopened : alreadyOpen).push(now);
    }
    return { reopened, alreadyOpen };
  }

  /** A question of the session named to be opened again: any answer it has, certain or not, is set aside. */
  private replied(sessionId: string, questionId: string): Question {
    const q = this.getQuestion(questionId);
    if (!q || q.sessionId !== sessionId) throw new InputError(`no question ${questionId} of session ${sessionId} in the store`);
    if (q.status === "open") return q;
    if (q.kind === "permission") throw new InputError(`question ${questionId} is a permission prompt: its answer is whether the tool ran, and cannot be set aside`);
    if (q.review) throw new InputError(`question ${questionId} holds the answers of review ${q.review.id}, sent from the desk: it is no question to open again; read them with agent-desk review ${q.review.id}`);
    if (q.answer === undefined) throw new InputError(`question ${questionId} was closed without an answer (${q.status}); there is no reply to set aside`);
    return q;
  }

  /**
   * The questions the session's latest answer closed, while that answer is probable; the question set
   * aside last instead, when no answer came since (it is open already).
   */
  private lastReplied(sessionId: string): Question[] {
    const replyAt = (q: Question) => (q.status === "open" ? q.setAside?.at(-1)?.at : q.answer?.at);
    const mine = this.listQuestions().filter((q) => q.sessionId === sessionId && q.kind !== "permission" && !q.review && replyAt(q) !== undefined);
    const latest = mine.sort((a, b) => (replyAt(a) ?? "").localeCompare(replyAt(b) ?? "")).at(-1);
    if (!latest) throw new InputError(`session ${sessionId} has no answered question to open again`);
    const answer = latest.answer;
    if (latest.status === "open" || answer === undefined) return [latest];
    if (!answer.probable) {
      const where = answer.via === "desk" ? "on the desk" : "in the session's own dialog";
      throw new InputError(`the latest answer, to question ${latest.id} (${JSON.stringify(headline(latest.text))}), was given to that very question ${where}, so it stays; to open it again all the same, name it: --question ${latest.id}`);
    }
    return mine.filter((q) => q.status === "answered" && q.answer?.probable && q.answer.at === answer.at && q.answer.text === answer.text);
  }

  // ── Answers from the desk ───────────────────────────────────────────────

  /**
   * Closes an open question with the developer's answer and puts it in the session's inbox,
   * exactly as typed. Refused unless the session takes it now (`acceptsMessages`), so an answer
   * never waits in an inbox to reach a later, unrelated turn. If the inbox write fails the question
   * is reopened.
   */
  answerFromDesk(questionId: string, text: string, images: string[] = []): Question {
    if (text.trim() === "" && images.length === 0) throw new InputError("the answer is empty");
    for (const image of images) if (!this.imageFile(image)) throw new InputError(`no image ${image} in the store; attach it again`);
    const attached = images.length > 0 ? images : undefined;
    let before: Question | undefined;
    const answered = this.changeQuestion(questionId, (q) => {
      if (q.status !== "open") throw new InputError(`question ${questionId} is already ${q.status}`);
      if (attached && (q.kind === "permission" || q.dialog)) throw new InputError("a permission prompt or a choice dialog takes text only; remove the images");
      if (!this.acceptsMessages(q.sessionId)) throw new InputError("the session is not taking answers from the desk right now; answer in its terminal");
      before = q;
      const at = this.stamp();
      return { ...q, status: "answered", closedAt: at, answer: compact({ text, at, via: "desk" as const, images: attached }) };
    });
    try {
      this.deliver(answered, text, attached);
    } catch (error) {
      const original = before;
      try {
        if (original) this.changeQuestion(questionId, () => original);
      } catch (rollback) {
        throw new AggregateError([error, rollback], `could not deliver the answer to session ${answered.sessionId}, nor reopen question ${questionId}`);
      }
      throw new Error(`could not deliver the answer to session ${answered.sessionId}; the question is open again`, { cause: error });
    }
    return answered;
  }

  /**
   * Puts `text` in the session's inbox as the answer to `question`, and in its conversation as the
   * developer's message from the desk. On failure neither is left behind.
   */
  private deliver(question: Question, text: string, images?: string[]): void {
    const entry: InboxEntry = compact({ questionId: question.id, question: question.text, answer: text, at: question.closedAt ?? this.stamp(), images });
    let message: ConversationEntry | undefined;
    let written = false;
    try {
      message = this.addMessage(compact({ sessionId: question.sessionId, from: "developer" as const, text, via: "desk" as const, images }));
      writeJson(this.paths.inboxEntry(question.sessionId, question.id), entry);
      written = true;
      this.syncInboxMarker();
    } catch (error) {
      // Its conversation must not show as sent what never reached the session.
      try {
        if (written) fs.rmSync(this.paths.inboxEntry(question.sessionId, question.id), { force: true });
        if (message) this.takeBackMessage(message);
      } catch (rollback) {
        throw new AggregateError([error, rollback], `could not deliver to session ${question.sessionId}, nor take back what was written`);
      }
      throw error;
    }
  }

  /** A message to a session while it works is kept on it, to show later whether its turn took it in. */
  private noteSentWhileWorking(sessionId: string, text: string): void {
    const at = this.stamp();
    this.updateSession(sessionId, (s) => (s.state === "working" ? { ...s, sentWhileWorking: [...(s.sentWhileWorking ?? []), { text: text.length > 2000 ? `${text.slice(0, 1999)}…` : text, at }].slice(-10) } : s));
  }

  /**
   * A message to a session that asked nothing: a reply to its last report while it waits, or a
   * message while it works, which it receives at its next step. It is kept in the history as an
   * answered item whose text is that last report.
   */
  messageFromDesk(sessionId: string, text: string, images: string[] = []): Question {
    const session = this.getSession(sessionId);
    if (!session) throw new InputError(`no session ${sessionId} in the store`);
    if (text.trim() === "" && images.length === 0) throw new InputError("the message is empty");
    if (!this.acceptsMessages(sessionId)) throw new InputError("the session is not taking messages from the desk right now; write in its terminal");
    if (session.state === "working") this.noteSentWhileWorking(sessionId, text);
    const said = session.lastMessage?.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).at(-1) ?? "(no message)";
    const item = this.ask({ sessionId, kind: "waiting", text: said.length > 600 ? `…${said.slice(-600)}` : said });
    try {
      return this.answerFromDesk(item.id, text, images);
    } catch (error) {
      this.dismiss(item.id); // it was only created to carry this message
      throw error;
    }
  }

  /**
   * Claims the answers waiting for a session; each one is returned to exactly one caller. If any
   * claimed entry is unreadable, the readable ones go back to the inbox, the unreadable one is set
   * aside as `.<name>.rejected`, and the error is raised.
   */
  takeInbox(sessionId: string, only?: (questionId: string) => boolean): InboxEntry[] {
    const dir = this.paths.sessionInbox(sessionId);
    const claimed: { file: string; claim: string }[] = [];
    for (const name of listJson(dir)) {
      if (only && !only(name.slice(0, -".json".length))) continue;
      const file = path.join(dir, name);
      const claim = path.join(dir, `.${name}.${process.pid}.${randomBytes(4).toString("hex")}.taken`);
      try {
        fs.renameSync(file, claim);
      } catch (error) {
        if (isCode(error, "ENOENT")) continue; // another waiter claimed it first
        throw error;
      }
      claimed.push({ file, claim });
    }
    const taken: InboxEntry[] = [];
    for (const c of claimed) {
      try {
        taken.push(readInboxEntry(readJson(c.claim), c.file));
      } catch (error) {
        for (const other of claimed) {
          if (other === c) fs.renameSync(c.claim, path.join(dir, `.${path.basename(c.file)}.rejected`));
          else if (fs.existsSync(other.claim)) fs.renameSync(other.claim, other.file);
        }
        throw error;
      }
    }
    for (const c of claimed) fs.rmSync(c.claim);
    if (claimed.length > 0) this.syncInboxMarker();
    return taken.sort((a, b) => a.at.localeCompare(b.at));
  }

  /** Creates or removes `paths.inboxMarker` to match the inboxes, under a lock so no update is lost. */
  syncInboxMarker(): void {
    const marker = this.paths.inboxMarker;
    withLock(marker, () => {
      const pending = this.subdirs(this.paths.inboxDir).some((dir) => listJson(dir).length > 0);
      if (pending) fs.writeFileSync(marker, "", { mode: 0o600 });
      else fs.rmSync(marker, { force: true });
    });
  }

  /**
   * The developer moved on in the terminal or the session ended: answers still in the inbox will
   * never be delivered. They are removed, and their questions take `replacement` as the answer
   * (what was typed instead) or are dismissed.
   */
  withdrawInbox(sessionId: string, replacement?: string): Question[] {
    return this.takeInbox(sessionId).map((entry) =>
      this.changeQuestion(entry.questionId, (q) => {
        if (q.review) return q; // the developer's answers to the review stand; only its line was not delivered
        const at = this.stamp();
        return replacement === undefined
          ? compact({ ...q, status: "dismissed" as const, closedAt: at, answer: undefined })
          : { ...q, status: "answered", closedAt: at, answer: { text: bounded(replacement), at, via: "terminal", probable: true } };
      }),
    );
  }

  /**
   * Marks the session as taking answers from the desk while this process waits for them.
   * Returns the function that withdraws the mark.
   */
  listen(sessionId: string, me = process.pid): () => void {
    const file = path.join(this.paths.sessionInbox(sessionId), `.listener.${me}.json`);
    writeJson(file, compact({ pid: me, start: procInfo(me)?.start, since: this.stamp() }));
    return () => fs.rmSync(file, { force: true });
  }

  /** Live processes listening for this session's answers, oldest first. */
  listeners(sessionId: string, problems?: string[]): { pid: number; since: string }[] {
    const dir = this.paths.sessionInbox(sessionId);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      if (isCode(error, "ENOENT")) return [];
      throw error;
    }
    const live: { pid: number; since: string }[] = [];
    for (const name of names.filter((n) => /^\.listener\.\d+\.json$/.test(n))) {
      const file = path.join(dir, name);
      try {
        const raw = readJson(file);
        if (raw === undefined) continue; // withdrawn since the listing
        const f = fields(raw, file);
        const pid = int(f.pid, `${file}.pid`, 1);
        if (isAlive(pid, f.start === undefined ? undefined : text(f.start, `${file}.start`, 100))) live.push({ pid, since: isoTime(f.since, `${file}.since`) });
      } catch (error) {
        if (!problems) throw error;
        problems.push((error as Error).message);
      }
    }
    return live.sort((a, b) => a.since.localeCompare(b.since));
  }

  isListening(sessionId: string, problems?: string[]): boolean {
    return this.listeners(sessionId, problems).length > 0;
  }

  /**
   * The session takes a message from the desk now: something listens for it (it waits), or it works
   * and its adapter hands messages over at its next step.
   */
  acceptsMessages(sessionId: string, problems?: string[]): boolean {
    if (this.isListening(sessionId, problems)) return true;
    const s = this.getSession(sessionId);
    return s?.state === "working" && s.takesMessagesWhileWorking === true && !sessionFinished(s);
  }

  // ── Agents ──────────────────────────────────────────────────────────────

  getAgent(sessionId: string, name: string): Agent | undefined {
    const file = this.paths.agent(sessionId, name);
    const raw = readJson(file);
    return raw === undefined ? undefined : readAgent(raw, file);
  }

  /** Creates the agent (working, started now) or merges `fields` into it. */
  upsertAgent(sessionId: string, name: string, fields: AgentFields): Agent {
    this.requireSession(sessionId);
    const file = this.paths.agent(sessionId, name);
    return withLock(file, () => this.writeAgent(sessionId, name, this.getAgent(sessionId, name), fields));
  }

  /** Creates a new agent named `base`, or `base-2`, `base-3`… when that name is taken, also by a concurrent writer. */
  addAgent(sessionId: string, base: string, fields: AgentFields): Agent {
    this.requireSession(sessionId);
    const taken = new Set(this.listAgents(sessionId).map((a) => a.name));
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      if (taken.has(name)) continue;
      const file = this.paths.agent(sessionId, name);
      const added = withLock(file, () => (this.getAgent(sessionId, name) ? undefined : this.writeAgent(sessionId, name, undefined, fields)));
      if (added) return added;
    }
  }

  /**
   * Merges `fields` into the agent; undefined, with nothing written, when it is not recorded (e.g.
   * renamed meanwhile) or `when`, checked under the agent's lock, refuses its current record: two
   * writers comparing the same record that way cannot both change it.
   */
  updateAgent(sessionId: string, name: string, fields: AgentFields, when?: (current: Agent) => boolean): Agent | undefined {
    const file = this.paths.agent(sessionId, name);
    return withLock(file, () => {
      const current = this.getAgent(sessionId, name);
      return current && (when === undefined || when(current)) ? this.writeAgent(sessionId, name, current, fields) : undefined;
    });
  }

  /**
   * Gives agent `from` the name `to`, with its state, times and history. When `to` is recorded
   * already, the two become one record under `to`: what was reported for it (goal, summary, branch,
   * commit, `after`) stays, the rest comes from `from`. Nothing moves, and undefined is returned,
   * when `from` is not recorded (another writer moved it first) or `to` follows another agent
   * (`ref`). Safe to run again: interrupted between writing `to` and removing `from`, it merges the
   * same record again.
   */
  renameAgent(sessionId: string, from: string, to: string): Agent | undefined {
    const source = this.paths.agent(sessionId, from);
    const target = this.paths.agent(sessionId, to);
    if (source === target) return this.getAgent(sessionId, from);
    return this.withBothAgents(source, target, () => {
      const moved = this.getAgent(sessionId, from);
      if (!moved) return undefined;
      const existing = this.getAgent(sessionId, to);
      if (existing?.ref !== undefined && existing.ref !== moved.ref) return undefined;
      const reported = existing ? reportedOf(existing) : {};
      const after = existing && existing.after.length > 0 ? existing.after : moved.after;
      const next = readAgent({ ...moved, ...reported, after, name: to, updatedAt: this.stamp() }, target);
      writeJson(target, next);
      fs.rmSync(source, { force: true });
      return next;
    });
  }

  /**
   * Makes two records that follow the same agent (the same `ref`) one record under `into`: what was
   * reported for it (goal, summary, branch, commit, `after`), its launch and type stay as `into`
   * has them, else as `from` has them; state, activity and failures come from the record updated
   * last; it started when the earlier one did. Nothing moves, and undefined is returned, when either
   * is not recorded or they follow different agents. Safe to run again, as renameAgent.
   */
  mergeAgent(sessionId: string, from: string, into: string): Agent | undefined {
    const source = this.paths.agent(sessionId, from);
    const target = this.paths.agent(sessionId, into);
    if (source === target) return undefined;
    return this.withBothAgents(source, target, () => {
      const gone = this.getAgent(sessionId, from);
      const kept = this.getAgent(sessionId, into);
      if (!gone || !kept || gone.ref === undefined || gone.ref !== kept.ref) return undefined;
      const live = gone.updatedAt > kept.updatedAt ? gone : kept;
      const next = readAgent(
        {
          ...live,
          ...reportedOf(gone),
          ...reportedOf(kept),
          ...compact({ type: kept.type ?? gone.type, launch: kept.launch ?? gone.launch }),
          after: kept.after.length > 0 ? kept.after : gone.after,
          startedAt: gone.startedAt < kept.startedAt ? gone.startedAt : kept.startedAt,
          name: into,
          updatedAt: this.stamp(),
        },
        target,
      );
      writeJson(target, next);
      fs.rmSync(source, { force: true });
      return next;
    });
  }

  /**
   * Runs `fn` holding the lock on the session's agents as a whole, which writers take while they
   * decide which record follows which agent (`ref`): one's read, decision and writes cannot
   * interleave with another's. Record locks are taken inside it, never the other way round.
   */
  withAgentsLocked<T>(sessionId: string, fn: () => T): T {
    return withLock(this.paths.agentsLock(sessionId), fn);
  }

  /** Both records' locks, always in the same order, so two writers on the same pair cannot deadlock. */
  private withBothAgents<T>(a: string, b: string, fn: () => T): T {
    const [first, second] = a < b ? [a, b] : [b, a];
    return withLock(first, () => withLock(second, fn));
  }

  private writeAgent(sessionId: string, name: string, current: Agent | undefined, fields: AgentFields): Agent {
    const file = this.paths.agent(sessionId, name);
    const at = this.stamp();
    // The mark goes with the activity it was written with: a new activity without it is someone's words.
    const activityIsCall = "activity" in fields ? fields.activityIsCall : (fields.activityIsCall ?? current?.activityIsCall);
    const merged = compact({ ...current, ...fields, activityIsCall, sessionId, name, updatedAt: at });
    const state = merged.state ?? "working";
    const ended = state === "done" || state === "failed";
    const next = readAgent(
      compact({
        ...merged,
        state,
        after: merged.after ?? [],
        startedAt: current?.startedAt ?? fields.startedAt ?? at,
        endedAt: ended ? (current?.endedAt ?? at) : undefined,
      }),
      file,
    );
    writeJson(file, next);
    return next;
  }

  listAgents(sessionId?: string, problems?: string[]): Agent[] {
    const dirs = sessionId === undefined ? this.subdirs(this.paths.agentsDir) : [this.paths.agentDir(sessionId)];
    return dirs.flatMap((dir) => this.readAll(dir, readAgent, problems)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  // ── Results and images ──────────────────────────────────────────────────

  addResult(input: ResultInput): Result {
    this.requireSession(input.sessionId);
    const images: { id: string; caption?: string }[] = [];
    try {
      return this.writeResult(input, images);
    } catch (error) {
      // No partial result: images copied for it are removed again.
      for (const image of images) {
        const stored = this.imageFile(image.id);
        if (stored) fs.rmSync(stored.file, { force: true });
      }
      throw error;
    }
  }

  private writeResult(input: ResultInput, images: { id: string; caption?: string }[]): Result {
    for (const [i, img] of (input.images ?? []).entries()) images.push(compact({ id: this.copyImage(img.path, `images[${i}]`), caption: img.caption }));
    const side = (i: number, which: string) => {
      const image = images[i];
      if (!image) throw new InputError(`compare.${which}: no image at index ${i} (there are ${images.length})`);
      return image.id;
    };
    const result = readResult({
      id: newId("r"),
      sessionId: input.sessionId,
      title: input.title,
      summary: input.summary ?? "",
      status: input.status ?? "ok",
      at: this.stamp(),
      url: input.url,
      images,
      compare: input.compare ? { before: side(input.compare.before, "before"), after: side(input.compare.after, "after") } : undefined,
      assumptions: input.assumptions ?? [],
      decisions: input.decisions ?? [],
      checks: input.checks ?? [],
    });
    writeJson(this.paths.result(result.id), result);
    return result;
  }

  markResultSeen(resultId: string): Result {
    return this.updateResult(resultId, (r) => (r.seenAt ? r : { ...r, seenAt: this.stamp() }));
  }

  /** Changes a result under its lock; one `change` returns unchanged is not written. */
  private updateResult(resultId: string, change: (current: Result) => Result): Result {
    const file = this.paths.result(resultId);
    return withLock(file, () => {
      const raw = readJson(file);
      if (raw === undefined) throw new InputError(`no result ${resultId} in the store`);
      const current = readResult(raw, file);
      const next = change(current);
      if (next !== current) writeJson(file, next);
      return next;
    });
  }

  listResults(problems?: string[]): Result[] {
    return this.readAll(this.paths.resultsDir, readResult, problems).sort((a, b) => b.at.localeCompare(a.at));
  }

  /** Copies an image into the store after checking its size and content type; returns its id. */
  private copyImage(source: string, where: string): string {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(source);
    } catch (error) {
      throw new InputError(`${where}: cannot read ${source} (${(error as Error).message})`);
    }
    if (!stat.isFile()) throw new InputError(`${where}: ${source} is not a file`);
    if (stat.size > IMAGE_MAX_BYTES) throw new InputError(`${where}: ${source} is larger than 20 MB`);
    return this.addImage(fs.readFileSync(source), `${where}: ${source}`);
  }

  /** Keeps an image (copied from a file, or attached on the desk) after checking it is one; returns its id. */
  addImage(data: Buffer, where = "image"): string {
    if (data.length > IMAGE_MAX_BYTES) throw new InputError(`${where} is larger than 20 MB`);
    const ext = imageType(data);
    if (!ext) throw new InputError(`${where} is not a PNG, JPEG, WebP or GIF image`);
    const imageId = newId("img");
    writeAtomic(this.paths.image(imageId, ext), data);
    return imageId;
  }

  imageFile(imageId: string): { file: string; ext: ImageExt } | undefined {
    for (const ext of Object.keys(IMAGE_TYPES) as ImageExt[]) {
      const file = this.paths.image(imageId, ext);
      if (fs.existsSync(file)) return { file, ext };
    }
    return undefined;
  }

  // ── Reviews ─────────────────────────────────────────────────────────────
  // reviews/<id>/review.json, round-<n>.html (the last few rounds) and state.json, all changed
  // under the lock of review.json.

  getReview(reviewId: string): Review | undefined {
    const file = this.paths.review(reviewId);
    const raw = readJson(file);
    return raw === undefined ? undefined : readReview(raw, file);
  }

  /** Every review, the one published last first. */
  listReviews(problems?: string[]): Review[] {
    const out: Review[] = [];
    for (const dir of this.subdirs(this.paths.reviewsDir)) {
      const file = path.join(dir, "review.json");
      try {
        const raw = readJson(file);
        if (raw !== undefined) out.push(readReview(raw, file)); // undefined: a review being created, or a folder left by a failed one
      } catch (error) {
        if (!problems) throw error;
        problems.push((error as Error).message);
      }
    }
    return out.sort((a, b) => (b.rounds.at(-1)?.at ?? "").localeCompare(a.rounds.at(-1)?.at ?? "") || b.id.localeCompare(a.id));
  }

  /**
   * Publishes a page for the developer to review, or the next round of the review of the same
   * title in the same project that is not closed (its saved state carries over). The page of the
   * last REVIEW_ROUNDS_KEPT rounds is kept.
   */
  publishReview(input: { sessionId: string; title: string; html: string }): Review {
    const session = this.getSession(input.sessionId);
    if (!session) throw new InputError(`no session ${input.sessionId} in the store; it registers when its first hook runs`);
    const title = reviewTitle(input.title.trim(), "title");
    const bytes = Buffer.byteLength(input.html);
    if (bytes > REVIEW_PAGE_MAX) throw new InputError(`the page is ${bytes} bytes with its images, more than the ${REVIEW_PAGE_MAX} a review takes`);
    const project = { name: session.project.name, dir: session.project.dir };
    const same = (r: Review) => !r.closedAt && r.project.dir === project.dir && r.title.toLowerCase() === title.toLowerCase();
    return withLock(this.paths.reviewsLock, () => {
      const existing = this.listReviews().find(same);
      const reviewId = existing?.id ?? newId("rv");
      return withLock(this.paths.review(reviewId), () => {
        const current = existing && this.getReview(reviewId);
        const n = (current?.rounds.at(-1)?.n ?? 0) + 1;
        const round = { n, at: this.stamp(), sessionId: session.id, bytes };
        const next = readReview(
          current
            ? { ...current, title, sessionId: session.id, rounds: [...current.rounds, round] }
            : { id: reviewId, title, project, sessionId: session.id, rounds: [round], hasSummary: false, sends: [] },
          this.paths.review(reviewId),
        );
        const page = this.paths.reviewRound(reviewId, n);
        writeAtomic(page, input.html);
        try {
          writeJson(this.paths.review(reviewId), next);
        } catch (error) {
          fs.rmSync(page, { force: true });
          if (!current) fs.rmSync(this.paths.reviewDir(reviewId), { recursive: true, force: true });
          throw error;
        }
        for (const old of next.rounds.slice(0, -REVIEW_ROUNDS_KEPT)) fs.rmSync(this.paths.reviewRound(reviewId, old.n), { force: true });
        return next;
      });
    });
  }

  /** The page of the review's latest round, as published (images inlined). */
  reviewPage(reviewId: string): { review: Review; html: string } | undefined {
    const review = this.getReview(reviewId);
    const latest = review?.rounds.at(-1);
    if (!review || !latest) return undefined;
    return { review, html: fs.readFileSync(this.paths.reviewRound(reviewId, latest.n), "utf8") };
  }

  /** The review's saved state: empty, at rev 0, until its page first writes to it. */
  reviewState(reviewId: string): ReviewState {
    const file = this.paths.reviewState(reviewId);
    const raw = readJson(file);
    return raw === undefined ? { data: {}, rev: 0 } : readReviewState(raw, file);
  }

  /**
   * Applies what the page changed, under the review's lock: two devices writing at once merge per
   * key, the later write winning on a key both set. Every accepted change counts one `rev`.
   * An empty `summary` clears it; a counter text that names no "done of total" leaves the progress.
   */
  changeReviewState(reviewId: string, change: ReviewChange, from: "local" | "remote"): { rev: number } {
    const file = this.paths.review(reviewId);
    return withLock(file, () => {
      const review = this.getReview(reviewId);
      if (!review) throw new InputError(`no review ${reviewId} in the store`);
      const before = readJson(this.paths.reviewState(reviewId));
      const state = before === undefined ? { data: {}, rev: 0 } : readReviewState(before, this.paths.reviewState(reviewId));
      const data = new Map(Object.entries(state.data));
      for (const op of change.ops) {
        if (op.op === "clear") data.clear();
        else if (op.op === "remove") data.delete(op.key);
        else data.set(op.key, op.value);
      }
      const nextData: Record<string, string> = Object.fromEntries(data);
      if (stateBytes(nextData) > REVIEW_STATE_MAX) throw new InputError(`the review's saved state would be larger than ${REVIEW_STATE_MAX} bytes; nothing was saved`);
      const summary = change.summary === undefined ? state.summary : change.summary === "" ? undefined : change.summary;
      const next: ReviewState = compact({ data: nextData, summary, rev: state.rev + 1 });
      const changed = change.ops.length > 0 || change.summary !== undefined;
      const progress = change.progress === undefined ? undefined : parseProgress(change.progress);
      const at = this.stamp();
      const nextReview = readReview(
        compact({
          ...review,
          progress: progress ?? review.progress,
          hasSummary: summary !== undefined,
          ...(changed ? { updatedAt: at, updatedFrom: from } : {}),
        }),
        file,
      );
      writeJson(this.paths.reviewState(reviewId), next);
      try {
        writeJson(file, nextReview);
      } catch (error) {
        if (before === undefined) fs.rmSync(this.paths.reviewState(reviewId), { force: true });
        else writeJson(this.paths.reviewState(reviewId), before);
        throw error;
      }
      return { rev: next.rev };
    });
  }

  /** The developer opened it on the desk: it is no longer new. */
  markReviewOpened(reviewId: string): Review {
    return this.updateReview(reviewId, (r) => (r.openedAt ? r : { ...r, openedAt: this.stamp() }));
  }

  /** It leaves To review, and stays in History. Publishing its title again then starts a new review. */
  closeReview(reviewId: string): Review {
    return this.updateReview(reviewId, (r) => (r.closedAt ? r : { ...r, closedAt: this.stamp() }));
  }

  /**
   * Sends the review: `session` delivers its line to the session that published the latest round,
   * as a message from the desk (refused with `Undeliverable` when that session takes none now);
   * `other` only returns the line, to copy into another conversation. Either way the send and the
   * developer's answers (the text the page copied, else how far they got) are recorded, the answers
   * as a closed question of that session, so the project's decisions and History hold them.
   */
  sendReview(reviewId: string, to: "session" | "other", seenRev: number): { line: string; review: Review } {
    const file = this.paths.review(reviewId);
    return withLock(file, () => {
      const review = this.getReview(reviewId);
      const round = review?.rounds.at(-1)?.n;
      if (!review || round === undefined) throw new InputError(`no review ${reviewId} in the store`);
      const session = this.getSession(review.sessionId);
      if (to === "session") {
        if (!session) throw new Undeliverable("the session that published it is no longer on the desk; send it to another conversation");
        if (sessionFinished(session)) throw new Undeliverable("the session that published it has ended; send it to another conversation");
        if (!this.acceptsMessages(session.id)) throw new Undeliverable("the session that published it is not taking messages from the desk right now; send it to another conversation, or write in its terminal");
      }
      const state = this.reviewState(reviewId);
      if (state.rev !== seenRev) throw new StaleReview(`the review changed since it was shown (saved state ${state.rev}, shown ${seenRev}); look at it again, then send it`, state.rev);
      const line = reviewLine(review, round, review.progress, to);
      const at = this.stamp();
      const decision = this.reviewDecision(review, round, state, at);
      const next = readReview({ ...review, sends: [...review.sends, compact({ at, to: to === "session" ? review.sessionId : null, round, progress: review.progress })] }, file);
      writeJson(this.paths.question(decision.id, "closed"), decision);
      try {
        writeJson(file, next);
        if (to === "session") {
          try {
            this.deliver(decision, line);
          } catch (error) {
            writeJson(file, review);
            throw error;
          }
        }
      } catch (error) {
        fs.rmSync(this.paths.question(decision.id, "closed"), { force: true });
        throw new Error(`could not send review ${reviewId}; nothing was recorded`, { cause: error });
      }
      if (to === "session" && session?.state === "working") this.noteSentWhileWorking(session.id, line);
      return { line, review: next };
    });
  }

  /** The developer's answers to a review as a decision of the session that published it: closed at once, never in Needs you. */
  private reviewDecision(review: Review, round: number, state: ReviewState, at: string): Question {
    const reviewed = review.progress ? `${review.progress.done} of ${review.progress.total} reviewed. ` : "";
    // What the page copied is the page's text, told apart from the developer's own words by its source.
    const answer = state.summary === undefined ? { text: `${reviewed}The page copied no answers; agent-desk review ${review.id} shows its saved state.`, via: "desk" as const } : { text: bounded(state.summary), via: "review" as const };
    return readQuestion({
      id: newId("q"),
      sessionId: review.sessionId,
      kind: "question",
      text: `Review «${review.title}», round ${round}`,
      options: [],
      askedAt: at,
      status: "answered",
      closedAt: at,
      answer: { ...answer, at },
      review: { id: review.id, round },
    });
  }

  /** What a session reads of a review: the record and its saved state. Recorded as read by `sessionId`, when given. */
  collectReview(reviewId: string, sessionId: string | undefined): { review: Review; state: ReviewState } {
    if (sessionId === undefined) {
      const review = this.getReview(reviewId);
      if (!review) throw new InputError(`no review ${reviewId} in the store`);
      return { review, state: this.reviewState(reviewId) };
    }
    const review = this.updateReview(reviewId, (r) => ({ ...r, collected: { at: this.stamp(), sessionId, round: r.rounds.at(-1)?.n ?? 1 } }));
    return { review, state: this.reviewState(reviewId) };
  }

  /** Changes a review under its lock; one `change` returns unchanged is not written. */
  private updateReview(reviewId: string, change: (current: Review) => Review): Review {
    const file = this.paths.review(reviewId);
    return withLock(file, () => {
      const current = this.getReview(reviewId);
      if (!current) throw new InputError(`no review ${reviewId} in the store`);
      const next = change(current);
      if (next !== current) writeJson(file, readReview(next, file));
      return next;
    });
  }

  // ── Services, metrics, seen ─────────────────────────────────────────────

  addService(input: { sessionId: string; name: string; url: string }): Service {
    this.requireSession(input.sessionId);
    const existing = this.listServices().find((s) => s.sessionId === input.sessionId && s.name === input.name);
    const service = readService({ id: existing?.id ?? newId("svc"), ...input, startedAt: this.stamp() });
    writeJson(this.paths.service(service.id), service);
    return service;
  }

  removeService(sessionId: string, name: string): boolean {
    const found = this.listServices().filter((s) => s.sessionId === sessionId && s.name === name);
    for (const s of found) fs.rmSync(this.paths.service(s.id), { force: true });
    return found.length > 0;
  }

  listServices(problems?: string[]): Service[] {
    return this.readAll(this.paths.servicesDir, readService, problems);
  }

  /** Merges what one writer knows (the status line, a hook) into the session's metrics. */
  mergeMetrics(metrics: Omit<Metrics, "at">): Metrics {
    const file = this.paths.metrics(metrics.sessionId);
    return withLock(file, () => {
      const raw = readJson(file);
      const current = raw === undefined ? undefined : readMetrics(raw, file);
      const next = readMetrics({ ...current, ...metrics, at: this.stamp() }, file);
      writeJson(file, next);
      return next;
    });
  }

  /** How the plan windows have filled, the current one and the last few; an unreadable file only costs the forecast. */
  planHistory(problems?: string[]): PlanHistory {
    try {
      const raw = readJson(this.paths.plan);
      return raw === undefined ? {} : readPlanHistory(raw, this.paths.plan);
    } catch (error) {
      problems?.push(`${this.paths.plan}: ${(error as Error).message}`);
      return {};
    }
  }

  recordPlan(windows: PlanWindow[], at: string): void {
    withLock(this.paths.plan, () => {
      const before = this.planHistory();
      const after = addSamples(before, windows, at);
      if (JSON.stringify(after) !== JSON.stringify(before)) writeJson(this.paths.plan, after);
    });
  }

  listMetrics(problems?: string[]): Metrics[] {
    return this.readAll(this.paths.metricsDir, readMetrics, problems);
  }

  getSeen(): Seen | undefined {
    const raw = readJson(this.paths.seen);
    return raw === undefined ? undefined : readSeen(raw, this.paths.seen);
  }

  /** "Mark everything as seen": what happened before now is no longer new. */
  markAllSeen(): Seen {
    const seen = { since: this.stamp() };
    writeJson(this.paths.seen, seen);
    return seen;
  }

  // ── Conversation ────────────────────────────────────────────────────────

  /**
   * Adds a message to the session's conversation, keeping its latest MESSAGES_KEPT, and counts it on
   * the session (written after the message, so a reader that sees the count finds the message).
   */
  addMessage(input: { sessionId: string; from: "session" | "developer"; text: string; via?: "terminal" | "desk"; images?: string[]; step?: boolean }): ConversationEntry {
    const entry = readConversationEntry(compact({ id: newId("m"), ...input, text: bounded(input.text), at: this.stamp() }));
    this.requireSession(entry.sessionId);
    const file = this.paths.message(entry.sessionId, entry.id);
    writeJson(file, entry);
    try {
      this.updateSession(entry.sessionId, (s) => ({ ...s, messageCount: (s.messageCount ?? 0) + 1 }));
    } catch (error) {
      fs.rmSync(file, { force: true });
      throw new Error(`could not count a message on session ${entry.sessionId}; the message was not kept`, { cause: error });
    }
    const names = listJson(this.paths.messageDir(entry.sessionId));
    for (const old of names.slice(0, Math.max(0, names.length - MESSAGES_KEPT))) fs.rmSync(path.join(this.paths.messageDir(entry.sessionId), old), { force: true });
    return entry;
  }

  /** Removes a message just added, whose delivery failed. */
  private takeBackMessage(entry: ConversationEntry): void {
    fs.rmSync(this.paths.message(entry.sessionId, entry.id), { force: true });
    this.updateSession(entry.sessionId, (s) => ({ ...s, messageCount: Math.max(0, (s.messageCount ?? 1) - 1) }));
  }

  /** The session's conversation, oldest first. */
  listMessages(sessionId: string, problems?: string[]): ConversationEntry[] {
    return this.readAll(this.paths.messageDir(sessionId), readConversationEntry, problems).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  // ── Projects ────────────────────────────────────────────────────────────

  getProjectScan(projectId: string): ProjectScan | undefined {
    const file = this.paths.project(projectId);
    const raw = readJson(file);
    return raw === undefined ? undefined : readProjectScan(raw, file);
  }

  putProjectScan(scan: ProjectScan): ProjectScan {
    const next = readProjectScan(scan);
    writeJson(this.paths.project(next.id), next);
    return next;
  }

  /**
   * Marks a scan of this project as running, so turn ends in several sessions do not measure the
   * same folders at once. Returns the release function, or undefined while another scan runs
   * (a mark older than 10 minutes is taken as abandoned).
   */
  claimScan(projectId: string): (() => void) | undefined {
    const mark = path.join(this.paths.projectsDir, `.${id(projectId, "project id")}.scanning`);
    ensureDir(this.paths.projectsDir);
    try {
      fs.closeSync(fs.openSync(mark, "wx", 0o600));
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      if (Date.now() - fs.statSync(mark).mtimeMs < 10 * 60_000) return undefined;
      fs.utimesSync(mark, new Date(), new Date());
    }
    return () => fs.rmSync(mark, { force: true });
  }

  listProjectScans(problems?: string[]): ProjectScan[] {
    return this.readAll(this.paths.projectsDir, readProjectScan, problems);
  }

  // ── Archive ─────────────────────────────────────────────────────────────

  /**
   * Moves what is older than `cutoff` out of the live store into archive/ (same layout): closed
   * questions, results with their images, and sessions that ended or whose process is gone, with
   * their agents, metrics and services; then the images nothing left shows (attached on the desk
   * to what was archived, or never sent). Nothing is deleted; the page and the hooks stop reading it.
   */
  archiveOlderThan(cutoff: Date): { questions: number; results: number; sessions: number; images: number } {
    const before = cutoff.toISOString();
    const counts = { questions: 0, results: 0, sessions: 0, images: 0 };
    for (const q of this.readAll(this.paths.questionDir("closed"), readQuestion)) {
      if ((q.closedAt ?? q.askedAt) >= before) continue;
      withLock(this.paths.questionLock(q.id), () => this.moveToArchive(this.paths.question(q.id, "closed")));
      counts.questions++;
    }
    for (const r of this.listResults()) {
      if (r.at >= before) continue;
      for (const image of r.images) {
        const stored = this.imageFile(image.id);
        if (stored) this.moveToArchive(stored.file);
      }
      this.moveToArchive(this.paths.result(r.id));
      counts.results++;
    }
    const open = new Set(this.openQuestions().map((q) => q.sessionId));
    for (const s of this.listSessions()) {
      if (!sessionFinished(s) || open.has(s.id) || (s.endedAt ?? s.updatedAt) >= before) continue;
      for (const service of this.listServices().filter((v) => v.sessionId === s.id)) this.moveToArchive(this.paths.service(service.id));
      this.moveToArchive(this.paths.agentDir(s.id));
      this.moveToArchive(this.paths.metrics(s.id));
      this.moveToArchive(this.paths.messageDir(s.id));
      fs.rmSync(this.paths.sessionInbox(s.id), { recursive: true, force: true }); // listener marks only; answers were withdrawn at the end
      this.moveToArchive(this.paths.session(s.id));
      counts.sessions++;
    }
    counts.images = this.archiveUnshownImages(cutoff);
    return counts;
  }

  /** Moves to archive/ the images older than `cutoff` that no live result, answer or message shows. */
  private archiveUnshownImages(cutoff: Date): number {
    const shown = new Set([
      ...this.listResults().flatMap((r) => r.images.map((i) => i.id)),
      ...(["open", "closed"] as const).flatMap((status) => this.readAll(this.paths.questionDir(status), readQuestion)).flatMap((q) => [q.answer, ...(q.setAside ?? [])].flatMap((a) => a?.images ?? [])),
      ...this.subdirs(this.paths.messagesDir).flatMap((dir) => this.readAll(dir, readConversationEntry)).flatMap((m) => m.images ?? []),
    ]);
    let names: string[];
    try {
      names = fs.readdirSync(this.paths.imagesDir);
    } catch (error) {
      if (isCode(error, "ENOENT")) return 0; // no image was ever kept
      throw error;
    }
    let moved = 0;
    for (const name of names) {
      const file = path.join(this.paths.imagesDir, name);
      if (shown.has(name.replace(/\.\w+$/, "")) || fs.statSync(file).mtime >= cutoff) continue;
      this.moveToArchive(file);
      moved++;
    }
    return moved;
  }

  private moveToArchive(file: string): void {
    const target = this.paths.archived(file);
    ensureDir(path.dirname(target));
    try {
      fs.renameSync(file, target);
    } catch (error) {
      if (isCode(error, "ENOENT")) return; // nothing there (a session without metrics, an image already moved)
      throw error;
    }
  }

  // ── Decisions ───────────────────────────────────────────────────────────

  /**
   * What was decided in a project, newest first: questions answered (also archived ones) and the
   * decisions sessions reported with their results. Permission prompts, and questions closed without
   * an answer, only when asked for. `total` counts every match, `decisions` holds the first `limit`.
   */
  decisions(query: DecisionQuery, problems?: string[]): { decisions: Decision[]; total: number; projects: Session["project"][] } {
    const members = projectSessions(this.everySession(problems), query.project);
    const words = query.search === undefined ? [] : fold(query.search).split(/\s+/).filter(Boolean);
    const matches = (...hay: (string | undefined)[]) => {
      const folded = fold(hay.filter((h) => h !== undefined).join("\n"));
      return words.every((w) => folded.includes(w));
    };
    const found: Decision[] = [];
    for (const q of this.everyRecord(this.paths.questionDir("closed"), readQuestion, problems)) {
      const session = members.get(q.sessionId);
      if (!session || q.status === "open") continue;
      if (q.kind === "permission" && !query.permissions) continue;
      if ((q.status === "dismissed" || q.answer === undefined) && !query.unanswered) continue;
      if (!matches(q.text, q.context, ...q.options, q.answer?.text, q.interpretation, session.title)) continue;
      found.push({ source: "question", at: q.answer?.at ?? q.closedAt ?? q.askedAt, session, question: q });
    }
    for (const r of this.everyRecord(this.paths.resultsDir, readResult, problems)) {
      const session = members.get(r.sessionId);
      if (!session || r.decisions.length === 0 || !matches(r.title, r.summary, ...r.decisions, session.title)) continue;
      found.push({ source: "result", at: r.at, session, result: r });
    }
    const key = (d: Decision) => (d.source === "question" ? d.question.id : d.result.id);
    found.sort((a, b) => b.at.localeCompare(a.at) || key(b).localeCompare(key(a)));
    const projects = new Map([...members.values()].map((s) => [`${s.project.name}\n${s.project.dir}`, s.project]));
    return { decisions: found.slice(0, query.limit), total: found.length, projects: [...projects.values()].sort((a, b) => a.dir.localeCompare(b.dir)) };
  }

  /** Live sessions and archived ones, which past decisions still belong to. */
  private everySession(problems?: string[]): DecisionSession[] {
    return this.everyRecord(this.paths.sessionsDir, readSession, problems).map((s) => compact({ id: s.id, title: s.title, project: s.project }));
  }

  /**
   * The records of a store folder and of its copy under archive/, one per id. The live folder is read
   * first: a record archived meanwhile moves from it to the archive, so it is seen in one of them.
   */
  private everyRecord<T extends { id: string }>(dir: string, read: (value: unknown, where: string) => T, problems?: string[]): T[] {
    const byId = new Map<string, T>();
    for (const where of [dir, this.paths.archived(dir)]) {
      for (const record of this.readAll(where, read, problems)) if (!byId.has(record.id)) byId.set(record.id, record);
    }
    return [...byId.values()];
  }

  // ── Whole view ──────────────────────────────────────────────────────────

  snapshot(): Snapshot {
    const problems: string[] = [];
    let seen: Seen | undefined;
    try {
      seen = this.getSeen();
    } catch (error) {
      problems.push((error as Error).message);
    }
    return {
      sessions: this.listSessions(problems),
      questions: this.listQuestions(problems),
      agents: this.listAgents(undefined, problems),
      results: this.listResults(problems),
      services: this.listServices(problems),
      metrics: this.listMetrics(problems),
      projects: this.listProjectScans(problems),
      reviews: this.listReviews(problems),
      seen,
      problems,
    };
  }

  /**
   * The folders whose files make up what the page shows (the snapshot, the plan's history, who
   * listens), for the server to watch; one that does not exist yet is listed all the same.
   */
  stateDirs(): string[] {
    const p = this.paths;
    return [
      p.home,
      p.sessionsDir,
      p.questionsDir,
      p.questionDir("open"),
      p.questionDir("closed"),
      p.resultsDir,
      p.servicesDir,
      p.metricsDir,
      p.projectsDir,
      p.agentsDir,
      ...this.subdirs(p.agentsDir),
      p.inboxDir,
      ...this.subdirs(p.inboxDir),
      p.reviewsDir,
      ...this.subdirs(p.reviewsDir),
    ];
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private requireSession(sessionId: string): void {
    if (!this.getSession(sessionId)) throw new InputError(`no session ${sessionId} in the store; it registers when its first hook runs`);
  }

  /**
   * Reads every record of a directory. A record that fails to read is reported in `problems`
   * when the caller collects them (the page shows them), and throws otherwise.
   */
  private readAll<T>(dir: string, read: (value: unknown, where: string) => T, problems?: string[]): T[] {
    const out: T[] = [];
    for (const name of listJson(dir)) {
      const file = path.join(dir, name);
      try {
        const raw = readJson(file);
        if (raw !== undefined) out.push(read(raw, file)); // undefined: removed since the listing
      } catch (error) {
        if (!problems) throw error;
        problems.push((error as Error).message);
      }
    }
    return out;
  }

  private subdirs(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => path.join(dir, d.name));
    } catch (error) {
      if (isCode(error, "ENOENT")) return [];
      throw error;
    }
  }
}

/** What the session reported for an agent, which a merge keeps over what its adapter recorded. */
const reportedOf = (a: Agent) => compact({ goal: a.goal, summary: a.summary, branch: a.branch, commit: a.commit });

const ANSWER_MAX = 20_000;
const MESSAGES_KEPT = 500;
/** A prompt can be a pasted log; the history keeps a bounded copy of it. */
/** A question's first line, at most 200 characters, to name it in a message. */
function headline(value: string): string {
  const first = value.trim().split("\n")[0] ?? "";
  return first.length > 200 ? `${first.slice(0, 199)}…` : first;
}

function bounded(answer: string): string {
  return answer.length > ANSWER_MAX ? `${answer.slice(0, ANSWER_MAX - 1)}…` : answer;
}

/** The sessions of a project, by id. A folder stands for the deepest recorded project folder holding it. */
function projectSessions(sessions: DecisionSession[], project: DecisionQuery["project"]): Map<string, DecisionSession> {
  if ("name" in project) return new Map(sessions.filter((s) => s.project.name === project.name).map((s) => [s.id, s]));
  const dir = path.resolve(project.dir);
  const holding = sessions.map((s) => path.resolve(s.project.dir)).filter((d) => within(dir, d));
  const root = holding.sort((a, b) => b.length - a.length)[0] ?? dir;
  return new Map(sessions.filter((s) => within(path.resolve(s.project.dir), root)).map((s) => [s.id, s]));
}

/** `dir` is `root` or a folder inside it. */
function within(dir: string, root: string): boolean {
  const rel = path.relative(root, dir);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Text compared without case or accents ("Decisión" finds "decision"). */
function fold(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The image type its first bytes say, of those the store keeps. */
export function imageType(data: Buffer): ImageExt | undefined {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (starts(0xff, 0xd8, 0xff)) return "jpg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && data.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return undefined;
}

/** A change to a review's saved state as the page sends it, checked against the review limits. */
export function readReviewChange(value: unknown): ReviewChange {
  const f = fields(value, "body");
  const ops = list(f.ops ?? [], "ops", (v, where): ReviewOp => {
    const o = fields(v, where);
    const op = oneOf(["set", "remove", "clear"] as const)(o.op, `${where}.op`);
    if (op === "clear") return { op };
    const key = reviewKey(o.key, `${where}.key`);
    return op === "remove" ? { op, key } : { op, key, value: text(o.value, `${where}.value`, REVIEW_STATE_MAX) };
  }, 10_000);
  return compact({
    ops,
    progress: optional(f.progress, "progress", (v, w) => text(v, w, REVIEW_PROGRESS_MAX)),
    summary: optional(f.summary, "summary", (v, w) => text(v, w, REVIEW_SUMMARY_MAX)),
  });
}
