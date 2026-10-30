// The store: one JSON file per record under the desk's home, shared by hooks, the CLI and the server.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { compact, fields, InputError, int, isoTime, text } from "../core/check.ts";
import { id, newId } from "../core/ids.ts";
import { isAlive, procInfo } from "../core/proc.ts";
import {
  type Agent,
  type Answer,
  type InboxEntry,
  type Metrics,
  type ConversationEntry,
  type ProjectScan,
  type Question,
  type QuestionKind,
  type Result,
  type Seen,
  type Service,
  type Session,
  readAgent,
  readInboxEntry,
  readMetrics,
  readConversationEntry,
  readProjectScan,
  readQuestion,
  readResult,
  readSeen,
  readService,
  readSession,
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
  seen: Seen | undefined;
  problems: string[];
};

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

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as const;
export type ImageExt = keyof typeof IMAGE_TYPES;

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

  ask(input: { sessionId: string; kind: QuestionKind; text: string; context?: string; options?: string[]; dialog?: boolean }): Question {
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
    });
    writeJson(this.paths.question(question.id, "open"), question);
    return question;
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
   * every open item of that session is closed. `answer` is recorded on questions it answers.
   */
  closeOpen(
    sessionId: string,
    how: { answer?: string; kinds?: readonly QuestionKind[]; which?: (q: Question) => boolean; status?: "answered" | "dismissed"; problems?: string[] },
  ): Question[] {
    const closed: Question[] = [];
    for (const q of this.openQuestions(sessionId, how.problems)) {
      if (how.kinds && !how.kinds.includes(q.kind)) continue;
      if (how.which && !how.which(q)) continue;
      closed.push(
        this.changeQuestion(q.id, (cur) => {
          if (cur.status !== "open") return cur;
          const at = this.stamp();
          const status = how.status ?? "answered";
          const answer: Answer | undefined =
            status === "answered" && how.answer !== undefined && cur.kind !== "permission" ? { text: bounded(how.answer), at, via: "terminal" } : undefined;
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

  /** Records how the session understood its latest answer. */
  interpret(sessionId: string, interpretation: string): Question {
    const answered = this.readAll(this.paths.questionDir("closed"), readQuestion).filter((q) => q.sessionId === sessionId && q.answer !== undefined);
    const latest = answered.sort((a, b) => (a.answer?.at ?? "").localeCompare(b.answer?.at ?? "")).at(-1);
    if (!latest) throw new InputError(`session ${sessionId} has no answered question to attach an interpretation to`);
    return this.changeQuestion(latest.id, (q) => ({ ...q, interpretation }));
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
    const entry: InboxEntry = compact({ questionId, question: answered.text, answer: text, at: answered.closedAt ?? this.stamp(), images: attached });
    this.addMessage(compact({ sessionId: answered.sessionId, from: "developer" as const, text, via: "desk" as const, images: attached }));
    try {
      writeJson(this.paths.inboxEntry(answered.sessionId, questionId), entry);
      this.syncInboxMarker();
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
   * A message to a session that asked nothing: a reply to its last report while it waits, or a
   * message while it works, which it receives at its next step. It is kept in the history as an
   * answered item whose text is that last report.
   */
  messageFromDesk(sessionId: string, text: string, images: string[] = []): Question {
    const session = this.getSession(sessionId);
    if (!session) throw new InputError(`no session ${sessionId} in the store`);
    if (text.trim() === "" && images.length === 0) throw new InputError("the message is empty");
    if (!this.acceptsMessages(sessionId)) throw new InputError("the session is not taking messages from the desk right now; write in its terminal");
    if (session.state === "working") {
      const at = this.stamp();
      this.updateSession(sessionId, (s) => ({ ...s, sentWhileWorking: [...(s.sentWhileWorking ?? []), { text: text.length > 2000 ? `${text.slice(0, 1999)}…` : text, at }].slice(-10) }));
    }
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
        const at = this.stamp();
        return replacement === undefined
          ? compact({ ...q, status: "dismissed" as const, closedAt: at, answer: undefined })
          : { ...q, status: "answered", closedAt: at, answer: { text: bounded(replacement), at, via: "terminal" } };
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
    return s?.state === "working" && s.takesMessagesWhileWorking === true && (s.process === undefined || isAlive(s.process.pid, s.process.start));
  }

  // ── Agents ──────────────────────────────────────────────────────────────

  getAgent(sessionId: string, name: string): Agent | undefined {
    const file = this.paths.agent(sessionId, name);
    const raw = readJson(file);
    return raw === undefined ? undefined : readAgent(raw, file);
  }

  /** Creates the agent (working, started now) or merges `fields` into it. */
  upsertAgent(sessionId: string, name: string, fields: Partial<Omit<Agent, "sessionId" | "name">>): Agent {
    this.requireSession(sessionId);
    const file = this.paths.agent(sessionId, name);
    return withLock(file, () => {
      const at = this.stamp();
      const current = this.getAgent(sessionId, name);
      const merged = compact({ ...current, ...fields, sessionId, name, updatedAt: at });
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
    });
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
    const file = this.paths.result(resultId);
    return withLock(file, () => {
      const raw = readJson(file);
      if (raw === undefined) throw new InputError(`no result ${resultId} in the store`);
      const current = readResult(raw, file);
      if (current.seenAt) return current;
      const next = { ...current, seenAt: this.stamp() };
      writeJson(file, next);
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

  /** Adds a message to the session's conversation, keeping its latest MESSAGES_KEPT. */
  addMessage(input: { sessionId: string; from: "session" | "developer"; text: string; via?: "terminal" | "desk"; images?: string[] }): ConversationEntry {
    const entry = readConversationEntry(compact({ id: newId("m"), ...input, text: bounded(input.text), at: this.stamp() }));
    writeJson(this.paths.message(entry.sessionId, entry.id), entry);
    const names = listJson(this.paths.messageDir(entry.sessionId));
    for (const old of names.slice(0, Math.max(0, names.length - MESSAGES_KEPT))) fs.rmSync(path.join(this.paths.messageDir(entry.sessionId), old), { force: true });
    return entry;
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
      const finished = s.state === "ended" || (s.process !== undefined && !isAlive(s.process.pid, s.process.start));
      if (!finished || open.has(s.id) || (s.endedAt ?? s.updatedAt) >= before) continue;
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
      ...(["open", "closed"] as const).flatMap((status) => this.readAll(this.paths.questionDir(status), readQuestion)).flatMap((q) => q.answer?.images ?? []),
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
      seen,
      problems,
    };
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

const ANSWER_MAX = 20_000;
const MESSAGES_KEPT = 500;
/** A prompt can be a pasted log; the history keeps a bounded copy of it. */
function bounded(answer: string): string {
  return answer.length > ANSWER_MAX ? `${answer.slice(0, ANSWER_MAX - 1)}…` : answer;
}

function imageType(data: Buffer): ImageExt | undefined {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (starts(0xff, 0xd8, 0xff)) return "jpg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && data.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return undefined;
}
