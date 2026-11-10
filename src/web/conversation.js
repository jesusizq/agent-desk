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
    for (const b of answer?.querySelectorAll(".decide button, .opts.sends button") ?? []) if (b instanceof HTMLButtonElement) b.disabled = sending || off;
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
        out.fromBox = false;
        // Its text is the failed message's now, kept on the device with it: the box is free for the next one.
        if (ui.drafts.get(out.key) === out.text) ui.drafts.delete(out.key);
        if (out.images.length && (ui.draftImages.get(out.key) ?? []).join() === out.images.join()) ui.draftImages.delete(out.key);
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

/** Fetches a session's conversation, then re-renders what shows it. @param {string} sid @param {() => void} then */
export function loadConversation(sid, then) {
  const asked = Date.now();
  run(
    fetch(`/api/sessions/${encodeURIComponent(sid)}/messages`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`${res.status}`))))
      .then((/** @type {ConversationEntry[]} */ list) => {
        ui.conversations.set(sid, list);
        // What was sent and is now in the conversation itself leaves its stand-in: one more message with
        // its text, or a fetch asked for after it was delivered (the conversation keeps its latest messages only).
        for (const [id, o] of ui.outbox) if (o.sid === sid && o.state === "sent" && (deskCount(sid, o.text) > o.before || asked > (o.sentAt ?? Infinity))) ui.outbox.delete(id);
        then();
      }),
  );
}

/**
 * Messages as a chat: the session on the left, the developer on the right; `whileWorking` holds
 * the texts the developer sent while the session was working, which get a mark.
 * @param {ConversationEntry[]} list @param {Set<string>} [whileWorking]
 */
export function conversationView(list, whileWorking = new Set()) {
  /** @param {ConversationEntry} m */
  const message = (m) => {
    const who = m.from === "session" ? null : m.via === "desk" ? TEXT.conversation.youDesk : TEXT.conversation.you;
    const mark = m.from === "developer" && whileWorking.has(m.text) ? ` · ${TEXT.conversation.whileWorking}` : "";
    return h(
      "div",
      { class: `msg from-${m.from}${m.step ? " step" : ""}`, "data-key": m.id },
      m.text.trim() ? h("div", { class: "md" }, mdBlocks(m.text, { breaks: m.from === "developer" })) : null,
      m.images?.length ? attachedImages(m.images) : null,
      h("div", { class: "msg-meta" }, who ? [who, " · "] : null, hm(m.at), mark, m.via === "desk" ? deliveredMark() : null),
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
        h("button", { class: "steps-fold linkish faint", "data-key": `fold-${key}`, "aria-expanded": String(open), onclick: () => ((open ? ui.stepsOpen.delete(key) : ui.stepsOpen.add(key)), page.render()) }, `${open ? "▾" : "▸"} ${TEXT.conversation.steps(run.length, agents)}`),
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
