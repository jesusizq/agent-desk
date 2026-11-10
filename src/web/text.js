// @ts-check
// Every string the desk itself shows. Session text never goes here: it is data, shown as text.

/** @param {number} n @param {string} one @param {string} many */
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** @param {number} done @param {number} failed */
const counts = (done, failed) =>
  [done && plural(done, "finished", "finished"), failed && plural(failed, "failure", "failures")].filter(Boolean).join(", ");

const NOW = "now";
// One name per part of the desk, the same on a phone's tab bar as on the desktop's columns.
const COLS = { needs: "Needs you", sessions: "Sessions", review: "To review" };
/** @param {number} c */
const contextAt = (c) => `Context ${Math.round(c)}%`;
const CLEAR = "All clear";
/** @param {boolean} resultsToo */
const clearRest = (resultsToo) => (resultsToo ? "nothing needs you, nothing new to review" : "nothing needs you");

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
  display: {
    title: "Display",
    theme: "Theme",
    text: "Text size",
    /** @param {string} size */
    sizes: (size) => `${size[0]?.toUpperCase()}${size.slice(1)} text`,
  },
  cols: COLS,
  tabbar: { inbox: COLS.needs, sessions: COLS.sessions, review: COLS.review, history: "History" },
  /** @param {number} n */
  nOptions: (n) => plural(n, "option", "options"),
  trouble: {
    /** @param {number} n */
    failed: (n) => `${n} failed`,
    /** @param {number} n */
    blocked: (n) => `${n} blocked`,
    /** @param {number} n */
    idle: (n) => `${n} idle`,
    /** @param {number} n */
    quiet: (n) => `${n} quiet`,
    /** @param {number} n */
    failing: (n) => `${n} failing`,
    /** @param {number} m */
    sessionQuiet: (m) => `no activity for ${m} min`,
  },
  /** @param {number} m */
  quietFor: (m) => `no activity for ${m} min`,
  sessionLine: {
    asks: "Asks you:",
    now: "Now:",
    permission: "Asks permission:",
    /** @param {number} n */
    more: (n) => `and ${n} more`,
    /** @param {number} n */
    moreAsks: (n) => `+${n} more`,
    /** @param {number} n */
    moreAgents: (n) => `+${plural(n, "more agent", "more agents")}`,
    /** @param {number} n */
    moreAtWork: (n) => `+${n} more at work`,
    /** @param {number} n */
    agentsDone: (n) => `${n} done`,
    /** @param {number} working @param {number} done */
    agents: (working, done) => [working && `${working} agent${working === 1 ? "" : "s"} working`, done && `${done} done`].filter(Boolean).join(" · "),
  },
  /** @param {number} n */
  failingCalls: (n) => `${n} failed calls in a row`,
  /** @param {string} call */
  lastFailed: (call) => `Last failed: ${call}`,
  /** @param {string} where */
  reminder: (where) => `Still waiting for you: ${where}`,
  /** @param {string} what @param {string} where */
  failedAlert: (what, where) => `Failed in ${where}: ${what}`,
  /** @param {number} c @param {string} command */
  suggestChip: (c, command) => `${contextAt(c)} · ${command}`,
  chips: {
    /** @param {number} n @param {number} failed */
    agents: (n, failed) => `${plural(n, "agent", "agents")}${failed ? ` · ${failed} failed` : ""}`,
    /** @param {number} n */
    results: (n) => plural(n, "result", "results"),
    /** @param {number} n */
    live: (n) => `${n} live`,
    more: "More",
  },
  /** @param {string} label @param {number} v @param {string} at when it resets, as a clock time */
  planChip: (label, v, at) => `${label} limit ${Math.round(v)}%${at ? ` · resets ${at}` : ""}`,
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
  keysHint: "oldest first · ↑ ↓ · 1–9 picks an option, Enter sends it · Ctrl+Enter sends · Enter goes to the session",
  /** @param {boolean} resultsToo */
  allClear: (resultsToo) => `${CLEAR}: ${clearRest(resultsToo)}.`,
  // The desk when nothing needs the developer: Needs you is one line, the sessions take the centre.
  quiet: {
    clear: CLEAR,
    rest: clearRest,
    /** @param {string} t */
    lastAnswer: (t) => `last answer ${t}`,
    lastAnswerTitle: "Past decisions, in History",
    /** @param {number} working @param {number} agents */
    sessionsAside: (working, agents) => [working && `${working} working`, agents && `${plural(agents, "agent", "agents")} at work`].filter(Boolean).join(" · "),
    earlierAside: "nothing new · seen earlier",
    allResults: "All results",
  },
  emptyResults: "Nothing new to review.",
  seeHistory: "Earlier results",
  dismissResult: "Seen, move it to the history",
  emptyRunning: "No sessions running.",
  now: NOW,
  go: "Go",
  next: "Next",
  asks: { question: "Asks you", waiting: "Asks you", permission: "Asks permission to" },
  itsMessage: "Its message, before the question",
  unfoldMessage: "Show the whole message",
  foldMessage: "Show less",
  options: "Options",
  pickSeveral: "Pick one or more",
  group: {
    /** @param {number} i @param {number} n */
    part: (i, n) => `Question ${i + 1} of ${n}`,
    /** @param {number} n @param {number} answered */
    waits: (n, answered) =>
      answered >= n ? `All ${n} answered.` : answered ? `${answered} of ${n} answered: its terminal waits for ${n - answered === 1 ? "the last one" : `the other ${n - answered}`}.` : `Asked together: its terminal waits for all ${n} answers.`,
    /** @param {number} n @param {number} answered */
    row: (n, answered) => (answered ? `${answered} of ${n} answered` : `${n} questions asked together`),
  },
  // Placeholders fit one line of a phone's box: the options above say the rest.
  answerPlaceholder: "Or your own answer…",
  replyPlaceholder: "Type your next instruction…",
  workingPlaceholder: "Write to it while it works…",
  sendHintWorking: "It reaches this session at its next step, exactly as written, as if typed in its terminal.",
  send: "Send to the session",
  sendShort: "Send",
  sending: "Sending…",
  sendKeys: "Ctrl+Enter sends.",
  optionKeys: "1–9 picks, Enter sends.",
  optionSends: "An option is sent as you choose it, exactly as written.",
  /** @param {string} option */
  answerWith: (option) => `Answer: ${option}`,
  sendHint: "It reaches this session exactly as written.",
  notListening: "This session is not listening for answers right now: answer in its terminal.",
  notListeningShort: "Answer in its terminal",
  workingNoMessages: "At work: use its terminal",
  attachImage: "Attach images",
  pasteImages: "Paste images to attach them.",
  attachedImage: "Attached image",
  removeImage: "Remove this image",
  attaching: "Attaching…",
  /** @param {number} n */
  tooManyImages: (n) => `At most ${n} images per message; the rest were left out.`,
  permission: {
    allow: "Allow",
    deny: "Deny",
    reason: "Reason for denying (optional)",
    hint: "Allow lets it run now. Deny stops it, with the reason written here if there is one.",
    keys: "Ctrl+Enter denies with this reason.",
    allowedLine: "Allowed",
    deniedLine: "Denied",
  },
  dismiss: "Dismiss",
  dismissTitle: "Remove from the list without answering (it goes to the history)",
  answered: "Answered",
  /** @param {string} where */
  newQuestion: (where) => `New question in ${where}`,
  arrival: {
    label: "New question",
    expand: "Expand",
    collapse: "Collapse",
    go: "Go",
    goTitle: "Show it in Needs you",
    dismiss: "Hide this notice: the question stays in Needs you",
    /** @param {number} n */
    more: (n) => `+${n} more`,
  },
  /** @param {string} where */
  newMessage: (where) => `New message from ${where}`,
  newBadge: "New message",
  markUnread: "Mark unread",
  markUnreadHint: "Keep it as a new message until you open it again",
  endedAsking: "It ended while asking",
  goneAsking: "Its process is gone: no answer reaches it",
  seenBadge: "Seen",
  /** @param {string} t */
  seenAt: (t) => `Opened at ${t}`,
  /** @param {string} names */
  waits: (names) => `waits for ${names}`,
  flow: "Flow",
  /** @param {string} t how long ago its turn ended */
  waitingForYou: (t) => `Waiting for you${t && t !== NOW ? ` · ${t}` : ""}`,
  /** @param {string} t */
  awaiting: (t) => `Finished${t === NOW ? " just now" : t ? ` ${t} ago` : ""} · waiting for your next instruction`,
  details: "Details",
  conversation: {
    whileWorking: "sent while it worked",
    /** @param {number} n @param {number} agents */
    steps: (n, agents) => `${n === 1 ? "1 message" : `${n} messages`} while it worked${agents ? ` · ${agents === 1 ? "1 agent" : `${agents} agents`}` : ""}`,
    openQuestion: "See it on the desk",
    /** @param {number} i @param {number} n */
    askOf: (i, n) => `${i} of ${n}`,
    working: "Its reply appears here when the turn ends. To write to it while it works, use its terminal.",
    /** @param {string} t */
    workingFor: (t) => (t && t !== NOW ? `Working for ${t}` : "Working"),
    /** @param {number} n */
    agentsAtWork: (n) => `Its turn ended; ${n === 1 ? "1 agent is" : `${n} agents are`} still at work`,
    /** Its agents not finished, of which `failed` failed. @param {number} n @param {number} failed */
    agentsLeft: (n, failed) => [n - failed && `${n - failed} still running`, failed && `${failed} failed`].filter(Boolean).join(" · "),
    session: "Session",
    you: "You",
    youDesk: "You, from the desk",
    delivered: "Delivered",
    /** @param {string} error */
    notSent: (error) => `Not sent: ${error}`,
    retry: "Retry",
    edit: "Edit",
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
    /** A key short enough that "Send" would double its button. @param {string} what */
    confirmShort: (what) => `${what}?`,
    /** @param {string} what @param {string} where */
    sent: (what, where) => `Sent ${what} to ${where}.`,
    session: "Session",
    end: "End session",
    endConfirm: "End the session?",
    endHint: "Stops its process, as closing its terminal would.",
    /** @param {string} where */
    ended: (where) => `Asked ${where} to end. It closes in a moment.`,
    forget: "Forget",
    forgetConfirm: "Forget it?",
    forgetHint: "Takes it off the desk now: what it still asks is dismissed; its results and decisions stay in History",
    /** @param {string} where */
    forgot: (where) => `Forgot ${where}. Its results and decisions stay in History.`,
  },
  /** @param {string} type */
  agentType: (type) => `${type} agent`,
  /** @param {string} what */
  now_: (what) => `now: ${what}`,
  /** @param {string} t */
  tookFor: (t) => `took ${t}`,
  timeline: {
    /** @param {string} t */
    now: (t) => `now ${t}`,
    /** @param {string} t */
    ended: (t) => `ended ${t}`,
    /** @param {string} from @param {string} to */
    bar: (from, to) => `${from} → ${to}`,
  },
  state: { needs: "Needs you", working: "Working", waiting: "Waiting on its job", blocked: "Blocked", idle: "Idle", done: "Done", failed: "Failed" },
  sessionWorking: "The session is working",
  failedAgent: "failed",
  /** @param {string} t */
  idleSince: (t) => `idle since ${t}`,
  context: contextAt,
  /** @param {string} t @param {number} done @param {number} failed */
  sinceSummary: (t, done, failed) => `Since ${t}: ${counts(done, failed)}.`,
  /** @param {number} done @param {number} failed */
  unseenSummary: (done, failed) => `Not reviewed: ${counts(done, failed)}.`,
  /** @param {string} t */
  nothingNew: (t) => `Nothing new since ${t}.`,
  nothingYet: "Nothing has finished yet.",
  away: {
    title: "While you were away",
    /** @param {string} t */
    since: (t) => `since ${t}`,
    /** @param {number} done @param {number} failed @param {number} answered */
    summary: (done, failed, answered) => [counts(done, failed), answered && `${answered} answered in the terminal`].filter(Boolean).join(", ") || "new questions",
    waits: COLS.needs,
    failed: "Failed",
    finished: "Finished",
    answered: "Answered in the terminal",
    /** @param {number} n */
    more: (n) => `+${n} more`,
    dismiss: "Dismiss this summary",
  },
  markSeen: "Mark all as seen",
  /** @param {string} free @param {string} projects */
  disk: (free, projects) => `Disk: ${free} free (${projects})`,
  /** @param {string} where @param {number} c */
  contextWarn: (where, c) => `${where}: ${contextAt(c)}`,
  limitForecast: {
    pace: { recent: "at this pace", window: "at its pace so far", usual: "at your usual pace" },
    /** @param {string} label @param {string} pace @param {string} out @param {string} reset clock times */
    out: (label, pace, out, reset) => `${label} limit: ${pace}, out around ${out} (resets ${reset})`,
    /** @param {string} label @param {string} pace @param {number} v @param {string} reset a clock time */
    high: (label, pace, v, reset) => `${label} limit: ${pace}, about ${v}% by its reset ${reset}`,
  },
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
  offline: {
    title: "Offline",
    /** @param {string} at */
    updated: (at) => `last update ${at}`,
    answer: "Offline: it can be sent once the desk answers again.",
    placeholder: "Offline",
    desk: "No connection to the desk: is \"agent-desk serve\" still running?",
    device: "This device has no connection.",
    refused: "This device is not allowed on this desk: sign in to Tailscale with the owner's account.",
    computer: "Can't reach the computer: it may be off or asleep, or Tailscale may be off on this device.",
  },
  /** @param {string} m */
  pageError: (m) => `Page error: ${m}`,
  backToConversation: "← Conversation",
  splitTitle: "Drag to resize the columns, or use ← →; double-click to reset",
  splitLabel: "Width of the sessions column",
  alerts: {
    title: "Notifications and sound",
    notify: "Desktop notifications",
    notifyHint: "When something needs you and this tab is not in view",
    blocked: "Blocked by the browser: allow notifications for this page in its site settings",
    unavailable: "This browser cannot show them",
    sound: "Sound",
    soundHint: "A short chime when a question or permission prompt arrives",
    failures: "Failures too",
    failuresHint: "Also notify when an agent or a result fails",
    push: "Notifications",
    pushHint: "On this phone, even when it is locked, while the desk's PIN is in: how many questions wait, never what they say",
    pushInstall: "Add the desk to the Home Screen first (Share → Add to Home Screen), then open it from there",
    pushDenied: "Notifications are not allowed for the desk: allow them in Settings → Notifications",
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
  zoomHintTouch: "Tap an image to zoom",
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
  underMinute: "< 1 min",
  /** @param {string} m */
  mode: (m) => `permission mode: ${m}`,
  /** @param {number} n */
  shells: (n) => plural(n, "background shell", "background shells"),
  /** @param {number} v */
  cost: (v) => `$${v.toFixed(2)}`,
  /** @param {number} n */
  tokens: (n) => `${n >= 1000 ? `${Math.round(n / 1000)}k` : n} tokens`,
  noAgents: "No agents recorded.",
  /** @param {string} t */
  svcSince: (t) => `up for ${t}`,
  unnamed: "session",
  history: {
    title: "History",
    search: "Search history",
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
    /** @param {number} n */
    more: (n) => `Show ${n} older`,
    today: "Today",
    yesterday: "Yesterday",
  },
  unlock: {
    title: "Enter your PIN",
    label: "PIN",
    placeholder: "PIN",
    submit: "Unlock",
    noConnection: "Can't reach the desk: check this device's connection and Tailscale, then try again.",
    wrong: "That PIN is not right. Try again.",
    tooMany: "Too many wrong PINs. Try again in 15 minutes.",
  },
  zoom: { in: "Zoom in", out: "Zoom out", fit: "Fit", previous: "Previous image (←)", next: "Next image (→)" },
};
