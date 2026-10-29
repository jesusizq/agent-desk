// Claude Code adapter: turns Claude Code hook events into desk records, at no cost to the model.
import * as fs from "node:fs";
import * as path from "node:path";
import { compact, fields, type Fields, InputError, optional, text } from "../../src/core/check.ts";
import { id, slug } from "../../src/core/ids.ts";
import type { SessionProcess } from "../../src/core/model.ts";
import { outerTerminal } from "../../src/core/tmux.ts";
import { withLock } from "../../src/store/fsx.ts";
import type { Store } from "../../src/store/store.ts";

export const PROVIDER = "Claude Code";

/** What a hook prints and exits with. */
export type HookOutput = { code: number; stdout?: string; stderr?: string; questionId?: string };

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

const LAST_TEXT_MAX = 600;
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
      store.updateSession(sid, (s) => ({ ...s, state: "waiting" }));
      return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: instructions() } }) };

    case "UserPromptSubmit": {
      const prompt = text(f.prompt ?? "", "hook input.prompt", 10_000_000);
      if (fromClaudeCode(prompt)) {
        // A background task's notification wakes the session like a prompt: it works again, but
        // nothing was said by the developer and nothing they were asked is answered.
        store.updateSession(sid, (s) => ({ ...s, state: "working" }));
        return { code: 0 };
      }
      // Without a title from Claude Code, the first thing asked of the session names it. A prompt
      // that arrives while the session works is kept, to show later whether that turn took it in.
      const at = new Date().toISOString();
      store.updateSession(sid, (s) =>
        compact({
          ...s,
          state: "working" as const,
          title: s.title ?? (titleFrom(prompt) || undefined),
          sentWhileWorking: s.state === "working" ? [...(s.sentWhileWorking ?? []), { text: bounded(prompt, 2000), at }].slice(-SENT_KEPT) : s.sentWhileWorking,
        }),
      );
      store.addMessage({ sessionId: sid, from: "developer", text: readablePrompt(prompt), via: "terminal" });
      // An answer given on the page but not yet delivered is overtaken by what was typed.
      store.withdrawInbox(sid, prompt);
      store.closeOpen(sid, { answer: prompt, problems });
      syncPermissionMarker(store, problems);
      return { code: 0 };
    }

    case "PermissionRequest": {
      const q = store.ask({ sessionId: sid, kind: "permission", text: describeTool(f.tool_name, f.tool_input), options: [ALLOW, DENY] });
      syncPermissionMarker(store, problems);
      return { code: 0, questionId: q.id };
    }

    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionDenied":
      // The tool ran or was refused: any permission prompt of this session is settled.
      store.closeOpen(sid, { kinds: ["permission"], problems });
      syncPermissionMarker(store, problems);
      if (input.event !== "PermissionDenied") recordActivity(input, ctx);
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
      endTurn(input, ctx, problems);
      ctx.startScan?.(ctx.env.CLAUDE_PROJECT_DIR || input.cwd);
      return { code: 0 };

    case "SessionEnd":
      store.withdrawInbox(sid);
      store.closeOpen(sid, { status: "dismissed", problems });
      syncPermissionMarker(store, problems);
      store.updateSession(sid, (s) => ({ ...s, state: "ended", endedAt: new Date().toISOString() }));
      return { code: 0 };

    default:
      return { code: 0 };
  }
}

/** Every event refreshes who and where the session is: it may have been resumed in another terminal. */
function register(input: Common, ctx: HookContext): void {
  const dir = ctx.env.CLAUDE_PROJECT_DIR || input.cwd;
  const title = optional(input.raw.session_title, "hook input.session_title", (v, w) => text(v, w, 200));
  const proc = ctx.sessionProcess();
  const terminal = ctx.env.TERM_PROGRAM;
  // Where the session runs inside tmux changes only when the terminal attaches or detaches.
  const tmux = ["SessionStart", "UserPromptSubmit", "Stop"].includes(input.event) ? ctx.tmuxLocation?.() : undefined;
  ctx.store.upsertSession(
    compact({
      id: input.sessionId,
      provider: PROVIDER,
      project: { name: path.basename(dir) || dir, dir },
      title: title || undefined,
      process: proc,
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
  // A turn that started without a typed prompt (e.g. a background task finishing) leaves the
  // previous turn's last message behind; this turn's message replaces it.
  store.closeOpen(sid, { kinds: ["waiting"], status: "dismissed", problems });
  syncPermissionMarker(store, problems);
  const message = text(input.raw.last_assistant_message ?? "", "hook input.last_assistant_message", 1_000_000).trim();
  const at = new Date().toISOString();
  store.updateSession(sid, (s) =>
    compact({
      ...s,
      state: "waiting" as const,
      activity: undefined,
      lastMessage: message ? { text: bounded(message, MESSAGE_MAX), at } : undefined,
      sentWhileWorking: s.sentWhileWorking?.map((m) => (m.turnEndedAt ? m : { ...m, turnEndedAt: at })),
    }),
  );
  if (message) store.addMessage({ sessionId: sid, from: "session", text: message });
  const tasks = Array.isArray(input.raw.background_tasks) ? input.raw.background_tasks : [];
  const shells = tasks.filter((t) => typeof t === "object" && t !== null && (t as Fields).type === "shell").length;
  store.mergeMetrics({ sessionId: sid, backgroundShells: shells });
  if (message === "") return;
  const { last, before } = splitLastParagraph(message);
  const asked = store.openQuestions(sid, problems);
  if (asked.length > 0) {
    // The model asked through the CLI: the message it ended the turn with explains the question.
    for (const q of asked) if (q.kind === "question") store.addContext(q.id, /[?¿]/.test(last) ? before : bounded(message, CONTEXT_MAX));
    return;
  }
  // Only a turn that ends asking something needs the developer; a report waits quietly on the session.
  if (!/[?¿]/.test(last)) return;
  store.ask(compact({ sessionId: sid, kind: "waiting" as const, text: last, context: before || undefined }));
}

const MESSAGE_MAX = 8000;
const SENT_KEPT = 10;
const bounded = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

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

/** What a tool call says about the session or sub-agent that made it. */
function recordActivity(input: Common, ctx: HookContext): void {
  const what = describeTool(input.raw.tool_name, input.raw.tool_input, ctx.env.CLAUDE_PROJECT_DIR || input.cwd);
  const agentId = typeof input.raw.agent_id === "string" ? input.raw.agent_id : "";
  if (agentId === "") {
    ctx.store.updateSession(input.sessionId, (s) => (s.state === "ended" ? s : { ...s, activity: bounded(what, 200) }));
    return;
  }
  const agent = ctx.store.listAgents(input.sessionId).find((a) => a.ref === agentId);
  if (agent && agent.state === "working") ctx.store.upsertAgent(input.sessionId, agent.name, { activity: bounded(what, 200) });
}

/** The last paragraph is usually the question; what precedes it is context, trimmed from the start. */
export function splitLastParagraph(message: string): { last: string; before: string } {
  const paragraphs = message.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const lastRaw = paragraphs.pop() ?? message;
  const last = lastRaw.length > LAST_TEXT_MAX ? `…${lastRaw.slice(-LAST_TEXT_MAX)}` : lastRaw;
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
    if (store.openQuestions(undefined, problems).some((q) => q.kind === "permission")) fs.writeFileSync(marker, "", { mode: 0o600 });
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
// Claude Code does not link SubagentStart's agent_id to the Agent tool call that launched it. An agent
// is named after the description given to the Agent tool; SubagentStart pairs with the oldest launch
// of the same agent type not yet paired. Two launches of one type at the same instant may swap ids.

const PENDING = "tool:";

function launchAgent(input: Common, ctx: HookContext): void {
  const toolInput = fields(input.raw.tool_input ?? {}, "hook input.tool_input");
  const description = text(toolInput.description ?? "", "tool_input.description", 2000).trim() || "agent";
  const type = text(toolInput.subagent_type ?? "general-purpose", "tool_input.subagent_type", 200);
  const toolUseId = text(input.raw.tool_use_id ?? "", "hook input.tool_use_id", 200);
  const name = freeName(ctx.store, input.sessionId, slug(description));
  ctx.store.upsertAgent(input.sessionId, name, compact({
    type,
    ref: `${PENDING}${toolUseId}`,
    goal: description,
    state: "working" as const,
  }));
}

function startAgent(input: Common, ctx: HookContext, problems: string[]): void {
  const agentId = text(input.raw.agent_id ?? "", "hook input.agent_id", 200);
  const type = text(input.raw.agent_type ?? "", "hook input.agent_type", 200);
  if (agentId === "") throw new InputError("SubagentStart without agent_id");
  // A message sent to a running or finished agent starts it again under the same id: same agent.
  const known = ctx.store.listAgents(input.sessionId).find((a) => a.ref === agentId);
  if (known) {
    ctx.store.upsertAgent(input.sessionId, known.name, { state: "working" });
    return;
  }
  const pending = ctx.store.listAgents(input.sessionId).find((a) => a.ref?.startsWith(PENDING) && (a.type === type || type === ""));
  if (pending) {
    ctx.store.upsertAgent(input.sessionId, pending.name, { ref: agentId, state: "working" });
    return;
  }
  // Launched by something other than the Agent tool (a workflow): its label is in Claude Code's notes.
  const goal = launchLabel(subagentMeta(input, agentId), problems);
  const name = freeName(ctx.store, input.sessionId, slug(goal || type || "agent"));
  ctx.store.upsertAgent(input.sessionId, name, compact({ type: type || undefined, ref: agentId, goal, state: "working" as const }));
}

function stopAgent(input: Common, ctx: HookContext, problems: string[]): void {
  const agentId = text(input.raw.agent_id ?? "", "hook input.agent_id", 200);
  const agents = ctx.store.listAgents(input.sessionId).filter((a) => a.ref === agentId);
  const last = firstLine(text(input.raw.last_assistant_message ?? "", "hook input.last_assistant_message", 1_000_000));
  const transcript = optional(input.raw.agent_transcript_path, "hook input.agent_transcript_path", (v, w) => text(v, w, 4096));
  // The notes may not have been written yet when the agent started.
  const goal = agents.some((a) => !a.goal) && transcript?.endsWith(".jsonl") ? launchLabel(transcript.replace(/\.jsonl$/, ".meta.json"), problems) : undefined;
  // Usually one; more only where an older adapter recorded a restarted agent twice.
  for (const agent of agents) ctx.store.upsertAgent(input.sessionId, agent.name, compact({ state: "done" as const, activity: last || undefined, goal: agent.goal ? undefined : goal }));
}

/**
 * Where Claude Code keeps its notes on a sub-agent: beside the session's transcript, in
 * `<session>/subagents/agent-<id>.meta.json`, or one folder down per workflow run.
 */
function subagentMeta(input: Common, agentId: string): string | undefined {
  const transcript = optional(input.raw.transcript_path, "hook input.transcript_path", (v, w) => text(v, w, 4096));
  if (!transcript?.endsWith(".jsonl") || !/^[\w-]+$/.test(agentId)) return undefined;
  const dir = path.join(transcript.slice(0, -".jsonl".length), "subagents");
  const file = `agent-${agentId}.meta.json`;
  if (fs.existsSync(path.join(dir, file))) return path.join(dir, file);
  const workflows = path.join(dir, "workflows");
  const runs = fs.existsSync(workflows) ? fs.readdirSync(workflows) : [];
  return runs.map((run) => path.join(workflows, run, file)).find((f) => fs.existsSync(f));
}

/** The label a sub-agent was launched with (its `description`), when its notes have one. */
function launchLabel(metaFile: string | undefined, problems: string[]): string | undefined {
  if (!metaFile) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(metaFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; // not written (yet): the agent just has no goal
    throw error;
  }
  try {
    const f = fields(JSON.parse(raw), metaFile);
    return optional(f.description, `${metaFile}.description`, (v, w) => text(v, w, 2000))?.trim() || undefined;
  } catch (error) {
    problems.push(`cannot read the sub-agent's label in ${metaFile}: ${(error as Error).message}`);
    return undefined;
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
        // Permission answers belong to the PermissionRequest hook waiting for them.
        const answers = store.takeInbox(sessionId, (qid) => store.getQuestion(qid)?.kind !== "permission");
        if (answers.length > 0) {
          const message = answers.map(deliveryText).join("\n\n");
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
export function deliveryText(entry: { question: string; answer: string }): string {
  const question = entry.question.length > 300 ? `${entry.question.slice(0, 299)}…` : entry.question;
  return `Answer from agent-desk (the developer replied on the desk page instead of the terminal).\nYour question: ${question}\nTheir answer, verbatim:\n${entry.answer}`;
}
