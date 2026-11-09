// @ts-check
// The desk page: polls the store through the local server and renders it. All strings live in text.js.
import { byId, dialog, h, icon, md, mdBlocks, on, onKept, patch, svgEl } from "./dom.js";
import { animateLists, bump, fadeIn, grow } from "./motion.js";
import { TEXT } from "./text.js";

// The most images one answer or message carries, as the server allows (ATTACHED_IMAGES_MAX in protocol.ts).
const ATTACHED_IMAGES_MAX = 10;

/** @typedef {import("../core/protocol.ts").DeskState} DeskState */
/** @typedef {import("../core/protocol.ts").Session} Session */
/** @typedef {import("../core/protocol.ts").Question} Question */
/** @typedef {import("../core/protocol.ts").Agent} Agent */
/** @typedef {import("../core/protocol.ts").Result} Result */
/** @typedef {import("../core/protocol.ts").Metrics} Metrics */
/** @typedef {import("../core/protocol.ts").AgentState} AgentState */
/** @typedef {import("../core/protocol.ts").ProjectScan} ProjectScan */
/** @typedef {import("../core/protocol.ts").ConversationEntry} ConversationEntry */
/** @typedef {import("../core/protocol.ts").Worktree} Worktree */
/** @typedef {AgentState | "needs"} DotState */

const POLL_MS = 1500;
const TICK_MS = 30_000;
const WARM_AFTER = 30;
const HOT_AFTER = 120;
const CONTEXT_WARN = 80;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PALETTE = ["#6366f1", "#14b8a6", "#f59e0b", "#ec4899", "#0ea5e9", "#84cc16", "#a855f7", "#d946ef"];
const ATTENTION = ["failed", "blocked", "idle", "working", "waiting", "done"];
const LEGEND = /** @type {const} */ (["needs", "working", "waiting", "blocked", "idle", "failed", "done"]);

/** How to bring a session's terminal to the front, per terminal program (TERM_PROGRAM). */
const SESSION_LINKS = /** @type {Record<string, (id: string) => string>} */ ({
  vscode: (id) => `vscode://agent-desk.agent-desk/focus?session=${encodeURIComponent(id)}`,
});
// Opened from another device (through Tailscale), a terminal on this machine cannot be brought forward.
const ON_THIS_MACHINE = ["127.0.0.1", "localhost"].includes(location.hostname);
const TERMINAL_NAMES = /** @type {Record<string, string>} */ ({ vscode: "VS Code" });

const secret = document.querySelector('meta[name="agent-desk-secret"]')?.getAttribute("content") ?? "";

/** @type {DeskState} */
let data = { sessions: [], questions: [], agents: [], results: [], services: [], metrics: [], seen: undefined, problems: [], now: new Date().toISOString(), gone: [], listening: [], disk: [], planForecasts: [], projects: [], build: "" };

const ui = {
  view: /** @type {"desk" | "history"} */ ("desk"),
  /** @type {string | null} */ project: null,
  hq: "",
  hfilter: /** @type {"all" | "decision" | "result"} */ ("all"),
  /** @type {string | null} */ sel: null,
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
  /** @type {Map<string, number>} questions answered from the desk, shown answered on their card until then */ resolved: new Map(),
  /** @type {{ key: string, until: number } | null} the session control waiting for its confirming click */ armed: null,
  /** @type {Set<string>} sessions whose agents at work are unfolded in the session panel */ agentsOpen: new Set(),
  /** @type {Set<string>} questions already brought up a second time */ reminded: new Set(),
  /** @type {Set<string>} questions whose long context is unfolded */ contextOpen: new Set(),
  /** @type {Set<string>} runs of messages between tool calls unfolded, by their first message */ stepsOpen: new Set(),
  /** @type {Set<string> | null} failures already noticed */ failuresSeen: null,
  offline: false,
  /** the desk answered that this device is not allowed */ refused: false,
  /** @type {string | null} when the desk shown was saved on this device, while the computer does not answer */ savedAt: null,
  loaded: false,
  /** @type {string | null} the session shown in the side panel */ panelSession: null,
  /** @type {string | null} what the panel's session had said when its conversation was fetched */ panelHeard: null,
  /** @type {PanelPart | null} the part of the session panel unfolded under its chips */ panelPart: null,
  /** which part of the desk a phone shows; History is the history view */ tab: /** @type {"inbox" | "sessions" | "review"} */ ("inbox"),
  /** @type {Set<string>} questions whose earlier conversation is unfolded */ unfolded: new Set(),
  /** @type {Map<string, ConversationEntry[]>} */ conversations: new Map(),
};

// ---------- Lookups and formatting ----------
/** @param {string} id */
const S = (id) => data.sessions.find((s) => s.id === id);
/** The session said something the developer has not opened yet. @param {Session} s */
const unread = (s) => !!s.lastMessage && (!s.readAt || s.readAt < s.lastMessage.at);
/** The first line of a message, without Markdown markers. @param {string} text */
const firstLine = (text) => (text.split("\n").map((l) => l.trim()).find(Boolean) ?? "").replace(/^(?:#+|[-*>]|\d+[.)])\s+/, "").replace(/\*\*|`/g, "");
/** @param {string} sid @param {string} name */
const agentOf = (sid, name) => data.agents.find((a) => a.sessionId === sid && a.name === name);
/** @param {string} sid */
const metricsOf = (sid) => data.metrics.find((m) => m.sessionId === sid);
/** @param {Agent} a */
const waitingOn = (a) => (a.state === "blocked" ? a.after.filter((n) => agentOf(a.sessionId, n)?.state !== "done") : []);
/** @param {string} text */
const color = (text) => PALETTE[[...text].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length] ?? "#6366f1";
/** @param {string} iso */
const hm = (iso) => new Date(iso).toTimeString().slice(0, 5);
/** @param {string} iso @param {number} [to] */
const minutes = (iso, to = Date.now()) => Math.max(0, Math.round((to - Date.parse(iso)) / 60000));
/** @param {number} m */
function duration(m) {
  return m < 1 ? TEXT.now : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
/** @param {string} iso @param {string} [until] */
const ago = (iso, until) => duration(minutes(iso, until ? Date.parse(until) : Date.now()));
/** @param {string} iso */
const heat = (iso) => {
  const m = minutes(iso);
  return m >= HOT_AFTER ? " hot" : m >= WARM_AFTER ? " warm" : "";
};
/** @param {number} bytes */
const gb = (bytes) => (bytes > 0 && bytes < 0.05e9 ? "< 0.1 GB" : `${(bytes / 1e9).toFixed(1)} GB`);
/** @param {Session} s */
const sessionName = (s) => s.title ?? `${TEXT.unnamed} ${s.id.slice(0, 6)}`;
/** "project › session", the one way a session is named on the page. @param {Session | undefined} s */
const label = (s) => (s ? `${s.project.name} › ${sessionName(s)}` : "?");
/** @param {string} provider */
const providerMark = (provider) =>
  provider.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase() || "?";
/** @param {string} sid */
const inProject = (sid) => ui.project === null || S(sid)?.project.name === ui.project;
const openQuestions = () => data.questions.filter((q) => q.status === "open" && inProject(q.sessionId));
/** @param {Result} r */
const isNew = (r) => !r.seenAt && (!data.seen || r.at > data.seen.since);
/** @param {Session} s */
const isLive = (s) => s.state !== "ended" && !data.gone.includes(s.id);
/** Ended with a question open and not looked at since: its question must not vanish unseen. @param {Session} s */
const endedUnseen = (s) => s.state === "ended" && s.endedAsking === true && unread(s);

// ---------- Small pieces ----------
/** @param {DotState} st */
const dot = (st) => h("span", { class: `dot st-${st}`, title: TEXT.state[st] });
/** @param {keyof typeof TEXT.kinds} kind */
const badge = (kind) => h("span", { class: `badge k-${kind}` }, TEXT.kinds[kind]);
/** @param {string} iso */
const beacon = (iso) => h("span", { class: `beacon${heat(iso)}`, "aria-hidden": "true" });
/** @param {string} c */
function tagIcon(c) {
  const i = icon("tag", "tag");
  i.style.setProperty("--g", c);
  return i;
}
/** A project's tag and name, both in the project's colour. @param {string} name @param {string} [cls] */
function projectMark(name, cls = "pname") {
  const c = color(name);
  const n = h("span", { class: cls }, name);
  n.style.setProperty("--g", c);
  return [tagIcon(c), n];
}
/** @param {Session | undefined} s @param {string} [name] */
function where(s, name) {
  if (!s) return h("span", { class: "where" }, "?");
  const mark = h("span", { class: "prov", title: s.provider }, providerMark(s.provider));
  mark.style.setProperty("--p", color(s.provider));
  return h("span", { class: "where" }, projectMark(s.project.name), h("span", { class: "sep" }, "›"), mark, name ?? sessionName(s));
}
/** @param {number} v */
function bar(v) {
  const fill = h("i", {});
  fill.style.width = `${Math.min(100, Math.max(0, v))}%`;
  return h("span", { class: `mini${v >= CONTEXT_WARN ? " warn" : ""}` }, fill);
}
/** @param {string} msg */
function toast(msg) {
  const box = byId("toasts");
  const t = h("div", { class: "toast" }, msg);
  box.append(t);
  // Re-shown each time so it sits above any open dialog in the browser's top layer.
  if (box.matches(":popover-open")) box.hidePopover();
  box.showPopover();
  grow(t); // the toasts above it slide up instead of jumping
  setTimeout(() => t.classList.add("leaving"), 3400);
  setTimeout(() => {
    t.remove();
    if (!box.childElementCount && box.matches(":popover-open")) box.hidePopover();
  }, 3600);
}
/** @param {string} text */
function copy(text) {
  const lines = text.split("\n");
  const shown = (lines[0] ?? "").length > 80 || lines.length > 1 ? `${(lines[0] ?? "").slice(0, 79)}…` : text;
  navigator.clipboard.writeText(text).then(
    () => toast(TEXT.copied(shown)),
    (/** @type {Error} */ e) => toast(e.message),
  );
}
// A command or path in session text is copied with a click, before the card around it opens;
// a click that ends a text selection leaves the selection alone.
document.addEventListener("click", (e) => {
  const code = e.target instanceof Element ? e.target.closest("[data-copy]") : null;
  if (!code || !document.getSelection()?.isCollapsed) return;
  e.stopPropagation();
  copy(code.textContent ?? "");
}, true);
const LOCAL_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?=[:/]|$)/;
/**
 * A link to a local preview. From another device localhost is that device, so the preview is only
 * named there, as running on the computer. @param {string} url @param {Child} content @param {string} [cls]
 */
function localLink(url, content, cls) {
  if (ON_THIS_MACHINE || !LOCAL_URL.test(url)) return h("a", { class: cls, href: url, target: "_blank", rel: "noopener noreferrer" }, content);
  return h("span", { class: "faint", title: url }, TEXT.onComputer(url.replace(/^https?:\/\//, "").replace(/\/$/, "")));
}

/** The link that brings a session's terminal to the front, or why there is none. @param {Session | undefined} s */
function sessionLink(s) {
  if (!ON_THIS_MACHINE) return { href: null, why: TEXT.remoteNoLink };
  if (!s || !ID.test(s.id)) return { href: null, why: TEXT.noTerminal };
  if (!s.terminal) return { href: null, why: TEXT.noTerminal };
  const build = SESSION_LINKS[s.terminal];
  return build ? { href: build(s.id), why: TEXT.goToTitle(label(s)) } : { href: null, why: TEXT.noLink(s.terminal) };
}
/** @param {Session | undefined} s @param {string} cls @param {Child[]} content */
function goLink(s, cls, ...content) {
  if (!ON_THIS_MACHINE) return null; // its terminal is on the computer, not on this device
  const { href, why } = sessionLink(s);
  if (!href) return h("button", { class: cls, disabled: true, title: why }, ...content);
  return h("a", { class: cls, href, title: why, onclick: (e) => e.stopPropagation() }, ...content);
}

// ---------- Server ----------
const LOCKED_HEADER = "X-Agent-Desk-Locked";
const DRAFTS_KEY = "agent-desk:drafts";
/** Longer than the service worker's wait (sw.js), so its saved copy arrives first when there is one. */
const NO_ANSWER_MS = 8000;

/** What is being written stays on this device: a phone may close the app, and the desk may reload it. */
function saveDrafts() {
  const drafts = [...ui.drafts].filter(([, text]) => text);
  const images = [...ui.draftImages].filter(([, ids]) => ids.length);
  if (drafts.length || images.length) localStorage.setItem(DRAFTS_KEY, JSON.stringify({ drafts, images }));
  else localStorage.removeItem(DRAFTS_KEY);
}
const savedDrafts = localStorage.getItem(DRAFTS_KEY);
if (savedDrafts !== null) {
  try {
    const kept = /** @type {{ drafts: [string, string][], images: [string, string[]][] }} */ (JSON.parse(savedDrafts));
    ui.drafts = new Map(kept.drafts);
    ui.draftImages = new Map(kept.images);
  } catch (error) {
    localStorage.removeItem(DRAFTS_KEY);
    toast(TEXT.pageError(`saved drafts unreadable, dropped: ${/** @type {Error} */ (error).message}`));
  }
}
/** Drafts for a question already closed or a session already gone have nowhere to go. */
function dropStaleDrafts() {
  for (const key of [...ui.drafts.keys(), ...ui.draftImages.keys()]) {
    const alive = data.questions.some((q) => q.status === "open" && key === `answer-${q.id}`) || data.sessions.some((s) => key === `message-${s.id}`);
    if (alive) continue;
    ui.drafts.delete(key);
    ui.draftImages.delete(key);
  }
  saveDrafts();
}

/** The unlock ended (12 hours): the reload brings the PIN page, and the same view after it. @param {Response} res */
const needsPin = (res) => res.status === 401 && res.headers.has(LOCKED_HEADER);

/** A write to the desk; no connection is said as such, not as fetch's own "Load failed". @param {string} route @param {RequestInit} init */
async function write(route, init) {
  const res = await fetch(route, init).catch(() => {
    throw new Error(offlineReason());
  });
  if (needsPin(res)) location.reload();
  return res;
}

/** Why the desk does not answer, as far as this device can tell. */
function offlineReason() {
  if (ui.refused) return TEXT.offline.refused;
  return ON_THIS_MACHINE ? TEXT.offline.desk : navigator.onLine ? TEXT.offline.computer : TEXT.offline.device;
}
function offlineText() {
  return ui.savedAt ? `${offlineReason()} ${TEXT.offline.saved(dayLabel(ui.savedAt))}` : offlineReason();
}

/** @param {string} route @param {unknown} [body] */
async function post(route, body = {}) {
  const res = await write(route, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-Desk-Secret": secret },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = /** @type {{ error?: string }} */ (await res.json().catch(() => ({})));
    throw new Error(detail.error ?? `${res.status} ${res.statusText}`);
  }
  await refresh();
}

let etag = "";
/** @type {string | null} */
let loadedBuild = null;
let latestRequest = 0;
let requestsWaiting = 0;
const SAVED_AT = "X-Agent-Desk-Saved-At";
async function refresh() {
  const request = ++latestRequest;
  /** @type {string | null} */
  let savedAt = null;
  /** @type {DeskState | null} */
  let next = null;
  requestsWaiting++;
  try {
    const res = await fetch("/api/state", { headers: etag ? { "If-None-Match": etag } : {}, signal: AbortSignal.timeout(NO_ANSWER_MS) });
    if (needsPin(res)) return location.reload();
    ui.refused = res.status === 421;
    savedAt = res.headers.get(SAVED_AT);
    if (res.status !== 304) {
      if (!res.ok) throw new Error(`${res.status}`);
      next = /** @type {DeskState} */ (await res.json());
      if (request === latestRequest && !savedAt) etag = res.headers.get("ETag") ?? "";
    }
  } catch {
    if (request === latestRequest) setOffline(true); // shown in the strip; polling continues
    return;
  } finally {
    requestsWaiting--;
  }
  if (request !== latestRequest) return; // a newer request answers instead; this one may be stale
  ui.savedAt = savedAt;
  if (savedAt) {
    // The computer does not answer and the device shows the desk it saved (sw.js): read only.
    if (next) {
      data = { ...next, listening: [] };
      ui.loaded = true;
    }
    return setOffline(true, true);
  }
  renewPush();
  if (next) {
    if (loadedBuild === null) {
      loadedBuild = next.build;
      data = next;
      dropStaleDrafts();
    } else if (next.build !== loadedBuild) return location.reload(); // the desk restarted, maybe with new code
    data = next;
    ui.loaded = true;
    noticeArrivals();
  }
  setOffline(false, next !== null);
}

/** @param {boolean} offline @param {boolean} [changed] */
function setOffline(offline, changed = false) {
  if (offline === ui.offline && !changed) return;
  ui.offline = offline;
  render();
}

function noticeArrivals() {
  const open = data.questions.filter((q) => q.status === "open");
  if (ui.known === null) {
    ui.known = new Set(open.map((q) => q.id));
    // What already waits long when the page opens is in sight: no reminder for it.
    for (const q of open) if (Date.now() - Date.parse(q.askedAt) >= REMIND_MS) ui.reminded.add(q.id);
    ui.failuresSeen = new Set(failures());
    return;
  }
  noticeFailures();
  let chimed = false;
  for (const q of open) {
    if (ui.known.has(q.id)) continue;
    ui.known.add(q.id);
    const where = label(S(q.sessionId));
    toast(TEXT.newQuestion(where));
    if (!chimed) chime();
    chimed = true;
    bump(byId("needs-pill"));
    notify(TEXT.newQuestion(where), q.text, q.id, () => {
      ui.view = "desk";
      ui.sel = q.id;
      render();
    });
  }
  noticeMessages();
}

// A question unanswered this long is brought up once more, in case the first call was missed.
const REMIND_MS = 15 * 60_000;
function remindWaiting() {
  if (ui.known === null) return;
  for (const q of data.questions) {
    if (q.status !== "open" || ui.reminded.has(q.id) || Date.now() - Date.parse(q.askedAt) < REMIND_MS) continue;
    ui.reminded.add(q.id);
    const where = label(S(q.sessionId));
    toast(TEXT.reminder(where));
    chime();
    notify(TEXT.reminder(where), q.text, `again-${q.id}`, () => {
      ui.view = "desk";
      ui.sel = q.id;
      render();
    });
  }
}

/** Keys of what has failed: results, and agents (by session and name). */
const failures = () => [...data.results.filter((r) => r.status === "failed").map((r) => `r ${r.id}`), ...data.agents.filter((a) => a.state === "failed").map((a) => `a ${a.sessionId} ${a.name}`)];

/** A new failure, when the developer asked to hear of failures too (off by default: they need no answer). */
function noticeFailures() {
  const seen = (ui.failuresSeen ??= new Set(failures()));
  for (const key of failures()) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (!alertOn("failures")) continue;
    const [kind, a, b] = key.split(" ");
    const result = kind === "r" ? data.results.find((r) => r.id === a) : undefined;
    const agent = kind === "a" ? data.agents.find((x) => x.sessionId === a && x.name === b) : undefined;
    const sid = result?.sessionId ?? agent?.sessionId ?? "";
    const what = result?.title ?? agent?.goal ?? agent?.name ?? "";
    toast(TEXT.failedAlert(what, label(S(sid))));
    chime();
    notify(TEXT.failedAlert(what, label(S(sid))), result?.summary ?? agent?.activity ?? "", key, () => (result ? openResult(result) : openSession(sid)));
  }
}

/**
 * A session that finished and wrote something new, without asking (questions are noticed above),
 * gets a toast, unless its panel is open and in view; no desktop notification, as it needs no answer.
 */
function noticeMessages() {
  const first = ui.heardAt === null;
  const heardAt = (ui.heardAt ??= new Map());
  for (const s of data.sessions) {
    const at = s.lastMessage?.at;
    if (!at || heardAt.get(s.id) === at) continue;
    heardAt.set(s.id, at);
    if (first || !unread(s) || data.questions.some((q) => q.status === "open" && q.sessionId === s.id)) continue;
    if (ui.panelSession === s.id && dialog("session").open && !document.hidden) continue;
    toast(TEXT.newMessage(label(s)));
  }
}

/** A desktop notification while the page is hidden, when the developer allowed them. @param {string} title @param {string} body @param {string} tag @param {() => void} open */
function notify(title, body, tag, open) {
  // A phone is told by the push alone: the permission push needs would also put the question's text on its lock screen.
  if (!ON_THIS_MACHINE || !document.hidden || !alertOn("notify") || !("Notification" in window) || Notification.permission !== "granted") return;
  const n = new Notification(title, { body: body.slice(0, 200), tag });
  n.onclick = () => {
    window.focus();
    open();
  };
}

// In one column (a phone) the large card sits above the queue, maybe off screen. Same query as style.css.
const ONE_COLUMN = matchMedia("(max-width: 700px), (max-height: 500px)");
/** A finger, not a mouse: no hover, and a focused box raises a keyboard. */
const COARSE = matchMedia("(pointer: coarse)");
/** @param {ScrollLogicalPosition} [block] */
function revealNext(block = "nearest") {
  if (ONE_COLUMN.matches) document.querySelector(".next")?.scrollIntoView({ block });
}
/** The large card is on screen (not in a hidden tab) and already at its top, from an earlier tap on the pill. */
function nextCardAtTop() {
  const card = document.querySelector(".next");
  if (!card || !card.getClientRects().length) return false;
  const top = card.getBoundingClientRect().top;
  return top > -40 && top < 60;
}

// ---------- Header and strip ----------
function renderHeader() {
  const n = inbox().count;
  const views = byId("views");
  views.setAttribute("aria-label", TEXT.viewsLabel);
  patch(
    views,
    ...(/** @type {const} */ ([["desk", "board"], ["history", "clock"]])).map(([v, ic]) =>
      h("button", { "aria-pressed": String(ui.view === v), "aria-label": TEXT.views[v], onclick: () => ((ui.view = v), render()) }, icon(ic), h("span", { class: "lbl" }, TEXT.views[v])),
    ),
  );
  // A project is offered while one of its sessions runs or still has something for the developer.
  const current = (/** @type {Session} */ s) => isLive(s) || endedUnseen(s) || data.questions.some((q) => q.status === "open" && q.sessionId === s.id) || data.results.some((r) => r.sessionId === s.id && isNew(r));
  const names = [...new Set(data.sessions.filter(current).map((s) => s.project.name))].sort();
  if (ui.project !== null && !names.includes(ui.project)) ui.project = null;
  const projects = byId("projects");
  projects.setAttribute("aria-label", TEXT.projectsLabel);
  projects.hidden = names.length < 2;
  patch(
    projects,
    ...[null, ...names].map((name) =>
      h("button", { "data-key": name ?? "", "aria-pressed": String(ui.project === name), onclick: () => ((ui.project = name), render()) }, name ? projectMark(name) : TEXT.allProjects),
    ),
  );
  const pill = byId("needs-pill");
  // Before the first data, a placeholder: "Nothing pending" would be a false all-clear.
  pill.classList.toggle("loading", !ui.loaded);
  pill.classList.toggle("zero", ui.loaded && !n);
  pill.toggleAttribute("aria-busy", !ui.loaded);
  if (!ui.loaded) patch(pill, h("span", { class: "skel" }));
  else patch(pill, n ? h("span", { class: "beacon on-accent", "aria-hidden": "true" }) : null, TEXT.needsPill(n));
  pill.onclick = () => {
    const list = openQuestions();
    // In one column the first tap brings the oldest question into view; each further tap moves on to the next one.
    if (ONE_COLUMN.matches && ui.view === "desk" && ui.tab === "inbox" && list.length > 1 && nextCardAtTop()) {
      const i = list.findIndex((q) => q.id === ui.sel);
      ui.sel = list[(i + 1) % list.length]?.id ?? null;
      renderView();
      return revealNext("start");
    }
    ui.view = "desk";
    ui.tab = "inbox";
    ui.sel = list[0]?.id ?? null;
    render();
    revealNext(ONE_COLUMN.matches ? "start" : "nearest");
  };
  const q = /** @type {HTMLInputElement} */ (byId("q"));
  q.placeholder = TEXT.search;
  q.setAttribute("aria-label", TEXT.search);
  // History has its own search box; the header's only leads there.
  const headerSearch = q.closest(".search");
  if (headerSearch instanceof HTMLElement) headerSearch.hidden = ui.view === "history";
  document.title = n ? `(${n}) ${TEXT.appName}` : TEXT.appName;
  appBadge(n);
  renderTabbar(n);
}

let badgeShown = -1;
/** The count on the icon of the desk installed as an app, like the title's. @param {number} n */
function appBadge(n) {
  if (n === badgeShown || !("setAppBadge" in navigator)) return;
  badgeShown = n;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); // refused outside an installed app or without notification permission; the title still counts
}

/** On a phone, the parts of the desk and the history sit in a bar at the bottom, under the thumb. @param {number} needs */
function renderTabbar(needs) {
  const review = data.results.filter((r) => inProject(r.sessionId) && isNew(r) && r.status !== "failed").length;
  /** @type {[typeof ui.tab | "history", import("./dom.js").IconName, number, string][]} */
  const tabs = [
    ["inbox", "inbox", needs, "accent"],
    ["sessions", "terminal", 0, ""],
    ["review", "image", review, "review"],
    ["history", "clock", 0, ""],
  ];
  const current = ui.view === "history" ? "history" : ui.tab;
  patch(
    byId("tabbar"),
    tabs.map(([key, ic, count, tone]) =>
      h(
        "button",
        {
          "aria-pressed": String(current === key),
          onclick: () => {
            if (key === "history") ui.view = "history";
            else ((ui.view = "desk"), (ui.tab = key));
            render();
            window.scrollTo(0, 0);
          },
        },
        icon(ic),
        h("span", {}, TEXT.tabbar[key]),
        count ? h("span", { class: `tcount ${tone}` }, count) : null,
      ),
    ),
  );
}

function renderStrip() {
  const since = data.seen?.since ?? null;
  const fresh = data.results.filter((r) => inProject(r.sessionId) && isNew(r));
  const failed = fresh.filter((r) => r.status === "failed").length;
  const summary = fresh.length
    ? since
      ? TEXT.sinceSummary(hm(since), fresh.length - failed, failed)
      : TEXT.unseenSummary(fresh.length - failed, failed)
    : since
      ? TEXT.nothingNew(hm(since))
      : TEXT.nothingYet;
  const contexts = data.sessions
    .filter((s) => isLive(s) && inProject(s.id))
    .map((s) => ({ s, c: metricsOf(s.id)?.contextPercent }))
    .filter(/** @returns {x is { s: Session, c: number }} */ (x) => x.c !== undefined && x.c >= CONTEXT_WARN);
  patch(
    byId("strip"),
    ui.offline ? h("span", { class: "err" }, offlineText()) : null,
    // Before the first data, a placeholder: "Nothing has finished yet" would be a false all-clear.
    ui.loaded ? h("span", { class: "muted" }, summary) : h("span", { class: "skel", "aria-hidden": "true" }),
    fresh.length ? h("button", { class: "linkish", onclick: () => run(post("/api/seen")) }, TEXT.markSeen) : null,
    h("span", { class: "spacer" }),
    data.problems.length ? h("span", { class: "chip warn problems", title: data.problems.join("\n") }, TEXT.problems(data.problems.length)) : null,
    data.disk.map((d) => h("span", { class: "chip warn", title: d.dir }, TEXT.disk(gb(d.freeBytes), d.projects.join(", ")))),
    contexts.map(({ s, c }) => h("button", { class: "chip warn", onclick: () => openSession(s.id) }, TEXT.contextWarn(label(s), c))),
    data.planForecasts.map((f) => h("span", { class: "chip warn" }, TEXT.limitForecast(f.label, ago(data.now, f.fullAt), ago(data.now, f.resetsAt)))),
    projectsInView()
      .filter((p) => worthWarning(p))
      .map((p) => {
        const m = mergedOf(p);
        return h("button", { class: "chip warn", onclick: () => openProject(p.id) }, TEXT.worktreeChip(p.name, gb(p.totalBytes), m.length, gb(sum(m))));
      }),
  );
}

// ---------- Desk: the inbox, the sessions and what to review ----------
/**
 * @param {keyof typeof TEXT.cols} key @param {number | null} count @param {Child} body
 * @param {{ foot?: Child, quiet?: boolean, aside?: Child, list?: boolean }} [more] `list`: the body's own children are cards that move (motion.js)
 */
function column(key, count, body, { foot, quiet, aside, list } = {}) {
  return h(
    "section",
    { class: `col col-${key}`, "data-key": `col-${key}`, "aria-label": TEXT.cols[key] },
    h("div", { class: "col-head" }, TEXT.cols[key], count !== null ? h("span", { class: `count${quiet ? " quiet" : ""}` }, count) : null, aside ? h("span", { class: "head-aside" }, aside) : null),
    h("div", { class: "col-body", "data-scroll": `col-${key}`, "data-list": list }, body),
    foot ? h("div", { class: "col-foot" }, foot) : null,
  );
}
/** @typedef {import("./dom.js").Child} Child */

/**
 * The options, then `middle` (what the session said around the question), then the box. While the
 * session does not listen, the same box, inert, says to answer in its terminal: nothing jumps when it starts or stops.
 * @param {Question} q @param {Child} [middle]
 */
function answerForm(q, middle = null) {
  const listening = data.listening.includes(q.sessionId);
  // A permission prompt or a choice dialog is settled by its hook, which takes text only.
  const textOnly = q.kind === "permission" || q.dialog === true;
  return replyBox(`answer-${q.id}`, q.options, `/api/questions/${q.id}/answer`, q.sessionId, {
    placeholder: !listening ? TEXT.notListeningShort : q.kind === "permission" && q.options.length ? TEXT.permissionPlaceholder : undefined,
    images: !textOnly,
    middle,
    off: listening ? null : TEXT.notListening,
  });
}

/** Keeps an image in the store for the reply being written; returns its id. @param {Blob} file */
async function uploadImage(file) {
  const res = await write("/api/images", { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-Agent-Desk-Secret": secret }, body: file });
  const body = /** @type {{ id?: unknown, error?: string }} */ (await res.json().catch(() => ({})));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  if (typeof body.id !== "string") throw new Error(`the desk kept the image but gave no id for it (${JSON.stringify(body)})`);
  return body.id;
}

/**
 * Text box (and option buttons) whose content is sent verbatim to a listening session, with the
 * images pasted into it or picked when `images` is set. Drafts survive re-renders. With `off` (why
 * the session cannot take it now) the same box is drawn inert, so it never jumps between states.
 * @param {string} key @param {string[]} options @param {string} route @param {string} sid
 * @param {{ placeholder?: string, hint?: string, images?: boolean, middle?: Child, off?: string | null }} [how] `middle` is shown between the options and the box
 */
function replyBox(key, options, route, sid, { placeholder = options.length ? TEXT.answerPlaceholder : TEXT.replyPlaceholder, hint = TEXT.sendHint, images = true, middle = null, off = null } = {}) {
  /** Every box of this draft on the page: the panel and the inbox's card can both show a question. */
  const boxes = () => /** @type {HTMLTextAreaElement[]} */ ([...document.querySelectorAll(`textarea[data-key="${CSS.escape(key)}"]`)]);
  const attached = images ? (ui.draftImages.get(key) ?? []) : [];
  const uploading = (ui.uploading.get(key) ?? 0) > 0;
  /** @param {Blob[]} files */
  const attach = (files) => {
    for (const file of files.slice(0, ATTACHED_IMAGES_MAX - attached.length)) {
      ui.uploading.set(key, (ui.uploading.get(key) ?? 0) + 1);
      run(uploadImage(file).then((id) => (ui.draftImages.set(key, [...(ui.draftImages.get(key) ?? []), id]), saveDrafts())), () => ui.uploading.set(key, (ui.uploading.get(key) ?? 1) - 1));
    }
    if (files.length > ATTACHED_IMAGES_MAX - attached.length) toast(TEXT.tooManyImages(ATTACHED_IMAGES_MAX));
  };
  /**
   * Shown on the boxes and buttons on the page at once, not at the next drawing: a panel being
   * scrolled puts its redraw off, and the text must not look unsent meanwhile.
   * @param {boolean} sending
   */
  const showSending = (sending) => {
    for (const el of boxes()) {
      el.readOnly = sending || off !== null;
      const button = el.closest(".answer")?.querySelector(".send");
      if (sending) button?.setAttribute("aria-busy", "true");
      else button?.removeAttribute("aria-busy");
    }
  };
  /** @param {Event} e */
  const send = (e) => {
    const text = box.value;
    // Read now, not as last drawn: a second click before the redraw must not send twice.
    if (off || (!text.trim() && attached.length === 0) || ui.sending.has(key) || (ui.uploading.get(key) ?? 0) > 0) return;
    ui.sending.add(key);
    showSending(true);
    // An answered card leaves, and the keyboard with it; a message's box stays, as in a chat app.
    const answer = key.startsWith("answer-");
    if (answer) box.blur();
    run(
      post(route, attached.length ? { text, images: attached } : { text }).then(() => {
        ui.drafts.delete(key);
        ui.draftImages.delete(key);
        saveDrafts();
        for (const el of boxes()) {
          el.value = "";
          fitBox(el);
        }
        if (ui.panelSession === sid) {
          ui.panelHeard = null; // the panel fetches the conversation again, with this message
          ui.panelTouchedAt = 0; // and shows it now: the developer's own action is not a scroll to wait out
        }
        if (answer) resolve(key.slice("answer-".length));
        toast(answer ? TEXT.sent(label(S(sid))) : TEXT.messageSent(label(S(sid))));
        // Answered with the keys, the next question's box is ready to type in.
        if (answer && e instanceof KeyboardEvent && !document.querySelector("dialog[open]")) {
          setTimeout(() => /** @type {HTMLElement | null} */ (document.querySelector(".next textarea:not([readonly])"))?.focus({ preventScroll: true }));
        }
      }),
      () => {
        ui.sending.delete(key);
        showSending(false);
      },
    );
  };
  /** The option buttons on the page, which are this drawing's or the kept ones. */
  const syncPressed = () => box.parentElement?.querySelectorAll(":scope > .opts > button").forEach((b, i) => b.setAttribute("aria-pressed", String(box.value === options[i])));
  /** @param {string} o @param {boolean} focus */
  const pick = (o, focus) => {
    box.value = o;
    ui.drafts.set(key, o);
    saveDrafts();
    syncPressed();
    fitBox(box);
    if (focus) box.focus();
  };
  /** A tap, unlike a click or a key, leaves the box alone: focusing it would raise the keyboard over the options. @param {Event} e */
  const byFinger = (e) => (e instanceof PointerEvent && e.pointerType ? e.pointerType !== "mouse" : COARSE.matches);
  // What is on its way stays as sent: an edit made meanwhile would be lost with the draft.
  /** The box on the page: this new one, or the one being typed in that `patch` kept. @type {HTMLTextAreaElement} */
  let box = h("textarea", {
    "data-key": key,
    rows: 1,
    placeholder,
    "aria-label": placeholder,
    "aria-disabled": off ? "true" : null,
    title: off,
    readonly: ui.sending.has(key) || off !== null,
    oninput: () => {
      ui.drafts.set(key, box.value);
      saveDrafts();
      syncPressed();
      fitBox(box);
    },
    onkeydown: (e) => {
      if (!(e instanceof KeyboardEvent)) return;
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        send(e);
      }
      // While the box is empty or holds an option as picked, a digit picks another option.
      const option = /^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !off ? options[Number(e.key) - 1] : undefined;
      if (option !== undefined && (box.value === "" || options.includes(box.value))) {
        e.preventDefault();
        pick(option, true);
      }
    },
    onpaste: images
      ? (e) => {
          const files = [...((e instanceof ClipboardEvent && e.clipboardData?.files) || [])].filter((f) => f.type.startsWith("image/"));
          if (files.length === 0) return; // text is pasted as usual
          e.preventDefault();
          attach(files);
        }
      : null,
  });
  box.value = ui.drafts.get(key) ?? "";
  onKept(box, (live) => {
    box = live;
    // Written only when it differs (a message sent empties it): setting a value resets the keyboard too.
    const draft = ui.drafts.get(key) ?? "";
    if (live.value !== draft) {
      live.value = draft;
      fitBox(live);
    }
  });
  const opts = options.map((o, i) => h("button", { "aria-pressed": String(box.value === o), disabled: off !== null, onclick: (e) => pick(o, !byFinger(e)) }, i < 9 ? h("kbd", {}, String(i + 1)) : null, o));
  /** @param {Event} e */
  const pickFiles = (e) => {
    const picker = e.currentTarget instanceof Element ? e.currentTarget.parentElement?.querySelector("input") : null;
    picker?.click();
  };
  return h(
    "div",
    { class: `answer${off ? " off" : ""}` },
    opts.length ? h("div", { class: "opts" }, opts) : null,
    middle ? h("div", { class: "answer-middle" }, middle) : null,
    attached.length || uploading
      ? h(
          "div",
          { class: "attached" },
          attached.map((id) =>
            h(
              "span",
              { class: "thumb", "data-key": id },
              h("img", { src: `/images/${encodeURIComponent(id)}`, alt: TEXT.attachedImage }),
              h("button", { class: "icon-btn", title: TEXT.removeImage, "aria-label": TEXT.removeImage, onclick: () => (ui.draftImages.set(key, attached.filter((x) => x !== id)), saveDrafts(), render()) }, icon("x")),
            ),
          ),
          uploading ? h("span", { class: "faint" }, TEXT.attaching) : null,
        )
      : null,
    box,
    h(
      "div",
      { class: "row" },
      h(
        "div",
        { class: "send-col" },
        images
          ? [
              h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", multiple: true, hidden: true, onchange: (e) => e.currentTarget instanceof HTMLInputElement && attach([...(e.currentTarget.files ?? [])]) }),
              h("button", { class: "icon-btn", title: TEXT.attachImage, "aria-label": TEXT.attachImage, disabled: off !== null, onclick: pickFiles }, icon("image")),
            ]
          : null,
        h(
          "button",
          {
            class: "primary send",
            title: off ?? TEXT.send,
            "aria-label": TEXT.send,
            "aria-busy": ui.sending.has(key) ? "true" : null,
            disabled: off !== null || uploading,
            // The focus stays in the box, so a phone's keyboard stays up for the next message.
            onmousedown: (e) => e.preventDefault(),
            onclick: send,
          },
          h("span", { class: "send-i" }, icon("send"), h("span", { class: "spin", "aria-hidden": "true" })),
          h("span", { class: "send-lbl", "aria-hidden": "true" }, h("span", {}, TEXT.sendShort), h("span", {}, TEXT.sending)),
        ),
      ),
      h("span", { class: "faint send-hint" }, off ?? [h("span", { class: "keys-only" }, `${TEXT.sendKeys} `), hint, images ? ` ${TEXT.pasteImages}` : ""]),
    ),
  );
}

/** A text box is one line when empty and grows with what is written; style.css caps it, past that it scrolls. @param {HTMLTextAreaElement} box */
function fitBox(box) {
  if (!box.getClientRects().length) return; // not laid out yet (a window still closed): fitted when it is
  box.style.height = "auto";
  box.style.height = `${box.scrollHeight + 2}px`;
}
/** Fits the boxes a redraw just placed, in the same frame: one drawn at its default height first would push the page down a frame later. @param {ParentNode} root */
function fitNewBoxes(root) {
  for (const box of root.querySelectorAll("textarea[data-key]")) if (box instanceof HTMLTextAreaElement && !box.style.height) fitBox(box);
}

// An answer sent from the desk shows on its card for a moment before the next question takes its place.
const RESOLVED_MS = 650;
/** @param {string} questionId */
function resolve(questionId) {
  ui.resolved.set(questionId, Date.now() + RESOLVED_MS);
  setTimeout(() => {
    ui.resolved.delete(questionId);
    render();
  }, RESOLVED_MS);
}

/**
 * A question's headline is the line that asks (or its first line); when the question is a whole
 * block (a list of pending points), the block follows in full, with its formatting.
 * @param {string} text
 */
function questionText(text) {
  if (text.split("\n").filter((l) => l.trim()).length <= 1) return h("div", { class: "qtext" }, md(text));
  return [h("div", { class: "qtext" }, md(headline(text))), h("div", { class: "qctx md qfull" }, mdBlocks(text))];
}

/** The line of a question that asks (the line introducing a list of them, or its first line), without list markers. @param {string} text */
function headline(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const item = /^(?:[-*•]|\d+[.)])\s+/;
  // Several questions in a list: the line that introduces them names them all.
  const first = lines.findIndex((l) => item.test(l));
  const intro = first > 0 && lines.filter((l) => item.test(l) && /[?¿]/.test(l)).length > 1 && /:$/.test(lines[first - 1] ?? "") ? lines[first - 1] : undefined;
  const asking = (intro ?? lines.find((l) => /[?¿]/.test(l)) ?? lines[0] ?? "").replace(item, "");
  return asking.length > 240 ? `${asking.slice(0, 239)}…` : asking;
}

/** Fetches a session's conversation, then re-renders what shows it. @param {string} sid @param {() => void} then */
function loadConversation(sid, then) {
  run(
    fetch(`/api/sessions/${encodeURIComponent(sid)}/messages`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`${res.status}`))))
      .then((/** @type {ConversationEntry[]} */ list) => {
        ui.conversations.set(sid, list);
        then();
      }),
  );
}

/**
 * Messages as a chat: the session on the left, the developer on the right; `whileWorking` holds
 * the texts the developer sent while the session was working, which get a mark.
 * @param {ConversationEntry[]} list @param {Set<string>} [whileWorking]
 */
function conversationView(list, whileWorking = new Set()) {
  /** @param {ConversationEntry} m */
  const message = (m) => {
    const who = m.from === "session" ? null : m.via === "desk" ? TEXT.conversation.youDesk : TEXT.conversation.you;
    const mark = m.from === "developer" && whileWorking.has(m.text) ? ` · ${TEXT.conversation.whileWorking}` : "";
    return h(
      "div",
      { class: `msg from-${m.from}${m.step ? " step" : ""}`, "data-key": m.id },
      m.text.trim() ? h("div", { class: "md" }, mdBlocks(m.text, { breaks: m.from === "developer" })) : null,
      m.images?.length ? attachedImages(m.images) : null,
      h("div", { class: "msg-meta" }, who ? [who, " · "] : null, hm(m.at), mark),
    );
  };
  /** @type {HTMLElement[]} */
  const out = [];
  for (let i = 0; i < list.length; ) {
    const m = list[i];
    if (!m) break;
    let end = i;
    while (list[end]?.step) end++;
    // What the session wrote between its tool calls folds under one line once something followed it;
    // the latest run, still being written, stays open.
    if (end > i && end < list.length) {
      const run = list.slice(i, end);
      const key = run[0]?.id ?? "";
      const open = ui.stepsOpen.has(key);
      const until = list[end]?.at ?? "";
      const agents = data.agents.filter((a) => a.sessionId === m.sessionId && a.startedAt >= (run[0]?.at ?? "") && a.startedAt <= until).length;
      out.push(
        h("button", { class: "steps-fold linkish faint", "data-key": `fold-${key}`, "aria-expanded": String(open), onclick: () => ((open ? ui.stepsOpen.delete(key) : ui.stepsOpen.add(key)), render()) }, `${open ? "▾" : "▸"} ${TEXT.conversation.steps(run.length, agents)}`),
      );
      if (open) out.push(...run.map(message));
      i = end;
      continue;
    }
    out.push(message(m));
    i++;
  }
  return out;
}

/** Images the developer attached on the desk, as thumbnails that open the zoom. @param {string[]} ids */
function attachedImages(ids) {
  const gallery = ids.map((id) => ({ src: `/images/${encodeURIComponent(id)}`, caption: "" }));
  return h("div", { class: "msg-imgs" }, gallery.map((p, i) => h("img", { src: p.src, alt: TEXT.attachedImage, onclick: () => zoom(gallery, i) })));
}

/** Earlier messages of the asking session, unfolded on demand under the large card. @param {Question} q */
function earlierConversation(q) {
  const open = ui.unfolded.has(q.id);
  const toggle = h("button", {
    class: "linkish faint",
    onclick: () => {
      if (open) ui.unfolded.delete(q.id);
      else {
        ui.unfolded.add(q.id);
        loadConversation(q.sessionId, renderView);
      }
      renderView();
    },
  }, open ? TEXT.conversation.hideEarlier : TEXT.conversation.showEarlier);
  if (!open) return toggle;
  // Everything said before this question; its own message is already on the card.
  const before = (ui.conversations.get(q.sessionId) ?? []).filter((m) => m.at < q.askedAt).slice(0, -1).slice(-8);
  return [toggle, h("div", { class: "conversation", "data-scroll": `conv-${q.id}` }, before.length ? conversationView(before) : h("div", { class: "faint" }, TEXT.conversation.none))];
}

// The oldest wait is the next thing to do: shown large, with what it takes to answer it.
/** @param {Question} q */
function nextCard(q) {
  const s = S(q.sessionId);
  const canAnswer = data.listening.includes(q.sessionId);
  const meta = h("div", { class: "meta" }, h("span", { class: `qkind k-${q.kind}` }, TEXT.kinds[q.kind]), where(s), h("span", { class: `age${heat(q.askedAt)}`, title: TEXT.askedAt(hm(q.askedAt)) }, ago(q.askedAt)));
  // A question shares its row's `data-flip`: picked or next in line, the row grows into this card.
  const card = { "aria-label": TEXT.next, "data-key": `next-${q.id}`, "data-flip": `q-${q.id}` };
  if (q.status !== "open") {
    return h(
      "article",
      { ...card, class: "next resolved" },
      meta,
      q.kind === "permission" ? h("pre", { class: "qcode" }, q.text) : h("div", { class: "qtext" }, md(headline(q.text))),
      h("div", { class: "resolved-line", role: "status" }, dot("done"), h("b", {}, TEXT.answered), q.answer ? h("span", { class: "resolved-answer" }, q.answer.text) : null),
    );
  }
  // The question and its answers come first; what the session said around it, folded, after the options.
  const long = (q.context ?? "").length > 320 || (q.context ?? "").split("\n").length > 5;
  const unfolded = ui.contextOpen.has(q.id);
  const context = q.context
    ? h(
        "div",
        { class: "qmore" },
        h("div", { class: `qctx md${long && !unfolded ? " folded" : ""}`, "data-scroll": `ctx-${q.id}` }, mdBlocks(q.context)),
        long
          ? h("button", { class: "linkish", onclick: () => ((unfolded ? ui.contextOpen.delete(q.id) : ui.contextOpen.add(q.id)), renderView()) }, unfolded ? TEXT.foldMessage : TEXT.unfoldMessage)
          : null,
        earlierConversation(q),
      )
    : h("div", { class: "qmore" }, earlierConversation(q));
  return h(
    "article",
    { ...card, class: `next${heat(q.askedAt)}` },
    meta,
    q.kind === "permission" ? h("pre", { class: "qcode", "data-scroll": `code-${q.id}` }, q.text) : questionText(q.text),
    answerForm(q, context),
    h(
      "div",
      { class: "actions" },
      goLink(s, "linkish go-link", icon("go"), TEXT.goTo, canAnswer ? null : h("kbd", {}, "⏎")),
      h("span", { class: "spacer" }),
      h("button", { class: "linkish faint", title: TEXT.dismissTitle, onclick: () => run(post(`/api/questions/${q.id}/dismiss`)) }, TEXT.dismiss),
    ),
  );
}

/**
 * Everything that waits for the developer, in the order to deal with it: questions and permission
 * prompts oldest first, then failures not looked at yet. A session that finished with a report and
 * asked nothing is not here: its card under Sessions marks the message as new.
 */
function inbox() {
  const questions = openQuestions();
  const failures = data.results.filter((r) => inProject(r.sessionId) && isNew(r) && r.status === "failed").sort((a, b) => a.at.localeCompare(b.at));
  return { questions, failures, count: questions.length + failures.length };
}

/**
 * A row of the inbox: a mark, one line saying what it is, where it comes from, and how long it has
 * waited. @param {{ mark: Child, line: Child, meta: string, when: Child, open: () => void, go?: Child, end?: Child, key: string, flip?: string }} row
 */
function inboxRow({ mark, line, meta, when, open, go, end, key, flip }) {
  return h(
    "div",
    {
      class: "qrow",
      "data-key": `row-${key}`,
      "data-flip": flip,
      role: "button",
      tabindex: "0",
      onclick: open,
      onkeydown: (e) => {
        if (/** @type {KeyboardEvent} */ (e).key === "Enter") {
          e.stopPropagation();
          open();
        }
      },
    },
    mark,
    h("span", { class: "qbody" }, h("span", { class: "qt" }, line), h("span", { class: "qs" }, meta)),
    h("span", { class: "qwhen" }, when),
    go ?? null,
    end ?? null,
  );
}

/** @param {Question} q */
function questionRow(q) {
  const s = S(q.sessionId);
  return inboxRow({
    key: q.id,
    flip: `q-${q.id}`,
    mark: beacon(q.askedAt),
    line: [q.kind !== "question" ? [badge(q.kind), " "] : null, h("b", {}, headline(q.text))],
    meta: [label(s), q.options.length ? TEXT.nOptions(q.options.length) : ""].filter(Boolean).join(" · "),
    when: h("span", { class: `age${heat(q.askedAt)}`, title: TEXT.askedAt(hm(q.askedAt)) }, ago(q.askedAt)),
    go: goLink(s, "row-go", icon("go"), TEXT.go),
    open: () => {
      ui.sel = q.id;
      renderView();
      revealNext();
    },
  });
}

/** A failure not looked at yet: opening it, or its ×, moves it to the history. @param {Result} r */
function failureRow(r) {
  return inboxRow({
    key: `r-${r.id}`,
    mark: dot("failed"),
    line: [badge("failed"), " ", r.title],
    meta: [label(S(r.sessionId)), r.summary ? firstLine(r.summary) : ""].filter(Boolean).join(" · "),
    when: h("span", { class: "age quiet" }, hm(r.at)),
    open: () => openResult(r),
    end: h("button", { class: "rdismiss icon-btn", "aria-label": TEXT.dismissResult, title: TEXT.dismissResult, onclick: (/** @type {Event} */ e) => (e.stopPropagation(), run(post(`/api/results/${r.id}/seen`))) }, icon("x")),
  });
}

/** The question just answered from the desk, while its card still says so. */
function resolvedQuestion() {
  const showing = (/** @type {Question} */ q) => ui.sending.has(`answer-${q.id}`) || (ui.resolved.get(q.id) ?? 0) > Date.now();
  return data.questions.find((q) => q.id === ui.sel && q.status !== "open" && showing(q));
}

/** The inbox: the selected question large, with what it takes to answer it, then the rest in order. */
function inboxColumn() {
  const { questions, failures, count } = inbox();
  const resolved = resolvedQuestion();
  const selected = resolved ?? questions.find((q) => q.id === ui.sel) ?? questions[0];
  ui.sel = selected?.id ?? null;
  const rows = [...questions.filter((q) => q !== selected).map(questionRow), ...failures.map(failureRow)];
  const reviewEmpty = !data.results.some((r) => inProject(r.sessionId) && isNew(r));
  const clear = h(
    "div",
    { class: "allclear", role: "status", "data-key": "allclear" },
    dot("done"),
    h("span", {}, TEXT.allClear(reviewEmpty), reviewEmpty ? [" ", h("button", { class: "linkish", onclick: showEarlierResults }, TEXT.seeHistory)] : null),
  );
  return column("needs", count || null, count || resolved ? [selected ? nextCard(selected) : null, rows] : clear, {
    aside: questions.length > 1 ? h("span", { class: "keys-only faint" }, TEXT.keysHint) : null,
    list: true,
  });
}

function showEarlierResults() {
  ui.view = "history";
  ui.hfilter = "result";
  render();
}

/** @param {Result} r @param {() => void} [opened] after the result's window opens */
function resultRow(r, opened) {
  const first = r.images[0];
  const thumb = first ? h("img", { src: `/images/${first.id}`, alt: "" }) : h("span", { class: "ph" }, dot(r.status === "failed" ? "failed" : "done"));
  return h(
    "button",
    {
      class: `rrow${isNew(r) ? " is-new" : ""}${r.status === "failed" ? " failed" : ""}`,
      "data-key": r.id,
      onclick: () => {
        openResult(r);
        opened?.();
      },
    },
    thumb,
    h("span", { class: "rbody" }, h("span", { class: "rt" }, r.title), h("span", { class: "rm" }, isNew(r) ? h("span", { class: "new", title: TEXT.newResult }) : null, `${label(S(r.sessionId))} · ${hm(r.at)}`)),
  );
}

/** A result not seen yet as a tile: its first picture and its title; × marks it seen without opening it. @param {Result} r */
function reviewTile(r) {
  const first = r.images[0];
  return h(
    "div",
    { class: "rtile-wrap", "data-key": `r-${r.id}` },
    h(
      "button",
      { class: "rtile", onclick: () => openResult(r), title: `${r.title}\n${label(S(r.sessionId))} · ${hm(r.at)}` },
      first ? h("img", { src: `/images/${first.id}`, alt: "" }) : h("span", { class: "ph" }, dot("done"), r.summary ? h("span", {}, firstLine(r.summary)) : null),
      h("span", { class: "rt" }, r.title),
      h("span", { class: "rm" }, hm(r.at)),
    ),
    h("button", { class: "rdismiss icon-btn", "aria-label": TEXT.dismissResult, title: TEXT.dismissResult, onclick: () => run(post(`/api/results/${r.id}/seen`)) }, icon("x")),
  );
}

/** Finished work to look at; failures wait in the inbox instead. */
function reviewColumn() {
  const list = data.results.filter((r) => inProject(r.sessionId) && isNew(r) && r.status !== "failed");
  const empty = h("div", { class: "empty" }, TEXT.emptyResults, " ", h("button", { class: "linkish", onclick: showEarlierResults }, TEXT.seeHistory));
  return column("review", list.length || null, list.length ? h("div", { class: "rtiles", "data-list": true }, list.map(reviewTile)) : empty, { quiet: true });
}

/** One dot per agent says the shape of a session at a glance. @param {Agent} a */
function agentDot(a) {
  const mark = dot(a.state);
  mark.title = [a.name, TEXT.state[a.state], a.activity].filter(Boolean).join(" · ");
  return a.state === "working" ? h("span", { class: "live" }, mark) : mark;
}
/** The session itself at work, before its agents' dots. */
function sessionDot() {
  const mark = dot("working");
  mark.title = TEXT.sessionWorking;
  return h("span", { class: "live" }, mark);
}
/** What an agent does now: who it waits for, its latest tool call, or what kind of agent it is. @param {Agent} a */
function agentDoing(a) {
  const waits = waitingOn(a);
  if (waits.length) return TEXT.waits(waits.map((n) => agentOf(a.sessionId, n)?.goal ?? n).join(", "));
  return a.activity ?? (a.type ? TEXT.agentType(a.type) : "");
}
/** Why an agent is in trouble, in a few words. @param {Agent} a */
function troubleText(a) {
  const waits = waitingOn(a);
  if (a.state === "failed") return a.activity ?? TEXT.failedAgent;
  if (waits.length) return TEXT.waits(waits.map((n) => agentOf(a.sessionId, n)?.goal ?? n).join(", "));
  return TEXT.idleSince(hm(a.updatedAt));
}
// An agent or session at work with no tool call for this long, or failing calls this recently, may be stuck.
const QUIET_MS = 5 * 60_000;
const FAILS_MS = 10 * 60_000;
/** Minutes since `at`, once past QUIET_MS; otherwise 0. @param {string} at */
const quietMinutes = (at) => {
  const ms = Date.now() - Date.parse(at);
  return ms >= QUIET_MS ? Math.floor(ms / 60_000) : 0;
};
/** Failed tool calls in the last FAILS_MS. @param {string[] | undefined} failedAt */
const recentFailures = (failedAt) => (failedAt ?? []).filter((t) => Date.now() - Date.parse(t) < FAILS_MS).length;
/**
 * A working agent quiet for a while: minutes, or 0. Only an agent whose adapter stamps its tool
 * calls can be quiet: an older adapter's agents carry no such stamp, and their last update says nothing.
 * @param {Agent} a
 */
const agentQuiet = (a) => (a.state === "working" && a.activityAt ? quietMinutes(a.activityAt) : 0);
/** Two failed calls in a row is a retry; three is a pattern. @param {Agent | Session} x */
const failing = (x) => recentFailures(x.failedAt) >= 3;
/** A working session none of whose own calls nor working agents' has moved for a while: minutes, or 0. @param {Session} s */
function sessionQuiet(s) {
  if (s.state !== "working" || !s.activityAt) return 0;
  const working = sessionAgents(s.id).filter((a) => a.state === "working");
  if (working.some((a) => !a.activityAt)) return 0; // an agent that cannot be timed may well be busy
  const last = [s.activityAt, ...working.map((a) => a.activityAt ?? "")].sort().at(-1);
  return last ? quietMinutes(last) : 0;
}
/** @param {string} sid */
const sessionAgents = (sid) => data.agents.filter((a) => a.sessionId === sid).sort((a, b) => ATTENTION.indexOf(a.state) - ATTENTION.indexOf(b.state));
/** @param {Session} s */
const sessionWeight = (s) =>
  data.questions.filter((q) => q.status === "open" && q.sessionId === s.id).length * 10 +
  (endedUnseen(s) ? 10 : 0) +
  sessionAgents(s.id).filter((a) => ["failed", "blocked", "idle"].includes(a.state) || agentQuiet(a) || failing(a)).length +
  (sessionQuiet(s) || failing(s) ? 1 : 0);

/**
 * One row per session: its state, name, context and age, then only what matters about it — what it
 * asks, which of its agents fail or have gone quiet — or else what it does now; its agents counted.
 * @param {Session} s
 */
function sessionCard(s) {
  const as = sessionAgents(s.id);
  const asking = data.questions.filter((q) => q.status === "open" && q.sessionId === s.id).sort((a, b) => a.askedAt.localeCompare(b.askedAt))[0];
  const m = metricsOf(s.id);
  const ctx = m?.contextPercent;
  const working = as.filter((a) => a.state === "working").length;
  const done = as.filter((a) => a.state === "done").length;
  const since = s.state === "working" ? (s.activityAt ?? s.updatedAt) : (s.lastMessage?.at ?? s.updatedAt);
  /** @type {HTMLElement[]} */
  const matters = [];
  if (asking) {
    matters.push(
      asking.kind === "permission"
        ? h("div", { class: "s-ask" }, h("span", { class: "s-label" }, TEXT.sessionLine.permission), " ", h("code", {}, asking.text))
        : h("div", { class: "s-ask" }, h("span", { class: "s-label" }, TEXT.sessionLine.asks), " ", headline(asking.text)),
    );
  }
  /** One line of trouble; the failed call, when known, on one line below it. @param {DotState} st @param {string} what @param {string} [call] */
  const troubleLine = (st, what, call) => h("div", { class: `s-bad${st === "idle" ? " s-warn" : ""}` }, dot(st), h("span", {}, what, call ? h("code", {}, call) : null));
  /** @param {Agent | Session} x @param {string} who */
  const failLine = (x, who) => troubleLine("failed", [who, TEXT.failingCalls(recentFailures(x.failedAt))].filter(Boolean).join(" · "), x.failedWhat);
  if (failing(s)) matters.push(failLine(s, ""));
  for (const a of as.filter(failing)) matters.push(failLine(a, a.goal ?? a.name));
  for (const a of as.filter((a) => a.state === "failed" || a.state === "blocked")) matters.push(troubleLine(a.state, `${a.goal ?? a.name} · ${troubleText(a)}`));
  const quiet = sessionQuiet(s);
  if (quiet) matters.push(troubleLine("idle", TEXT.trouble.sessionQuiet(quiet)));
  else for (const a of as.filter(agentQuiet)) matters.push(troubleLine("idle", `${a.goal ?? a.name} · ${TEXT.quietFor(agentQuiet(a))}`));
  const shown = matters.slice(0, 3);
  const open = () => openSession(s.id);
  return h(
    "div",
    {
      class: `scard${asking ? " needs" : ""}`,
      role: "button",
      tabindex: "0",
      onclick: open,
      onkeydown: (e) => {
        if (/** @type {KeyboardEvent} */ (e).key === "Enter") open();
      },
      "data-key": `s-${s.id}`,
    },
    h(
      "div",
      { class: "s-l1" },
      asking ? dot("needs") : s.state === "working" || working ? sessionDot() : dot("done"),
      // The project names the session only while every project is shown; its colour stays.
      h("span", { class: "sname", title: label(s) }, ui.project === null ? [projectMark(s.project.name, "pname sproj"), h("span", { class: "sep" }, "›")] : tagIcon(color(s.project.name)), h("b", {}, sessionName(s))),
      h("span", { class: "s-meta num" }, [ctx !== undefined ? `${Math.round(ctx)}%` : "", ago(since)].filter(Boolean).join(" · ")),
    ),
    shown.length ? shown : quietLine(s),
    matters.length > shown.length ? h("div", { class: "s-more" }, TEXT.sessionLine.more(matters.length - shown.length)) : null,
    working || done ? h("div", { class: "s-l3" }, TEXT.sessionLine.agents(working, done)) : null,
    m?.suggestion ? h("span", { class: "chip warn", title: TEXT.suggest[m.suggestion.reason](ctx ?? 0) }, TEXT.suggestChip(ctx ?? 0, m.suggestion.command)) : null,
  );
}

/**
 * Keys the desk may send a session that runs inside tmux, and ending the session's process. Each
 * button asks for a second click within 3 s before acting, so a stray click does nothing. @param {Session} s
 */
function controlSection(s) {
  const endable = Boolean(s.process?.start);
  if ((!s.tmux && !endable) || !isLive(s)) return null;
  // Armed in `ui`, not in the button: the panel redraws as the session's metrics change.
  /** @param {string} id @param {string} text @param {() => Promise<unknown>} act @param {string} [cls] */
  const confirmed = (id, text, act, cls = "secondary") => {
    const key = `${s.id} ${id}`;
    const armed = () => ui.armed?.key === key && ui.armed.until > Date.now();
    const click = () => {
      if (!armed()) {
        const until = Date.now() + ARM_MS;
        ui.armed = { key, until };
        setTimeout(() => {
          if (ui.armed?.until !== until) return;
          ui.armed = null;
          redrawPanel(s.id);
        }, ARM_MS);
        return redrawPanel(s.id);
      }
      ui.armed = null;
      redrawPanel(s.id);
      run(act());
    };
    return h("button", { class: cls, "data-key": id, onclick: click }, armed() ? TEXT.control.confirm(text) : text);
  };
  /** @param {string} action @param {string} text */
  const key = (action, text) => confirmed(action, text, () => post(`/api/sessions/${s.id}/keys`, { action }).then(() => toast(TEXT.control.sent(text, label(s)))));
  // The terminal shows a dialog (a permission prompt, a question with options) only while the
  // session has one open; the keys that answer it are offered only then.
  const dialog = data.questions.some((q) => q.status === "open" && q.sessionId === s.id && (q.kind === "permission" || q.kind === "question"));
  return h(
    "div",
    { class: "rsec" },
    h("h4", {}, TEXT.control.title),
    h(
      "div",
      { class: "row wt-actions" },
      s.tmux ? [key("compact", "/compact"), key("interrupt", TEXT.control.interrupt)] : null,
      s.tmux && dialog ? [h("span", { class: "faint" }, TEXT.control.dialog), ...[1, 2, 3, 4, 5].map((n) => key(`option-${n}`, String(n))), key("enter", "Enter")] : null,
      endable ? confirmed("end", TEXT.control.end, () => post(`/api/sessions/${s.id}/end`, {}).then(() => toast(TEXT.control.ended(label(s)))), "secondary danger") : null,
    ),
    s.tmux && !ON_THIS_MACHINE ? attachLine(s.tmux) : null,
  );
}
const ARM_MS = 3000;
/** Redraws the session panel now, if it still shows this session. @param {string} sid */
function redrawPanel(sid) {
  if (ui.panelSession === sid && dialog("session").open) openSession(sid);
}

/**
 * The command that opens the session's terminal from another one (an SSH client on a phone). The
 * socket is a path the session reported: shown only when it cannot carry shell syntax.
 * @param {{ socket: string, pane: string }} where
 */
function attachLine({ socket, pane }) {
  const plain = /\/tmux-\d+\/default$/.test(socket);
  if (!plain && !/^[\w./-]+$/.test(socket)) return null;
  const command = `tmux ${plain ? "" : `-S ${socket} `}attach -t ${pane}`;
  return h("div", { class: "attach" }, h("span", {}, TEXT.control.attach), h("code", {}, command), h("button", { class: "secondary", onclick: () => copy(command) }, icon("copy"), TEXT.copy));
}




/** What a session is up to, in one quiet line: its current tool call, or that it waits for instructions. @param {Session} s */
function quietLine(s) {
  if (endedUnseen(s)) return h("div", { class: "quiet-line unread", title: s.lastMessage ? firstLine(s.lastMessage.text) : "" }, h("span", { class: "badge k-new" }, TEXT.endedAsking), s.lastMessage ? firstLine(s.lastMessage.text) : "");
  if (s.state === "waiting" && s.lastMessage && unread(s)) return h("div", { class: "quiet-line unread", title: firstLine(s.lastMessage.text) }, readBadge(s), firstLine(s.lastMessage.text));
  if (s.state === "waiting") return h("div", { class: "quiet-line" }, readBadge(s), TEXT.awaiting(s.lastMessage ? ago(s.lastMessage.at) : ""));
  if (s.activity) return h("div", { class: "quiet-line", title: s.activity }, TEXT.sessionLine.now, " ", h("code", {}, s.activity));
  return null;
}
/** "New message" until the developer opens the session, "Seen" after. @param {Session} s */
function readBadge(s) {
  if (!s.lastMessage) return null;
  return unread(s) ? h("span", { class: "badge k-new" }, TEXT.newBadge) : h("span", { class: "badge k-seen", title: s.readAt ? TEXT.seenAt(hm(s.readAt)) : "" }, TEXT.seenBadge);
}
function sessionsColumn() {
  const list = data.sessions.filter((s) => (isLive(s) || endedUnseen(s)) && inProject(s.id)).sort((a, b) => sessionWeight(b) - sessionWeight(a));
  const legend = h("div", { class: "legend" }, LEGEND.map((st) => h("span", {}, dot(st), TEXT.state[st])));
  return column("sessions", list.length, list.length ? h("div", { class: "slist", "data-list": true }, list.map(sessionCard)) : h("div", { class: "empty" }, TEXT.emptyRunning), { foot: legend, quiet: true });
}

// ---------- Session panel ----------
/** @typedef {"agents" | "results" | "services" | "more"} PanelPart */

/**
 * The session's state in one line of chips: context and plan, the command its context calls for,
 * then its agents, results, servers and the rest, each unfolding under the chips.
 * Every field is optional: a provider that does not report one leaves it out.
 * @param {Session} s @param {Metrics | undefined} m
 */
function panelChips(s, m) {
  const as = data.agents.filter((a) => a.sessionId === s.id);
  const failed = as.filter((a) => a.state === "failed").length;
  const results = data.results.filter((r) => r.sessionId === s.id).length;
  const services = data.services.filter((v) => v.sessionId === s.id).length;
  const command = m?.suggestion?.command;
  /** @param {PanelPart} part @param {Child} content @param {string} [cls] */
  const unfold = (part, content, cls = "") =>
    h(
      "button",
      { class: `chip ${cls}`, "aria-pressed": String(ui.panelPart === part), onclick: () => ((ui.panelPart = ui.panelPart === part ? null : part), openSession(s.id)) },
      content,
      part === "more" ? null : h("span", { class: "caret", "aria-hidden": "true" }, "▾"),
    );
  return h(
    "div",
    { class: "pchips" },
    m?.contextPercent !== undefined ? h("span", { class: "chip" }, bar(m.contextPercent), TEXT.context(m.contextPercent)) : null,
    (m?.planWindows ?? []).map((w) => h("span", { class: "chip", title: TEXT.plan(w.label, w.percent, w.resetsAt ? ago(new Date().toISOString(), w.resetsAt) : "") }, TEXT.planChip(w.label, w.percent))),
    m?.suggestion && command ? h("button", { class: "chip warn", title: TEXT.suggest[m.suggestion.reason](m.contextPercent ?? 0), onclick: () => copy(command) }, icon("copy"), command) : null,
    s.state === "ended" || data.gone.includes(s.id) ? h("span", { class: "chip quiet" }, s.state === "ended" ? TEXT.ended : TEXT.gone) : null,
    as.length ? unfold("agents", [failed ? dot("failed") : null, TEXT.chips.agents(as.length, failed)], failed ? "bad" : "") : null,
    results ? unfold("results", TEXT.chips.results(results)) : null,
    services ? unfold("services", TEXT.chips.live(services)) : null,
    unfold("more", TEXT.chips.more),
  );
}

/** What a chip unfolds. @param {Session} s @param {Metrics | undefined} m @param {HTMLDialogElement} d */
function panelPart(s, m, d) {
  if (ui.panelPart === "agents") return agentsPart(s);
  if (ui.panelPart === "results") {
    return h("div", { class: "stack" }, data.results.filter((r) => r.sessionId === s.id).map((r) => resultRow(r, () => d.close())));
  }
  if (ui.panelPart === "services") {
    return h("div", { class: "links" }, data.services.filter((v) => v.sessionId === s.id).map((v) => h("span", { title: TEXT.svcSince(ago(v.startedAt)) }, h("span", { class: "up" }), `${v.name} `, localLink(v.url, v.url.replace(LOCAL_URL, "")))));
  }
  if (ui.panelPart === "more") return morePart(s, m);
  return null;
}

/** @param {Session} s @param {Metrics | undefined} m */
function sessionDetails(s, m) {
  const cacheLeft = m?.cacheExpiresAt ? minutes(new Date().toISOString(), Date.parse(m.cacheExpiresAt)) : undefined;
  const cache = m?.cacheExpiresAt ? TEXT.cache(Date.parse(m.cacheExpiresAt) > Date.now() ? TEXT.cacheLeft(duration(cacheLeft ?? 0)) : TEXT.cacheExpired) : null;
  const parts = [
    m?.model && [m.model, m.effort].filter(Boolean).join(" · "),
    m?.branch,
    cache,
    m?.permissionMode && TEXT.mode(m.permissionMode),
    m?.backgroundShells !== undefined && TEXT.shells(m.backgroundShells),
    m?.costUsd !== undefined && TEXT.cost(m.costUsd),
  ];
  return h("div", { class: "faint" }, parts.filter(Boolean).join(" · "));
}

/**
 * One row per agent: its goal, the sentence saying what it must deliver, and what it does now (or
 * how it ended). Branch, commit and tokens wait in the tooltip. @param {Session} s
 */
function agentList(s) {
  const rows = sessionAgents(s.id);
  return rows.length ? agentRows(rows) : h("div", { class: "faint" }, TEXT.noAgents);
}

/** One row per agent: its goal, what it was asked, what it does now, and for how long. @param {Agent[]} rows */
function agentRows(rows) {
  /** @param {Agent} a */
  const tip = (a) => [a.branch && `${a.branch}${a.commit ? ` @ ${a.commit}` : ""}`, a.tokens !== undefined && TEXT.tokens(a.tokens)].filter(Boolean).join(" · ");
  return h(
    "div",
    { class: "alist" },
    rows.map((a) =>
      h(
        "div",
        { class: `arow${a.state === "failed" ? " failed" : ""}`, title: tip(a) },
        h(
          "span",
          { class: "awhat" },
          h("span", { class: "aname" }, agentDot(a), h("span", { class: "agoal" }, a.goal ?? a.name)),
          a.summary ? h("span", { class: "asummary" }, a.summary) : null,
          agentDoing(a) ? h("span", { class: "adoing" }, a.state === "working" && a.activity ? TEXT.now_(agentDoing(a)) : agentDoing(a)) : null,
          agentQuiet(a) || failing(a)
            ? h("span", { class: "astuck" }, [agentQuiet(a) ? TEXT.quietFor(agentQuiet(a)) : "", failing(a) ? TEXT.failingCalls(recentFailures(a.failedAt)) : ""].filter(Boolean).join(" · "))
            : null,
        ),
        h("span", { class: "num faint", title: TEXT.state[a.state] }, a.endedAt ? TEXT.tookFor(ago(a.startedAt, a.endedAt)) : ago(a.startedAt)),
      ),
    ),
  );
}

/** Dependencies as a left-to-right flow; only drawn when the session reported any. @param {Session} s */
function flowGraph(s) {
  const as = data.agents.filter((a) => a.sessionId === s.id).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  if (!as.some((a) => a.after.some((n) => agentOf(s.id, n)))) return null;
  /** @type {Map<Agent, number>} */
  const depth = new Map();
  /** @param {Agent} a @returns {number} */
  const deep = (a) => {
    const known = depth.get(a);
    if (known !== undefined) return known;
    depth.set(a, 0); // a cycle ends here instead of looping
    const parents = a.after.map((n) => agentOf(s.id, n)).filter(/** @returns {b is Agent} */ (b) => b !== undefined);
    const d = Math.max(0, ...parents.map((b) => deep(b) + 1));
    depth.set(a, d);
    return d;
  };
  as.forEach(deep);
  /** @type {Agent[][]} */
  const cols = [];
  for (const a of as) (cols[depth.get(a) ?? 0] ??= []).push(a);
  const W = 190, H = 56, GX = 54, GY = 12;
  /** @type {Map<Agent, { x: number, y: number }>} */
  const pos = new Map();
  cols.forEach((col, i) => col.forEach((a, j) => pos.set(a, { x: i * (W + GX), y: j * (H + GY) })));
  const width = cols.length * (W + GX) - GX;
  const height = Math.max(...cols.map((c) => c.length)) * (H + GY) - GY;
  const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true" });
  const defs = svgEl("defs", {});
  for (const k of ["done", "live", "wait"]) {
    const m = svgEl("marker", { id: `arrow-${k}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    m.append(svgEl("path", { d: "M0 1 L9 5 L0 9 z", class: `ah-${k}` }));
    defs.append(m);
  }
  svg.append(defs);
  for (const a of as) {
    for (const n of a.after) {
      const b = agentOf(s.id, n);
      const p = b && pos.get(b);
      const q = pos.get(a);
      if (!b || !p || !q) continue;
      const x1 = p.x + W, y1 = p.y + H / 2, x2 = q.x - 2, y2 = q.y + H / 2;
      const k = a.state === "blocked" ? "wait" : b.state === "working" ? "live" : "done";
      svg.append(svgEl("path", { d: `M${x1} ${y1} C${x1 + GX / 2} ${y1} ${x2 - GX / 2} ${y2} ${x2} ${y2}`, class: `edge e-${k}`, "marker-end": `url(#arrow-${k})` }));
    }
  }
  const flow = h(
    "div",
    { class: "flow" },
    svg,
    as.map((a) => {
      const p = pos.get(a) ?? { x: 0, y: 0 };
      const node = h("div", { class: `fnode st-${a.state}`, title: a.goal ?? a.name }, h("span", { class: "aname" }, agentDot(a), h("span", { class: "agoal" }, a.goal ?? a.name)), h("span", { class: "fact" }, agentDoing(a)));
      node.style.left = `${p.x}px`;
      node.style.top = `${p.y}px`;
      return node;
    }),
  );
  flow.style.width = `${width}px`;
  flow.style.height = `${height}px`;
  return flow;
}

/**
 * The session panel: its head, its chips (and the part one of them unfolds), then the conversation
 * with the answer box on the bottom edge.
 * @param {string} sid
 */
function openSession(sid) {
  const d = dialog("session");
  const s = S(sid);
  if (!s) return;
  if (ui.panelSession !== sid) {
    ui.panelSession = sid;
    ui.panelPart = null;
  }
  const m = metricsOf(sid);
  const part = ui.panelPart ?? "";
  const before = d.querySelector(".session-body");
  const fetched = ui.conversations.has(sid) ? "yes" : "no";
  // Opening a session, or its conversation arriving, starts at the latest message.
  const fresh = !d.open || !(before instanceof HTMLElement) || before.dataset.session !== sid || before.dataset.fetched !== fetched;
  const samePart = !fresh && before instanceof HTMLElement && before.dataset.part === part;
  const atBottom = !before || before.scrollHeight - before.scrollTop - before.clientHeight < 40;
  const scrolled = before?.scrollTop ?? 0;
  const chipsLeft = before?.querySelector(".pchips")?.scrollLeft ?? 0;
  const body = h(
    "div",
    { class: "dbody session-body", "data-key": `body-${sid}`, "data-part": part, "data-session": sid, "data-fetched": fetched },
    panelChips(s, m),
    // An open part takes the conversation's place; its chip, or the way back, closes it.
    ui.panelPart
      ? h("div", { class: "ppart" }, h("button", { class: "linkish back", onclick: () => ((ui.panelPart = null), openSession(sid)) }, TEXT.backToConversation), panelPart(s, m, d))
      : chat(s),
  );
  patch(
    d,
    h(
      "div",
      { class: "dhead" },
      h("div", {}, h("div", { class: "meta" }, where(s, s.provider)), h("h3", {}, sessionName(s))),
      h("span", { class: "spacer" }),
      s.lastMessage && (isLive(s) || s.endedAsking) ? h("button", { class: "secondary", title: TEXT.markUnreadHint, "aria-label": TEXT.markUnread, onclick: () => markUnread(s) }, icon("unread"), h("span", { class: "lbl" }, TEXT.markUnread)) : null,
      goLink(s, "primary", icon("go"), h("span", { class: "lbl" }, TEXT.goTo)),
      h("button", { class: "icon-btn", "aria-label": TEXT.close, onclick: () => d.close() }, icon("x")),
    ),
    body,
  );
  // The conversation reads bottom up: it opens at the latest message and follows new ones, unless
  // the developer scrolled up to read. A part that just unfolded is shown from its top.
  // `body` is not on the page when `patch` kept the one already shown.
  fitNewBoxes(d);
  const shownBody = d.querySelector(".session-body");
  if (samePart && shownBody) shownBody.scrollTop = scrolled;
  // The chip row scrolls sideways on a phone: a tap on a chip keeps it where it was.
  const chips = shownBody?.querySelector(".pchips");
  if (chips && !fresh) chips.scrollLeft = chipsLeft;
  if (fresh || (samePart && atBottom) || (!samePart && !ui.panelPart)) {
    // After layout, on whichever body is shown then: opening draws the panel twice in one go.
    requestAnimationFrame(() => {
      const shown = d.querySelector(".session-body");
      if (shown) shown.scrollTop = shown.scrollHeight;
    });
  }
  if (!d.open) {
    ui.panelHeard = null;
    d.showModal();
    renderPanel();
  }
}

/** What a session has said and whether it works: when it changes, its conversation is fetched again. @param {Session} s */
const heard = (s) => `${s.state} ${s.lastMessage?.at ?? ""}`;

/** Redraws the open session panel with the latest data, keeping the box being typed in. */
function renderPanel() {
  const d = dialog("session");
  const s = d.open && ui.panelSession ? S(ui.panelSession) : undefined;
  if (!s) return;
  if (unread(s) && !document.hidden && s.lastMessage && ui.readFor.get(s.id) !== s.lastMessage.at) {
    ui.readFor.set(s.id, s.lastMessage.at);
    run(post(`/api/sessions/${encodeURIComponent(s.id)}/read`));
  }
  if (ui.panelHeard !== heard(s)) {
    ui.panelHeard = heard(s);
    loadConversation(s.id, () => {});
  }
  const shows = panelShows(s);
  if (shows === ui.panelDrawn) return;
  // Redrawing under a finger stops its scroll and jumps the content; wait until it rests.
  const resting = Date.now() - ui.panelTouchedAt;
  if (resting < PANEL_REST_MS) {
    clearTimeout(ui.panelLater);
    ui.panelLater = setTimeout(renderPanel, PANEL_REST_MS - resting);
    return;
  }
  ui.panelDrawn = shows;
  openSession(s.id);
}
const PANEL_REST_MS = 1200;

/** Everything the session panel shows, to redraw it only when some of it changed. @param {Session} s */
function panelShows(s) {
  const mine = (/** @type {{ sessionId: string }} */ x) => x.sessionId === s.id;
  return JSON.stringify([
    s,
    metricsOf(s.id),
    data.agents.filter(mine),
    data.questions.filter((q) => mine(q) && q.status === "open"),
    data.listening.includes(s.id),
    data.gone.includes(s.id),
    data.services.filter(mine),
    data.results.filter(mine).map((r) => r.id),
    projectOf(s),
    ui.conversations.get(s.id)?.length,
    [...ui.draftImages, ...ui.uploading, ...ui.sending], // the box below: images attached, a message on its way
    ui.offline && offlineText(),
    [...ui.stepsOpen],
    Math.floor(Date.now() / 60_000), // times shown as "for 5 min"
  ]);
}

/**
 * The session's conversation as a chat, newest at the bottom, with the answer box under it: the
 * open question with its options, or a reply to a waiting session. What the developer wrote while
 * it worked is marked.
 * @param {Session} s
 */
function chat(s) {
  const fetched = ui.conversations.get(s.id);
  const list = fetched && fetched.length ? fetched : s.lastMessage ? [{ id: "last", sessionId: s.id, from: /** @type {const} */ ("session"), text: s.lastMessage.text, at: s.lastMessage.at }] : [];
  const whileWorking = new Set((s.sentWhileWorking ?? []).map((w) => w.text));
  const asking = data.questions.find((q) => q.status === "open" && q.sessionId === s.id);
  // At work, a session whose adapter delivers mid-turn gets the message at its next step.
  const midTurn = s.state === "working" && s.takesMessagesWhileWorking === true && isLive(s);
  const canReply = !asking && ((s.state === "waiting" && data.listening.includes(s.id)) || midTurn);
  // Until the conversation arrives, the shape of what comes before the latest message, which is known.
  const loading = !fetched ? [h("div", { class: "skel skel-msg mine", "aria-hidden": "true" }), h("div", { class: "skel skel-msg", "aria-hidden": "true" })] : null;
  return [
    h(
      "div",
      { class: "conversation chat", "aria-busy": !fetched },
      loading,
      list.length ? conversationView(list, whileWorking) : fetched ? h("div", { class: "faint" }, TEXT.conversation.none) : null,
      workingNow(s, list),
    ),
    h(
      "div",
      { class: "chat-footer" },
      // The window covers the strip that says it elsewhere.
      ui.offline ? h("div", { class: "offline-line", role: "status" }, offlineText()) : null,
      asking
        ? h(
            "div",
            { class: "panel-question" },
            h("div", { class: "meta" }, badge(asking.kind), h("span", { class: "spacer" }), h("button", { class: "linkish", onclick: () => answerOnDesk(asking.id) }, TEXT.conversation.openQuestion)),
            h("div", { class: "qtext" }, md(headline(asking.text))),
            answerForm(asking),
          )
        : // One box whatever the session does, inert while it cannot take a message: the panel's foot never jumps.
          replyBox(`message-${s.id}`, [], `/api/sessions/${s.id}/message`, s.id, {
            placeholder: canReply ? (midTurn ? TEXT.workingPlaceholder : undefined) : s.state === "working" ? TEXT.workingNoMessages : TEXT.notListeningShort,
            hint: midTurn ? TEXT.sendHintWorking : undefined,
            off: canReply ? null : s.state === "working" ? TEXT.conversation.working : TEXT.notListening,
          }),
    ),
  ];
}

/**
 * The work in progress, last in the conversation: how long the turn has run since the developer's
 * last message, what it does now and its agents that have not finished, so a session at work (or
 * whose agents still run after its turn) never looks finished.
 * @param {Session} s @param {{ from: string, at: string }[]} list
 */
function workingNow(s, list) {
  const agents = sessionAgents(s.id).filter((a) => a.state !== "done");
  const turn = s.state === "working";
  if (!turn && !agents.some((a) => a.state === "working" || a.state === "waiting")) return null;
  const since = list.findLast((m) => m.from === "developer")?.at;
  return h(
    "div",
    { class: "msg from-session working-now" },
    h(
      "div",
      { class: "msg-meta" },
      h("span", { class: "live" }, dot("working")),
      " ",
      turn ? TEXT.conversation.workingFor(since ? ago(since) : "") : TEXT.conversation.agentsAtWork(agents.length),
      sessionQuiet(s) ? h("span", { class: "astuck" }, ` · ${TEXT.quietFor(sessionQuiet(s))}`) : null,
    ),
    turn && s.activity ? h("div", { class: "adoing", title: s.activity }, s.activity) : null,
    agents.length
      ? h(
          "details",
          { class: "agents-fold", open: ui.agentsOpen.has(s.id) },
          // Kept on the click itself: a redraw between the click and its toggle event would fold it again.
          h(
            "summary",
            { onclick: () => (ui.agentsOpen.has(s.id) ? ui.agentsOpen.delete(s.id) : ui.agentsOpen.add(s.id)) },
            TEXT.chips.agents(agents.length, agents.filter((a) => a.state === "failed").length),
          ),
          agentRows(agents),
        )
      : null,
  );
}

/** Back to the list with the session new again: left open, the panel would mark it read at once. @param {Session} s */
function markUnread(s) {
  dialog("session").close();
  ui.readFor.delete(s.id);
  run(post(`/api/sessions/${encodeURIComponent(s.id)}/unread`));
}

/** Closes the session panel and shows the question large on the desk. @param {string} questionId */
function answerOnDesk(questionId) {
  ui.sel = questionId;
  showNeedsYou();
}
/** Back to the desk, on what needs the developer: nothing left open on top of it. */
function showNeedsYou() {
  ui.view = "desk";
  ui.tab = "inbox";
  for (const id of ["result", "session", "zoom"]) dialog(id).close();
  render();
  revealNext("start");
}

/** Its agents: the flow when they depend on each other, then one row each. @param {Session} s */
function agentsPart(s) {
  const flow = flowGraph(s);
  return [flow ? h("div", { class: "rsec flow-sec" }, h("h4", {}, TEXT.flow), h("div", { class: "flow-wrap" }, flow)) : null, h("div", { class: "rsec" }, agentList(s))];
}

/** Everything else, rarely needed: terminal keys, worktrees, details. @param {Session} s @param {Metrics | undefined} m */
function morePart(s, m) {
  const p = projectOf(s);
  return [
    controlSection(s),
    p ? h("div", { class: "rsec" }, h("h4", {}, TEXT.worktrees.title), h("button", { class: "linkish", onclick: () => openProject(p.id) }, TEXT.worktreeLine(p.worktrees.length, gb(p.totalBytes), mergedOf(p).length))) : null,
    h(
      "div",
      { class: "rsec" },
      h("h4", {}, TEXT.details),
      sessionDetails(s, m),
      h("div", { class: "faint mono" }, [s.project.dir, s.terminal && (TERMINAL_NAMES[s.terminal] ?? s.terminal), TEXT.running(ago(s.startedAt))].filter(Boolean).join(" · ")),
    ),
  ];
}

// ---------- Projects: worktrees on disk ----------
const WARN_BYTES = 5e9;
/** @param {Worktree[]} ws */
const sum = (ws) => ws.reduce((n, w) => n + w.bytes, 0);
/** @param {ProjectScan} p */
const mergedOf = (p) => p.worktrees.filter((w) => !w.main && w.merged);
const projectsInView = () => data.projects.filter((p) => ui.project === null || p.name === ui.project);
/** @param {Session} s */
const projectOf = (s) => data.projects.find((p) => p.dir === s.project.dir);
/** Worth a chip: a lot to reclaim, or a lot of growth today. @param {ProjectScan} p */
const worthWarning = (p) => sum(mergedOf(p)) > WARN_BYTES || p.totalBytes - p.dayStart.bytes > WARN_BYTES;

/** A project's checkouts: what is already merged (and can go), what is not, and the main one. @param {string} projectId */
function openProject(projectId) {
  const p = data.projects.find((x) => x.id === projectId);
  if (!p) return;
  ui.panelSession = null;
  const d = dialog("session");
  const t = TEXT.worktrees;
  const base = p.baseBranch ?? "main";
  const merged = mergedOf(p).sort((a, b) => b.bytes - a.bytes);
  const open = p.worktrees.filter((w) => !w.main && !w.merged).sort((a, b) => (b.ahead ?? 0) - (a.ahead ?? 0));
  const main = p.worktrees.filter((w) => w.main);
  const name = (/** @type {Worktree} */ w) => w.path.split("/").at(-1) ?? w.path;
  /** @param {Worktree[]} ws @param {(w: Worktree) => string} note */
  const rows = (ws, note) =>
    h("div", { class: "alist wt-list" }, ws.map((w) => h("div", { class: "arow", title: w.path }, h("span", { class: "awhat" }, h("span", { class: "agoal" }, w.branch ?? t.detached), h("span", { class: "adoing" }, `${name(w)} · ${note(w)}`)), h("span", { class: "num faint" }, gb(w.bytes)))));
  const grew = p.totalBytes - p.dayStart.bytes;
  // Paths come from git's own listing; quoted for the shell the developer pastes them into.
  const cleanup = merged.map((w) => `git -C '${p.dir.replace(/'/g, "'\\''")}' worktree remove '${w.path.replace(/'/g, "'\\''")}'`).join("\n");
  d.replaceChildren(
    h("div", { class: "dhead" }, h("div", {}, h("div", { class: "meta" }, projectMark(p.name)), h("h3", {}, t.title)), h("span", { class: "spacer" }), h("button", { class: "icon-btn", "aria-label": TEXT.close, onclick: () => d.close() }, icon("x"))),
    h(
      "div",
      { class: "dbody" },
      h("div", { class: "status" }, h("span", {}, t.summary(gb(p.totalBytes), grew > 1e8 ? gb(grew) : "", ago(p.measuredAt)))),
      merged.length
        ? h("div", { class: "rsec" }, h("h4", {}, t.merged(base, merged.length, gb(sum(merged)))), rows(merged, () => ""), h("div", { class: "row wt-actions" }, h("button", { class: "secondary", onclick: () => copy(cleanup) }, icon("copy"), t.copyCleanup), h("span", { class: "faint" }, t.cleanupNote)))
        : null,
      open.length ? h("div", { class: "rsec" }, h("h4", {}, t.open(open.length)), rows(open, (w) => (w.ahead !== undefined ? t.ahead(w.ahead) : ""))) : null,
      h("div", { class: "rsec" }, h("h4", {}, t.main), rows(main, (w) => w.branch ?? "")),
      p.problems.length ? h("div", { class: "rsec faint" }, p.problems.join("\n")) : null,
    ),
  );
  if (!d.open) d.showModal();
}

// ---------- Result dialog, compare and zoom ----------
/** @param {Result} r @param {{ markSeen?: boolean }} [opts] */
function openResult(r, { markSeen = true } = {}) {
  const d = dialog("result");
  const s = S(r.sessionId);
  // Only a click marks a result seen: a link from elsewhere (#r=…) must not write anything.
  if (markSeen && isNew(r)) run(post(`/api/results/${r.id}/seen`));
  const imgs = r.images.map((i) => ({ src: `/images/${i.id}`, cap: i.caption ?? "" }));
  const before = r.compare && imgs[r.images.findIndex((i) => i.id === r.compare?.before)];
  const after = r.compare && imgs[r.images.findIndex((i) => i.id === r.compare?.after)];
  let mode = before && after ? "slider" : "side";
  const viewer = h("div", { class: "viewer" });
  const drawViewer = () => {
    const tools = h(
      "div",
      { class: "vtools" },
      before && after
        ? h("div", { class: "seg" }, (/** @type {const} */ ([["slider", TEXT.slider], ["side", TEXT.sideBySide]])).map(([k, l]) => h("button", { "aria-pressed": String(mode === k), onclick: () => ((mode = k), drawViewer()) }, l)))
        : null,
      h("span", { class: "faint" }, h("span", { class: "mouse-only" }, TEXT.zoomHint), h("span", { class: "touch-only" }, TEXT.zoomHintTouch)),
    );
    viewer.replaceChildren(
      tools,
      mode === "slider" && before && after
        ? compareView(before, after, gallery)
        : h("div", { class: "vimgs" }, imgs.map(({ src, cap }, i) => h("figure", {}, h("img", { src, alt: cap, onclick: () => zoom(gallery, i) }), cap ? h("figcaption", {}, cap) : null))),
    );
  };
  const gallery = imgs.map(({ src, cap }) => ({ src, caption: cap ? `${r.title} · ${cap}` : r.title }));
  if (imgs.length) drawViewer();
  /** @param {string} title @param {string[]} items */
  const list = (title, items) => (items.length ? h("div", { class: "rsec" }, h("h4", {}, title), h("ul", { class: "plain" }, items.map((a) => h("li", {}, md(a))))) : null);
  d.replaceChildren(
    h(
      "div",
      { class: "dhead" },
      h("div", {}, h("div", { class: "meta" }, badge(r.status === "failed" ? "failed" : "result"), where(s), h("span", {}, `· ${hm(r.at)}`)), h("h3", {}, r.title)),
      h("span", { class: "spacer" }),
      r.url ? localLink(r.url, [icon("link"), TEXT.openLive], "secondary") : null,
      goLink(s, "primary", icon("go"), TEXT.goTo),
      h("button", { class: "icon-btn", "aria-label": TEXT.close, onclick: () => d.close() }, icon("x")),
    ),
    h(
      "div",
      { class: "dbody" },
      imgs.length ? viewer : null,
      r.summary ? h("div", { class: "rsec" }, h("p", { class: "lead" }, md(r.summary))) : null,
      list(TEXT.assumed, r.assumptions),
      list(TEXT.taste, r.decisions),
      r.checks.length
        ? h("div", { class: "rsec" }, h("h4", {}, TEXT.criteria), h("table", { class: "crit" }, h("tbody", {}, r.checks.map((c) => h("tr", {}, h("td", {}, dot("done")), h("td", {}, md(c.criterion)), h("td", { class: "muted" }, md(c.verification)))))))
        : null,
    ),
  );
  if (!d.open) d.showModal();
}

/** @param {{ src: string, cap: string }} a @param {{ src: string, cap: string }} b @param {Picture[]} gallery */
function compareView(a, b, gallery) {
  const top = h("img", { src: b.src, alt: b.cap, class: "top" });
  const line = h("div", { class: "line" });
  /** @param {string} v */
  const set = (v) => {
    top.style.clipPath = `inset(0 0 0 ${v}%)`;
    line.style.left = `${v}%`;
  };
  const range = h("input", { type: "range", min: 0, max: 100, value: 50, "aria-label": `${a.cap} / ${b.cap}`, oninput: (e) => set(/** @type {HTMLInputElement} */ (e.target).value) });
  const box = h("div", { class: "compare" }, h("img", { src: a.src, alt: a.cap, onclick: () => zoom(gallery, Math.max(0, gallery.findIndex((g) => g.src === a.src))) }), top, line, h("span", { class: "tagl" }, a.cap), h("span", { class: "tagr" }, b.cap));
  set("50");
  return h("div", { class: "cmp" }, box, range);
}

/** @typedef {{ src: string, caption: string }} Picture */

/**
 * Full-screen viewer for a result's pictures: wheel, pinch and drag to zoom and pan; ← → or a
 * sideways swipe (at fit size) to move between pictures; a click on the backdrop closes it.
 * @param {Picture[]} gallery @param {number} start
 */
function zoom(gallery, start) {
  const d = dialog("zoom");
  let index = start;
  const img = h("img", { alt: "" });
  const stage = h("div", { class: "zstage" }, img);
  let k = 1, x = 0, y = 0, moved = 0, fitK = 1;
  /** @type {[number, number] | null} */
  let drag = null;
  /** @type {[number, number] | null} */
  let swipeFrom = null;
  const pct = h("span", { class: "num zfine" });
  const caption = h("span", { class: "faint zcaption" });
  const counter = h("span", { class: "num faint zcount" });
  const apply = () => {
    img.style.transform = `translate(${x}px, ${y}px) scale(${k}) translate(-50%, -50%)`;
    pct.textContent = `${Math.round(k * 100)} %`;
  };
  const fit = () => {
    fitK = Math.min((innerWidth * 0.9) / img.naturalWidth, (innerHeight * 0.82) / img.naturalHeight, 2);
    k = fitK;
    x = y = 0;
    apply();
  };
  /** @param {number} i */
  const show = (i) => {
    index = (i + gallery.length) % gallery.length;
    const picture = gallery[index];
    if (!picture) return;
    img.src = picture.src;
    img.alt = picture.caption;
    caption.textContent = picture.caption;
    counter.textContent = gallery.length > 1 ? `${index + 1} / ${gallery.length}` : "";
  };
  img.onload = fit;
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    k = Math.min(8, Math.max(0.1, k * Math.exp(-e.deltaY * 0.0022)));
    apply();
  }, { passive: false });
  // Two fingers on a touch screen pinch the image; one finger or the mouse drags it.
  /** @type {Map<number, [number, number]>} */
  const touches = new Map();
  let spread = 0;
  const distance = () => {
    const [a, b] = [...touches.values()];
    return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 0;
  };
  const atFit = () => k <= fitK * 1.05;
  stage.addEventListener("pointerdown", (e) => {
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    stage.setPointerCapture(e.pointerId);
    if (touches.size === 1) {
      drag = [e.clientX - x, e.clientY - y];
      swipeFrom = atFit() && gallery.length > 1 ? [e.clientX, e.clientY] : null;
      moved = 0;
    } else {
      drag = null;
      swipeFrom = null;
      spread = distance();
      moved = Infinity; // a pinch never closes the zoom
    }
  });
  stage.addEventListener("pointermove", (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (touches.size === 2) {
      const now = distance();
      if (spread && now) k = Math.min(8, Math.max(0.1, (k * now) / spread));
      spread = now;
      apply();
      return;
    }
    if (!drag) return;
    moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    x = e.clientX - drag[0];
    y = e.clientY - drag[1];
    apply();
  });
  /** @param {PointerEvent} e */
  const release = (e) => {
    touches.delete(e.pointerId);
    drag = null;
    if (e.type !== "pointerup" || touches.size) return;
    const from = swipeFrom;
    swipeFrom = null;
    if (from) {
      const dx = e.clientX - from[0];
      const dy = e.clientY - from[1];
      if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) return show(index + (dx < 0 ? 1 : -1));
    }
    if (moved < 4 && e.target === stage) d.close();
  };
  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);
  d.onkeydown = (e) => {
    if (e.key === "ArrowRight") show(index + 1);
    else if (e.key === "ArrowLeft") show(index - 1);
    else return;
    e.preventDefault();
  };
  const many = gallery.length > 1;
  d.replaceChildren(
    stage,
    h(
      "div",
      { class: "zbar" },
      many ? h("button", { onclick: () => show(index - 1), "aria-label": TEXT.zoom.previous }, "‹") : null,
      many ? counter : null,
      many ? h("button", { onclick: () => show(index + 1), "aria-label": TEXT.zoom.next }, "›") : null,
      // A finger pinches instead: on touch screens the step buttons give their room to the caption.
      h("button", { class: "zfine", onclick: () => ((k /= 1.25), apply()), "aria-label": TEXT.zoom.out }, "−"),
      pct,
      h("button", { class: "zfine", onclick: () => ((k *= 1.25), apply()), "aria-label": TEXT.zoom.in }, "+"),
      h("button", { onclick: fit }, TEXT.zoom.fit),
      h("button", { class: "zfine", onclick: () => ((k = 1), (x = y = 0), apply()) }, "100 %"),
      caption,
      h("button", { onclick: () => d.close(), "aria-label": TEXT.close }, icon("x")),
    ),
  );
  show(start);
  d.showModal();
}

// ---------- History ----------
/** @param {string} text @param {string} q */
function highlight(text, q) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  return i < 0 ? text : [text.slice(0, i), h("mark", {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
}
/**
 * @typedef {{ at: string, sid: string, type: "decision" | "result", kind: keyof typeof TEXT.kinds,
 *   title: string, answer?: string, viaDesk?: boolean, images?: string[], note?: string, result?: Result }} Entry
 */
function historyView() {
  const q = ui.hq.trim();
  const t = TEXT.history;
  /** @type {Entry[]} */
  const decisions = data.questions
    .filter((x) => x.status !== "open")
    .map((x) => ({
      at: x.closedAt ?? x.askedAt,
      sid: x.sessionId,
      type: "decision",
      kind: x.status === "dismissed" ? "dismissed" : x.kind === "permission" ? "permission" : "decision",
      title: x.text,
      ...(x.answer ? { answer: x.answer.text, viaDesk: x.answer.via === "desk", images: x.answer.images ?? [] } : {}),
      ...(x.interpretation ? { note: x.interpretation } : {}),
    }));
  /** @type {Entry[]} */
  const results = data.results.map((r) => ({ at: r.at, sid: r.sessionId, type: "result", kind: r.status === "failed" ? "failed" : "result", title: r.title, note: r.summary, result: r }));
  const entries = [...decisions, ...results]
    .filter((e) => inProject(e.sid))
    .filter((e) => ui.hfilter === "all" || e.type === ui.hfilter)
    .filter((e) => !q || [e.title, e.answer, e.note, label(S(e.sid))].join(" ").toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.at.localeCompare(a.at));
  const input = h("input", {
    value: ui.hq,
    placeholder: t.search,
    "aria-label": t.search,
    "data-key": "history-search",
    oninput: (e) => {
      ui.hq = /** @type {HTMLInputElement} */ (e.target).value;
      /** @type {HTMLInputElement} */ (byId("q")).value = ui.hq;
      renderView();
    },
  });
  const count = h("div", { class: "faint" }, t.entries(entries.length));
  count.style.marginTop = "10px";
  return h(
    "div",
    { class: "page", "data-scroll": "history" },
    h(
      "div",
      { class: "wrap" },
      h("h1", { class: "title" }, t.title),
      h("div", { class: "hsearch" }, h("label", { class: "search" }, input), h("div", { class: "seg" }, (/** @type {const} */ ([["all", t.all], ["decision", t.decisions], ["result", t.results]])).map(([k, l]) => h("button", { "aria-pressed": String(ui.hfilter === k), onclick: () => ((ui.hfilter = k), render()) }, l)))),
      count,
      entries.length
        ? h("div", { class: "hlist" }, entries.map((e) => {
            const open = e.result;
            return h(
              open ? "button" : "div",
              { class: `hitem${open ? " open" : ""}`, onclick: open ? () => openResult(open) : null },
              h("div", { class: "hwhen" }, dayLabel(e.at)),
              h(
                "div",
                {},
                h("div", { class: "meta" }, badge(e.kind), label(S(e.sid))),
                h("div", { class: "hq" }, highlight(e.title, q)),
                e.answer !== undefined ? h("div", { class: "ha" }, t.answer, h("b", {}, highlight(e.answer, q)), e.viaDesk ? t.viaDesk : "") : null,
                e.images?.length ? attachedImages(e.images) : null,
                e.note ? h("div", { class: "hi" }, e.type === "decision" ? t.understood : "", highlight(e.note, q)) : null,
              ),
            );
          }))
        : h("div", { class: "empty" }, t.none(q)),
    ),
  );
}
/** @param {string} iso */
function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 864e5);
  const t = TEXT.history;
  return days <= 0 ? `${t.today} ${hm(iso)}` : days === 1 ? `${t.yesterday} ${hm(iso)}` : `${d.toLocaleDateString(TEXT.locale, { day: "numeric", month: "short" })} ${hm(iso)}`;
}

// ---------- Render ----------
/**
 * Redraws the view: only what changed changes, so the scroll of every part, the focused element, the
 * text selected and what is under the pointer stay; cards that come, go or move are animated.
 */
function renderView() {
  document.body.dataset.tab = ui.tab;
  const view = byId("view");
  const placeholder = view.querySelector(".board[aria-busy]") !== null;
  /** @type {Map<string, number>} */
  const scrolls = new Map();
  for (const el of view.querySelectorAll("[data-scroll]")) if (el instanceof HTMLElement && el.dataset.scroll) scrolls.set(el.dataset.scroll, el.scrollTop);
  const pageScroll = window.scrollY;
  animateLists(view, () => {
    patch(view, !ui.loaded ? skeleton() : ui.view === "history" ? historyView() : board());
    fitNewBoxes(view);
  });
  for (const el of view.querySelectorAll("[data-scroll]")) {
    const top = el instanceof HTMLElement && el.dataset.scroll ? scrolls.get(el.dataset.scroll) : undefined;
    if (top !== undefined) el.scrollTop = top;
  }
  window.scrollTo(0, pageScroll);
  // The first data takes the placeholders' place by fading in, not in one frame.
  if (placeholder && ui.loaded) fadeIn(view.firstElementChild, byId("needs-pill"), byId("strip"));
}

/**
 * The inbox on the left; the sessions and what to review on the right. On a phone one of them at a
 * time, chosen in the tab bar.
 */
function board() {
  const reviewEmpty = !data.results.some((r) => inProject(r.sessionId) && isNew(r) && r.status !== "failed");
  return h("main", { class: `board${reviewEmpty ? " review-empty" : ""}`, "data-tab": ui.tab }, inboxColumn(), splitter(), sessionsColumn(), reviewColumn());
}

// The right column's width, set by dragging the line before it; kept in this browser.
const SIDE_KEY = "agent-desk:side-width";
const SIDE_MIN = 280;
const SIDE_DEFAULT = 400; // style.css's --side-w
const SIDE_STEP = 16;
/** @param {number | null} px */
function setSide(px) {
  if (px === null) {
    localStorage.removeItem(SIDE_KEY);
    document.documentElement.style.removeProperty("--side-w");
    return;
  }
  localStorage.setItem(SIDE_KEY, String(Math.round(px)));
  document.documentElement.style.setProperty("--side-w", `${Math.round(px)}px`);
}
const savedSide = Number(localStorage.getItem(SIDE_KEY));
if (savedSide) document.documentElement.style.setProperty("--side-w", `${Math.round(savedSide)}px`);

/** The line between the inbox and the right column: dragged, or moved with ← →, it resizes them. */
function splitter() {
  return h("div", {
    class: "split",
    title: TEXT.splitTitle,
    role: "separator",
    tabindex: "0",
    "aria-orientation": "vertical",
    "aria-label": TEXT.splitLabel,
    "aria-valuemin": SIDE_MIN,
    "aria-valuenow": Number(localStorage.getItem(SIDE_KEY)) || SIDE_DEFAULT,
    onpointerdown: (e) => {
      const handle = e.currentTarget;
      const board = handle instanceof HTMLElement ? handle.parentElement : null;
      if (!(handle instanceof HTMLElement) || !board || !(e instanceof PointerEvent)) return;
      e.preventDefault();
      const right = board.getBoundingClientRect().right - parseFloat(getComputedStyle(board).paddingRight);
      const half = handle.offsetWidth / 2; // read once: a redraw during the drag must not shift the line
      const move = (/** @type {PointerEvent} */ m) => {
        setSide(Math.max(SIDE_MIN, right - m.clientX - half));
        handle.setAttribute("aria-valuenow", localStorage.getItem(SIDE_KEY) ?? "");
      };
      const up = () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        document.body.classList.remove("resizing");
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
      document.body.classList.add("resizing");
    },
    onkeydown: (e) => {
      const step = e instanceof KeyboardEvent ? { ArrowLeft: SIDE_STEP, ArrowRight: -SIDE_STEP }[e.key] : undefined;
      const side = document.querySelector(".board > .col-sessions");
      if (!step || !side || !(e.currentTarget instanceof HTMLElement)) return;
      e.preventDefault();
      setSide(Math.max(SIDE_MIN, side.getBoundingClientRect().width + step));
      e.currentTarget.setAttribute("aria-valuenow", localStorage.getItem(SIDE_KEY) ?? "");
    },
    ondblclick: () => setSide(null),
  });
}

/** The desk's shape while the first data arrives. */
function skeleton() {
  /** @param {string} key @param {number[]} heights */
  const col = (key, heights) =>
    h("section", { class: `col col-${key}` }, h("div", { class: "col-head" }, h("span", { class: "skel", style: "width:90px;height:14px" })), h("div", { class: "col-body" }, heights.map((px) => h("div", { class: "skel", style: `height:${px}px` }))));
  return h("main", { class: "board", "aria-busy": "true", "data-tab": ui.tab }, col("needs", [230, 54, 54]), col("sessions", [104, 132, 104]), col("review", [150]));
}
function render() {
  renderHeader();
  renderStrip();
  renderView();
  renderPanel();
}

/** Runs a page action; a failure is shown, never swallowed. @param {Promise<unknown>} p @param {() => void} [always] */
function run(p, always) {
  p.catch((/** @type {Error} */ e) => toast(e.message)).finally(() => {
    always?.();
    render();
  });
}

// ---------- Wiring ----------
// A page error is shown, never left in the console only.
// Browsers inject scripts of their own (Firefox and Brave for iOS: reader mode), and WebKit reports
// their errors against the page's address; only errors from the page's own script files are its own.
addEventListener("error", (e) => {
  if (e.filename.startsWith(`${location.origin}/`) && e.filename.endsWith(".js")) toast(TEXT.pageError(e.message));
});
addEventListener("unhandledrejection", (e) => toast(TEXT.pageError(e.reason instanceof Error ? e.reason.message : String(e.reason))));
/**
 * iOS ignores interactive-widget: its keyboard covers the page, whose layout keeps its height. Only the
 * visual viewport knows what is left, so the layout is told, and the box being typed in brought above it.
 * Android resizes the layout instead. On both, `data-keyboard` says a keyboard is up, and `data-compact`
 * that the screen is short (that, or landscape), for style.css.
 */
function followKeyboard() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  const short = matchMedia("(max-height: 500px)");
  let covered = 0;
  let up = false;
  let tallest = 0;
  let wide = 0;
  const follow = () => {
    if (vv && vv.scale > 1.01) return; // a pinch shrinks the visual viewport too, with no keyboard
    const box = document.activeElement;
    const typing = box instanceof HTMLTextAreaElement || (box instanceof HTMLInputElement && /^(text|search|email|url|tel|password|number)$/.test(box.type));
    let keyboard = 0;
    let raised = false;
    if (vv) {
      // Against the layout's height: on iOS innerHeight shrinks with the keyboard too. Less than this is a browser's toolbar.
      const gap = Math.round(root.clientHeight - vv.height);
      keyboard = gap > 80 ? gap : 0;
      // Android shrinks the layout with the keyboard, so only the height lost since the tallest seen in this orientation tells.
      if (Math.abs(vv.width - wide) > 1) [wide, tallest] = [vv.width, 0];
      tallest = Math.max(tallest, vv.height);
      raised = COARSE.matches && typing && (keyboard > 0 || tallest - vv.height > 150);
      root.style.setProperty("--keyboard", `${keyboard}px`);
      root.style.setProperty("--viewport-top", `${Math.round(vv.offsetTop)}px`);
      if (keyboard) root.style.setProperty("--viewport-height", `${Math.round(vv.height)}px`);
      else root.style.removeProperty("--viewport-height");
    }
    root.toggleAttribute("data-keyboard", raised);
    root.toggleAttribute("data-compact", raised || short.matches);
    if (keyboard === covered && raised === up) return;
    covered = keyboard;
    up = raised;
    if (!(keyboard || raised) || !(box instanceof HTMLTextAreaElement)) return;
    const chat = box.closest(".session-body");
    if (chat) chat.scrollTop = chat.scrollHeight;
    else if (vv) window.scrollBy(0, Math.max(0, box.getBoundingClientRect().bottom + 16 - (vv.offsetTop + vv.height)));
  };
  follow();
  vv?.addEventListener("resize", follow);
  vv?.addEventListener("scroll", follow);
  short.addEventListener("change", follow);
  // The keyboard comes and goes with the focus; measured once the focus has settled on its new element.
  for (const event of ["focusin", "focusout"]) document.addEventListener(event, () => requestAnimationFrame(follow));
}

// ---------- Alerts: desktop notifications and sound, each switched off on the page ----------
const ALERTS = { notify: "agent-desk:notify", sound: "agent-desk:sound", failures: "agent-desk:failures" };
const ALERTS_ON = { notify: true, sound: true, failures: false };
/** As the developer set it in this browser, or its default. @param {keyof typeof ALERTS} k */
const alertOn = (k) => {
  const set = localStorage.getItem(ALERTS[k]);
  return set === null ? ALERTS_ON[k] : set !== "off";
};
/** @type {AudioContext | null} */
let audio = null;
/** Browsers keep a page's audio muted until it is clicked once: the first click unmutes the chime. */
addEventListener(
  "pointerdown",
  () => {
    audio ??= new AudioContext();
    if (audio.state === "suspended") audio.resume().catch((/** @type {Error} */ e) => toast(TEXT.pageError(e.message)));
  },
  { capture: true },
);
/** Two short notes made by the browser, no file to load. */
function chime() {
  if (!alertOn("sound") || !audio || audio.state !== "running") return;
  const t = audio.currentTime;
  [880, 1320].forEach((freq, i) => {
    if (!audio) return;
    const start = t + i * 0.12;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
    osc.connect(gain).connect(audio.destination);
    osc.start(start);
    osc.stop(start + 0.32);
  });
}
function renderAlerts() {
  const can = "Notification" in window;
  const allowed = can && Notification.permission === "granted";
  const notifyOn = alertOn("notify") && allowed;
  const button = byId("alerts");
  button.title = TEXT.alerts.title;
  button.setAttribute("aria-label", TEXT.alerts.title);
  button.replaceChildren(icon((ON_THIS_MACHINE ? notifyOn : pushOn === true) || alertOn("sound") ? "bell" : "bellOff"));
  /** @param {keyof typeof ALERTS} k @param {string} text @param {string} hint @param {boolean} checked @param {boolean} disabled */
  const row = (k, text, hint, checked, disabled) => {
    const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", disabled }));
    box.checked = checked;
    box.addEventListener("change", () => {
      localStorage.setItem(ALERTS[k], box.checked ? "on" : "off");
      if (k === "notify" && box.checked && Notification.permission === "default") run(Notification.requestPermission().then(renderAlerts));
      if (k === "sound" && box.checked) chime();
      renderAlerts();
    });
    return h("label", { class: disabled ? "off" : "" }, box, h("span", {}, text), h("small", {}, hint));
  };
  byId("alerts-menu").replaceChildren(
    // One notifications switch per device: the page's own on the computer, push on the phone.
    ON_THIS_MACHINE ? row("notify", TEXT.alerts.notify, !can ? TEXT.alerts.unavailable : Notification.permission === "denied" ? TEXT.alerts.blocked : TEXT.alerts.notifyHint, notifyOn, !can || Notification.permission === "denied") : pushRow(),
    row("sound", TEXT.alerts.sound, TEXT.alerts.soundHint, alertOn("sound"), false),
    row("failures", TEXT.alerts.failures, TEXT.alerts.failuresHint, alertOn("failures"), false),
  );
}
/**
 * A header button that opens its menu; a click anywhere else closes it. The path is read as
 * dispatched, since a choice made in the menu redraws it. @param {string} buttonId @param {string} menuId @param {() => void} fill
 */
function headerMenu(buttonId, menuId, fill) {
  const menu = byId(menuId);
  byId(buttonId).onclick = () => {
    menu.hidden = !menu.hidden;
    if (!menu.hidden) fill();
  };
  document.addEventListener("click", (e) => {
    if (!menu.hidden && menu.parentElement && !e.composedPath().includes(menu.parentElement)) menu.hidden = true;
  });
}
// ---------- Push: notifications on a phone that is locked, from the computer ----------
/** Whether this device is subscribed; null until known. @type {boolean | null} */
let pushOn = null;
/** @type {PushSubscription | null} */
let pushSubscription = null;
let pushRenewed = false;
const canPush = "serviceWorker" in navigator && "PushManager" in window;
if (canPush && !ON_THIS_MACHINE) {
  run(navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then((sub) => ((pushOn = sub !== null), (pushSubscription = sub), renderAlerts())));
}
/** Once per load, when the desk answers: tells it this device has the PIN in, and until when (a new unlock reloads the page). */
function renewPush() {
  if (pushRenewed || !pushSubscription) return;
  pushRenewed = true;
  run(post("/api/push/subscribe", pushSubscription.toJSON()));
}
/** The row that subscribes this phone; on iOS push exists only in the app added to the Home Screen. */
function pushRow() {
  const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", disabled: !canPush || pushOn === null }));
  box.checked = pushOn === true;
  box.addEventListener("change", () => run((box.checked ? subscribePush() : unsubscribePush()).then(() => ((pushOn = box.checked), renderAlerts())), renderAlerts));
  return h("label", { class: canPush ? "" : "off" }, box, h("span", {}, TEXT.alerts.push), h("small", {}, canPush ? TEXT.alerts.pushHint : TEXT.alerts.pushInstall));
}
async function subscribePush() {
  // Asked first, inside the tap: iOS grants the permission only from a gesture.
  if ((await Notification.requestPermission()) !== "granted") throw new Error(TEXT.alerts.pushDenied);
  const res = await fetch("/api/push/key");
  if (!res.ok) throw new Error(`push key: ${res.status} ${res.statusText}`);
  const { key } = /** @type {{ key: string }} */ (await res.json());
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)) });
  await post("/api/push/subscribe", sub.toJSON());
  pushSubscription = sub;
  pushRenewed = true;
}
async function unsubscribePush() {
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  if (!sub) return;
  await post("/api/push/unsubscribe", { endpoint: sub.endpoint });
  await sub.unsubscribe();
  pushSubscription = null;
}

headerMenu("alerts", "alerts-menu", renderAlerts);
renderAlerts();

const THEMES = /** @type {const} */ (["auto", "light", "dark"]);
/** The display menu: theme and text size, each kept in this browser. */
function renderDisplay() {
  const root = document.documentElement;
  const shown = root.dataset.theme;
  applyDisplay();
  if (root.dataset.theme !== shown) {
    // The colours change in one frame: transitions held for it, so no control fades on its own.
    root.classList.add("theme-switching");
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
  }
  const theme = THEMES.find((x) => x === localStorage.getItem("agent-desk:theme")) ?? "auto";
  const sizes = Object.keys(TEXT_SIZES);
  const size = sizes.find((x) => x === localStorage.getItem("agent-desk:text")) ?? "normal";
  const button = byId("theme");
  button.title = TEXT.display.title;
  button.setAttribute("aria-label", TEXT.display.title);
  // Settings, not a light/dark switch: the menu holds the theme and the text size.
  button.replaceChildren(icon("sliders"), h("span", { class: "lbl" }, TEXT.display.title));
  /** @param {string} key @param {string} value @param {string} current @param {Node | string} text @param {string} [name] */
  const choice = (key, value, current, text, name) =>
    h("button", { "aria-pressed": String(value === current), "aria-label": name, title: name, onclick: () => (localStorage.setItem(key, value), renderDisplay()) }, text);
  byId("display-menu").replaceChildren(
    h("div", { class: "menu-row" }, h("span", {}, TEXT.display.theme), h("div", { class: "seg" }, THEMES.map((t) => choice("agent-desk:theme", t, theme, h("span", { class: "row-i" }, icon(t === "auto" ? "auto" : t === "light" ? "sun" : "moon"), TEXT.theme[t]))))),
    h("div", { class: "menu-row" }, h("span", {}, TEXT.display.text), h("div", { class: "seg sizes" }, sizes.map((k, i) => choice("agent-desk:text", k, size, h("span", { class: `a${i}` }, "A"), TEXT.display.sizes(k))))),
  );
}
headerMenu("theme", "display-menu", renderDisplay);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderDisplay);
byId("q").addEventListener("input", (e) => {
  ui.hq = /** @type {HTMLInputElement} */ (e.target).value;
  ui.view = "history";
  render();
  focusHistorySearch();
});
/** The typing carries on in History's own box, the header's being hidden there. */
function focusHistorySearch() {
  const box = document.querySelector('[data-key="history-search"]');
  if (!(box instanceof HTMLInputElement)) return;
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}
document.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]")) return;
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "");
  if (e.key === "/" && !typing) {
    e.preventDefault();
    if (ui.view === "history") focusHistorySearch();
    else byId("q").focus();
    return;
  }
  if (typing || ui.view !== "desk") return;
  const list = openQuestions();
  const i = list.findIndex((q) => q.id === ui.sel);
  if (/^[1-9]$/.test(e.key)) {
    // 1–9 pick an option of the large card; the box keeps focus so Ctrl+Enter sends it.
    const option = document.querySelectorAll(".next .opts button")[Number(e.key) - 1];
    if (option instanceof HTMLButtonElement) {
      e.preventDefault();
      option.click();
    }
    return;
  }
  const step = /** @type {Record<string, number>} */ ({ ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 })[e.key];
  if (step && list.length) {
    e.preventDefault();
    ui.sel = list[Math.max(0, Math.min(list.length - 1, i + step))]?.id ?? null;
    renderView();
  } else if (e.key === "Enter" && ui.sel && document.activeElement === document.body) {
    const q = list.find((x) => x.id === ui.sel);
    const { href } = sessionLink(q && S(q.sessionId));
    if (href) {
      e.preventDefault();
      location.href = href;
    }
  }
});
// iOS Safari applies :active (the desk's pressed look) only on pages that listen to touchstart.
document.addEventListener("touchstart", () => {}, { passive: true });
// A tap is not a scroll: counted, it put off the redraw that shows what the tap did.
for (const event of ["scroll", "touchmove"]) dialog("session").addEventListener(event, () => (ui.panelTouchedAt = Date.now()), { capture: true, passive: true });
for (const id of ["result", "session", "zoom"]) {
  const d = dialog(id);
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
  });
}
/** Links into the page: #history, #needs, #s=<session id>, #r=<result id>. */
function route() {
  const [k, v] = location.hash.slice(1).split("=");
  if (k === "needs") {
    ui.sel = null;
    showNeedsYou();
  }
  if (k === "history") {
    ui.view = "history";
    render();
  }
  const s = k === "s" && v ? S(v) : undefined;
  if (s) openSession(s.id);
  const r = k === "r" && v ? data.results.find((x) => x.id === v) : undefined;
  if (r) openResult(r, { markSeen: false });
}
addEventListener("hashchange", route);
// The device keeps the last desk it saw, shown when the computer is off or asleep (sw.js). Some
// browsers (third-party ones on iOS) have no service workers: the desk works there without it.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((/** @type {Error} */ e) => toast(TEXT.pageError(e.message)));
  // A notification tapped while the app is open (sw.js).
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.show !== "needs") return;
    ui.sel = null;
    showNeedsYou();
  });
}
renderDisplay();
render();
await refresh();
route();
// A new poll every tick over one still waiting would make the waiting one stale, and a hung
// connection would never get to report itself: only NO_ANSWER_MS bounds the wait.
setInterval(() => requestsWaiting === 0 && refresh(), POLL_MS);
followKeyboard();
// A phone puts a hidden tab's timers to sleep: coming back, the desk is fetched at once, not at the next tick.
document.addEventListener("visibilitychange", () => document.hidden || refresh());
addEventListener("pageshow", (e) => /** @type {PageTransitionEvent} */ (e).persisted && refresh());
for (const change of ["online", "offline"]) addEventListener(change, () => (render(), refresh()));
setInterval(render, TICK_MS);
setInterval(remindWaiting, TICK_MS);
