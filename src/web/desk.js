// @ts-check
// The desk: the inbox, the sessions and what to review, side by side, or one per tab on a phone.
import { h, icon } from "./dom.js";
import { TEXT } from "./text.js";
import { agentDoing, agentDot, agentQuiet, failedInARow, failing, failingTip, sessionAgents, sessionDot, sessionQuiet, troubleText } from "./agents.js";
import { askBody, decisionOf } from "./answer.js";
import { forgetButton } from "./control.js";
import { ago, color, firstLine, headline, heat, hm, stamp } from "./format.js";
import { markCuts, ONE_COLUMN, revealNext } from "./layout.js";
import { badge, bar, beacon, dot, emptyState, goLink, LOCAL_URL, localLink, planGauge, projectMark, suggestionChip, tagIcon, where } from "./pieces.js";
import { openResult } from "./result.js";
import { imageUrl, post, run } from "./server.js";
import { openSession, resultRow } from "./session.js";
import { answeredNow, asksOf, data, endedUnseen, inbox, inProject, isLive, isNew, itemKey, itemOf, label, metricsOf, page, S, sessionName, toReview, ui, unread } from "./state.js";

/** @typedef {import("../core/protocol.ts").Session} Session */
/** @typedef {import("../core/protocol.ts").Question} Question */
/** @typedef {import("../core/protocol.ts").Agent} Agent */
/** @typedef {import("../core/protocol.ts").Result} Result */
/** @typedef {import("../core/protocol.ts").Metrics} Metrics */
/** @typedef {import("./state.js").Item} Item */
/** @typedef {import("./dom.js").Child} Child */
/** @typedef {import("./state.js").DotState} DotState */

const LEGEND = /** @type {const} */ (["needs", "working", "waiting", "blocked", "idle", "failed", "done"]);

/**
 * A column: its head, its body and its foot. Head and foot glide when the board changes shape (motion.js).
 * @param {keyof typeof TEXT.cols} key @param {number | null} count @param {Child} body
 * @param {{ foot?: Child, quiet?: boolean, aside?: Child, list?: boolean, headless?: boolean }} [more] `list`: the body's own children are cards that move (motion.js)
 */
function column(key, count, body, { foot, quiet, aside, list, headless } = {}) {
  return h(
    "section",
    { class: `col col-${key}`, "data-key": `col-${key}`, "aria-label": TEXT.cols[key] },
    headless ? null : h("div", { class: "col-head", "data-glide": true }, TEXT.cols[key], count !== null ? h("span", { class: `count${quiet ? " quiet" : ""}` }, count) : null, aside ? h("span", { class: "head-aside" }, aside) : null),
    h("div", { class: "col-body", "data-scroll": `col-${key}`, "data-list": list }, body),
    foot ? h("div", { class: "col-foot", "data-glide": true }, foot) : null,
  );
}

// The oldest wait is the next thing to do: shown large, with what it takes to answer it.
/** @param {Item} item */
function nextCard(item) {
  const lead = item.open[0] ?? item.questions[0];
  if (!lead) return null;
  const s = S(lead.sessionId);
  const canAnswer = data.listening.includes(lead.sessionId);
  const meta = h("div", { class: "meta" }, h("span", { class: `qkind k-${lead.kind}` }, TEXT.kinds[lead.kind]), where(s), h("span", { class: `age${heat(lead.askedAt)}`, title: TEXT.askedAt(hm(lead.askedAt)) }, ago(lead.askedAt)));
  // An item shares its row's `data-flip`: picked or next in line, the row grows into this card.
  const card = { "aria-label": TEXT.next, "data-key": `next-${item.key}`, "data-flip": `q-${item.key}` };
  if (!item.open.length) return h("article", { ...card, class: "next resolved" }, meta, askBody(item));
  return h(
    "article",
    { ...card, class: `next${heat(lead.askedAt)}` },
    meta,
    askBody(item),
    h(
      "div",
      { class: "actions" },
      goLink(s, "linkish go-link", icon("go"), TEXT.goTo, canAnswer ? null : h("kbd", {}, "⏎")),
      h("span", { class: "spacer" }),
      h("button", { class: "linkish faint", title: TEXT.dismissTitle, onclick: () => run(Promise.all(item.open.map((q) => post(`/api/questions/${q.id}/dismiss`)))) }, TEXT.dismiss),
    ),
  );
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

/** @param {Item} item */
function questionRow(item) {
  const q = item.open[0] ?? item.questions[0];
  if (!q) return null;
  const s = S(q.sessionId);
  const group = item.questions.length > 1;
  return inboxRow({
    key: item.key,
    flip: `q-${item.key}`,
    mark: beacon(q.askedAt),
    line: [q.kind !== "question" ? [badge(q.kind), " "] : null, h("b", {}, group ? item.open.map((x) => headline(x.text)).join(" · ") : headline(q.text))],
    meta: [label(s), group ? TEXT.group.row(item.questions.length, item.questions.length - item.open.length) : q.options.length && !decisionOf(q) ? TEXT.nOptions(q.options.length) : ""].filter(Boolean).join(" · "),
    when: h("span", { class: `age${heat(q.askedAt)}`, title: TEXT.askedAt(hm(q.askedAt)) }, ago(q.askedAt)),
    go: goLink(s, "row-go", icon("go"), TEXT.go),
    open: () => {
      ui.sel = item.key;
      page.renderView();
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
    when: h("span", { class: "age quiet", title: stamp(r.at) }, ago(r.at)),
    open: () => openResult(r),
    end: h("button", { class: "rdismiss icon-btn", "aria-label": TEXT.dismissResult, title: TEXT.dismissResult, onclick: (/** @type {Event} */ e) => (e.stopPropagation(), run(post(`/api/results/${r.id}/seen`))) }, icon("x")),
  });
}

/** The item whose last question was just answered from the desk, while its card still says so. */
function resolvedItem() {
  const q = data.questions.find((x) => itemKey(x) === ui.sel && x.status !== "open" && answeredNow(x));
  return q ? itemOf(q) : undefined;
}

/**
 * The inbox: the selected item large, with what it takes to answer it, then the rest in order. On a
 * quiet desk, one line that says so.
 * @param {ReturnType<typeof inbox>} box @param {Item | undefined} resolved @param {boolean} quiet
 */
function inboxColumn({ items, failures, count }, resolved, quiet) {
  if (quiet) {
    ui.sel = null;
    return column("needs", null, allClearLine(), { list: true, headless: true });
  }
  const selected = items.find((it) => it.key === ui.sel) ?? resolved ?? items[0];
  ui.sel = selected?.key ?? null;
  const rows = [...items.filter((it) => it !== selected).map(questionRow), ...failures.map(failureRow)];
  const reviewEmpty = !data.results.some((r) => inProject(r.sessionId) && isNew(r));
  // Earlier results are offered once, by To review.
  const clear = emptyState("allclear", TEXT.allClear(reviewEmpty), { mark: dot("done") });
  return column("needs", count || null, count || resolved ? [selected ? nextCard(selected) : null, rows] : clear, {
    aside: items.length > 1 ? h("span", { class: "keys-only faint" }, TEXT.keysHint) : null,
    list: true,
  });
}

/** Nothing needs the developer: one line that says so, and the last answer given, which opens the past decisions. */
function allClearLine() {
  const last = data.questions.filter((q) => q.answer && inProject(q.sessionId)).sort((a, b) => (b.answer?.at ?? "").localeCompare(a.answer?.at ?? ""))[0]?.answer;
  return h(
    "div",
    { class: "all-clear", role: "status", "data-key": "clear-line" },
    dot("done"),
    h("b", {}, TEXT.quiet.clear),
    h("span", { class: "clear-rest" }, TEXT.quiet.rest(!toReview().length)),
    last ? h("button", { class: "last-answer", title: TEXT.quiet.lastAnswerTitle, onclick: showDecisions }, TEXT.quiet.lastAnswer(stamp(last.at)), " · ", h("q", {}, firstLine(last.text))) : null,
  );
}

function showDecisions() {
  ui.view = "history";
  ui.hfilter = "decision";
  page.render();
}

function showEarlierResults() {
  ui.view = "history";
  ui.hfilter = "result";
  page.render();
}

/** A result not seen yet as a tile: its first picture and its title; × marks it seen without opening it. @param {Result} r */
function reviewTile(r) {
  const first = r.images[0];
  const s = S(r.sessionId);
  return h(
    "div",
    { class: "rtile-wrap", "data-key": `r-${r.id}` },
    h(
      "button",
      { class: "rtile", onclick: () => openResult(r), title: `${r.title}\n${label(s)} · ${stamp(r.at)}` },
      first ? h("img", { src: imageUrl(first.id), alt: "" }) : h("span", { class: "ph" }, dot("done"), r.summary ? h("span", {}, firstLine(r.summary)) : null),
      h("span", { class: "rt" }, r.title),
      // Where it comes from, as on every other card, unless one project is already picked.
      h("span", { class: "rm" }, ui.project === null && s ? projectMark(s.project.name) : null, h("span", { class: "num" }, stamp(r.at))),
    ),
    h("button", { class: "rdismiss icon-btn", "aria-label": TEXT.dismissResult, title: TEXT.dismissResult, onclick: () => run(post(`/api/results/${r.id}/seen`)) }, icon("x")),
  );
}

// How many results already seen a quiet desk keeps in view while there is nothing new.
const EARLIER_RESULTS = 8;

/**
 * Finished work to look at; failures wait in the inbox instead. On a quiet desk with nothing new, the
 * latest results already seen, quietly. @param {boolean} quiet
 */
function reviewColumn(quiet) {
  const list = toReview();
  if (list.length) return column("review", list.length, h("div", { class: "rtiles", "data-list": true }, list.map(reviewTile)), { quiet: true });
  const all = h("button", { class: "linkish", onclick: showEarlierResults }, quiet ? TEXT.quiet.allResults : TEXT.seeHistory);
  const earlier = quiet ? data.results.filter((r) => inProject(r.sessionId) && !isNew(r)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, EARLIER_RESULTS) : [];
  if (earlier.length) return column("review", null, [h("div", { class: "rearlier", "data-list": true }, earlier.map((r) => resultRow(r))), all], { aside: h("span", { class: "faint" }, TEXT.quiet.earlierAside) });
  return column("review", null, emptyState("no-results", TEXT.emptyResults, { action: all }), { quiet: true });
}

/** @param {Session} s */
const sessionWeight = (s) =>
  asksOf(s.id).length * 10 +
  (endedUnseen(s) ? 10 : 0) +
  sessionAgents(s.id).filter((a) => ["failed", "blocked", "idle"].includes(a.state) || agentQuiet(a) || failing(a)).length +
  (sessionQuiet(s) || failing(s) ? 1 : 0);

/**
 * One row per session: its state, name, context and age, then only what matters about it — what it
 * asks, which of its agents fail or have gone quiet — or else what it does now; its agents counted.
 * Rich, when the sessions have the room (a quiet desk, a phone's Sessions tab): what it does now,
 * then each agent on its row with its state, and its context, plan, live previews, model and branch.
 * @param {Session} s @param {boolean} rich @param {boolean} [planInHead] the plan windows stand once in the column's head instead
 */
function sessionCard(s, rich, planInHead = false) {
  const as = sessionAgents(s.id);
  const asks = asksOf(s.id).sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  const asking = asks[0];
  const m = metricsOf(s.id);
  const ctx = m?.contextPercent;
  const working = as.filter((a) => a.state === "working").length;
  const done = as.filter((a) => a.state === "done").length;
  const since = s.state === "working" ? (s.activityAt ?? s.updatedAt) : (s.lastMessage?.at ?? s.updatedAt);
  /** @type {HTMLElement[]} */
  const matters = [];
  if (asking) {
    matters.push(
      h(
        "div",
        { class: "s-ask" },
        h("span", { class: "s-ask-t" }, h("span", { class: "s-label" }, asking.kind === "permission" ? TEXT.sessionLine.permission : TEXT.sessionLine.asks), " ", asking.kind === "permission" ? h("code", {}, asking.text) : headline(asking.text)),
        asks.length > 1 ? h("span", { class: "s-ask-more" }, TEXT.sessionLine.moreAsks(asks.length - 1)) : null,
      ),
    );
  }
  /** One line of trouble: red only for a failed agent, amber for one that may be stuck. @param {DotState} st @param {string} what @param {string} [tip] */
  const troubleLine = (st, what, tip) => h("div", { class: `s-bad${st === "failed" ? "" : " s-warn"}`, title: tip }, dot(st), h("span", {}, what));
  if (s.state !== "ended" && !isLive(s)) matters.push(troubleLine("idle", TEXT.goneAsking));
  /** Calls failing in a row warn; the call itself waits in the tooltip and the session's agent rows. @param {Agent | Session} x @param {string} who */
  const failLine = (x, who) => troubleLine("idle", [who, TEXT.failingCalls(failedInARow(x))].filter(Boolean).join(" · "), failingTip(x));
  // A rich card says why on the agent's own row.
  if (!rich) for (const a of as.filter((a) => a.state === "failed" || a.state === "blocked")) matters.push(troubleLine(a.state, `${a.goal ?? a.name} · ${troubleText(a)}`));
  if (failing(s)) matters.push(failLine(s, ""));
  for (const a of as.filter(failing)) matters.push(failLine(a, a.goal ?? a.name));
  const quiet = sessionQuiet(s);
  if (quiet) matters.push(troubleLine("idle", TEXT.trouble.sessionQuiet(quiet)));
  else for (const a of as.filter(agentQuiet)) matters.push(troubleLine("idle", `${a.goal ?? a.name} · ${TEXT.quietFor(agentQuiet(a))}`));
  const shown = matters.slice(0, 3);
  const open = () => openSession(s.id);
  return h(
    "div",
    {
      class: `scard${rich ? " rich" : ""}${asking ? " needs" : ""}`,
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
      asking ? dot("needs") : s.state === "working" || working ? sessionDot(s) : dot("done"),
      // The project names the session only while every project is shown; its colour stays.
      h("span", { class: "sname", title: label(s) }, ui.project === null ? [projectMark(s.project.name, "pname sproj"), h("span", { class: "sep" }, "›")] : tagIcon(color(s.project.name)), h("b", {}, sessionName(s))),
      h("span", { class: "s-meta num" }, [ctx !== undefined ? `${Math.round(ctx)}%` : "", ago(since)].filter(Boolean).join(" · ")),
    ),
    shown,
    shown.length && !rich ? null : quietLine(s),
    matters.length > shown.length ? h("div", { class: "s-more" }, TEXT.sessionLine.more(matters.length - shown.length)) : null,
    rich ? agentLines(as) : working || done ? h("div", { class: "s-l3" }, TEXT.sessionLine.agents(working, done)) : null,
    rich ? workLine(s, m, planInHead) : m?.suggestion ? suggestionChip(m.suggestion, ctx ?? 0, TEXT.suggestChip(ctx ?? 0, m.suggestion.command)) : null,
    // Its own click: not the card's, which opens the session.
    isLive(s) ? null : h("div", { class: "s-actions", onclick: stopClick }, forgetButton(s, () => page.renderView(), "secondary")),
  );
}

/** @param {Event} e */
const stopClick = (e) => e.stopPropagation();

// A rich card's agent rows; past them, one line counts the rest (sessionAgents puts trouble first, done last).
const AGENT_LINES = 6;

/** Each agent on one row: its state, its goal and what it does now or why it stopped, and for how long. @param {Agent[]} as */
function agentLines(as) {
  if (!as.length) return null;
  const rows = as.slice(0, as.length > AGENT_LINES ? AGENT_LINES - 1 : AGENT_LINES);
  return h(
    "div",
    { class: "s-agents" },
    rows.map((a) => {
      const doing = a.state === "failed" || a.state === "blocked" ? troubleText(a) : agentDoing(a);
      return h(
        "div",
        { class: `s-agent${a.state === "failed" ? " failed" : ""}`, title: [a.goal ?? a.name, doing].filter(Boolean).join("\n") },
        agentDot(a),
        h("span", { class: "s-agent-t" }, h("b", {}, a.goal ?? a.name), doing ? h("small", {}, doing) : null),
        h("span", { class: "s-agent-at num" }, a.endedAt ? TEXT.tookFor(ago(a.startedAt, a.endedAt)) : ago(a.startedAt)),
      );
    }),
    as.length > rows.length ? h("div", { class: "s-more" }, TEXT.sessionLine.moreAgents(as.length - rows.length)) : null,
  );
}

/**
 * What a session runs on, in one wrapping line: its context (with the command it calls for), its plan
 * windows unless the column's head shows them, its live previews, its model and branch. Each part only
 * when its provider reports it. @param {Session} s @param {Metrics | undefined} m @param {boolean} planInHead
 */
function workLine(s, m, planInHead) {
  const ctx = m?.contextPercent;
  const services = data.services.filter((v) => v.sessionId === s.id);
  const where = [[m?.model, m?.effort].filter(Boolean).join(" · "), m?.branch].filter(Boolean).join(" · ");
  const parts = [
    ctx !== undefined || m?.suggestion
      ? h("span", { class: "s-gauge" }, ctx !== undefined ? bar(ctx) : null, m?.suggestion ? suggestionChip(m.suggestion, ctx ?? 0, TEXT.suggestChip(ctx ?? 0, m.suggestion.command)) : TEXT.context(ctx ?? 0))
      : null,
    ...(planInHead ? [] : (m?.planWindows ?? []).map((w) => planGauge(w, "s-gauge"))),
    // A preview opens in its own tab, not the session.
    ...services.map((v) => h("span", { class: "s-live", title: TEXT.svcSince(ago(v.startedAt)), onclick: stopClick }, h("span", { class: "up" }), localLink(v.url, `${v.name} ${v.url.replace(LOCAL_URL, "")}`))),
    where ? h("span", { class: "s-where", title: where }, where) : null,
  ].filter(Boolean);
  return parts.length ? h("div", { class: "s-work" }, parts) : null;
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
/** @param {boolean} rich the cards have the room to show each session's work @param {boolean} quiet */
function sessionsColumn(rich, quiet) {
  // A session whose process is gone stays while it still asks, so what it asked can be forgotten with it.
  const list = data.sessions.filter((s) => (isLive(s) || endedUnseen(s) || asksOf(s.id).length > 0) && inProject(s.id)).sort((a, b) => sessionWeight(b) - sessionWeight(a));
  const legend = h("div", { class: "legend" }, LEGEND.map((st) => h("span", {}, dot(st), TEXT.state[st])));
  const working = list.filter((s) => s.state === "working").length;
  const agents = data.agents.filter((a) => a.state === "working" && list.some((s) => s.id === a.sessionId)).length;
  // Every session reports the same account's plan windows: a quiet desk shows them once, from the latest report.
  const plan = quiet ? list.map((s) => metricsOf(s.id)).filter((m) => m?.planWindows?.length).sort((a, b) => (b?.at ?? "").localeCompare(a?.at ?? ""))[0]?.planWindows : undefined;
  const aside = [quiet && (working || agents) ? h("span", { class: "faint" }, TEXT.quiet.sessionsAside(working, agents)) : null, ...(plan ?? []).map((w) => planGauge(w, "s-gauge"))].filter(Boolean);
  return column("sessions", list.length, list.length ? h("div", { class: `slist${rich ? " rich" : ""}`, "data-list": true }, list.map((s) => sessionCard(s, rich, quiet))) : emptyState("no-sessions", TEXT.emptyRunning), {
    foot: legend,
    quiet: true,
    aside: aside.length ? aside : null,
  });
}

/**
 * The inbox on the left; the sessions and what to review on the right. While nothing needs the
 * developer, Needs you is one line and the sessions take the centre under it, To review the right
 * column whole; a question that arrives takes the top back, and that move is the signal. On a phone
 * one part at a time, chosen in the tab bar, its Sessions tab always with the room for rich cards.
 */
export function board() {
  const box = inbox();
  const resolved = resolvedItem();
  const quiet = !box.count && !resolved && !ONE_COLUMN.matches;
  const reviewEmpty = !toReview().length;
  return h(
    "main",
    { class: `board${quiet ? " quiet" : ""}${reviewEmpty ? " review-empty" : ""}`, "data-tab": ui.tab },
    inboxColumn(box, resolved, quiet),
    splitter(),
    sessionsColumn(quiet || ONE_COLUMN.matches, quiet),
    reviewColumn(quiet),
  );
}
// The board's shape and its cards follow the window: crossing into one column, or out of it, redraws them.
ONE_COLUMN.addEventListener("change", () => page.renderView({ instant: true }));

// The right column's width, set by dragging the line before it; kept in this browser.
const SIDE_KEY = "agent-desk:side-width";
const SIDE_MIN = 280;
/** The right column's width until one is dragged: style.css's clamp(360px, 30vw, 560px). */
const sideDefault = () => Math.round(Math.min(560, Math.max(360, document.documentElement.clientWidth * 0.3)));
const SIDE_STEP = 16;
/** @param {number | null} px */
function setSide(px) {
  if (px === null) {
    localStorage.removeItem(SIDE_KEY);
    document.documentElement.style.removeProperty("--side-w");
  } else {
    localStorage.setItem(SIDE_KEY, String(Math.round(px)));
    document.documentElement.style.setProperty("--side-w", `${Math.round(px)}px`);
  }
  markCuts();
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
    "aria-valuenow": Number(localStorage.getItem(SIDE_KEY)) || sideDefault(),
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
export function skeleton() {
  /** @param {string} key @param {number[]} heights */
  const col = (key, heights) =>
    h("section", { class: `col col-${key}` }, h("div", { class: "col-head" }, h("span", { class: "skel", style: "width:90px;height:14px" })), h("div", { class: "col-body" }, heights.map((px) => h("div", { class: "skel", style: `height:${px}px` }))));
  return h("main", { class: "board", "aria-busy": "true", "data-tab": ui.tab }, col("needs", [230, 54, 54]), col("sessions", [104, 132, 104]), col("review", [150]));
}
