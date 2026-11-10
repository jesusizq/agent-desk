// @ts-check
// The session panel: its chips and the parts they unfold, and its conversation with the box to answer it.
import { dialog, h, icon, patch } from "./dom.js";
import { arrive } from "./motion.js";
import { TEXT } from "./text.js";
import { agentRows, agentsPart, sessionAgents, sessionQuiet } from "./agents.js";
import { askBody, replyBox } from "./answer.js";
import { controlSection } from "./control.js";
import { conversationView, loadConversation, outgoingView } from "./conversation.js";
import { ago, clockAt, duration, gb, stamp } from "./format.js";
import { fitNewBoxes, showNeedsYou } from "./layout.js";
import { badge, bar, dialogHead, dot, goLink, LOCAL_URL, localLink, suggestionChip, where } from "./pieces.js";
import { mergedOf, openProject, projectOf } from "./projects.js";
import { openResult } from "./result.js";
import { imageUrl, offlineNotice, offlineText, post, run } from "./server.js";
import { asksOf, data, isLive, isNew, itemsOf, label, metricsOf, S, sessionName, ui, unread } from "./state.js";

/** @typedef {import("../core/protocol.ts").Session} Session */
/** @typedef {import("../core/protocol.ts").Result} Result */
/** @typedef {import("../core/protocol.ts").Metrics} Metrics */
/** @typedef {import("./state.js").PanelPart} PanelPart */
/** @typedef {import("./dom.js").Child} Child */

const TERMINAL_NAMES = /** @type {Record<string, string>} */ ({ vscode: "VS Code" });

/**
 * The session's state in one line of chips: first what asks for action (the command its context
 * calls for, an ended session, failed agents), then context and plan, then its agents, results,
 * servers and the rest, each unfolding under the chips.
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
  const agents = as.length ? unfold("agents", [failed ? dot("failed") : null, TEXT.chips.agents(as.length, failed)], failed ? "bad" : "") : null;
  // What asks for action leads: on a phone the row scrolls sideways and its end starts off-screen.
  return h(
    "div",
    { class: "pchips" },
    m?.suggestion && command ? suggestionChip(m.suggestion, m.contextPercent ?? 0, command) : null,
    s.state === "ended" || data.gone.includes(s.id) ? h("span", { class: "chip quiet" }, s.state === "ended" ? TEXT.ended : TEXT.gone) : null,
    failed ? agents : null,
    m?.contextPercent !== undefined ? h("span", { class: "chip" }, bar(m.contextPercent), TEXT.context(m.contextPercent)) : null,
    (m?.planWindows ?? []).map((w) => h("span", { class: "chip", title: TEXT.plan(w.label, w.percent, w.resetsAt ? ago(new Date().toISOString(), w.resetsAt) : "") }, bar(w.percent), TEXT.planChip(w.label, w.percent, w.resetsAt ? clockAt(w.resetsAt) : ""))),
    failed ? null : agents,
    results ? unfold("results", TEXT.chips.results(results)) : null,
    services ? unfold("services", TEXT.chips.live(services)) : null,
    unfold("more", TEXT.chips.more),
  );
}

/** What a chip unfolds. @param {Session} s @param {Metrics | undefined} m @param {HTMLDialogElement} d */
export function panelPart(s, m, d) {
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
  const cacheMs = m?.cacheExpiresAt ? Date.parse(m.cacheExpiresAt) - Date.now() : undefined;
  const cache = cacheMs === undefined ? null : TEXT.cache(cacheMs <= 0 ? TEXT.cacheExpired : TEXT.cacheLeft(cacheMs < 60_000 ? TEXT.underMinute : duration(Math.floor(cacheMs / 60_000))));
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

/** @param {Result} r @param {() => void} [opened] after the result's window opens */
function resultRow(r, opened) {
  const first = r.images[0];
  const thumb = first ? h("img", { src: imageUrl(first.id), alt: "" }) : h("span", { class: "ph" }, dot(r.status === "failed" ? "failed" : "done"));
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
    h("span", { class: "rbody" }, h("span", { class: "rt" }, r.title), h("span", { class: "rm" }, isNew(r) ? h("span", { class: "new", title: TEXT.newResult }) : null, `${label(S(r.sessionId))} · ${stamp(r.at)}`)),
  );
}

/** Redraws the session panel now, if it still shows this session. @param {string} sid */
function redrawPanel(sid) {
  if (ui.panelSession === sid && dialog("session").open) openSession(sid);
}

/**
 * The session panel: its head, its chips (and the part one of them unfolds), then the conversation
 * with the answer box on the bottom edge.
 * @param {string} sid
 */
export function openSession(sid) {
  const d = dialog("session");
  const s = S(sid);
  if (!s) return;
  if (ui.panelSession !== sid) {
    ui.panelSession = sid;
    ui.panelPart = null;
    ui.panelAsk = null;
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
  const askedBefore = d.open ? (d.querySelector(".panel-question")?.getAttribute("data-key") ?? null) : null;
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
    dialogHead(
      d,
      where(s, s.provider),
      sessionName(s),
      s.lastMessage && (isLive(s) || s.endedAsking) ? h("button", { class: "secondary", title: TEXT.markUnreadHint, "aria-label": TEXT.markUnread, onclick: () => markUnread(s) }, icon("unread"), h("span", { class: "lbl" }, TEXT.markUnread)) : null,
      goLink(s, "primary", icon("go"), h("span", { class: "lbl" }, TEXT.goTo)),
    ),
    body,
  );
  // The conversation reads bottom up: it opens at the latest message and follows new ones, unless
  // the developer scrolled up to read. A part that just unfolded is shown from its top.
  // `body` is not on the page when `patch` kept the one already shown.
  fitNewBoxes(d);
  // A question that arrives while the panel is open comes into its foot, softly; the focus stays where it is.
  if (ui.panelArrival !== null) {
    const ask = d.querySelector(".panel-question");
    if (d.open && ask instanceof HTMLElement && ask.dataset.key === `ask-${ui.panelArrival}` && askedBefore !== ask.dataset.key) arrive(ask);
    ui.panelArrival = null;
  }
  const shownBody = d.querySelector(".session-body");
  if (samePart && shownBody) shownBody.scrollTop = scrolled;
  else if (ui.panelPart && shownBody) shownBody.scrollTop = 0; // the kept body would keep the conversation's offset
  // The chip row scrolls sideways on a phone: a tap on a chip keeps it where it was.
  const chips = shownBody?.querySelector(".pchips");
  if (chips && !fresh) chips.scrollLeft = chipsLeft;
  if (!ui.panelPart && (!samePart || atBottom || ui.panelToEnd)) {
    ui.panelToEnd = false;
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
const heard = (s) => `${s.state} ${s.lastMessage?.at ?? ""} ${s.messageCount ?? 0}`;

/** Redraws the open session panel with the latest data, keeping the box being typed in. */
export function renderPanel() {
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
    asksOf(s.id),
    data.listening.includes(s.id),
    data.gone.includes(s.id),
    data.services.filter(mine),
    data.results.filter(mine).map((r) => r.id),
    projectOf(s),
    ui.conversations.get(s.id)?.length,
    [...ui.draftImages, ...ui.uploading, ...ui.sending], // the box below: images attached, a message on its way
    [...ui.outbox.values()].filter((o) => o.sid === s.id).map((o) => [o.id, o.state, o.error]),
    ui.offline && offlineText(),
    [...ui.stepsOpen],
    [...ui.contextOpen],
    Math.floor(Date.now() / 60_000), // times shown as "for 5 min"
  ]);
}

/**
 * The session's conversation as a chat, newest at the bottom, with the answer box under it: the
 * open question with its options, or a reply to a waiting session. What the developer wrote while
 * it worked is marked.
 * @param {Session} s
 */
export function chat(s) {
  const fetched = ui.conversations.get(s.id);
  const list = fetched && fetched.length ? fetched : s.lastMessage ? [{ id: "last", sessionId: s.id, from: /** @type {const} */ ("session"), text: s.lastMessage.text, at: s.lastMessage.at }] : [];
  const whileWorking = new Set((s.sentWhileWorking ?? []).map((w) => w.text));
  // Everything the session asks, one item at a time, oldest first.
  const items = itemsOf(asksOf(s.id));
  const at = Math.max(0, items.findIndex((it) => it.key === ui.panelAsk));
  const asking = items[at];
  const lead = asking?.open[0];
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
      list.length ? conversationView(list, whileWorking) : fetched && !outgoingView(s.id).length ? h("div", { class: "faint" }, TEXT.conversation.none) : null,
      outgoingView(s.id),
      workingNow(s, list),
    ),
    h(
      "div",
      { class: "chat-footer" },
      // The window covers the strip that says it elsewhere.
      ui.offline ? offlineNotice("offline-line") : null,
      asking && lead
        ? h(
            "div",
            { class: "panel-question", "data-key": `ask-${asking.key}` },
            h(
              "div",
              { class: "meta" },
              badge(lead.kind),
              items.length > 1
                ? [
                    h("span", { class: "faint num" }, TEXT.conversation.askOf(at + 1, items.length)),
                    h("button", { class: "linkish", onclick: () => ((ui.panelAsk = items[(at + 1) % items.length]?.key ?? null), openSession(s.id)) }, TEXT.next),
                  ]
                : null,
              h("span", { class: "spacer" }),
              h("button", { class: "linkish", onclick: () => answerOnDesk(asking.key) }, TEXT.conversation.openQuestion),
            ),
            askBody(asking, { panel: true }),
          )
        : // One box whatever the session does, inert while it cannot take a message: the panel's foot never jumps.
          replyBox(`message-${s.id}`, [], s.id, {
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
            TEXT.conversation.agentsLeft(agents.length, agents.filter((a) => a.state === "failed").length),
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

/** Closes the session panel and shows the item large on the desk. @param {string} key */
function answerOnDesk(key) {
  ui.sel = key;
  showNeedsYou();
}

/** Everything else, rarely needed: terminal keys, worktrees, details. @param {Session} s @param {Metrics | undefined} m */
function morePart(s, m) {
  const p = projectOf(s);
  return [
    controlSection(s, () => redrawPanel(s.id)),
    p ? h("div", { class: "rsec" }, h("h4", {}, TEXT.worktrees.title), h("button", { class: "linkish", onclick: () => openProject(p.id) }, TEXT.worktreeLine(p.worktrees.length, gb(p.totalBytes), mergedOf(p).length))) : null,
    h(
      "div",
      { class: "rsec" },
      h("h4", {}, TEXT.details),
      sessionDetails(s, m),
      h("div", { class: "faint mono" }, [s.project.worktree ?? s.project.dir, s.terminal && (TERMINAL_NAMES[s.terminal] ?? s.terminal), TEXT.running(ago(s.startedAt))].filter(Boolean).join(" · ")),
    ),
  ];
}
