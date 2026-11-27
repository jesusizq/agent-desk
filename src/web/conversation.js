// @ts-check
// A session's conversation: fetched, drawn as a chat, and what is sent to it on its way.
import { h, icon, mdBlocks } from "./dom.js";
import { TEXT } from "./text.js";
import { hm } from "./format.js";
import { toast } from "./pieces.js";
import { imageUrl, post, routeOf, run, saveDrafts } from "./server.js";
import { ATTACHED_IMAGES_MAX, data, page, ui } from "./state.js";
import { zoom } from "./zoom.js";

/** @typedef {import("../core/protocol.ts").ConversationEntry} ConversationEntry */
/** @typedef {import("./state.js").Outgoing} Outgoing */

/** Every box of a draft on the page: the panel, the inbox's card and the arrival bubble can each show a question. @param {string} key */
export const boxesOf = (key) => /** @type {HTMLTextAreaElement[]} */ ([...document.querySelectorAll(`textarea[data-key="${CSS.escape(key)}"]`)]);
/**
 * Shown on the boxes and buttons on the page at once, not at the next drawing: a panel being
 * scrolled puts its redraw off, and the text must not look unsent meanwhile.
 * @param {string} key @param {boolean} sending
 */
export function markSending(key, sending) {
  for (const el of boxesOf(key)) {
    const off = el.getAttribute("aria-disabled") === "true"; // drawn inert: the session cannot take it now
    el.readOnly = sending || off;
    const answer = el.closest(".answer");
    const button = answer?.querySelector(".send");
    if (sending) button?.setAttribute("aria-busy", "true");
    else button?.removeAttribute("aria-busy");
    for (const b of answer?.querySelectorAll(".decide button, .opts.sends button, .replies button.reply") ?? []) if (b instanceof HTMLButtonElement) b.disabled = sending || off;
  }
}

/** @param {string} sid @param {string} text */
const deskCount = (sid, text) => (ui.conversations.get(sid) ?? []).filter((m) => m.from === "developer" && m.via === "desk" && m.text === text).length;
/** A draft whose text is in the conversation on its way: its box shows empty meanwhile, the draft kept until it is delivered. @param {string} key */
export const leftTheBox = (key) => [...ui.outbox.values()].some((o) => o.key === key && o.state === "sending" && o.fromBox);
/**
 * Sends `out` from the session's conversation, where it shows at once; delivered, `onSent` runs. On
 * failure it stays in the conversation with the error, its text kept on the device, never in a toast.
 * @param {Outgoing} out @param {() => void} [onSent]
 */
export function deliver(out, onSent) {
  const route = routeOf(out.key);
  if (!route || ui.sending.has(out.key)) return;
  out.state = "sending";
  delete out.error;
  out.before = deskCount(out.sid, out.text);
  ui.outbox.set(out.id, out);
  ui.sending.add(out.key);
  markSending(out.key, true);
  if (ui.panelSession === out.sid) {
    ui.panelToEnd = true; // as a chat app, what is sent shows at the conversation's end
    ui.panelTouchedAt = 0; // now: the developer's own action is not a scroll to wait out
  }
  saveDrafts();
  page.renderPanel();
  post(route, out.images.length ? { text: out.text, images: out.images } : { text: out.text })
    .then(
      () => {
        out.state = "sent";
        out.sentAt = Date.now();
        saveDrafts();
        onSent?.();
      },
      (/** @type {Error} */ e) => {
        out.state = "failed";
        out.error = e.message;
        // Its text is the failed message's now, kept on the device with it: the box is free for the next one.
        // A saved reply never left the box, so a draft that merely equals it stays.
        if (out.fromBox) {
          if (ui.drafts.get(out.key) === out.text) ui.drafts.delete(out.key);
          if (out.images.length && (ui.draftImages.get(out.key) ?? []).join() === out.images.join()) ui.draftImages.delete(out.key);
        }
        out.fromBox = false;
        saveDrafts();
      },
    )
    .catch((/** @type {Error} */ e) => toast(e.message))
    .finally(() => {
      ui.sending.delete(out.key);
      markSending(out.key, false);
      page.render();
    });
}
/** Once delivered: the panel shows the conversation with it, and an answered card says it is answered. @param {string} key @param {string} sid */
export function landed(key, sid) {
  if (ui.panelSession === sid) {
    ui.panelHeard = null; // the panel fetches the conversation again, with this message
    ui.panelTouchedAt = 0; // and shows it now: the developer's own action is not a scroll to wait out
  }
  if (key.startsWith("answer-")) resolve(key.slice("answer-".length));
}
/** A message not sent goes back into its box, before what is there, to be changed or sent again. @param {Outgoing} out */
function editUnsent(out) {
  // An answer whose question closed meanwhile has no box: it becomes a message to its session.
  const key = boxesOf(out.key).length ? out.key : `message-${out.sid}`;
  ui.outbox.delete(out.id);
  ui.drafts.set(key, [out.text, ui.drafts.get(key)].filter(Boolean).join("\n"));
  if (out.images.length) ui.draftImages.set(key, [...out.images, ...(ui.draftImages.get(key) ?? [])].slice(0, ATTACHED_IMAGES_MAX));
  saveDrafts();
  page.render();
  const box = boxesOf(key).at(-1);
  if (box && !box.readOnly) box.focus();
}

// An answer sent from the desk shows on its card for a moment before the next question takes its place.
const RESOLVED_MS = 650;
/** @param {string} questionId */
function resolve(questionId) {
  ui.resolved.set(questionId, Date.now() + RESOLVED_MS);
  setTimeout(() => {
    ui.resolved.delete(questionId);
    page.render();
  }, RESOLVED_MS);
}

/** The copy of a conversation this device saved (sw.js) carries when it answered for a computer too slow or away. */
const SAVED_AT = "X-Agent-Desk-Saved-At";
/** The latest fetch of each session's conversation: one asked earlier that answers later is older. @type {Map<string, number>} */
const latestFetch = new Map();
let fetches = 0;
/**
 * Fetches a session's conversation, then re-renders what shows it. `then` learns whether it is the
 * desk's own (`fresh`): a copy the device saved may predate what was just sent, so the caller asks again.
 * @param {string} sid @param {(fresh: boolean) => void} then
 */
export function loadConversation(sid, then) {
  const asked = Date.now();
  const n = ++fetches;
  latestFetch.set(sid, n);
  run(
    fetch(`/api/sessions/${encodeURIComponent(sid)}/messages`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return { list: /** @type {ConversationEntry[]} */ (await res.json()), saved: res.headers.has(SAVED_AT) };
      })
      .then(({ list, saved }) => {
        if (latestFetch.get(sid) !== n) return; // a later fetch answers instead: this one may lack the newest messages
        if (saved) {
          // Better than nothing before the first answer, never over a newer list nor taking what was sent off the page.
          if (!ui.conversations.has(sid)) ui.conversations.set(sid, list);
          then(false);
          return;
        }
        ui.conversations.set(sid, list);
        // What was sent and is now in the conversation itself leaves its stand-in: one more message with
        // its text, or a fetch asked for after it was delivered (the conversation keeps its latest messages only).
        for (const [id, o] of ui.outbox) if (o.sid === sid && o.state === "sent" && (deskCount(sid, o.text) > o.before || asked > (o.sentAt ?? Infinity))) ui.outbox.delete(id);
        then(true);
      }),
  );
}

/** Who a message is from, as its line under it says; none for the session's own. @param {ConversationEntry} m */
function author(m) {
  const t = TEXT.conversation;
  if (m.from === "peer") return t.fromPeer(m.sender);
  if (m.from === "agent") return t.fromAgent(m.sender);
  if (m.from === "developer") return m.via === "desk" ? t.youDesk : t.you;
  return null;
}

/**
 * The conversation as it is drawn: what the session wrote between its tool calls folds under one line
 * once something followed it (the latest run, still being written, stays open), and an agent's report,
 * long and meant for the session, folds too. `key` is the fold's, in `ui.stepsOpen`.
 * @param {ConversationEntry[]} list
 * @returns {{ kind: "steps" | "agent" | "message", key: string, run: ConversationEntry[], end: number }[]}
 */
export function groupsOf(list) {
  /** @type {{ kind: "steps" | "agent" | "message", key: string, run: ConversationEntry[], end: number }[]} */
  const out = [];
  for (let i = 0; i < list.length; ) {
    const m = list[i];
    if (!m) break;
    let end = i;
    while (list[end]?.step) end++;
    if (end > i && end < list.length) {
      const run = list.slice(i, end);
      out.push({ kind: "steps", key: run[0]?.id ?? "", run, end });
      i = end;
    } else {
      out.push({ kind: m.from === "agent" ? "agent" : "message", key: m.id, run: [m], end: i + 1 });
      i++;
    }
  }
  return out;
}

/**
 * The developer's messages that `sent` (what the session recorded as written to it while it worked)
 * names: each record, the message of its text nearest it in time, so a "Yes" sent mid-turn marks
 * that one only, not every "Yes" before it.
 * @param {ConversationEntry[]} list @param {{ text: string, at: string }[]} sent @returns {Set<string>}
 */
export function sentWhileWorking(list, sent) {
  const marked = new Set();
  for (const w of sent) {
    const at = Date.parse(w.at);
    let best = /** @type {ConversationEntry | undefined} */ (undefined);
    for (const m of list) {
      if (m.from !== "developer" || m.text !== w.text || marked.has(m.id)) continue;
      if (!best || Math.abs(Date.parse(m.at) - at) < Math.abs(Date.parse(best.at) - at)) best = m;
    }
    if (best) marked.add(best.id);
  }
  return marked;
}

/**
 * Messages as a chat: the session on the left, the developer on the right, what another session or
 * an agent sent it quoted on the left (an agent's report folded to one line); `whileWorking` holds
 * the ids of the developer's messages sent while the session was working, which get a mark.
 * @param {ConversationEntry[]} list @param {Set<string>} [whileWorking]
 */
export function conversationView(list, whileWorking = new Set()) {
  /** @param {ConversationEntry} m */
  const message = (m) => {
    const who = author(m);
    const mark = m.from === "developer" && whileWorking.has(m.id) ? ` · ${TEXT.conversation.whileWorking}` : "";
    return h(
      "div",
      { class: `msg from-${m.from}${m.step ? " step" : ""}`, "data-key": m.id },
      m.text.trim() ? h("div", { class: "md" }, mdBlocks(m.text, { breaks: m.from === "developer" })) : null,
      m.images?.length ? attachedImages(m.images) : null,
      h("div", { class: "msg-meta" }, who ? [who, " · "] : null, hm(m.at), mark, m.via === "desk" ? deliveredMark() : null),
    );
  };
  /** @param {string} key @param {string} label */
  const fold = (key, label) => {
    const open = ui.stepsOpen.has(key);
    return h("button", { class: "steps-fold linkish faint", "data-key": `fold-${key}`, "aria-expanded": String(open), onclick: () => ((open ? ui.stepsOpen.delete(key) : ui.stepsOpen.add(key)), page.render()) }, `${open ? "▾" : "▸"} ${label}`);
  };
  /** @type {HTMLElement[]} */
  const out = [];
  for (const g of groupsOf(list)) {
    if (g.kind === "steps") {
      const until = list[g.end]?.at ?? "";
      const agents = data.agents.filter((a) => a.sessionId === g.run[0]?.sessionId && a.startedAt >= (g.run[0]?.at ?? "") && a.startedAt <= until).length;
      out.push(fold(g.key, TEXT.conversation.steps(g.run.length, agents)));
      if (ui.stepsOpen.has(g.key)) out.push(...g.run.map(message));
    } else if (g.kind === "agent") {
      out.push(fold(g.key, `${TEXT.conversation.fromAgent(g.run[0]?.sender)} · ${hm(g.run[0]?.at ?? "")}`));
      if (ui.stepsOpen.has(g.key)) out.push(...g.run.map(message));
    } else out.push(...g.run.map(message));
  }
  return out;
}

/** The desk delivered it to the session's inbox, which hands it over at once. */
const deliveredMark = () => h("span", { class: "delivered", role: "img", "aria-label": TEXT.conversation.delivered, title: TEXT.conversation.delivered }, icon("check"));

/**
 * What was sent from this conversation and is not in it yet, as the developer's last messages:
 * sending, delivered, or not sent, with the error, Retry and Edit. @param {string} sid
 */
export function outgoingView(sid) {
  return [...ui.outbox.values()]
    .filter((o) => o.sid === sid)
    .map((o) =>
      h(
        "div",
        { class: `msg from-developer out ${o.state}`, "data-key": o.id },
        o.text.trim() ? h("div", { class: "md" }, mdBlocks(o.text, { breaks: true })) : null,
        o.images.length ? attachedImages(o.images) : null,
        h(
          "div",
          { class: "msg-meta", role: "status" },
          TEXT.conversation.youDesk,
          o.state === "sending" ? [" · ", TEXT.sending] : o.state === "sent" && o.sentAt ? [" · ", hm(new Date(o.sentAt).toISOString()), deliveredMark()] : null,
        ),
        o.state === "failed"
          ? h(
              "div",
              { class: "unsent", role: "alert" },
              h("span", { class: "unsent-why" }, TEXT.conversation.notSent(o.error ?? "")),
              h("span", { class: "unsent-do" }, h("button", { class: "linkish", onclick: () => deliver(o, () => landed(o.key, o.sid)) }, TEXT.conversation.retry), h("button", { class: "linkish", onclick: () => editUnsent(o) }, TEXT.conversation.edit)),
            )
          : null,
      ),
    );
}

/** Images the developer attached on the desk, as thumbnails that open the zoom. @param {string[]} ids */
export function attachedImages(ids) {
  const gallery = ids.map((id) => ({ src: imageUrl(id), caption: "" }));
  return h("div", { class: "msg-imgs" }, gallery.map((p, i) => h("img", { src: p.src, alt: TEXT.attachedImage, onclick: () => zoom(gallery, i) })));
}
