// The protocol: every record the desk stores. Plain types with no runtime imports, shared with the page.

export const SESSION_STATES = ["working", "waiting", "ended"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export type SessionProcess = {
  /** The session's own process. */
  pid: number;
  /** Process start time as reported by the OS; guards against a reused pid. */
  start?: string;
  /** Parent, grandparent… of `pid`, nearest first. An editor extension finds its terminal among them. */
  ancestors: number[];
};

export type Session = {
  id: string;
  /** Display label of the AI tool, e.g. "Claude Code". The core never branches on it. */
  provider: string;
  project: { name: string; dir: string };
  title?: string;
  state: SessionState;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  process?: SessionProcess;
  /** Terminal program the session runs in (the TERM_PROGRAM convention), e.g. "vscode". */
  terminal?: string;
  /**
   * The tmux pane the session runs in, when it runs inside tmux: the desk can send it keys from a
   * fixed list. `clients` are the processes of the terminals attached to that tmux session (an
   * editor extension finds its terminal among them, since the session no longer descends from it).
   */
  tmux?: { socket: string; pane: string; clients: number[] };
  /**
   * Its adapter hands it messages from the desk while it works, at its next step (as a provider
   * does with what the developer types mid-turn); otherwise only while it waits.
   */
  takesMessagesWhileWorking?: boolean;
  /** What the session is doing now, sampled from its tool calls (e.g. "Edit: src/app.ts"). */
  activity?: string;
  /** The session's last message at the end of a turn: shown quietly unless it asks something. */
  lastMessage?: { text: string; at: string };
  /** When the developer last read this session's conversation on the desk (any device). */
  readAt?: string;
  /**
   * Messages the developer sent while the session was working (latest last), and when the turn
   * that received them ended; the session's last message says how it applied them.
   */
  sentWhileWorking?: { text: string; at: string; turnEndedAt?: string }[];
};

export const QUESTION_KINDS = ["question", "permission", "waiting"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export const QUESTION_STATUSES = ["open", "answered", "dismissed"] as const;
export const ANSWER_CHANNELS = ["terminal", "desk"] as const;

export type Answer = { text: string; at: string; via: (typeof ANSWER_CHANNELS)[number] };

export type Question = {
  id: string;
  sessionId: string;
  /** question: asked by the model; permission: the tool asks to run something; waiting: the turn ended. */
  kind: QuestionKind;
  text: string;
  context?: string;
  options: string[];
  askedAt: string;
  status: (typeof QUESTION_STATUSES)[number];
  answer?: Answer;
  /** How the session understood the answer, when it reports it. */
  interpretation?: string;
  closedAt?: string;
  /**
   * A dialog of the provider shown on the desk (a tool asking the developer to choose): its answer
   * goes only to the provider hook that waits for it, as a permission answer does.
   */
  dialog?: boolean;
};

export const AGENT_STATES = ["working", "waiting", "blocked", "idle", "done", "failed"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export type Agent = {
  sessionId: string;
  name: string;
  /** Kind of agent as the provider calls it, e.g. "Explore". */
  type?: string;
  /** The provider's own id for this agent, used by its adapter to match later events. */
  ref?: string;
  /** Short title of the task (the description it was launched with). */
  goal?: string;
  /** One sentence from the orchestrating session: what this agent must deliver. */
  summary?: string;
  state: AgentState;
  activity?: string;
  branch?: string;
  commit?: string;
  /** Names of agents of the same session this one builds on or waits for. */
  after: string[];
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  tokens?: number;
};

export type Check = { criterion: string; verification: string };

export type Result = {
  id: string;
  sessionId: string;
  title: string;
  summary: string;
  status: "ok" | "failed";
  at: string;
  url?: string;
  /** Image ids in the store, shown in this order. */
  images: { id: string; caption?: string }[];
  /** Two of `images` to compare with a slider. */
  compare?: { before: string; after: string };
  assumptions: string[];
  decisions: string[];
  checks: Check[];
  seenAt?: string;
};

export type Service = {
  id: string;
  sessionId: string;
  name: string;
  url: string;
  startedAt: string;
};

export const SUGGESTION_REASONS = ["context-full"] as const;
export type Suggestion = { reason: (typeof SUGGESTION_REASONS)[number]; command: string };

export type PlanWindow = { label: string; percent: number; resetsAt?: string };

/** What a session's status line shows; every field is optional because providers differ. */
export type Metrics = {
  sessionId: string;
  at: string;
  model?: string;
  effort?: string;
  branch?: string;
  contextPercent?: number;
  contextTokens?: number;
  costUsd?: number;
  planWindows?: PlanWindow[];
  permissionMode?: string;
  cacheExpiresAt?: string;
  backgroundShells?: number;
  /** A terminal command worth running now, chosen by the provider's adapter; the page words the reason. */
  suggestion?: Suggestion;
};

/** One message of a session's conversation with the developer: a turn's last message or a reply. */
export type ConversationEntry = {
  id: string;
  sessionId: string;
  from: "session" | "developer";
  text: string;
  at: string;
  /** For the developer's messages: typed in the terminal or sent from the desk. */
  via?: "terminal" | "desk";
};

export type InboxEntry = { questionId: string; question: string; answer: string; at: string };

export type Seen = { since: string };

/** One checkout of a project's repository: the main one or a git worktree. */
export type Worktree = {
  path: string;
  /** Branch checked out, absent when detached. */
  branch?: string;
  head: string;
  /** Bytes on disk, everything under the path (build folders and dependencies included). */
  bytes: number;
  /** When `bytes` was measured; sizes are re-measured less often than branches. */
  sizedAt: string;
  main: boolean;
  /** For non-main worktrees: whether its head is already in the main checkout's branch. */
  merged?: boolean;
  /** Commits on this worktree's head not yet in the main branch. */
  ahead?: number;
};

/** What a project's checkouts look like on disk, measured from outside the project. */
export type ProjectScan = {
  id: string;
  name: string;
  dir: string;
  /** The main checkout's branch, the one others are compared against. */
  baseBranch?: string;
  worktrees: Worktree[];
  totalBytes: number;
  /** Total at the first scan of the day, to tell how much it grew today. */
  dayStart: { day: string; bytes: number };
  measuredAt: string;
  /** Files or folders that could not be measured, reported instead of skipped. */
  problems: string[];
};

/** A filesystem holding active projects that is running out of space. */
export type DiskWarning = { dir: string; projects: string[]; freeBytes: number; totalBytes: number };

/** What the page receives: the store, plus what only the machine can tell. */
export type DeskState = {
  sessions: Session[];
  questions: Question[];
  agents: Agent[];
  results: Result[];
  services: Service[];
  metrics: Metrics[];
  seen: Seen | undefined;
  /** Store files that could not be read, shown on the page instead of being skipped silently. */
  problems: string[];
  now: string;
  /** Sessions still marked running whose process has disappeared. */
  gone: string[];
  /** Sessions with a listener waiting for answers from the desk right now. */
  listening: string[];
  disk: DiskWarning[];
  projects: ProjectScan[];
  /** Changes when the server restarts; the page reloads itself to pick up new code. */
  build: string;
};
