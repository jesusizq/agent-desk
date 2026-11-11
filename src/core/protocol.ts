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
  /**
   * The project it works on. Inside a linked git worktree, `dir` is the repository's main checkout
   * (so its worktrees group under one project) and `worktree` the folder the session works in.
   */
  project: { name: string; dir: string; worktree?: string };
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
  /**
   * Its activity is the tool call its adapter recorded ("Bash: npm test"), not words the session or
   * the adapter wrote: a page shows such a line only where the call itself helps.
   */
  activityIsCall?: boolean;
  /** When its last tool call was recorded. */
  activityAt?: string;
  /**
   * When its latest tool calls failed in a row, the last 10: a successful call ends the streak and
   * empties it, so several here mean the same thing keeps failing.
   */
  failedAt?: string[];
  /** The latest failed call of that streak, as its activity line reads ("Bash: npm test"). */
  failedWhat?: string;
  /**
   * Its latest tool call started work that runs on, or waited for it (a background command or agent,
   * a monitor, a wait): it is waiting on its own job, not quiet, until its next call.
   */
  waitsForJob?: boolean;
  /** When its latest turn ended: an answer given after it belongs to the turn now running. */
  turnEndedAt?: string;
  /** The session's last message at the end of a turn: shown quietly unless it asks something. */
  lastMessage?: { text: string; at: string };
  /** How many messages its conversation has received, so a reader sees one added mid-turn. */
  messageCount?: number;
  /** When the developer last read this session's conversation on the desk (any device). */
  readAt?: string;
  /** It ended with a question still open, so it stays in view until the developer opens it. */
  endedAsking?: boolean;
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
/** Where an answer comes from: a channel, or `review`, the text a review's page copied (written by the page, not the developer). */
export const ANSWER_SOURCES = [...ANSWER_CHANNELS, "review"] as const;

/** Images the developer can attach to one answer or message from the desk. */
export const ATTACHED_IMAGES_MAX = 10;

/**
 * `images`: ids of images in the store the developer attached on the desk. `probable`: taken from
 * the developer's next message in the terminal, which may be about something else; an answer given
 * to that very question (on the desk, or in the provider's own dialog) is certain and has none.
 */
export type Answer = { text: string; at: string; via: (typeof ANSWER_SOURCES)[number]; images?: string[]; probable?: boolean };

/** The questions asked together: `index` is this one's place among `size` of them, from 0. */
export type QuestionGroup = { id: string; index: number; size: number };

/** The most questions one group holds. */
export const GROUP_SIZE_MAX = 10;

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
   * Replies that closed it without answering it, as the session said (oldest first): the question
   * opened again, and they stay in the conversation as messages, never as its answer.
   */
  setAside?: Answer[];
  /**
   * A dialog of the provider shown on the desk (a tool asking the developer to choose): its answer
   * goes only to the provider hook that waits for it, as a permission answer does.
   */
  dialog?: boolean;
  /** More than one option can be picked: the answer names them, separated by commas. */
  several?: boolean;
  /** Asked together with other questions (one dialog), which waits until every one of them is answered. */
  group?: QuestionGroup;
  /**
   * Asked while the session's turn still runs: the message that explains it comes when the turn ends,
   * so the desk holds the question until then.
   */
  writing?: boolean;
  /**
   * The answers of a review, recorded when the developer sent it from the desk: closed when written,
   * never opened again, so a review never shows in Needs you.
   */
  review?: { id: string; round: number; note?: boolean };
  /**
   * Answered questions of the same project that read like this one, best first (at most 3), found when
   * it was asked: the developer can answer it again with one of their answers, never automatically.
   */
  past?: PastDecision[];
};

/** A question answered before in the same project, as a new question that reads like it shows it. */
export type PastDecision = {
  questionId: string;
  text: string;
  answer: string;
  at: string;
  /** The answer was the developer's next message in the terminal, which may be about something else. */
  probable?: boolean;
};

/** Past decisions shown with a question. */
export const PAST_SHOWN = 3;

export const AGENT_STATES = ["working", "waiting", "blocked", "idle", "done", "failed"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export type Agent = {
  sessionId: string;
  name: string;
  /** Kind of agent as the provider calls it, e.g. "Explore". */
  type?: string;
  /** The provider's own id for this agent, used by its adapter to match later events. */
  ref?: string;
  /**
   * The provider's id of the call that launched it, when its adapter follows launches: it settles a
   * launch that never started, and keeps the launch apart from the agent its adapter paired with it.
   */
  launch?: string;
  /**
   * The provider's id of the sub-agent whose call launched this one, when a sub-agent launched it: it
   * runs while that one runs, even where the provider lists only the agents its session launched.
   */
  launchedBy?: string;
  /** When the session last sent it a message (resuming it, or redirecting it while it ran). */
  resumedAt?: string;
  /** Short title of the task (the description it was launched with). */
  goal?: string;
  /** One sentence from the orchestrating session: what this agent must deliver. */
  summary?: string;
  state: AgentState;
  activity?: string;
  /**
   * Its activity is the tool call its adapter recorded ("Bash: npm test"), not words the session or
   * the adapter wrote: a page shows such a line only where the call itself helps.
   */
  activityIsCall?: boolean;
  /** When its last tool call was recorded. */
  activityAt?: string;
  /**
   * When its latest tool calls failed in a row, the last 10: a successful call ends the streak and
   * empties it, so several here mean the same thing keeps failing.
   */
  failedAt?: string[];
  /** The latest failed call of that streak, as its activity line reads ("Bash: npm test"). */
  failedWhat?: string;
  /**
   * Its latest tool call started work that runs on, or waited for it (a background command or agent,
   * a monitor, a wait): it is waiting on its own job, not quiet, until its next call.
   */
  waitsForJob?: boolean;
  branch?: string;
  /**
   * Its branch is the one its adapter read checked out in its worktree, not one the session reported
   * (`agent-desk agent --branch`): it follows that worktree, and a reported one replaces it.
   */
  branchFromWorktree?: boolean;
  commit?: string;
  /** The linked git worktree its tool calls ran in, as its adapter saw them. */
  worktree?: string;
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
  /**
   * The desk found its port listening in the session's own processes (src/core/ports.ts): it is shown
   * only while it still listens there. Without it, a server the session named that the desk cannot
   * see (a container's port) is shown until the session stops it.
   */
  detected?: boolean;
};

export const SUGGESTION_REASONS = ["context-full"] as const;
export type Suggestion = { reason: (typeof SUGGESTION_REASONS)[number]; command: string };

export type PlanWindow = { label: string; percent: number; resetsAt?: string };
/**
 * How a plan window fills by its reset: when it runs out (`fullAt`), or, for a long window, how full it
 * gets when that is 85% or more (`atReset`). `pace` is what the forecast follows: the last while
 * (`recent`, a short window), the window's own average so far (`window`), or the developer's usual pace
 * over the past windows weighed with this one (`usual`).
 */
export type PlanForecast = { label: string; percent: number; resetsAt: string; pace: "recent" | "window" | "usual" } & (
  | { fullAt: string; atReset?: never }
  | { atReset: number; fullAt?: never }
);

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

/**
 * Who wrote a message of a session's conversation: the session, the developer, another session
 * (`peer`), or an agent of this session reporting to it (`agent`); the last two never speak for the developer.
 */
export const MESSAGE_AUTHORS = ["session", "developer", "peer", "agent"] as const;
export type MessageAuthor = (typeof MESSAGE_AUTHORS)[number];

/** One message of a session's conversation: a turn's last message, a reply, or what another session or an agent sent it. */
export type ConversationEntry = {
  id: string;
  sessionId: string;
  from: MessageAuthor;
  /** For `peer` and `agent` messages: the sender's name as its adapter knows it (the other session's, the agent's). */
  sender?: string;
  text: string;
  at: string;
  /** For the developer's messages: typed in the terminal or sent from the desk. */
  via?: "terminal" | "desk";
  /** Ids of images in the store attached on the desk. */
  images?: string[];
  /** For the session's messages: written between its tool calls, not at the end of its turn. */
  step?: boolean;
};

export type InboxEntry = { questionId: string; question: string; answer: string; at: string; images?: string[] };

export type Seen = { since: string };

/** One checkout of a project's repository: the main one or a git worktree. */
export type Worktree = {
  path: string;
  /** Branch checked out, absent when detached. */
  branch?: string;
  head: string;
  /** Bytes on disk, everything under the path (build folders and dependencies included); absent until measured. */
  bytes?: number;
  /** When `bytes` was measured; sizes are re-measured less often than branches. */
  sizedAt?: string;
  main: boolean;
  /** For non-main worktrees: whether its head is already in the main checkout's branch. */
  merged?: boolean;
  /** Commits on this worktree's head not yet in the main branch. */
  ahead?: number;
  /** Commits of the main branch not yet in this worktree's head. */
  behind?: number;
  /** Files changed and not committed (staged, unstaged or untracked); 0 when clean. */
  dirty?: number;
  /** Its head commit's subject and commit time. */
  subject?: string;
  committedAt?: string;
  /** Live processes whose working folder is in this checkout (not a nested one), by command name. */
  busy?: string[];
  /** What failed while reading its git state, said instead of a guess. */
  error?: string;
};

/**
 * A branch an agent was said to work on that no checkout has: whether it exists, and where it stands
 * against the main branch when it does.
 */
export type BranchState = {
  name: string;
  exists: boolean;
  head?: string;
  merged?: boolean;
  ahead?: number;
  behind?: number;
  subject?: string;
  committedAt?: string;
  error?: string;
};

/** What a project's checkouts look like on disk, measured from outside the project. */
export type ProjectScan = {
  id: string;
  name: string;
  dir: string;
  /** The main checkout's branch, the one others are compared against. */
  baseBranch?: string;
  worktrees: Worktree[];
  /** Branches the project's agents were said to work on, checked out nowhere. */
  branches?: BranchState[];
  totalBytes: number;
  /** Total at the first scan of the day, to tell how much it grew today. */
  dayStart: { day: string; bytes: number };
  /** When git was read (branches, commits, changes); sizes carry their own time. */
  measuredAt: string;
  /** Files or folders that could not be measured, reported instead of skipped. */
  problems: string[];
};

/** Where one branch of a session's work stands: an agent's checkout or branch, or a checkout of its project. */
export type BranchRow = {
  /** The agent that works or worked on it, by record name. */
  agent?: { name: string; goal?: string; state: AgentState };
  branch?: string;
  /** The checkout's folder; absent for a branch checked out nowhere. */
  path?: string;
  main?: boolean;
  /** The session itself works in this checkout. */
  session?: boolean;
  /** `found` in the last scan; `missing`: no such branch; `unread`: named after the last scan read git. */
  status: "found" | "missing" | "unread";
  head?: string;
  merged?: boolean;
  ahead?: number;
  behind?: number;
  dirty?: number;
  subject?: string;
  committedAt?: string;
  busy?: string[];
  error?: string;
};

/**
 * A session's branches as the last scan of its project read them (`checkedAt`): its agents' first,
 * then the project's other checkouts; `hidden` counts the merged, clean and idle ones left out, and
 * `gone` the finished agents whose branch or checkout no longer exists.
 */
export type SessionBranches = { sessionId: string; projectId: string; baseBranch?: string; checkedAt: string; rows: BranchRow[]; hidden: number; gone: number };

/** The mechanical half of a session's handoff, recorded by its adapter before its context is compacted. */
export type Handoff = { sessionId: string; at: string; trigger: "manual" | "auto"; text: string };

/** A filesystem holding active projects that is running out of space. */
export type DiskWarning = { dir: string; projects: string[]; freeBytes: number; totalBytes: number };

/** Limits of a review: its page after images are inlined, its saved state, a key in it, the text it copies, its counter's text. */
export const REVIEW_PAGE_MAX = 25 * 1024 * 1024;
export const REVIEW_STATE_MAX = 2 * 1024 * 1024;
export const REVIEW_KEY_MAX = 200;
export const REVIEW_SUMMARY_MAX = 200 * 1024;
export const REVIEW_PROGRESS_MAX = 200;
export const REVIEW_TITLE_MAX = 120;
/** Why a review was closed, when it was said: one line. */
export const REVIEW_REASON_MAX = 300;
/** The developer's note sent with a review, after its line. */
export const REVIEW_NOTE_MAX = 4096;
/** Rounds whose page is kept; every round's metadata is. */
export const REVIEW_ROUNDS_KEPT = 5;

export type ReviewProgress = { done: number; total: number };
export type ReviewRound = { n: number; at: string; sessionId: string; bytes: number };
/** `to`: the session it was delivered to, or null when its line was copied for another conversation. `note`: the developer's words sent after the line. */
export type ReviewSend = { at: string; to: string | null; round: number; progress?: ReviewProgress; note?: string };

/** An HTML page a session published for the developer to review or choose from, round after round. */
export type Review = {
  id: string;
  title: string;
  project: { name: string; dir: string };
  /** The session that published the latest round. */
  sessionId: string;
  /** Oldest first, at least one. */
  rounds: ReviewRound[];
  /** Parsed from the page's counter (`data-agent-desk-progress`). */
  progress?: ReviewProgress;
  /** Last change of its saved state, and whether it came from this computer or a tailnet device. */
  updatedAt?: string;
  updatedFrom?: "local" | "remote";
  /** The page has handed over the text it copies (`data-agent-desk-answers`). */
  hasSummary: boolean;
  sends: ReviewSend[];
  /** Last read through `agent-desk review <id>`. */
  collected?: { at: string; sessionId: string; round: number };
  /** First opened on the desk ("New" until then). */
  openedAt?: string;
  /** Left To review; it stays in History. */
  closedAt?: string;
  /** Why it was closed, when whoever closed it said (one line). */
  closedReason?: string;
  /** The session that closed it with `agent-desk review <id> --close`; absent when closed on the desk or outside a session. */
  closedBy?: string;
};

/** A review's saved state, kept apart from the review (it can be large): the page's localStorage and the text it copied. */
export type ReviewState = { data: Record<string, string>; summary?: string; rev: number };

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
  /** Plan windows that fill before they reset at the recent pace. */
  planForecasts: PlanForecast[];
  /** Sessions with a listener waiting for answers from the desk right now. */
  listening: string[];
  disk: DiskWarning[];
  projects: ProjectScan[];
  reviews: Review[];
  /** Each running session's branches, from its project's last scan. */
  branches: SessionBranches[];
  /** Changes when the server restarts; the page reloads itself to pick up new code. */
  build: string;
};
