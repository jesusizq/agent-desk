// @ts-check
// What the page knows: the desk's state as last fetched, the page's own state, and the lookups on them.
import { color, distinctColors } from "./format.js";
import { TEXT } from "./text.js";

/** @typedef {import("../core/protocol.ts").DeskState} DeskState */
/** @typedef {import("../core/protocol.ts").Session} Session */
/** @typedef {import("../core/protocol.ts").Question} Question */
/** @typedef {import("../core/protocol.ts").Agent} Agent */
/** @typedef {import("../core/protocol.ts").AgentState} AgentState */
/** @typedef {import("../core/protocol.ts").Result} Result */
/** @typedef {import("../core/protocol.ts").ConversationEntry} ConversationEntry */
/** @typedef {AgentState | "needs"} DotState */

/** @param {string} name */
const unwired = (name) => () => {
  throw new Error(`page.${name} called before app.js wired it`);
};
/**
 * What the modules call back into above them (app.js wires it once every module is loaded), so no
 * module imports one that imports it: the page's drawing, and what follows each fetch of the state.
 */
export const page = {
  /** @type {(how?: { instant?: boolean }) => void} */ render: unwired("render"),
  /** @type {(how?: { instant?: boolean }) => void} */ renderView: unwired("renderView"),
  /** @type {() => void} */ renderPanel: unwired("renderPanel"),
  /** @type {() => void} */ noticeArrivals: unwired("noticeArrivals"),
  /** @type {() => void} */ renewPush: unwired("renewPush"),
};

// The most images one answer or message carries, as the server allows (ATTACHED_IMAGES_MAX in protocol.ts).
export const ATTACHED_IMAGES_MAX = 10;

export const CONTEXT_WARN = 80;
export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// Opened from another device (through Tailscale), a terminal on this machine cannot be brought forward.
export const ON_THIS_MACHINE = ["127.0.0.1", "localhost"].includes(location.hostname);

export const secret = document.querySelector('meta[name="agent-desk-secret"]')?.getAttribute("content") ?? "";

/**
 * Something the developer sent from a session's conversation, shown there as a chat app shows it:
 * sending, delivered, or not sent with the error and a way to send it again. `before` is how many
 * messages from the desk with its text the conversation held when it was sent, to tell when the
 * conversation fetched holds it. `fromBox`: its text left the box for the conversation as it was sent.
 * @typedef {{ id: string, key: string, sid: string, text: string, images: string[], state: "sending" | "sent" | "failed", error?: string, before: number, sentAt?: number, fromBox?: boolean }} Outgoing
 */

/** @typedef {"agents" | "results" | "services" | "more"} PanelPart */

/** @type {DeskState} */
export let data = { sessions: [], questions: [], agents: [], results: [], services: [], metrics: [], seen: undefined, problems: [], now: new Date().toISOString(), gone: [], listening: [], disk: [], planForecasts: [], projects: [], build: "" };
/** @type {Map<string, string>} */
let projectColors = new Map();
/** @param {DeskState} next */
export function setData(next) {
  data = next;
  // Projects keep their colour as new ones arrive: the oldest session of each decides its turn.
  const firstSeen = new Map();
  for (const s of [...next.sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) if (!firstSeen.has(s.project.name)) firstSeen.set(s.project.name, s.startedAt);
  projectColors = distinctColors([...firstSeen.keys()]);
}
/** A project's colour on the desk, different from every other project's while the palette lasts. @param {string} name */
export const projectColor = (name) => projectColors.get(name) ?? color(name);

export const ui = {
  view: /** @type {"desk" | "history"} */ ("desk"),
  /** @type {string | null} */ project: null,
  hq: "",
  hfilter: /** @type {"all" | "decision" | "result"} */ ("all"),
  /** how many history entries are drawn; more are drawn on demand */ hshown: 0,
  /** @type {string | null} the item shown large (itemKey) */ sel: null,
  /** @type {Map<string, string>} */ drafts: new Map(),
  /** @type {Map<string, string[]>} ids of the images attached to each draft */ draftImages: new Map(),
  /** @type {Map<string, number>} images of each draft still on their way to the store */ uploading: new Map(),
  /** @type {Set<string> | null} */ known: null,
  /** @type {Map<string, string> | null} when each session last said something, to notice new messages */ heardAt: null,
  /** @type {Map<string, string>} the message each session was last marked read for; a failure is not retried in a loop */ readFor: new Map(),
  /** what the session panel showed when it was last drawn */ panelDrawn: "",
  /** when the developer last scrolled or touched the session panel */ panelTouchedAt: 0,
  /** @type {number | undefined} a redraw of the panel put off while it is scrolled */ panelLater: undefined,
  /** @type {Set<string>} */ sending: new Set(),
  /** @type {Map<string, Outgoing>} what was sent from a session's conversation, shown there until the conversation holds it */ outbox: new Map(),
  /** the session panel scrolls to its newest message at its next drawing */ panelToEnd: false,
  /** @type {string[]} questions that arrived out of sight, as items, oldest first: the arrival bubble shows the last */ arrivals: [],
  /** the arrival bubble shows its question whole, to answer it there */ arrivalOpen: false,
  /** @type {string | null} a question that arrived in the open session panel, to draw coming in */ panelArrival: null,
  /** a part of the bubble's question answered with the keys: the part still open takes the focus */ arrivalFocus: false,
  /** @type {Map<string, number>} questions answered from the desk, shown answered on their card until then */ resolved: new Map(),
  /** @type {string | null} a question answered with the keys: the box that replaces it takes the focus */ focusAfter: null,
  /** @type {{ key: string, until: number } | null} the session control waiting for its confirming click */ armed: null,
  /** @type {Set<string>} sessions whose agents at work are unfolded in the session panel */ agentsOpen: new Set(),
  /** @type {Set<string>} questions already brought up a second time */ reminded: new Set(),
  /** @type {Set<string>} questions whose long context is unfolded */ contextOpen: new Set(),
  /** @type {Set<string>} runs of messages between tool calls unfolded, by their first message */ stepsOpen: new Set(),
  /** @type {Set<string> | null} failures already noticed */ failuresSeen: null,
  offline: false,
  /** the desk answered that this device is not allowed */ refused: false,
  /** @type {string | null} when the desk shown was saved on this device, while the computer does not answer */ savedAt: null,
  /** @type {string | null} when the desk shown was last the desk's own, fresh or saved */ updatedAt: null,
  loaded: false,
  /** @type {string | null} the session shown in the side panel */ panelSession: null,
  /** @type {string | null} what the panel's session had said when its conversation was fetched */ panelHeard: null,
  /** @type {PanelPart | null} the part of the session panel unfolded under its chips */ panelPart: null,
  /** @type {string | null} the item the session panel shows, when its session asks several things */ panelAsk: null,
  /** which part of the desk a phone shows; History is the history view */ tab: /** @type {"inbox" | "sessions" | "review"} */ ("inbox"),
  /** @type {Map<string, number>} where each tab of the phone's tab bar was scrolled when left */ tabScroll: new Map(),
  /** @type {Set<string>} questions whose earlier conversation is unfolded */ unfolded: new Set(),
  /** @type {Map<string, ConversationEntry[]>} */ conversations: new Map(),
};

/** @param {string} id */
export const S = (id) => data.sessions.find((s) => s.id === id);
/** The session said something the developer has not opened yet. @param {Session} s */
export const unread = (s) => !!s.lastMessage && (!s.readAt || s.readAt < s.lastMessage.at);

/** @param {string} sid @param {string} name */
export const agentOf = (sid, name) => data.agents.find((a) => a.sessionId === sid && a.name === name);
/** @param {string} sid */
export const metricsOf = (sid) => data.metrics.find((m) => m.sessionId === sid);
/** @param {Agent} a */
export const waitingOn = (a) => (a.state === "blocked" ? a.after.filter((n) => agentOf(a.sessionId, n)?.state !== "done") : []);

/** @param {Session} s */
export const sessionName = (s) => s.title ?? `${TEXT.unnamed} ${s.id.slice(0, 6)}`;
/** "project › session", the one way a session is named on the page. @param {Session | undefined} s */
export const label = (s) => (s ? `${s.project.name} › ${sessionName(s)}` : "?");

/** @param {string} sid */
export const inProject = (sid) => ui.project === null || S(sid)?.project.name === ui.project;
const openQuestions = () => data.questions.filter((q) => q.status === "open" && inProject(q.sessionId));
/**
 * What waits for the developer as one thing: a question, or the questions a session asked together,
 * all of which it waits for. @typedef {{ key: string, questions: Question[], open: Question[] }} Item
 */
/** @param {Question} q */
export const itemKey = (q) => (q.group ? `g-${q.group.id}` : q.id);
/** The item a question belongs to, with all its questions in the order asked. @param {Question} q @returns {Item} */
export function itemOf(q) {
  const group = q.group?.id;
  const questions = group ? data.questions.filter((x) => x.sessionId === q.sessionId && x.group?.id === group).sort((a, b) => (a.group?.index ?? 0) - (b.group?.index ?? 0)) : [q];
  return { key: itemKey(q), questions, open: questions.filter((x) => x.status === "open") };
}
/** Open questions as items, in their order, one per group. @param {Question[]} open */
export function itemsOf(open) {
  const keys = new Set();
  return open.filter((q) => !keys.has(itemKey(q)) && keys.add(itemKey(q))).map(itemOf);
}
export const openItems = () => itemsOf(openQuestions());
/** @param {Result} r */
export const isNew = (r) => !r.seenAt && (!data.seen || r.at > data.seen.since);
/** @param {Session} s */
export const isLive = (s) => s.state !== "ended" && !data.gone.includes(s.id);
/** Ended with a question open and not looked at since: its question must not vanish unseen. @param {Session} s */
export const endedUnseen = (s) => s.state === "ended" && s.endedAsking === true && unread(s);

/** Finished work to look at, in the projects shown; failures wait in the inbox instead. */
export const toReview = () => data.results.filter((r) => inProject(r.sessionId) && isNew(r) && r.status !== "failed");
/** What a session asks that is still open, in the order asked. @param {string} sid */
export const asksOf = (sid) => data.questions.filter((q) => q.status === "open" && q.sessionId === sid);
/** On the desk: it runs, or its process is gone while it still asks or ended unseen, so what it asked can be forgotten with it. @param {Session} s */
export const onDesk = (s) => isLive(s) || endedUnseen(s) || asksOf(s.id).length > 0;

/** An answer or message is on its way to the desk, or an image to the store: leaving now would lose it. */
export const inFlight = () => ui.sending.size > 0 || [...ui.uploading.values()].some((n) => n > 0);

/** Answered from the desk a moment ago, or its answer on its way: where it shows, it says so before it goes. @param {Question} q */
export const answeredNow = (q) => ui.sending.has(`answer-${q.id}`) || (ui.resolved.get(q.id) ?? 0) > Date.now();

/** @param {string} key */
export function itemByKey(key) {
  const q = data.questions.find((x) => itemKey(x) === key);
  return q ? itemOf(q) : undefined;
}

/**
 * Everything that waits for the developer, in the order to deal with it: questions and permission
 * prompts oldest first, then failures not looked at yet. A session that finished with a report and
 * asked nothing is not here: its card under Sessions marks the message as new.
 */
export function inbox() {
  const questions = openQuestions();
  const failures = data.results.filter((r) => inProject(r.sessionId) && isNew(r) && r.status === "failed").sort((a, b) => a.at.localeCompare(b.at));
  // Counted by question, as a phone's push counts them: questions asked together wait for an answer each.
  return { items: itemsOf(questions), failures, count: questions.length + failures.length };
}
