// @ts-check
// The desk page: polls the store through the local server and renders it. All strings live in text.js.
import { byId, dialog, fill, h, icon, md, mdBlocks, svgEl } from "./dom.js";
import { TEXT } from "./text.js";

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
const ARRIVAL_MS = 5000;
const WARM_AFTER = 30;
const HOT_AFTER = 120;
const CONTEXT_WARN = 80;
const HALO_MS = 3200; // the halo animation's period in style.css
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PALETTE = ["#6366f1", "#14b8a6", "#f59e0b", "#ec4899", "#0ea5e9", "#84cc16", "#a855f7", "#ef4444"];
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
let data = { sessions: [], questions: [], agents: [], results: [], services: [], metrics: [], seen: undefined, problems: [], now: new Date().toISOString(), gone: [], listening: [], disk: [], projects: [], build: "" };

const ui = {
  view: /** @type {"desk" | "history"} */ ("desk"),
  /** @type {string | null} */ project: null,
  hq: "",
  hfilter: /** @type {"all" | "decision" | "result"} */ ("all"),
  /** @type {string | null} */ sel: null,
  /** @type {Map<string, string>} */ drafts: new Map(),
  /** @type {Map<string, number>} */ arrived: new Map(),
  /** @type {Set<string> | null} */ known: null,
  /** @type {Map<string, string> | null} when each session last said something, to notice new messages */ heardAt: null,
  /** @type {Map<string, string>} the message each session was last marked read for; a failure is not retried in a loop */ readFor: new Map(),
  /** what the session panel showed when it was last drawn */ panelDrawn: "",
  /** when the developer last scrolled or touched the session panel */ panelTouchedAt: 0,
  /** @type {number | undefined} a redraw of the panel put off while it is scrolled */ panelLater: undefined,
  /** @type {Set<string>} */ sending: new Set(),
  offline: false,
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
/** @param {string} id */
const arriving = (id) => Date.now() - (ui.arrived.get(id) ?? 0) < ARRIVAL_MS;
/** @param {Session} s */
const isLive = (s) => s.state !== "ended" && !data.gone.includes(s.id);

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
/** @param {Session | undefined} s @param {string} [name] */
function where(s, name) {
  if (!s) return h("span", { class: "where" }, "?");
  const mark = h("span", { class: "prov", title: s.provider }, providerMark(s.provider));
  mark.style.setProperty("--p", color(s.provider));
  return h("span", { class: "where" }, tagIcon(color(s.project.name)), s.project.name, h("span", { class: "sep" }, "›"), mark, name ?? sessionName(s));
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
  setTimeout(() => {
    t.remove();
    if (!box.childElementCount && box.matches(":popover-open")) box.hidePopover();
  }, 3600);
}
/** @param {string} text */
function copy(text) {
  navigator.clipboard.writeText(text).then(
    () => toast(TEXT.copied(text)),
    (/** @type {Error} */ e) => toast(e.message),
  );
}
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
/** @param {string} route @param {unknown} [body] */
async function post(route, body = {}) {
  const res = await fetch(route, {
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
const SAVED_AT = "X-Agent-Desk-Saved-At";
async function refresh() {
  const request = ++latestRequest;
  /** @type {string | null} */
  let savedAt = null;
  /** @type {DeskState | null} */
  let next = null;
  try {
    const res = await fetch("/api/state", { headers: etag ? { "If-None-Match": etag } : {} });
    savedAt = res.headers.get(SAVED_AT);
    if (res.status !== 304) {
      if (!res.ok) throw new Error(`${res.status}`);
      next = /** @type {DeskState} */ (await res.json());
      if (request === latestRequest && !savedAt) etag = res.headers.get("ETag") ?? "";
    }
  } catch {
    if (request === latestRequest) setOffline(true); // shown in the strip; polling continues
    return;
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
  if (next) {
    if (loadedBuild === null) loadedBuild = next.build;
    else if (next.build !== loadedBuild) return location.reload(); // the desk restarted, maybe with new code
    const before = shape();
    const firstLoad = !ui.loaded;
    data = next;
    ui.loaded = true;
    noticeArrivals();
    // The first data replaces the skeleton at once: nothing moved, and a transition still running
    // when a link (#s=…, #r=…) opens a dialog would be aborted.
    if (!firstLoad && shape() !== before && !ui.offline) return animate(render);
  }
  setOffline(false, next !== null);
}

/** Which cards are on the desk: when it changes, the change is animated. */
function shape() {
  const { questions, messages } = inbox();
  return [questions.map((q) => q.id), messages.map((s) => s.id), ui.sel, data.results.filter(isNew).map((r) => r.id), data.sessions.filter(isLive).map((s) => s.id)].flat().join(" ");
}

/**
 * Runs a DOM update as a view transition, so cards move, enter and leave instead of jumping. Not
 * while the developer types or has a window open (a transition briefly freezes the page, and a
 * click on the window would be lost), or prefers reduced motion.
 * @param {() => void} update
 */
function animate(update) {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "");
  if (typing || document.querySelector("dialog[open]") || !document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return update();
  // A transition cut short by a newer one rejects `ready`; its update has run all the same.
  document.startViewTransition(update).ready.catch(() => {});
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
    return;
  }
  let chimed = false;
  for (const q of open) {
    if (ui.known.has(q.id)) continue;
    ui.known.add(q.id);
    ui.arrived.set(q.id, Date.now());
    const where = label(S(q.sessionId));
    toast(TEXT.newQuestion(where));
    if (!chimed) chime();
    chimed = true;
    const pill = byId("needs-pill");
    pill.classList.remove("bump");
    void pill.offsetWidth; // restart the animation
    pill.classList.add("bump");
    notify(TEXT.newQuestion(where), q.text, q.id, () => {
      ui.view = "desk";
      ui.sel = q.id;
      render();
    });
  }
  noticeMessages();
}

/**
 * A session that finished and wrote something new, without asking (questions are noticed above),
 * gets a toast, unless its panel is open and in view.
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
    notify(TEXT.newMessage(label(s)), firstLine(s.lastMessage?.text ?? ""), `m-${s.id}`, () => openSession(s.id));
  }
}

/** A desktop notification while the page is hidden, when the developer allowed them. @param {string} title @param {string} body @param {string} tag @param {() => void} open */
function notify(title, body, tag, open) {
  if (!document.hidden || !alertOn("notify") || !("Notification" in window) || Notification.permission !== "granted") return;
  const n = new Notification(title, { body: body.slice(0, 200), tag });
  n.onclick = () => {
    window.focus();
    open();
  };
}

// In one column (a phone) the large card sits above the queue, maybe off screen. Same query as style.css.
const ONE_COLUMN = matchMedia("(max-width: 700px), (max-height: 500px)");
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
  views.replaceChildren(
    ...(/** @type {const} */ ([["desk", "board"], ["history", "clock"]])).map(([v, ic]) =>
      h("button", { "aria-pressed": String(ui.view === v), "aria-label": TEXT.views[v], onclick: () => ((ui.view = v), render()) }, icon(ic), h("span", { class: "lbl" }, TEXT.views[v])),
    ),
  );
  // A project is offered while one of its sessions runs or still has something for the developer.
  const current = (/** @type {Session} */ s) => isLive(s) || data.questions.some((q) => q.status === "open" && q.sessionId === s.id) || data.results.some((r) => r.sessionId === s.id && isNew(r));
  const names = [...new Set(data.sessions.filter(current).map((s) => s.project.name))].sort();
  if (ui.project !== null && !names.includes(ui.project)) ui.project = null;
  const projects = byId("projects");
  projects.setAttribute("aria-label", TEXT.projectsLabel);
  projects.hidden = names.length < 2;
  projects.replaceChildren(
    ...[null, ...names].map((name) =>
      h("button", { "aria-pressed": String(ui.project === name), onclick: () => ((ui.project = name), render()) }, name ? tagIcon(color(name)) : null, name ?? TEXT.allProjects),
    ),
  );
  const pill = byId("needs-pill");
  pill.className = `needs-pill${n ? "" : " zero"}`;
  pill.replaceChildren(...(n ? [h("span", { class: "beacon on-accent", "aria-hidden": "true" })] : []), TEXT.needsPill(n));
  pill.onclick = () => {
    const list = openQuestions();
    // In one column the first tap brings the oldest question into view; each further tap moves on to the next one.
    if (ONE_COLUMN.matches && ui.view === "desk" && ui.tab === "inbox" && list.length > 1 && nextCardAtTop()) {
      const i = list.findIndex((q) => q.id === ui.sel);
      ui.sel = list[(i + 1) % list.length]?.id ?? null;
      return animate(() => {
        renderView();
        revealNext("start");
      });
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
  renderTabbar(n);
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
  fill(
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
  fill(
    byId("strip"),
    ui.offline ? h("span", { class: "err" }, ui.savedAt ? TEXT.offlineSaved(hm(ui.savedAt)) : TEXT.offline) : null,
    h("span", { class: "muted" }, summary),
    fresh.length ? h("button", { class: "linkish", onclick: () => run(post("/api/seen")) }, TEXT.markSeen) : null,
    h("span", { class: "spacer" }),
    data.problems.length ? h("span", { class: "chip warn problems", title: data.problems.join("\n") }, TEXT.problems(data.problems.length)) : null,
    data.disk.map((d) => h("span", { class: "chip warn", title: d.dir }, TEXT.disk(gb(d.freeBytes), d.projects.join(", ")))),
    contexts.map(({ s, c }) => h("button", { class: "chip warn", onclick: () => openSession(s.id) }, TEXT.contextWarn(label(s), c))),
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
 * @param {{ foot?: Child, quiet?: boolean, aside?: Child }} [more]
 */
function column(key, count, body, { foot, quiet, aside } = {}) {
  return h(
    "section",
    { class: `col col-${key}`, "aria-label": TEXT.cols[key] },
    h("div", { class: "col-head" }, TEXT.cols[key], count !== null ? h("span", { class: `count${quiet ? " quiet" : ""}` }, count) : null, aside ? h("span", { class: "head-aside" }, aside) : null),
    h("div", { class: "col-body", "data-scroll": `col-${key}` }, body),
    foot ? h("div", { class: "col-foot" }, foot) : null,
  );
}
/** @typedef {import("./dom.js").Child} Child */

/** @param {Question} q */
function answerForm(q) {
  if (!data.listening.includes(q.sessionId)) {
    return h("div", {}, q.options.length ? h("div", { class: "optline" }, h("span", { class: "faint" }, `${TEXT.options}: `), q.options.join(" · ")) : null, h("div", { class: "faint" }, TEXT.notListening));
  }
  return replyBox(`answer-${q.id}`, q.options, `/api/questions/${q.id}/answer`, q.sessionId, q.kind === "permission" ? TEXT.permissionPlaceholder : undefined);
}

/**
 * Text box (and option buttons) whose content is sent verbatim to a listening session.
 * Drafts survive re-renders. @param {string} key @param {string[]} options @param {string} route @param {string} sid @param {string} [placeholder]
 */
function replyBox(key, options, route, sid, placeholder = options.length ? TEXT.answerPlaceholder : TEXT.replyPlaceholder) {
  const box = /** @type {HTMLTextAreaElement} */ (h("textarea", { "data-key": key, placeholder, "aria-label": placeholder }));
  box.value = ui.drafts.get(key) ?? "";
  const send = () => {
    const text = box.value;
    if (!text.trim() || ui.sending.has(key)) return;
    ui.sending.add(key);
    run(post(route, { text }).then(() => {
      ui.drafts.delete(key);
      if (ui.panelSession === sid) ui.panelHeard = null; // the panel fetches the conversation again, with this message
      toast(TEXT.sent(label(S(sid))));
    }), () => ui.sending.delete(key));
  };
  const opts = options.map((o, i) => h("button", { "aria-pressed": String(box.value === o), onclick: () => pick(o) }, i < 9 ? h("kbd", {}, String(i + 1)) : null, o));
  const syncPressed = () => opts.forEach((b, i) => b.setAttribute("aria-pressed", String(box.value === options[i])));
  /** @param {string} o */
  const pick = (o) => {
    box.value = o;
    ui.drafts.set(key, o);
    syncPressed();
    box.focus();
  };
  box.addEventListener("input", () => {
    ui.drafts.set(key, box.value);
    syncPressed();
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
    // While the box is empty or holds an option as picked, a digit picks another option.
    const option = /^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey ? options[Number(e.key) - 1] : undefined;
    if (option !== undefined && (box.value === "" || options.includes(box.value))) {
      e.preventDefault();
      pick(option);
    }
  });
  return h(
    "div",
    { class: "answer" },
    opts.length ? h("div", { class: "opts" }, opts) : null,
    box,
    h("div", { class: "row" }, h("button", { class: "primary", title: TEXT.send, onclick: send, disabled: ui.sending.has(key) }, icon("send"), TEXT.sendShort), h("span", { class: "faint send-hint" }, h("span", { class: "keys-only" }, `${TEXT.sendKeys} `), TEXT.sendHint)),
  );
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

/** The line of a question that asks (or its first line), without list markers. @param {string} text */
function headline(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const asking = (lines.find((l) => /[?¿]/.test(l)) ?? lines[0] ?? "").replace(/^(?:[-*•]|\d+[.)])\s+/, "");
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
  return list.map((m) => {
    const who = m.from === "session" ? TEXT.conversation.session : m.via === "desk" ? TEXT.conversation.youDesk : TEXT.conversation.you;
    const mark = m.from === "developer" && whileWorking.has(m.text) ? ` · ${TEXT.conversation.whileWorking}` : "";
    return h("div", { class: `msg from-${m.from}` }, h("div", { class: "msg-meta" }, who, " · ", hm(m.at), mark), h("div", { class: "md" }, mdBlocks(m.text)));
  });
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
  return h(
    "article",
    {
      class: `next${heat(q.askedAt)}${arriving(q.id) ? " arrived" : ""}`,
      "aria-label": TEXT.next,
      // The halo keeps its phase across re-renders instead of starting over each time.
      style: `view-transition-name: q-${q.id}; animation-delay: ${arriving(q.id) ? "0s, .35s" : `-${Date.now() % HALO_MS}ms`}`,
    },
    h("div", { class: "meta" }, beacon(q.askedAt), badge(q.kind), where(s), h("span", { class: `age${heat(q.askedAt)}`, title: TEXT.askedAt(hm(q.askedAt)) }, ago(q.askedAt))),
    h("div", { class: "qlabel" }, TEXT.asks[q.kind]),
    q.kind === "permission" ? h("pre", { class: "qcode", "data-scroll": `code-${q.id}` }, q.text) : questionText(q.text),
    q.context ? [h("div", { class: "qlabel" }, TEXT.itsMessage), h("div", { class: "qctx md", "data-scroll": `ctx-${q.id}` }, mdBlocks(q.context))] : null,
    earlierConversation(q),
    answerForm(q),
    h(
      "div",
      { class: "actions" },
      goLink(s, canAnswer ? "secondary" : "primary go", icon("go"), TEXT.goTo, canAnswer ? null : h("kbd", {}, "⏎")),
      h("span", { class: "spacer" }),
      h("button", { class: "linkish faint", title: TEXT.dismissTitle, onclick: () => run(post(`/api/questions/${q.id}/dismiss`)) }, TEXT.dismiss),
    ),
  );
}

/**
 * Everything that waits for the developer, in the order to deal with it: questions and permission
 * prompts oldest first, then sessions that finished with something new to read, then failures not
 * looked at yet.
 */
function inbox() {
  const questions = openQuestions();
  const asking = new Set(questions.map((q) => q.sessionId));
  const messages = data.sessions
    .filter((s) => isLive(s) && inProject(s.id) && s.state === "waiting" && unread(s) && !asking.has(s.id))
    .sort((a, b) => (a.lastMessage?.at ?? "").localeCompare(b.lastMessage?.at ?? ""));
  const failures = data.results.filter((r) => inProject(r.sessionId) && isNew(r) && r.status === "failed").sort((a, b) => a.at.localeCompare(b.at));
  return { questions, messages, failures, count: questions.length + messages.length + failures.length };
}

/**
 * A row of the inbox: a mark, one line saying what it is, where it comes from, and how long it has
 * waited. @param {{ mark: Child, line: Child, meta: string, when: Child, open: () => void, go?: Child, end?: Child, key: string }} row
 */
function inboxRow({ mark, line, meta, when, open, go, end, key }) {
  return h(
    "div",
    {
      class: `qrow${arriving(key) ? " arrived" : ""}`,
      style: `view-transition-name: i-${key}`,
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
    mark: beacon(q.askedAt),
    line: [q.kind !== "question" ? [badge(q.kind), " "] : null, h("b", {}, headline(q.text))],
    meta: [label(s), q.options.length ? TEXT.nOptions(q.options.length) : ""].filter(Boolean).join(" · "),
    when: h("span", { class: `age${heat(q.askedAt)}`, title: TEXT.askedAt(hm(q.askedAt)) }, ago(q.askedAt)),
    go: goLink(s, "row-go", icon("go"), TEXT.go),
    open: () => {
      ui.sel = q.id;
      animate(() => {
        renderView();
        revealNext();
      });
    },
  });
}

/** A session that finished and wrote something not read yet: opening it reads it. @param {Session} s */
function messageRow(s) {
  const at = s.lastMessage?.at ?? s.updatedAt;
  return inboxRow({
    key: `m-${s.id}`,
    mark: dot("waiting"),
    line: [h("span", { class: "badge k-new" }, TEXT.newBadge), " ", firstLine(s.lastMessage?.text ?? "")],
    meta: `${label(s)} · ${TEXT.yourTurn}`,
    when: h("span", { class: "age quiet", title: hm(at) }, ago(at)),
    open: () => openSession(s.id),
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

/** The inbox: the selected question large, with what it takes to answer it, then the rest in order. */
function inboxColumn() {
  const { questions, messages, failures, count } = inbox();
  const selected = questions.find((q) => q.id === ui.sel) ?? questions[0];
  ui.sel = selected?.id ?? null;
  const rows = [...questions.filter((q) => q !== selected).map(questionRow), ...messages.map(messageRow), ...failures.map(failureRow)];
  const reviewEmpty = !data.results.some((r) => inProject(r.sessionId) && isNew(r));
  const clear = h(
    "div",
    { class: "allclear", role: "status" },
    dot("done"),
    h("span", {}, TEXT.allClear(reviewEmpty), reviewEmpty ? [" ", h("button", { class: "linkish", onclick: showEarlierResults }, TEXT.seeHistory)] : null),
  );
  return column("needs", count || null, count ? [selected ? nextCard(selected) : null, rows] : clear, {
    aside: questions.length > 1 ? h("span", { class: "keys-only faint" }, TEXT.keysHint) : null,
  });
}

function showEarlierResults() {
  ui.view = "history";
  ui.hfilter = "result";
  render();
}

/** @param {Result} r */
function resultRow(r) {
  const first = r.images[0];
  const thumb = first ? h("img", { src: `/images/${first.id}`, alt: "" }) : h("span", { class: "ph" }, dot(r.status === "failed" ? "failed" : "done"));
  return h(
    "button",
    { class: `rrow${isNew(r) ? " is-new" : ""}${r.status === "failed" ? " failed" : ""}`, onclick: () => openResult(r) },
    thumb,
    h("span", { class: "rbody" }, h("span", { class: "rt" }, r.title), h("span", { class: "rm" }, isNew(r) ? h("span", { class: "new", title: TEXT.newResult }) : null, `${label(S(r.sessionId))} · ${hm(r.at)}`)),
  );
}

/** A result not seen yet as a tile: its first picture and its title; × marks it seen without opening it. @param {Result} r */
function reviewTile(r) {
  const first = r.images[0];
  return h(
    "div",
    { class: "rtile-wrap", style: `view-transition-name: r-${r.id}` },
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
  return column("review", list.length || null, list.length ? h("div", { class: "rtiles" }, list.map(reviewTile)) : empty, { quiet: true });
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
/** @param {string} sid */
const sessionAgents = (sid) => data.agents.filter((a) => a.sessionId === sid).sort((a, b) => ATTENTION.indexOf(a.state) - ATTENTION.indexOf(b.state));
/** @param {Session} s */
const sessionWeight = (s) =>
  data.questions.filter((q) => q.status === "open" && q.sessionId === s.id).length * 10 + sessionAgents(s.id).filter((a) => ["failed", "blocked", "idle"].includes(a.state)).length;

/**
 * One compact card per session: where it runs and how full its context is, its agents as dots with
 * what it does now, what went wrong, and the command its context calls for.
 * @param {Session} s
 */
function sessionCard(s) {
  const as = sessionAgents(s.id);
  const needs = data.questions.some((q) => q.status === "open" && q.sessionId === s.id);
  const m = metricsOf(s.id);
  const ctx = m?.contextPercent;
  const trouble = /** @type {const} */ (["failed", "blocked", "idle"]).map((st) => ({ st, n: as.filter((a) => a.state === st).length })).filter((t) => t.n);
  // What is done needs nothing: active agents get a dot each, finished ones a count.
  const active = as.filter((a) => a.state !== "done");
  const done = as.length - active.length;
  // The session's own turn counts too: with every agent done, it still shows it is working.
  const working = s.state === "working";
  const open = () => openSession(s.id);
  return h(
    "div",
    {
      class: "scard",
      role: "button",
      tabindex: "0",
      onclick: open,
      onkeydown: (e) => {
        if (/** @type {KeyboardEvent} */ (e).key === "Enter") open();
      },
      style: `view-transition-name: s-${s.id}`,
    },
    h(
      "div",
      { class: "shead-line" },
      // The project names the session only while every project is shown; its colour stays.
      h("span", { class: "sname", title: label(s) }, tagIcon(color(s.project.name)), ui.project === null ? [h("span", { class: "sproj" }, s.project.name), h("span", { class: "sep" }, "›")] : null, h("b", {}, sessionName(s))),
      ctx !== undefined ? h("span", { class: "ctx" }, bar(ctx), `${Math.round(ctx)}%`) : null,
    ),
    h("div", { class: "sline" }, active.length || needs || working || done ? h("span", { class: "adots" }, needs ? dot("needs") : working ? sessionDot() : null, active.map(agentDot), done ? h("span", { class: "faint done-count" }, TEXT.doneCount(done)) : null) : null, needs ? (s.activity ? h("div", { class: "quiet-line", title: s.activity }, s.activity) : null) : quietLine(s)),
    trouble.length ? h("div", { class: "strouble" }, dot(trouble[0]?.st ?? "failed"), trouble.map((t) => TEXT.trouble[t.st](t.n)).join(" · ")) : null,
    m?.suggestion ? h("span", { class: "chip warn", title: TEXT.suggest[m.suggestion.reason](ctx ?? 0) }, TEXT.suggestChip(ctx ?? 0, m.suggestion.command)) : null,
  );
}

/**
 * Keys the desk may send a session that runs inside tmux. Each button asks for a second click
 * within 3 s before sending, so a stray click sends nothing. @param {Session} s
 */
function controlSection(s) {
  if (!s.tmux || !isLive(s)) return null;
  /** @param {string} action @param {string} text */
  const key = (action, text) => {
    const b = h("button", { class: "secondary" }, text);
    let armed = 0;
    b.addEventListener("click", () => {
      if (Date.now() - armed > 3000) {
        armed = Date.now();
        b.textContent = TEXT.control.confirm(text);
        setTimeout(() => (b.textContent = text), 3000);
        return;
      }
      armed = 0;
      b.textContent = text;
      run(post(`/api/sessions/${s.id}/keys`, { action }).then(() => toast(TEXT.control.sent(text, label(s)))));
    });
    return b;
  };
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
      key("compact", "/compact"),
      key("interrupt", TEXT.control.interrupt),
      dialog ? [h("span", { class: "faint" }, TEXT.control.dialog), ...[1, 2, 3, 4, 5].map((n) => key(`option-${n}`, String(n))), key("enter", "Enter")] : null,
    ),
    ON_THIS_MACHINE ? null : attachLine(s.tmux),
  );
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
  if (s.state === "waiting" && s.lastMessage && unread(s)) return h("div", { class: "quiet-line unread", title: firstLine(s.lastMessage.text) }, readBadge(s), firstLine(s.lastMessage.text));
  if (s.state === "waiting") return h("div", { class: "quiet-line" }, readBadge(s), TEXT.awaiting(s.lastMessage ? ago(s.lastMessage.at) : ""));
  if (s.activity) return h("div", { class: "quiet-line", title: s.activity }, s.activity);
  return null;
}
/** "New message" until the developer opens the session, "Seen" after. @param {Session} s */
function readBadge(s) {
  if (!s.lastMessage) return null;
  return unread(s) ? h("span", { class: "badge k-new" }, TEXT.newBadge) : h("span", { class: "badge k-seen", title: s.readAt ? TEXT.seenAt(hm(s.readAt)) : "" }, TEXT.seenBadge);
}
function sessionsColumn() {
  const list = data.sessions.filter((s) => isLive(s) && inProject(s.id)).sort((a, b) => sessionWeight(b) - sessionWeight(a));
  const legend = h("div", { class: "legend" }, LEGEND.map((st) => h("span", {}, dot(st), TEXT.state[st])));
  return column("sessions", list.length, list.length ? list.map(sessionCard) : h("div", { class: "empty" }, TEXT.emptyRunning), { foot: legend, quiet: true });
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
    return h("div", { class: "stack" }, data.results.filter((r) => r.sessionId === s.id).map((r) => {
      const row = resultRow(r);
      row.addEventListener("click", () => d.close());
      return row;
    }));
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
  if (!rows.length) return h("div", { class: "faint" }, TEXT.noAgents);
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
    { class: "dbody session-body", "data-part": part, "data-session": sid, "data-fetched": fetched },
    panelChips(s, m),
    // An open part takes the conversation's place; its chip, or the way back, closes it.
    ui.panelPart
      ? h("div", { class: "ppart" }, h("button", { class: "linkish back", onclick: () => ((ui.panelPart = null), openSession(sid)) }, TEXT.backToConversation), panelPart(s, m, d))
      : chat(s),
  );
  d.replaceChildren(
    h(
      "div",
      { class: "dhead" },
      h("div", {}, h("div", { class: "meta" }, where(s, s.provider)), h("h3", {}, sessionName(s))),
      h("span", { class: "spacer" }),
      goLink(s, "primary", icon("go"), h("span", { class: "lbl" }, TEXT.goTo)),
      h("button", { class: "icon-btn", "aria-label": TEXT.close, onclick: () => d.close() }, icon("x")),
    ),
    body,
  );
  // The conversation reads bottom up: it opens at the latest message and follows new ones, unless
  // the developer scrolled up to read. A part that just unfolded is shown from its top.
  if (samePart) body.scrollTop = scrolled;
  // The chip row scrolls sideways on a phone: a tap on a chip keeps it where it was.
  const chips = body.querySelector(".pchips");
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
  keepFocus(d, () => openSession(s.id));
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
  const canReply = s.state === "waiting" && data.listening.includes(s.id) && !asking;
  return [
    h(
      "div",
      { class: "conversation chat" },
      !fetched ? h("div", { class: "faint" }, "…") : list.length ? conversationView(list, whileWorking) : h("div", { class: "faint" }, TEXT.conversation.none),
    ),
    h(
      "div",
      { class: "chat-footer" },
      asking
        ? h(
            "div",
            { class: "panel-question" },
            h("div", { class: "meta" }, badge(asking.kind), h("span", { class: "spacer" }), h("button", { class: "linkish", onclick: () => answerOnDesk(asking.id) }, TEXT.conversation.openQuestion)),
            h("div", { class: "qtext" }, md(headline(asking.text))),
            answerForm(asking),
          )
        : canReply
          ? replyBox(`message-${s.id}`, [], `/api/sessions/${s.id}/message`, s.id)
          : h("div", { class: "faint" }, s.state === "working" ? TEXT.conversation.working : TEXT.notListening),
    ),
  ];
}

/** Closes the session panel and shows the question large on the desk. @param {string} questionId */
function answerOnDesk(questionId) {
  ui.sel = questionId;
  ui.view = "desk";
  ui.tab = "inbox";
  dialog("session").close();
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
    h("div", { class: "dhead" }, h("div", {}, h("div", { class: "meta" }, tagIcon(color(p.name)), p.name), h("h3", {}, t.title)), h("span", { class: "spacer" }), h("button", { class: "icon-btn", "aria-label": TEXT.close, onclick: () => d.close() }, icon("x"))),
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
 *   title: string, answer?: string, viaDesk?: boolean, note?: string, result?: Result }} Entry
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
      ...(x.answer ? { answer: x.answer.text, viaDesk: x.answer.via === "desk" } : {}),
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
/** Re-rendering keeps the scroll of every scrollable part, the focused field, its caret and what was typed in it. */
function renderView() {
  document.body.dataset.tab = ui.tab;
  const view = byId("view");
  /** @type {Map<string, number>} */
  const scrolls = new Map();
  for (const el of view.querySelectorAll("[data-scroll]")) if (el instanceof HTMLElement && el.dataset.scroll) scrolls.set(el.dataset.scroll, el.scrollTop);
  const pageScroll = window.scrollY;
  keepFocus(view, () => view.replaceChildren(!ui.loaded ? skeleton() : ui.view === "history" ? historyView() : board()));
  for (const el of view.querySelectorAll("[data-scroll]")) {
    const top = el instanceof HTMLElement && el.dataset.scroll ? scrolls.get(el.dataset.scroll) : undefined;
    if (top !== undefined) el.scrollTop = top;
  }
  window.scrollTo(0, pageScroll);
}

/** Rebuilds part of the page; the text box being typed in keeps focus and caret. @param {ParentNode} root @param {() => void} rebuild */
function keepFocus(root, rebuild) {
  const active = document.activeElement;
  const key = active instanceof HTMLElement && root.contains(active) ? active.dataset.key : undefined;
  const caret = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? { from: active.selectionStart, to: active.selectionEnd } : null;
  rebuild();
  if (!key) return;
  const again = root.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (again instanceof HTMLTextAreaElement || again instanceof HTMLInputElement) {
    again.focus({ preventScroll: true });
    if (caret) again.setSelectionRange(caret.from, caret.to);
  }
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
/** @param {number | null} px */
function setSide(px) {
  if (px === null) document.documentElement.style.removeProperty("--side-w");
  else document.documentElement.style.setProperty("--side-w", `${Math.round(px)}px`);
}
setSide(Number(localStorage.getItem(SIDE_KEY)) || null);

/** The board is rebuilt on every change, so the drag listens on the window, not on this element. */
function splitter() {
  const handle = h("div", { class: "split", title: TEXT.splitTitle });
  handle.addEventListener("pointerdown", (e) => {
    const board = handle.parentElement;
    if (!board) return;
    e.preventDefault();
    const right = board.getBoundingClientRect().right - parseFloat(getComputedStyle(board).paddingRight);
    const move = (/** @type {PointerEvent} */ m) => {
      const px = Math.max(SIDE_MIN, right - m.clientX - handle.offsetWidth / 2);
      setSide(px);
      localStorage.setItem(SIDE_KEY, String(Math.round(px)));
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    document.body.classList.add("resizing");
  });
  handle.addEventListener("dblclick", () => {
    localStorage.removeItem(SIDE_KEY);
    setSide(null);
  });
  return handle;
}

/** The desk's shape while the first data arrives. */
function skeleton() {
  /** @param {string} key @param {number[]} heights */
  const col = (key, heights) =>
    h("section", { class: `col col-${key}` }, h("div", { class: "col-head" }, h("span", { class: "skel", style: "width:90px;height:14px" })), h("div", { class: "col-body" }, heights.map((px) => h("div", { class: "skel", style: `height:${px}px` }))));
  return h("main", { class: "board", "aria-busy": "true", "data-tab": ui.tab }, col("needs", [230, 54, 54]), col("sessions", [70, 70, 70]), col("review", [90]));
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
// ---------- Alerts: desktop notifications and sound, each switched off on the page ----------
const ALERTS = { notify: "agent-desk:notify", sound: "agent-desk:sound" };
/** On unless the developer switched it off in this browser. @param {keyof typeof ALERTS} k */
const alertOn = (k) => localStorage.getItem(ALERTS[k]) !== "off";
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
  button.replaceChildren(icon(notifyOn || alertOn("sound") ? "bell" : "bellOff"));
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
    row("notify", TEXT.alerts.notify, !can ? TEXT.alerts.unavailable : Notification.permission === "denied" ? TEXT.alerts.blocked : TEXT.alerts.notifyHint, notifyOn, !can || Notification.permission === "denied"),
    row("sound", TEXT.alerts.sound, TEXT.alerts.soundHint, alertOn("sound"), false),
  );
}
byId("alerts").onclick = () => {
  const menu = byId("alerts-menu");
  menu.hidden = !menu.hidden;
  if (!menu.hidden) renderAlerts();
};
document.addEventListener("click", (e) => {
  const menu = byId("alerts-menu");
  if (!menu.hidden && e.target instanceof Node && !menu.parentElement?.contains(e.target)) menu.hidden = true;
});
renderAlerts();

const THEMES = /** @type {const} */ (["auto", "light", "dark"]);
function applyTheme() {
  const stored = localStorage.getItem("agent-desk:theme");
  const t = THEMES.find((x) => x === stored) ?? "auto";
  document.documentElement.dataset.theme = t === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : t;
  const button = byId("theme");
  button.setAttribute("aria-label", TEXT.theme[t]);
  button.replaceChildren(icon(t === "auto" ? "auto" : t === "light" ? "sun" : "moon"), h("span", { class: "lbl" }, TEXT.theme[t]));
}
byId("theme").onclick = () => {
  const t = THEMES.find((x) => x === localStorage.getItem("agent-desk:theme")) ?? "auto";
  localStorage.setItem("agent-desk:theme", THEMES[(THEMES.indexOf(t) + 1) % THEMES.length] ?? "auto");
  applyTheme();
};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
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
for (const event of ["scroll", "touchstart", "touchmove"]) dialog("session").addEventListener(event, () => (ui.panelTouchedAt = Date.now()), { capture: true, passive: true });
for (const id of ["result", "session", "zoom"]) {
  const d = dialog(id);
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
  });
}
/** Links into the page: #history, #s=<session id>, #r=<result id>. */
function route() {
  const [k, v] = location.hash.slice(1).split("=");
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
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch((/** @type {Error} */ e) => toast(TEXT.pageError(e.message)));
applyTheme();
render();
await refresh();
route();
setInterval(refresh, POLL_MS);
setInterval(render, TICK_MS);
