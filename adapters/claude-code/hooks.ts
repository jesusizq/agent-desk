// Claude Code adapter: turns Claude Code hook events into desk records, at no cost to the model.
import * as fs from "node:fs";
import * as path from "node:path";
import { bool, compact, fields, type Fields, InputError, list, nonEmpty, optional, text } from "../../src/core/check.ts";
import { id, newId, slug } from "../../src/core/ids.ts";
import { type Agent, FAILURES_KEPT, type SessionProcess } from "../../src/core/model.ts";
import { outerTerminal } from "../../src/core/tmux.ts";
import { locateProject } from "../../src/project/locate.ts";
import { isCode, withLock } from "../../src/store/fsx.ts";
import type { AgentFields, Store } from "../../src/store/store.ts";

export const PROVIDER = "Claude Code";

/** What a hook prints and exits with. */
export type HookOutput = { code: number; stdout?: string; stderr?: string; questionId?: string; dialog?: Dialog };
/** Claude Code's AskUserQuestion call shown on the desk: its input, and one desk question per question. */
export type Dialog = { input: Fields; questions: { id: string; text: string }[] };

export type HookContext = {
  store: Store;
  env: NodeJS.ProcessEnv;
  /** The Claude Code process that ran this hook, with its ancestors (see src/core/proc.ts). */
  sessionProcess: () => SessionProcess | undefined;
  /** Starts measuring the project's worktrees in the background, without waiting for it. */
  startScan?: (projectDir: string) => void;
  /** The tmux pane the session runs in, if any (see src/core/tmux.ts). */
  tmuxLocation?: () => { socket: string; pane: string; clients: number[] } | undefined;
};

/** Hook input fields every event carries. */
type Common = { sessionId: string; event: string; cwd: string; permissionMode?: string; raw: Fields };

// A closing list of decisions is one paragraph: room for several, each with a line or two.
const LAST_TEXT_MAX = 2000;
const CONTEXT_MAX = 8000;

export function readHookInput(json: string): Common {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new InputError(`hook input is not JSON (${(error as Error).message})`);
  }
  const f = fields(parsed, "hook input");
  return compact({
    sessionId: id(f.session_id, "hook input.session_id"),
    event: text(f.hook_event_name, "hook input.hook_event_name", 100),
    cwd: text(f.cwd, "hook input.cwd", 4096),
    permissionMode: optional(f.permission_mode, "hook input.permission_mode", (v, w) => text(v, w, 100)),
    raw: f,
  });
}

/** Handles one synchronous hook event. Answers from the desk are awaited separately by `waitForAnswer`. */
export function handleHook(input: Common, ctx: HookContext): HookOutput {
  // Unreadable store files are reported (stderr, and on the page) without failing the hook.
  const problems: string[] = [];
  const out = dispatch(input, ctx, problems);
  return problems.length ? { ...out, stderr: [out.stderr, ...problems.map((p) => `agent-desk: ${p}`)].filter(Boolean).join("\n") } : out;
}

function dispatch(input: Common, ctx: HookContext, problems: string[]): HookOutput {
  const { store } = ctx;
  register(input, ctx);
  const sid = input.sessionId;
  const f = input.raw;
  switch (input.event) {
    case "SessionStart":
      // Started again (resumed, or the plugins reloaded): what its last end left no longer holds.
      store.updateSession(sid, ({ endedAt: _endedAt, endedAsking: _endedAsking, ...s }) => ({ ...s, state: "waiting" }));
      retireContinued(input, ctx, problems);
      return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: instructions() } }) };

    case "UserPromptSubmit": {
      const prompt = text(f.prompt ?? "", "hook input.prompt", 10_000_000);
      if (fromClaudeCode(prompt)) {
        // A background task's notification wakes the session like a prompt: it works again, but
        // nothing was said by the developer and nothing they were asked is answered.
        store.updateSession(sid, (s) => ({ ...s, state: "working", activityAt: new Date().toISOString() }));
        settleAgents(input, ctx, problems);
        return { code: 0 };
      }
      // Without a title from Claude Code, the first thing asked of the session names it. A prompt
      // that arrives while the session works is kept, to show later whether that turn took it in.
      const at = new Date().toISOString();
      const wasWorking = store.getSession(sid)?.state === "working";
      store.updateSession(sid, (s) =>
        compact({
          ...s,
          state: "working" as const,
          activityAt: at,
          title: s.title ?? (titleFrom(prompt) || undefined),
          sentWhileWorking: s.state === "working" ? [...(s.sentWhileWorking ?? []), { text: bounded(prompt, 2000), at }].slice(-SENT_KEPT) : s.sentWhileWorking,
        }),
      );
      store.addMessage({ sessionId: sid, from: "developer", text: readablePrompt(prompt), via: "terminal" });
      // An answer given on the page but not yet delivered is overtaken by what was typed; a message
      // sent from the page while the session works still reaches it, at its next step.
      if (!wasWorking) store.withdrawInbox(sid, prompt);
      store.closeOpen(sid, { answer: prompt, problems });
      syncPermissionMarker(store, problems);
      settleAgents(input, ctx, problems);
      return { code: 0 };
    }

    case "PermissionRequest": {
      // A tool that asks the developer to choose is shown as its questions, not as a permission.
      if (f.tool_name === ASK_TOOL) {
        const dialog = askDialog(sid, f.tool_input, store, problems);
        syncPermissionMarker(store, problems);
        return { code: 0, dialog };
      }
      const q = store.ask({ sessionId: sid, kind: "permission", text: describeTool(f.tool_name, f.tool_input), options: [ALLOW, DENY] });
      syncPermissionMarker(store, problems);
      return { code: 0, questionId: q.id };
    }

    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionDenied":
      // The tool ran or was refused: any permission prompt of this session is settled, and so are
      // the questions of a dialog, answered in the terminal or from the desk.
      store.closeOpen(sid, { kinds: ["permission"], problems });
      if (f.tool_name === ASK_TOOL) closeDialog(sid, f.tool_response, store, problems);
      syncPermissionMarker(store, problems);
      if (input.event !== "PermissionDenied") recordActivity(input, ctx, problems);
      if (input.event !== "PermissionDenied" && (f.tool_name === "Agent" || f.tool_name === "Task")) launchReturned(input, ctx);
      return { code: 0 };

    case "Notification": {
      const type = optional(f.notification_type, "hook input.notification_type", (v, w) => text(v, w, 100));
      if (type === "elicitation_dialog" || type === "agent_needs_input") {
        store.ask({ sessionId: sid, kind: "question", text: text(f.message ?? "", "hook input.message") || type });
      }
      return { code: 0 };
    }

    case "PreToolUse":
      if (f.tool_name === "Agent" || f.tool_name === "Task") launchAgent(input, ctx);
      return { code: 0 };

    case "SubagentStart":
      startAgent(input, ctx, problems);
      return { code: 0 };

    case "SubagentStop":
      stopAgent(input, ctx, problems);
      return { code: 0 };

    case "Stop":
      retireContinued(input, ctx, problems);
      endTurn(input, ctx, problems);
      store.releaseQuestions(sid, problems); // last: with the turn's message already on them
      ctx.startScan?.(locateProject(workDir(input, ctx)).dir);
      return { code: 0 };

    case "SessionEnd":
      store.withdrawInbox(sid);
      const asking = store.openQuestions(sid, problems).length > 0;
      store.closeOpen(sid, { status: "dismissed", problems });
      syncPermissionMarker(store, problems);
      // A question that goes with its session must not vanish unseen: the session stays in view, unread.
      store.updateSession(sid, ({ readAt, ...s }) => ({ ...s, ...(asking ? { endedAsking: true } : readAt ? { readAt } : {}), state: "ended", endedAt: new Date().toISOString() }));
      return { code: 0 };

    default:
      return { code: 0 };
  }
}

/**
 * A conversation sent to the background goes on under a new session id, and the old one never gets
 * a SessionEnd: its terminal stays open. Its transcript says so; the session is ended here.
 */
function retireContinued(input: Common, ctx: HookContext, problems: string[]): void {
  const { store } = ctx;
  const transcript = optional(input.raw.transcript_path, "hook input.transcript_path", (v, w) => text(v, w, 4096));
  if (!transcript) return;
  const dir = workDir(input, ctx);
  for (const s of store.listSessions(problems)) {
    if (s.id === input.sessionId || s.state === "ended" || (s.project.worktree ?? s.project.dir) !== dir) continue;
    if (!continuedElsewhere(path.join(path.dirname(transcript), `${s.id}.jsonl`))) continue;
    store.withdrawInbox(s.id);
    store.closeOpen(s.id, { status: "dismissed", problems });
    for (const agent of store.listAgents(s.id)) {
      if (agent.state === "working") store.updateAgent(s.id, agent.name, { state: "done", activity: "The session continued elsewhere" });
    }
    store.updateSession(s.id, (old) => ({ ...old, state: "ended", endedAt: new Date().toISOString() }));
  }
}

/** Whether the transcript's last word is that it continued elsewhere: a conversation resumed since has written on. */
function continuedElsewhere(transcript: string): boolean {
  for (const line of readTail(transcript, 8192).split("\n").reverse()) {
    let type: unknown;
    try {
      type = (JSON.parse(line) as { type?: unknown }).type;
    } catch {
      continue; // the blank last line, or the first one, cut by the tail
    }
    if (type === "continued-in") return true;
    if (type === "user" || type === "assistant") return false;
  }
  return false;
}

/** The folder the session was started in. */
const workDir = (input: Common, ctx: HookContext) => ctx.env.CLAUDE_PROJECT_DIR || input.cwd;

/** Every event refreshes who and where the session is: it may have been resumed in another terminal. */
function register(input: Common, ctx: HookContext): void {
  const title = optional(input.raw.session_title, "hook input.session_title", (v, w) => text(v, w, 200));
  const proc = ctx.sessionProcess();
  const terminal = ctx.env.TERM_PROGRAM;
  // Where the session runs inside tmux changes only when the terminal attaches or detaches.
  const tmux = ["SessionStart", "UserPromptSubmit", "Stop"].includes(input.event) ? ctx.tmuxLocation?.() : undefined;
  ctx.store.upsertSession(
    compact({
      id: input.sessionId,
      provider: PROVIDER,
      project: locateProject(workDir(input, ctx)),
      title: title || undefined,
      process: proc,
      takesMessagesWhileWorking: true, // deliverWhileWorking, after each tool call
      // Inside tmux the terminal is the one attached to it, looked up only with the pane; the other
      // events keep what was found then.
      terminal: (terminal === "tmux" ? tmux && outerTerminal(tmux.clients) : terminal) || undefined,
      tmux,
    }),
  );
  if (input.permissionMode) ctx.store.mergeMetrics({ sessionId: input.sessionId, permissionMode: input.permissionMode });
}

/** The turn ended: the session waits for the developer. Unless it already asked a question, its last message is what waits. */
function endTurn(input: Common, ctx: HookContext, problems: string[]): void {
  const { store } = ctx;
  const sid = input.sessionId;
  store.closeOpen(sid, { kinds: ["permission"], problems });
  syncPermissionMarker(store, problems);
  const message = text(input.raw.last_assistant_message ?? "", "hook input.last_assistant_message", 1_000_000).trim();
  const at = new Date().toISOString();
  // The turn is over: what its calls were doing, failing in a row or waiting on, ends with it.
  store.updateSession(sid, ({ failedAt: _failed, failedWhat: _what, waitsForJob: _waits, ...s }) =>
    compact({
      ...s,
      state: "waiting" as const,
      activity: undefined,
      lastMessage: message ? { text: bounded(message, MESSAGE_MAX), at } : undefined,
      sentWhileWorking: s.sentWhileWorking?.map((m) => (m.turnEndedAt ? m : { ...m, turnEndedAt: at })),
    }),
  );
  recordTurnTexts(input, store, message);
  settleAgents(input, ctx, problems);
  if (message) store.addMessage({ sessionId: sid, from: "session", text: message });
  const tasks = Array.isArray(input.raw.background_tasks) ? input.raw.background_tasks : [];
  const shells = tasks.filter((t) => typeof t === "object" && t !== null && (t as Fields).type === "shell").length;
  store.mergeMetrics({ sessionId: sid, backgroundShells: shells });
  if (message === "") return;
  const { last, before } = splitLastParagraph(message);
  // A question still open here was not answered: this turn started without a typed prompt (e.g. a
  // background task finishing). A turn that asks again replaces it; a report that asks nothing
  // ("still waiting for your answer") leaves it open, or the developer would lose the question.
  const replaced = () => store.closeOpen(sid, { kinds: ["waiting"], status: "dismissed", problems });
  const asked = store.openQuestions(sid, problems).filter((q) => q.kind === "question");
  if (asked.length > 0) {
    // The model asked through the CLI: the message it ended the turn with explains the question.
    // Its last paragraph is left out only when it repeats the question; anything more it says stays.
    replaced();
    const whole = [before, last].filter(Boolean).join("\n\n");
    for (const q of asked) store.addContext(q.id, sameWords(last, q.text) ? before : whole);
    return;
  }
  // Only a turn that ends asking something needs the developer; a report waits quietly on the session.
  if (!/[?¿？]/.test(last)) return;
  replaced();
  // The sentences that ask are the question; what the paragraph says around them reads first under it.
  const { question, rest } = splitQuestion(last);
  store.ask(compact({ sessionId: sid, kind: "waiting" as const, text: question, context: [rest, before].filter(Boolean).join("\n\n") || undefined }));
}

const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+/;
const FENCE = /^\s*(?:```|~~~)/;
const ENDS = ".!?…。！？";
/** What may close a sentence after its mark: more marks, emphasis, quotes, brackets. */
const CLOSERS = `${ENDS})]"'»”’*_`;
/** "e.g.", "i.e.", "U.S.": a full stop inside an abbreviation does not end the sentence. */
const ABBREVIATION = /(?:^|[\s(])(?:\p{L}\.){2,}$/u;
const asks = (sentence: string) => /[?？]$/.test(sentence.replace(/[)\]"'»”’*_]+$/, ""));
const outsideCode = (line: string) => line.replace(/`[^`]*`/g, "");

/** A line's sentences, cut after their closing mark; a mark inside inline code or a word ("v1.2") cuts nothing. */
function sentences(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  let code = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (c === "`") code = !code;
    if (code || !ENDS.includes(c) || (c === "." && ABBREVIATION.test(line.slice(0, i + 1)))) continue;
    let end = i + 1;
    while (end < line.length && CLOSERS.includes(line.charAt(end))) end++;
    // Fullwidth marks end a sentence with no space after them, as Chinese and Japanese write.
    if (end < line.length && !/\s/.test(line.charAt(end)) && !"。！？".includes(c)) continue;
    out.push(line.slice(start, end).trim());
    start = end;
    i = end - 1;
  }
  const tail = line.slice(start).trim();
  return tail ? [...out, tail] : out;
}

/** A sentence cut out of a bold span keeps no lone `**` at its edge. */
function balanced(piece: string): string {
  if ((piece.split("**").length - 1) % 2 === 0) return piece;
  if (piece.startsWith("**")) return piece.slice(2).trimStart();
  return piece.endsWith("**") ? piece.slice(0, -2).trimEnd() : piece;
}

/**
 * The asking sentences of a turn's last paragraph, in order, and the rest of it, lines kept. The
 * paragraph stays whole when it is a list whose items ask (a list of decisions, shown as a block),
 * when every sentence asks, or when nothing outside code ends in a question mark.
 */
export function splitQuestion(paragraph: string): { question: string; rest: string } {
  const whole = { question: paragraph, rest: "" };
  const asked: string[] = [];
  const kept: string[] = [];
  let fenced = false;
  let inItem = false;
  for (const line of paragraph.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced || FENCE.test(line) || line.trim() === "") {
      kept.push(line);
      continue;
    }
    // An item's own lines are indented under it.
    inItem = LIST_ITEM.test(line) || (inItem && /^\s/.test(line));
    if (inItem) {
      if (/[?？¿]/.test(outsideCode(line))) return whole;
      kept.push(line);
      continue;
    }
    const parts = sentences(line).map(balanced);
    asked.push(...parts.filter(asks));
    const said = parts.filter((p) => !asks(p)).join(" ");
    if (said) kept.push(said);
  }
  const rest = kept.join("\n").trim();
  return asked.length === 0 || rest === "" ? whole : { question: asked.join(" "), rest };
}

const MESSAGE_MAX = 8000;
const SENT_KEPT = 10;
const bounded = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
/** The same text once Markdown marks, case, spacing and punctuation are set aside. */
const sameWords = (a: string, b: string) => {
  const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return words(a) === words(b);
};

/** Prompts Claude Code itself submits (background task notifications), not typed by the developer. */
export function fromClaudeCode(prompt: string): boolean {
  return /^\s*<(task-notification|system-reminder|agent-message|local-command-stdout|command-name)[\s>]/.test(prompt);
}

/** Pasted text arrives wrapped in Claude Code's paste markers; on the desk it reads as a quoted block. */
export function readablePrompt(prompt: string): string {
  return prompt.replace(/<pasted_content[^>]*>\n?/g, "\n```\n").replace(/\n?<\/pasted_content[^>]*>/g, "\n```\n").trim();
}

/** A session title from the first prompt: its first line, at most 60 characters. */
function titleFrom(prompt: string): string {
  const first = firstLine(prompt).replace(/\s+/g, " ");
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

/**
 * Adds to the conversation what Claude wrote to the developer during the turn, between its tool
 * calls, so it can be read later on the desk (the turn's last message is recorded on its own).
 * Runs at the end of the turn and, at most every few seconds, after the session's tool calls.
 */
function recordTurnTexts(input: Common, store: Store, last = ""): void {
  const transcript = optional(input.raw.transcript_path, "hook input.transcript_path", (v, w) => text(v, w, 4096));
  if (!transcript?.endsWith(".jsonl")) return;
  const known = new Set(store.listMessages(input.sessionId).slice(-100).map((m) => m.text));
  for (const said of turnTexts(transcript)) {
    if (known.has(said) || (last !== "" && last.includes(said))) continue;
    store.addMessage({ sessionId: input.sessionId, from: "session", text: said, step: true });
    known.add(said);
  }
}

const TRANSCRIPT_TAIL = 1024 * 1024;

/** The last `bytes` of a transcript; empty when it is not written yet. */
function readTail(transcript: string, bytes: number): string {
  try {
    const fd = fs.openSync(transcript, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (isCode(error, "ENOENT")) return ""; // a session or agent that has not written its transcript yet
    throw error;
  }
}

/** Whether a transcript ends where the developer interrupted it (Esc, or a stopped workflow). */
export function endsInterrupted(transcript: string): boolean {
  const last = readTail(transcript, 8192).trimEnd().split("\n").at(-1) ?? "";
  let entry: unknown;
  try {
    entry = JSON.parse(last);
  } catch {
    return false; // a last line longer than the tail, or half written: not the short interruption note
  }
  if (typeof entry !== "object" || entry === null || (entry as Fields).type !== "user") return false;
  const message = (entry as Fields).message;
  const content = typeof message === "object" && message !== null ? (message as Fields).content : undefined;
  const said = typeof content === "string" ? [content] : Array.isArray(content) ? content.map((b) => (typeof b === "object" && b !== null ? (b as Fields).text : undefined)) : [];
  return said.some((t) => typeof t === "string" && t.startsWith("[Request interrupted by user"));
}

/**
 * At each turn's start and end, agents no hook will stop are recorded as stopped:
 * - a launch whose Agent call returned without its sub-agent starting (refused, failed, interrupted;
 *   no hook reports most of those): settled from the call's result in the session's transcript
 *   (settleLaunch);
 * - an interrupted sub-agent gets no SubagentStop: one still working whose transcript ends
 *   interrupted;
 * - an agent the session reported with `agent-desk agent` that no sub-agent took (its name is not
 *   the label of any), once no sub-agent the hooks follow may still run. Should its sub-agent start
 *   later after all, it takes the sub-agent's state again with its label (settleName).
 */
function settleAgents(input: Common, ctx: HookContext, problems: string[]): void {
  const { store } = ctx;
  const sid = input.sessionId;
  settleLaunches(input, ctx, problems);
  for (const agent of store.listAgents(sid)) {
    if (agent.state !== "working" || !agent.ref || agent.ref.startsWith(PENDING)) continue;
    const meta = subagentMeta(input, agent.ref);
    if (meta && endsInterrupted(meta.replace(/\.meta\.json$/, ".jsonl"))) {
      store.updateAgent(sid, agent.name, { state: "done", activity: "Interrupted before it finished" });
    }
  }
  const agents = store.listAgents(sid);
  const followed = agents.filter((a) => a.ref !== undefined);
  if (followed.length === 0 || followed.some((a) => a.state !== "done" && a.state !== "failed")) return;
  for (const agent of agents) {
    if (agent.ref === undefined && agent.state === "working") store.updateAgent(sid, agent.name, { state: "done", activity: "No sub-agent of the session runs any more" });
  }
}

/**
 * The texts Claude wrote in the session's current turn, oldest first: its assistant entries after
 * the last entry from the developer, read from the end of the transcript (sub-agents' left out).
 */
export function turnTexts(transcript: string): string[] {
  const tail = readTail(transcript, TRANSCRIPT_TAIL);
  const texts: string[] = [];
  for (const line of tail.split("\n").reverse()) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the first line of the tail is cut, and the last may be half written
    }
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Fields;
    if (e.isSidechain === true) continue;
    const content = typeof e.message === "object" && e.message !== null ? (e.message as Fields).content : undefined;
    const blocks = Array.isArray(content) ? content.filter((b): b is Fields => typeof b === "object" && b !== null) : [];
    if (e.type === "user") {
      if (typeof content === "string" || !blocks.some((b) => b.type === "tool_result")) break; // the developer spoke: the turn starts after it
      continue;
    }
    if (e.type !== "assistant") continue;
    for (const b of blocks.reverse()) if (b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") texts.unshift(b.text.trim());
  }
  return texts;
}

/** What a tool call says about the session or sub-agent that made it. */
function recordActivity(input: Common, ctx: HookContext, problems: string[]): void {
  const what = describeTool(input.raw.tool_name, input.raw.tool_input, workDir(input, ctx));
  const agentId = typeof input.raw.agent_id === "string" ? input.raw.agent_id : "";
  const at = new Date().toISOString();
  // Failed calls are kept only while they come in a row: any successful call ends the streak, so a
  // test failing while it is fixed, or a search that finds nothing, does not read as stuck.
  const fails = input.event === "PostToolUseFailure";
  const call = {
    activity: bounded(what, 200),
    activityAt: at,
    failedWhat: fails ? bounded(what, 200) : undefined,
    waitsForJob: (!fails && waitsOnJob(input.raw.tool_name, input.raw.tool_input)) || undefined,
  };
  const streak = (before: string[] | undefined) => (fails ? [...(before ?? []), at].slice(-FAILURES_KEPT) : undefined);
  if (agentId === "") {
    ctx.store.updateSession(input.sessionId, (s) => {
      if (s.state === "ended") return s;
      const { failedAt, failedWhat: _what, waitsForJob: _waits, ...rest } = s;
      return compact({ ...rest, ...call, failedAt: streak(failedAt) });
    });
    syncFailingMarker(ctx.store, fails, problems);
    recordTurnTexts(input, ctx.store);
    return;
  }
  const label = launchNotes(subagentMeta(input, agentId), problems).description;
  settleLabel(input, ctx, agentId, label);
  // A workflow's agent whose notes were not written when it started gets its label now.
  updateByRef(ctx.store, input.sessionId, agentId, (agent) =>
    agent.state === "working" ? { ...compact({ goal: agent.goal ? undefined : label }), ...call, failedAt: streak(agent.failedAt) } : undefined,
  );
  syncFailingMarker(ctx.store, fails, problems);
}

/** Tools that wait on work running apart from the call: a monitor, a background task's output, a wake-up. */
const JOB_TOOLS = new Set(["Monitor", "TaskOutput", "BashOutput", "ScheduleWakeup"]);
/** A shell command that waits: `sleep 60 && tail run.log`, `until …; do sleep 5; done`, `wait`. */
const WAIT_COMMAND = /(?:^|[;&|(]\s*|\bdo\s+)(?:sleep\s+\d|wait\b)/;

/** Whether a call started work that runs on after it (in the background), or waited for such work. */
function waitsOnJob(tool: unknown, input: unknown): boolean {
  if (typeof tool !== "string") return false;
  if (JOB_TOOLS.has(tool)) return true;
  if (typeof input !== "object" || input === null) return false;
  const f = input as Fields;
  if (f.run_in_background === true) return true; // Bash, Agent and Task take it
  return tool === "Bash" && typeof f.command === "string" && WAIT_COMMAND.test(f.command.trim());
}

/**
 * hooks.json runs this adapter after every tool call while this marker exists, instead of sampling
 * them every few seconds: the successful call that ends a streak of failures must not be missed.
 */
export const FAILING_MARKER = ".failing";

function syncFailingMarker(store: Store, failed: boolean, problems: string[]): void {
  const marker = path.join(store.paths.home, FAILING_MARKER);
  if (!failed && !fs.existsSync(marker)) return;
  // Under a lock, so a call that ends one streak cannot remove the marker a failure elsewhere just needed.
  withLock(marker, () => {
    if (failed || streakOpen(store, problems)) fs.writeFileSync(marker, "", { mode: 0o600 });
    else fs.rmSync(marker, { force: true });
  });
}

/** Whether a session at work, or a working agent of a live session, has failed calls in a row. */
function streakOpen(store: Store, problems: string[]): boolean {
  return store
    .listSessions(problems)
    .filter((s) => s.state !== "ended")
    .some((s) => (s.state === "working" && (s.failedAt?.length ?? 0) > 0) || store.listAgents(s.id, problems).some((a) => a.state === "working" && (a.failedAt?.length ?? 0) > 0));
}

/**
 * The last paragraph is usually the question; what precedes it is context, trimmed from the start.
 * A last paragraph too long to show large is cut between lines, and its first lines join the context:
 * nothing of it is lost.
 */
export function splitLastParagraph(message: string): { last: string; before: string } {
  const paragraphs = message.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const lastRaw = paragraphs.pop() ?? message;
  let last = lastRaw;
  if (last.length > LAST_TEXT_MAX) {
    const lines = lastRaw.split("\n");
    let kept = lines.length - 1;
    while (kept > 0 && lines.slice(kept - 1).join("\n").length <= LAST_TEXT_MAX) kept--;
    last = lines.slice(kept).join("\n");
    if (last.length > LAST_TEXT_MAX) last = `…${last.slice(-LAST_TEXT_MAX)}`; // one line longer than the limit
    else if (kept > 0) paragraphs.push(lines.slice(0, kept).join("\n"));
  }
  const rest = paragraphs.join("\n\n");
  const before = rest.length > CONTEXT_MAX ? `…${rest.slice(-CONTEXT_MAX)}` : rest;
  return { last, before };
}

/**
 * hooks.json runs this adapter after a tool call only while this marker exists, so the many tool
 * calls made while no permission prompt is open do not start a process each.
 */
export const PERMISSION_MARKER = ".permission-open";

function syncPermissionMarker(store: Store, problems: string[]): void {
  const marker = path.join(store.paths.home, PERMISSION_MARKER);
  // Under a lock, so one session's check cannot remove the marker another session just needed.
  withLock(marker, () => {
    if (store.openQuestions(undefined, problems).some((q) => q.kind === "permission" || q.dialog)) fs.writeFileSync(marker, "", { mode: 0o600 });
    else fs.rmSync(marker, { force: true });
  });
}

/** "Bash: npm test", "Edit: src/app.ts" (paths shown relative to the project). */
function describeTool(tool: unknown, input: unknown, projectDir?: string): string {
  const name = typeof tool === "string" && tool !== "" ? tool : "?";
  if (typeof input !== "object" || input === null) return name;
  const f = input as Fields;
  const found = [f.command, f.file_path, f.url, f.pattern, f.description].find((v) => typeof v === "string" && v !== "");
  if (found === undefined) return name;
  let detail = String(found);
  if (projectDir && detail.startsWith(`${projectDir}/`)) detail = detail.slice(projectDir.length + 1);
  return `${name}: ${detail.slice(0, 2000)}`;
}

// ── Sub-agents ──────────────────────────────────────────────────────────
// SubagentStart's input does not name the Agent tool call that launched it, and Claude Code writes its
// notes on the sub-agent (label and Agent call) only after that hook. An agent is named after the
// description given to the Agent tool; SubagentStart pairs with the oldest unpaired launch of its type,
// and the agent's first tool call or its stop corrects the pairing and the name from the notes
// (settleLabel). Once the Agent call returns, its result names its sub-agent and settles the pairing
// for good, or settles a launch that never started (settleLaunch).

const PENDING = "tool:";

function launchAgent(input: Common, ctx: HookContext): void {
  const toolInput = fields(input.raw.tool_input ?? {}, "hook input.tool_input");
  const description = text(toolInput.description ?? "", "tool_input.description", 2000).trim() || "agent";
  const type = text(toolInput.subagent_type ?? "general-purpose", "tool_input.subagent_type", 200);
  const toolUseId = text(input.raw.tool_use_id ?? "", "hook input.tool_use_id", 200);
  ctx.store.addAgent(input.sessionId, slug(description), compact({
    type,
    ref: `${PENDING}${toolUseId}`,
    launch: toolUseId || undefined,
    goal: description,
    state: "working" as const,
  }));
}

/** The Agent call that launched the record's agent; a record from an older adapter names it only while unpaired. */
const launchOf = (a: Agent) => a.launch ?? (a.ref?.startsWith(PENDING) ? a.ref.slice(PENDING.length) || undefined : undefined);

/** A launch no sub-agent start has been paired with yet, and that has not been settled. */
const awaitsStart = (a: Agent) => a.state === "working" && a.ref?.startsWith(PENDING) === true;

/**
 * Pairs a start with the oldest launch of its type that awaits one. Each claim is compared under the
 * record's lock, so two starts of the same type running at once take two different launches.
 */
function claimLaunch(store: Store, sessionId: string, type: string, agentId: string): boolean {
  for (let tries = 0; tries < 3; tries++) {
    const waiting = store.listAgents(sessionId).filter((a) => awaitsStart(a) && (a.type === type || type === ""));
    if (waiting.length === 0) return false;
    for (const launch of waiting) {
      if (store.updateAgent(sessionId, launch.name, claimed(launch, agentId), (a) => awaitsStart(a) && a.ref === launch.ref)) return true;
    }
  }
  throw new Error(`sub-agent ${agentId} of session ${sessionId}: the launches it could pair with were taken or renamed meanwhile, three times; run the hook again`);
}

/** A launch record now following sub-agent `agentId`; one from an older adapter keeps its launch's id from its ref. */
const claimed = (launch: Agent, agentId: string): AgentFields => compact({ ref: agentId, state: "working" as const, launch: launchOf(launch) });

/**
 * Two launch records trade the sub-agents paired with them: id, state and activity. A record left
 * with none awaits its own launch's start again.
 */
function trade(store: Store, sessionId: string, a: Agent, b: Agent): void {
  const given = (from: Agent, to: Agent) =>
    compact({ ref: from.ref?.startsWith(PENDING) && to.launch !== undefined ? `${PENDING}${to.launch}` : from.ref, state: from.state, activity: from.activity });
  store.updateAgent(sessionId, b.name, given(a, b));
  store.updateAgent(sessionId, a.name, given(b, a));
}

/** What an Agent call returned: its sub-agent and how it ran, or the error it failed with. */
export type LaunchOutcome = { agentId?: string; status?: string; error?: string; interrupted?: boolean };

const AGENT_ID = /^[\w-]{1,200}$/;

/** The Agent call of a launch returned (PostToolUse, PostToolUseFailure): its outcome settles the launch. */
function launchReturned(input: Common, ctx: HookContext): void {
  const launchId = text(input.raw.tool_use_id ?? "", "hook input.tool_use_id", 200);
  if (launchId === "") return;
  if (input.event === "PostToolUseFailure") {
    const error = firstLine(text(input.raw.error ?? "", "hook input.error", 1_000_000));
    const interrupted = optional(input.raw.is_interrupt, "hook input.is_interrupt", bool) === true || interruption(error);
    settleLaunch(ctx.store, input.sessionId, launchId, { error, interrupted });
    return;
  }
  settleLaunch(ctx.store, input.sessionId, launchId, agentResult(fields(input.raw.tool_response ?? {}, "hook input.tool_response"), "hook input.tool_response"));
}

/** The sub-agent and status an Agent call's result names (`agentId`; `status`: "completed", "async_launched"). */
function agentResult(response: Fields, where: string): LaunchOutcome {
  const agentId = optional(response.agentId, `${where}.agentId`, (v, w) => text(v, w, 200));
  if (agentId !== undefined && !AGENT_ID.test(agentId)) throw new InputError(`${where}.agentId: expected letters, digits, _ or -, got ${JSON.stringify(agentId)}`);
  return compact({ agentId, status: optional(response.status, `${where}.status`, (v, w) => text(v, w, 100)) });
}

const interruption = (said: string) => said.startsWith("[Request interrupted by user");

/**
 * Settles the launch of Agent call `launchId` from what the call returned:
 * - it names its sub-agent: that sub-agent is paired with this launch (pairLaunch); a foreground call
 *   that completed leaves it done, a background one (`async_launched`) working, as its start may
 *   still come;
 * - it failed, was refused or was interrupted before its sub-agent started: failed, or done when
 *   interrupted, with the reason as its activity;
 * - it completed without naming one, and no start was seen: done.
 */
export function settleLaunch(store: Store, sessionId: string, launchId: string, outcome: LaunchOutcome): void {
  const agentId = outcome.agentId;
  if (agentId !== undefined) {
    const paired = pairLaunch(store, sessionId, launchId, agentId);
    if (paired && outcome.status === "completed") store.updateAgent(sessionId, paired.name, { state: "done" }, (a) => a.ref === agentId && a.state === "working");
    return;
  }
  const launch = store.listAgents(sessionId).find((a) => launchOf(a) === launchId);
  if (!launch || !awaitsStart(launch)) return;
  const change: AgentFields | undefined =
    outcome.error !== undefined
      ? outcome.interrupted
        ? { state: "done", activity: "Interrupted before it started" }
        : { state: "failed", activity: bounded(`Did not start: ${outcome.error || "its Agent call failed"}`, 200) }
      : outcome.status === "completed"
        ? { state: "done", activity: "Finished; its start was not seen" }
        : undefined;
  if (change) store.updateAgent(sessionId, launch.name, change, (a) => awaitsStart(a) && a.ref === launch.ref);
}

/**
 * Makes the record of launch `launchId` the one that follows sub-agent `agentId`: it trades with the
 * launch record a start paired that sub-agent with, or claims it; a sub-agent it held by mistake goes
 * to another launch of its type still awaiting a start. Returns the launch record.
 */
function pairLaunch(store: Store, sessionId: string, launchId: string, agentId: string): Agent | undefined {
  const agents = store.listAgents(sessionId);
  const launch = agents.find((a) => launchOf(a) === launchId);
  if (!launch || launch.ref === agentId) return launch;
  const holder = agents.find((a) => a.ref === agentId);
  if (holder) {
    // A record made for a start no launch awaited (no `launch`) is no launch to trade with.
    if (holder.launch === undefined) return launch;
    trade(store, sessionId, holder, launch);
  } else {
    if (!launch.ref?.startsWith(PENDING)) {
      const other = agents.find((a) => a.name !== launch.name && awaitsStart(a) && a.type === launch.type);
      if (!other) return launch;
      trade(store, sessionId, launch, other);
    }
    store.updateAgent(sessionId, launch.name, claimed(launch, agentId), (a) => a.ref?.startsWith(PENDING) === true);
  }
  return store.listAgents(sessionId).find((a) => launchOf(a) === launchId);
}

/**
 * At a turn's start or end, launches are settled from their Agent calls' results, when the
 * transcript has them: one still awaiting its start, and one a start may have paired by mistake.
 */
function settleLaunches(input: Common, ctx: HookContext, problems: string[]): void {
  const agents = ctx.store.listAgents(input.sessionId);
  if (!agents.some(awaitsStart)) return;
  const transcript = optional(input.raw.transcript_path, "hook input.transcript_path", (v, w) => text(v, w, 4096));
  if (!transcript?.endsWith(".jsonl")) return;
  const launches = new Map(agents.flatMap((a) => {
      const id = launchOf(a);
      return id !== undefined && (awaitsStart(a) || !a.ref?.startsWith(PENDING)) ? [[id, a] as const] : [];
    }));
  const outcomes = [...launchOutcomes(transcript, new Set(launches.keys()), problems)];
  // Pairings already right are left alone; the rest go pairings first, as one may hand a launch back
  // the start it awaits before that launch's own outcome is read.
  const due = outcomes.filter(([launchId, o]) => o.agentId === undefined || launches.get(launchId)?.ref !== o.agentId);
  due.sort(([, a], [, b]) => Number(b.agentId !== undefined) - Number(a.agentId !== undefined));
  for (const [launchId, outcome] of due) settleLaunch(ctx.store, input.sessionId, launchId, outcome);
}

/**
 * The results of these Agent calls in the session's transcript, read from its end: Claude Code
 * records each tool result as a `user` entry with a `tool_result` block, and the Agent tool's own
 * result (`toolUseResult`: `agentId`, `status`) beside it.
 */
export function launchOutcomes(transcript: string, launchIds: Set<string>, problems: string[]): Map<string, LaunchOutcome> {
  const found = new Map<string, LaunchOutcome>();
  for (const line of readTail(transcript, TRANSCRIPT_TAIL).split("\n")) {
    if (!line.includes("tool_result")) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the first line of the tail is cut, and the last may be half written
    }
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Fields;
    if (e.type !== "user" || e.isSidechain === true || typeof e.message !== "object" || e.message === null) continue;
    const content = (e.message as Fields).content;
    const results = (Array.isArray(content) ? content : []).filter((b): b is Fields => typeof b === "object" && b !== null && (b as Fields).type === "tool_result");
    for (const block of results) {
      const launchId = block.tool_use_id;
      if (typeof launchId !== "string" || !launchIds.has(launchId)) continue;
      const said = firstLine(resultText(block.content));
      if (block.is_error === true || interruption(said)) {
        found.set(launchId, { error: said, interrupted: interruption(said) });
        continue;
      }
      // The entry's `toolUseResult` is this call's only when the entry carries this result alone.
      const own = results.length === 1 && typeof e.toolUseResult === "object" && e.toolUseResult !== null ? (e.toolUseResult as Fields) : {};
      try {
        found.set(launchId, agentResult(own, `${transcript}: the result of ${launchId}`));
      } catch (error) {
        problems.push((error as Error).message);
      }
    }
  }
  return found;
}

/** A tool result's text: a string, or its text blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (typeof b === "object" && b !== null && typeof (b as Fields).text === "string" ? String((b as Fields).text) : "")).join("\n");
}

function startAgent(input: Common, ctx: HookContext, problems: string[]): void {
  const agentId = text(input.raw.agent_id ?? "", "hook input.agent_id", 200);
  const type = text(input.raw.agent_type ?? "", "hook input.agent_type", 200);
  if (agentId === "") throw new InputError("SubagentStart without agent_id");
  // A message sent to a running or finished agent starts it again under the same id: same agent.
  if (ctx.store.listAgents(input.sessionId).some((a) => a.ref === agentId)) {
    updateByRef(ctx.store, input.sessionId, agentId, () => ({ state: "working" }));
    return;
  }
  if (claimLaunch(ctx.store, input.sessionId, type, agentId)) return;
  // Launched by something other than the Agent tool (a workflow): its label, when already noted, is its goal.
  const goal = launchNotes(subagentMeta(input, agentId), problems).description;
  ctx.store.addAgent(input.sessionId, slug(goal || type || "agent"), compact({ type: type || undefined, ref: agentId, goal, state: "working" as const }));
  settleName(input, ctx, agentId, goal);
}

function stopAgent(input: Common, ctx: HookContext, problems: string[]): void {
  const agentId = text(input.raw.agent_id ?? "", "hook input.agent_id", 200);
  const transcript = optional(input.raw.agent_transcript_path, "hook input.agent_transcript_path", (v, w) => text(v, w, 4096));
  const meta = transcript?.endsWith(".jsonl") ? transcript.replace(/\.jsonl$/, ".meta.json") : subagentMeta(input, agentId);
  const label = launchNotes(meta, problems).description;
  settleLabel(input, ctx, agentId, label);
  const last = firstLine(text(input.raw.last_assistant_message ?? "", "hook input.last_assistant_message", 1_000_000));
  // Usually one record; more only where an older adapter recorded a restarted agent twice. The goal
  // comes with the notes when they were not written yet at the agent's start.
  updateByRef(ctx.store, input.sessionId, agentId, (agent) => compact({ state: "done" as const, activity: last || undefined, goal: agent.goal ? undefined : label }));
}

/** What the notes' label settles: which launch the agent is (settlePairing), then its name (settleName). */
function settleLabel(input: Common, ctx: HookContext, agentId: string, label: string | undefined): void {
  if (!label) return;
  settlePairing(input, ctx, agentId, label);
  settleName(input, ctx, agentId, label);
}

/**
 * Launches of one type that start together may be paired the wrong way round. Once Claude Code has
 * noted the sub-agent's label, the agent recorded under its id is checked against it and, when they
 * differ, trades id and state with the launch that carries that label.
 */
function settlePairing(input: Common, ctx: HookContext, agentId: string, label: string): void {
  const agents = ctx.store.listAgents(input.sessionId);
  const held = agents.find((a) => a.ref === agentId);
  if (!held?.goal || held.goal === label) return;
  const owner = agents.find((a) => a.goal === label && a.type === held.type && a.ref !== agentId);
  if (owner) trade(ctx.store, input.sessionId, held, owner);
}

/**
 * A sub-agent that started before Claude Code noted its label was named after its type
 * ("workflow-subagent-3"); once the label is known, it takes the label's name, the one the session
 * reports it under (`agent-desk agent "<label>"`). A record the session already made under that
 * name, which follows no sub-agent, becomes this agent's: one record, with the session's summary,
 * branch and `after`, and this agent's id, state and times.
 */
function settleName(input: Common, ctx: HookContext, agentId: string, label: string | undefined): void {
  if (!label) return;
  const name = slug(label);
  const { store } = ctx;
  // A rename refused because an agent of the same label took the name meanwhile is tried again with
  // the next free name; after a few, the agent's next event tries again.
  for (let tries = 0; tries < 3; tries++) {
    const agents = store.listAgents(input.sessionId);
    const held = agents.find((a) => a.ref === agentId);
    if (!held || held.name === name) return;
    const reported = agents.find((a) => a.name === name);
    const to = reported && reported.ref === undefined ? name : namedFromType(held) ? freeName(store, input.sessionId, name) : undefined;
    if (to === undefined || store.renameAgent(input.sessionId, held.name, to)) return;
  }
}

/** Named as startAgent names an agent whose label it does not know: after its type (or "agent"), maybe numbered. */
const namedFromType = (agent: Agent) => new RegExp(`^${slug(agent.type || "agent")}(-\\d+)?$`).test(agent.name);

/**
 * Merges `change` into the agents recorded under `ref`. Another hook may rename one meanwhile
 * (settleName): it is found again under its new name, never recreated under the old one.
 */
function updateByRef(store: Store, sessionId: string, ref: string, change: (agent: Agent) => AgentFields | undefined): void {
  const updated = new Set<string>();
  for (let tries = 0; tries < 3; tries++) {
    let missed = false;
    for (const agent of store.listAgents(sessionId)) {
      if (agent.ref !== ref || updated.has(agent.name)) continue;
      const fields = change(agent);
      if (fields === undefined || store.updateAgent(sessionId, agent.name, fields)) updated.add(agent.name);
      else missed = true;
    }
    if (!missed) return;
  }
  throw new Error(`agent ${ref} of session ${sessionId} was renamed again and again while its hook updated it; run the hook again`);
}

/**
 * Where Claude Code keeps its notes on a sub-agent: beside the session's transcript, in
 * `<session>/subagents/agent-<id>.meta.json`, or one folder down per workflow run.
 */
function subagentMeta(input: Common, agentId: string): string | undefined {
  const transcript = optional(input.raw.transcript_path, "hook input.transcript_path", (v, w) => text(v, w, 4096));
  if (!transcript?.endsWith(".jsonl") || !/^[\w-]+$/.test(agentId)) return undefined;
  if (path.basename(transcript) === `agent-${agentId}.jsonl`) return transcript.replace(/\.jsonl$/, ".meta.json");
  const dir = path.join(transcript.slice(0, -".jsonl".length), "subagents");
  const file = `agent-${agentId}.meta.json`;
  if (fs.existsSync(path.join(dir, file))) return path.join(dir, file);
  const workflows = path.join(dir, "workflows");
  const runs = fs.existsSync(workflows) ? fs.readdirSync(workflows) : [];
  return runs.map((run) => path.join(workflows, run, file)).find((f) => fs.existsSync(f));
}

/** What Claude Code noted on a sub-agent's launch: its label (`description`). */
function launchNotes(metaFile: string | undefined, problems: string[]): { description?: string } {
  if (!metaFile) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(metaFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; // not written (yet): nothing noted
    throw error;
  }
  try {
    const f = fields(JSON.parse(raw), metaFile);
    return compact({ description: optional(f.description, `${metaFile}.description`, (v, w) => text(v, w, 2000))?.trim() || undefined });
  } catch (error) {
    problems.push(`cannot read the sub-agent's notes in ${metaFile}: ${(error as Error).message}`);
    return {};
  }
}

/** `base`, or `base-2`, `base-3`… when an earlier agent of the session already has that name. */
function freeName(store: Store, sessionId: string, base: string): string {
  const taken = new Set(store.listAgents(sessionId).map((a) => a.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

function firstLine(value: string): string {
  const line = value.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

let cachedInstructions: string | undefined;
function instructions(): string {
  cachedInstructions ??= fs.readFileSync(path.join(import.meta.dirname, "instructions.md"), "utf8").trim();
  return cachedInstructions;
}

// ── Answers from the desk ───────────────────────────────────────────────

export type WaitOptions = { pollMs: number; deadline: number; armWithinMs: number; now?: () => number; signal?: AbortSignal };

/**
 * Runs after Stop as a background hook that wakes Claude: waits for an answer given on the desk
 * and returns it as the message Claude reads (exit code 2). It starts waiting once the session is
 * marked as waiting (the synchronous Stop hook may finish after this one starts) and gives up with
 * exit code 0 when the developer answers in the terminal, the session ends, or a newer turn takes over.
 */
export async function waitForAnswer(sessionId: string, store: Store, options: WaitOptions): Promise<HookOutput> {
  const now = options.now ?? Date.now;
  const armBy = now() + options.armWithinMs;
  let armed = false;
  const release = store.listen(sessionId);
  const mine = store.listeners(sessionId).find((l) => l.pid === process.pid)?.since ?? new Date(now()).toISOString();
  try {
    while (now() < options.deadline && !options.signal?.aborted) {
      const session = store.getSession(sessionId);
      if (!session || session.state === "ended") return { code: 0 };
      if (session.state === "waiting") armed = true;
      else if (armed || now() > armBy) return { code: 0 };
      if (armed) {
        const answers = store.takeInbox(sessionId, forTheTurn(store));
        if (answers.length > 0) {
          const message = answers.map((a) => deliveryText(a, imageFiles(store, a.images))).join("\n\n");
          try {
            store.updateSession(sessionId, (s) => ({ ...s, state: "working" }));
          } catch (error) {
            // The answers are already taken: they must reach the session even if the state cannot be saved.
            return { code: 2, stderr: `${message}\n\n(agent-desk could not mark the session as working: ${(error as Error).message})` };
          }
          return { code: 2, stderr: message };
        }
        if (store.listeners(sessionId).some((l) => l.pid !== process.pid && l.since > mine)) return { code: 0 };
      }
      await new Promise((r) => setTimeout(r, options.pollMs));
    }
    return { code: 0 };
  } finally {
    release();
  }
}

/** Answers for the session's turn: permission and dialog answers belong to the hook waiting for them. */
function forTheTurn(store: Store): (questionId: string) => boolean {
  return (qid) => {
    const q = store.getQuestion(qid);
    return q?.kind !== "permission" && !q?.dialog;
  };
}

export const ASK_TOOL = "AskUserQuestion";

/**
 * Shows an AskUserQuestion call on the desk: one question per question it asks, with its options
 * and whether several can be picked, grouped when there are more than one; the options' descriptions
 * go in the context. A question the model also asked through `agent-desk ask` with the same text is replaced.
 */
function askDialog(sessionId: string, toolInput: unknown, store: Store, problems: string[]): Dialog {
  const input = fields(toolInput, "tool_input");
  const asked = list(input.questions, "tool_input.questions", (v, w) => {
    const q = fields(v, w);
    return {
      text: nonEmpty(q.question, `${w}.question`, 2000),
      options: list(q.options ?? [], `${w}.options`, (o, ow) => {
        const opt = fields(o, ow);
        return { label: nonEmpty(opt.label, `${ow}.label`, 500), description: optional(opt.description, `${ow}.description`, (d, dw) => text(d, dw, 2000)) };
      }, 20),
      several: optional(q.multiSelect, `${w}.multiSelect`, bool) === true,
    };
  }, 10);
  const group = asked.length > 1 ? newId("dialog") : undefined;
  const questions = asked.map((q, index) => {
    store.closeOpen(sessionId, { kinds: ["question"], which: (o) => !o.dialog && o.text === q.text, status: "dismissed", problems });
    const context = q.options.filter((o) => o.description).map((o) => `- **${o.label}**: ${o.description}`).join("\n");
    const item = store.ask(
      compact({ sessionId, kind: "question" as const, text: q.text, options: q.options.map((o) => o.label), context: context || undefined, dialog: true, several: q.several || undefined, group: group ? { id: group, index, size: asked.length } : undefined }),
    );
    return { id: item.id, text: q.text };
  });
  return { input, questions };
}

/** The dialog's call ended: its questions still open are closed, with the answers it returned when it has them. */
function closeDialog(sessionId: string, toolResponse: unknown, store: Store, problems: string[]): void {
  const response = typeof toolResponse === "object" && toolResponse !== null ? (toolResponse as Fields) : {};
  const answers = typeof response.answers === "object" && response.answers !== null ? (response.answers as Fields) : {};
  for (const q of store.openQuestions(sessionId, problems).filter((o) => o.dialog)) {
    const answer = answers[q.text];
    store.closeOpen(sessionId, typeof answer === "string" ? { which: (o) => o.id === q.id, answer, problems } : { which: (o) => o.id === q.id, status: "dismissed", problems });
  }
}

/**
 * Runs inside the PermissionRequest hook of an AskUserQuestion call: waits until every question of
 * the dialog is answered on the desk and returns them to Claude Code as the call's answers, so the
 * terminal dialog closes. Returns no decision (the terminal dialog decides) when one of them is
 * settled elsewhere or the wait ends.
 */
export async function waitForDialog(sessionId: string, dialog: Dialog, store: Store, options: WaitOptions): Promise<HookOutput> {
  const now = options.now ?? Date.now;
  const answers: Record<string, string> = {};
  const release = store.listen(sessionId);
  try {
    while (now() < options.deadline && !options.signal?.aborted) {
      for (const q of dialog.questions) {
        if (q.text in answers) continue;
        const [entry] = store.takeInbox(sessionId, (qid) => qid === q.id);
        if (entry) answers[q.text] = entry.answer;
        else if (store.getQuestion(q.id)?.status !== "open") return { code: 0 };
      }
      if (dialog.questions.every((q) => q.text in answers)) {
        const decision = { behavior: "allow", updatedInput: { ...dialog.input, answers } };
        return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }) };
      }
      await new Promise((r) => setTimeout(r, options.pollMs));
    }
    return { code: 0 };
  } finally {
    release();
  }
}

export const ALLOW = "Allow";
export const DENY = "Deny";

/**
 * Runs inside the PermissionRequest hook: waits for the developer to allow or deny on the desk and
 * returns Claude Code's decision. "Allow" allows; any other answer denies, and its text (unless it
 * is just "Deny") is passed to Claude as the reason. Returns no decision (the terminal dialog
 * decides) when the prompt is settled elsewhere or the wait ends.
 */
export async function waitForPermission(sessionId: string, questionId: string, store: Store, options: WaitOptions): Promise<HookOutput> {
  const now = options.now ?? Date.now;
  const release = store.listen(sessionId);
  try {
    while (now() < options.deadline && !options.signal?.aborted) {
      const [answer] = store.takeInbox(sessionId, (qid) => qid === questionId);
      if (answer) {
        const decision =
          answer.answer === ALLOW
            ? { behavior: "allow" }
            : { behavior: "deny", message: answer.answer === DENY ? "The developer denied this on agent-desk." : `Denied on agent-desk: ${answer.answer}` };
        return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }) };
      }
      if (store.getQuestion(questionId)?.status !== "open") return { code: 0 };
      await new Promise((r) => setTimeout(r, options.pollMs));
    }
    return { code: 0 };
  } finally {
    release();
  }
}

/** The answer goes to Claude exactly as the developer typed it, framed so it is read as their reply. */
/**
 * Runs after each tool call while some inbox holds a message (hooks.json tests the store's marker
 * first): hands the session's messages from the desk to Claude at this step, as context it reads
 * before going on. A sub-agent's tool call leaves them for the session itself.
 */
export function deliverWhileWorking(input: Common, store: Store): HookOutput {
  if (typeof input.raw.agent_id === "string" && input.raw.agent_id !== "") return { code: 0 };
  const entries = store.takeInbox(input.sessionId, forTheTurn(store));
  if (entries.length === 0) return { code: 0 };
  const additionalContext = entries
    .map((e) => `Message from agent-desk: the developer wrote this to you on the desk page while you worked. Act on it as if they had typed it in the terminal now. Verbatim:\n${e.answer}${attachedText(imageFiles(store, e.images))}`)
    .join("\n\n");
  return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }) };
}

export function deliveryText(entry: { question: string; answer: string }, images: string[] = []): string {
  const question = entry.question.length > 300 ? `${entry.question.slice(0, 299)}…` : entry.question;
  return `Answer from agent-desk (the developer replied on the desk page instead of the terminal).\nYour question: ${question}\nTheir answer, verbatim:\n${entry.answer}${attachedText(images)}`;
}

/** The files of the images attached on the desk; one no longer in the store is named as such. */
function imageFiles(store: Store, ids: string[] = []): string[] {
  return ids.map((id) => store.imageFile(id)?.file ?? `(image ${id} is no longer in the agent-desk store)`);
}

function attachedText(files: string[]): string {
  return files.length > 0 ? `\n\nImages they attached (open each file to see it):\n${files.join("\n")}` : "";
}
