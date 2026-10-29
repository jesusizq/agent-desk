// @ts-check
// Every string the desk itself shows. Session text never goes here: it is data, shown as text.

/** @param {number} n @param {string} one @param {string} many */
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** @param {number} done @param {number} failed */
const counts = (done, failed) =>
  [done && plural(done, "finished", "finished"), failed && plural(failed, "failure", "failures")].filter(Boolean).join(", ");

const NOW = "now";

export const TEXT = {
  appName: "Agent Desk",
  locale: "en-GB",
  views: { desk: "Desk", history: "History" },
  viewsLabel: "View",
  projectsLabel: "Project",
  allProjects: "All",
  /** @param {number} n */
  needsPill: (n) => (n ? `${n} need${n === 1 ? "s" : ""} you` : "Nothing pending"),
  search: "Search history",
  theme: { auto: "Auto", light: "Light", dark: "Dark" },
  cols: { needs: "Needs you", sessions: "Sessions", review: "To review" },
  tabbar: { inbox: "Inbox", sessions: "Sessions", review: "Results", history: "History" },
  yourTurn: "your turn",
  /** @param {number} n */
  nOptions: (n) => plural(n, "option", "options"),
  trouble: {
    /** @param {number} n */
    failed: (n) => `${n} failed`,
    /** @param {number} n */
    blocked: (n) => `${n} blocked`,
    /** @param {number} n */
    idle: (n) => `${n} idle`,
  },
  /** @param {number} c @param {string} command */
  suggestChip: (c, command) => `Context ${Math.round(c)}%: ${command}`,
  chips: {
    /** @param {number} n @param {number} failed */
    agents: (n, failed) => `${plural(n, "agent", "agents")}${failed ? ` · ${failed} failed` : ""}`,
    /** @param {number} n */
    results: (n) => plural(n, "result", "results"),
    /** @param {number} n */
    live: (n) => `${n} live`,
    more: "More",
  },
  /** @param {string} label @param {number} v */
  planChip: (label, v) => `${label} ${Math.round(v)}%`,
  kinds: { question: "Question", permission: "Permission", waiting: "Your turn", decision: "Decision", dismissed: "Dismissed", result: "Result", failed: "Failed" },
  /** @param {string} t */
  askedAt: (t) => `Asked at ${t}`,
  goTo: "Go to session",
  /** @param {string} where */
  goToTitle: (where) => `Brings the terminal of ${where} to the front`,
  /** @param {string} terminal */
  noLink: (terminal) => `Cannot bring a "${terminal}" terminal to the front; find it by hand`,
  noTerminal: "This session did not say which terminal it runs in",
  remoteNoLink: "Opened from another device: answer here, or go to the computer",
  keysHint: "oldest first · ↑ ↓ · 1–9 · Ctrl+Enter sends · Enter goes to the session",
  /** @param {boolean} resultsToo */
  allClear: (resultsToo) => (resultsToo ? "All clear: nothing needs you, nothing new to review." : "All clear: nothing needs you."),
  emptyResults: "Nothing new to review.",
  seeHistory: "Earlier results",
  dismissResult: "Seen, move it to the history",
  emptyRunning: "No sessions running.",
  now: NOW,
  go: "Go",
  next: "Next",
  asks: { question: "Asks you", waiting: "Asks you", permission: "Asks permission to" },
  itsMessage: "Its message, before the question",
  options: "Options",
  answerPlaceholder: "Type your answer or pick an option…",
  replyPlaceholder: "Type your next instruction…",
  send: "Send to the session",
  sendShort: "Send",
  sendKeys: "Ctrl+Enter sends.",
  sendHint: "It reaches this session exactly as written.",
  notListening: "This session is not listening for answers right now: answer in its terminal.",
  permissionPlaceholder: "Allow, Deny, or type why it should not do this…",
  dismiss: "Dismiss",
  dismissTitle: "Remove from the list without answering (it goes to the history)",
  /** @param {string} where */
  sent: (where) => `Answer sent to ${where}.`,
  /** @param {string} where */
  newQuestion: (where) => `New question in ${where}`,
  /** @param {string} where */
  newMessage: (where) => `New message from ${where}`,
  newBadge: "New message",
  seenBadge: "Seen",
  /** @param {string} t */
  seenAt: (t) => `Opened at ${t}`,
  /** @param {string} names */
  waits: (names) => `waits for ${names}`,
  flow: "Flow",
  /** @param {string} t */
  awaiting: (t) => `Finished${t === NOW ? " just now" : t ? ` ${t} ago` : ""} · waiting for your next instruction`,
  details: "Details",
  conversation: {
    whileWorking: "sent while it worked",
    openQuestion: "See it on the desk",
    working: "It is working. What you write in its terminal or answer on the desk will appear here.",
    session: "Session",
    you: "You",
    youDesk: "You, from the desk",
    showEarlier: "Earlier in this session",
    hideEarlier: "Hide earlier messages",
    none: "Nothing earlier recorded.",
  },
  control: {
    title: "Terminal",
    interrupt: "Interrupt (Esc)",
    dialog: "Dialog option:",
    attach: "Open this terminal over SSH (e.g. Termius):",
    /** @param {string} what */
    confirm: (what) => `Send ${what}?`,
    /** @param {string} what @param {string} where */
    sent: (what, where) => `Sent ${what} to ${where}.`,
  },
  /** @param {string} type */
  agentType: (type) => `${type} agent`,
  /** @param {string} what */
  now_: (what) => `now: ${what}`,
  /** @param {string} t */
  tookFor: (t) => `took ${t}`,
  state: { needs: "Needs you", working: "Working", waiting: "Waiting on its job", blocked: "Blocked", idle: "Idle", done: "Done", failed: "Failed" },
  sessionWorking: "The session is working",
  failedAgent: "failed",
  /** @param {string} t */
  idleSince: (t) => `idle since ${t}`,
  /** @param {number} c */
  context: (c) => `context ${Math.round(c)}%`,
  /** @param {string} t @param {number} done @param {number} failed */
  sinceSummary: (t, done, failed) => `Since ${t}: ${counts(done, failed)}.`,
  /** @param {number} done @param {number} failed */
  unseenSummary: (done, failed) => `Not reviewed: ${counts(done, failed)}.`,
  /** @param {string} t */
  nothingNew: (t) => `Nothing new since ${t}.`,
  nothingYet: "Nothing has finished yet.",
  markSeen: "Mark all as seen",
  /** @param {string} free @param {string} projects */
  disk: (free, projects) => `Disk: ${free} free (${projects})`,
  /** @param {string} where @param {number} c */
  contextWarn: (where, c) => `${where}: context at ${Math.round(c)}%`,
  /** @param {number} n */
  problems: (n) => plural(n, "unreadable file", "unreadable files"),
  /** @param {string} name @param {string} size @param {number} merged @param {string} reclaim */
  worktreeChip: (name, size, merged, reclaim) => `${name}: ${size} in worktrees${merged ? ` · ${merged} merged (${reclaim})` : ""}`,
  /** @param {number} n @param {string} size @param {number} merged */
  worktreeLine: (n, size, merged) => `${plural(n, "checkout", "checkouts")} · ${size}${merged ? ` · ${merged} already merged` : ""}`,
  worktrees: {
    title: "Worktrees",
    /** @param {string} size @param {string} grew @param {string} t */
    summary: (size, grew, t) => `${size} on disk${grew ? ` · ${grew} more than this morning` : ""} · measured ${t} ago`,
    /** @param {string} base @param {number} n @param {string} size */
    merged: (base, n, size) => `Already in ${base}, safe to remove · ${n} · ${size}`,
    /** @param {number} n */
    open: (n) => `Not merged yet · ${n}`,
    main: "Main checkout",
    /** @param {number} n */
    ahead: (n) => plural(n, "commit ahead", "commits ahead"),
    detached: "detached",
    copyCleanup: "Copy the commands to remove them",
    cleanupNote: "The desk never removes anything: paste them in a terminal if you agree.",
  },
  offline: "No connection to the desk: is \"agent-desk serve\" still running?",
  /** @param {string} at */
  offlineSaved: (at) => `The computer is not answering (off or asleep). This is the desk as it was at ${at}; answers need the computer.`,
  /** @param {number} n */
  doneCount: (n) => `${n} done`,
  /** @param {string} m */
  pageError: (m) => `Page error: ${m}`,
  backToConversation: "← Conversation",
  splitTitle: "Drag to resize the columns; double-click to reset",
  alerts: {
    title: "Notifications and sound",
    notify: "Desktop notifications",
    notifyHint: "When something needs you and this tab is not in view",
    blocked: "Blocked by the browser: allow notifications for this page in its site settings",
    unavailable: "This browser cannot show them",
    sound: "Sound",
    soundHint: "A short chime when a question or permission prompt arrives",
  },
  newResult: "New",
  /** @param {string} t */
  copied: (t) => `Copied: ${t}`,
  copy: "Copy",
  suggest: {
    /** @param {number} c */
    "context-full": (c) => `Context at ${Math.round(c)}%. A good moment to compact, between two tasks:`,
  },
  openLive: "Open live",
  /** @param {string} where */
  onComputer: (where) => `Live at ${where} (on the computer)`,
  close: "Close",
  slider: "Slider",
  sideBySide: "Side by side",
  zoomHint: "Click an image to zoom",
  zoomHintTouch: "Tap a picture to zoom",
  assumed: "What the agent assumed",
  taste: "Taste decisions",
  criteria: "Acceptance criteria",
  /** @param {string} label @param {number} v @param {string} t */
  plan: (label, v, t) => `${label} ${Math.round(v)}%${t ? ` · resets in ${t}` : ""}`,
  /** @param {string} t */
  running: (t) => `running for ${t}`,
  ended: "ended",
  gone: "its process is gone",
  /** @param {string} t */
  cache: (t) => `cache ${t}`,
  /** @param {string} t */
  cacheLeft: (t) => `${t} left`,
  cacheExpired: "expired",
  /** @param {string} m */
  mode: (m) => `permissions ${m}`,
  /** @param {number} n */
  shells: (n) => plural(n, "background shell", "background shells"),
  /** @param {number} v */
  cost: (v) => `US$${v.toFixed(2)}`,
  /** @param {number} n */
  tokens: (n) => `${n >= 1000 ? `${Math.round(n / 1000)}k` : n} tokens`,
  noAgents: "No agents recorded.",
  /** @param {string} t */
  svcSince: (t) => `up for ${t}`,
  unnamed: "session",
  history: {
    title: "History",
    search: "Search questions, answers and results",
    all: "All",
    decisions: "Decisions",
    results: "Results",
    /** @param {number} n */
    entries: (n) => plural(n, "entry", "entries"),
    answer: "Answer: ",
    viaDesk: " (from the desk)",
    understood: "Understood as: ",
    /** @param {string} q */
    none: (q) => (q ? `Nothing matches "${q}".` : "Nothing in the history yet."),
    today: "Today",
    yesterday: "Yesterday",
  },
  unlock: {
    title: "Enter your PIN",
    why: "This device reaches the desk through your tailnet. The PIN unlocks it here for 12 hours.",
    label: "PIN",
    placeholder: "PIN",
    submit: "Unlock",
  },
  zoom: { in: "Zoom in", out: "Zoom out", fit: "Fit", previous: "Previous picture (←)", next: "Next picture (→)" },
};
