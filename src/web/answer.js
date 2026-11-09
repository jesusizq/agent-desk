// @ts-check
// What a question asks and the box that answers it: options, text and images, delivered verbatim.
import { h, icon, md, mdBlocks, onKept } from "./dom.js";
import { TEXT } from "./text.js";
import { boxesOf, conversationView, deliver, landed, leftTheBox, loadConversation, markSending } from "./conversation.js";
import { headline } from "./format.js";
import { COARSE, fitBox } from "./layout.js";
import { dot, toast } from "./pieces.js";
import { imageUrl, post, routeOf, run, saveDrafts, uploadImage } from "./server.js";
import { ATTACHED_IMAGES_MAX, data, page, ui } from "./state.js";

/** @typedef {import("../core/protocol.ts").Question} Question */
/** @typedef {import("../core/protocol.ts").ConversationEntry} ConversationEntry */
/** @typedef {import("./state.js").Item} Item */
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
  const decide = decisionOf(q);
  return replyBox(`answer-${q.id}`, decide ? [] : q.options, q.sessionId, {
    placeholder: !listening ? TEXT.notListeningShort : decide ? TEXT.permission.reason : undefined,
    hint: decide ? TEXT.permission.hint : undefined,
    decide,
    images: !textOnly,
    middle,
    several: q.several === true,
    off: listening ? null : TEXT.notListening,
  });
}

/**
 * A permission prompt's two options are what allows it and what denies it, in that order. Any other
 * text denies it with that text as the reason, so a reason is never sent as the allowing answer.
 * @param {Question} q @returns {Decide | null}
 */
export function decisionOf(q) {
  const [allow, deny] = q.options;
  return q.kind === "permission" && q.options.length === 2 && allow !== undefined && deny !== undefined ? { allow, deny } : null;
}
/** @typedef {{ allow: string, deny: string }} Decide */
/** The denial sent for a reason written in the box: the reason itself, unless it reads as the allowing answer. @param {Decide} decide @param {string} reason */
const denial = (decide, reason) => (!reason.trim() || reason.trim() === decide.allow ? decide.deny : reason);

/**
 * Text box (and option buttons) whose content is sent verbatim to a listening session, with the
 * images pasted into it or picked when `images` is set. Drafts survive re-renders. With `off` (why
 * the session cannot take it now) the same box is drawn inert, so it never jumps between states.
 * With `several`, each option toggles: the box holds the ones picked, in their order, separated by ", ".
 * With `decide` (a permission prompt), Allow and Deny send at once, and the box holds Deny's reason.
 * Sent from a session's conversation, it shows there with how its delivery goes; elsewhere the card
 * it answers says it is answered.
 * @param {string} key `answer-<question id>` or `message-<session id>` @param {string[]} options @param {string} sid
 * @param {{ placeholder?: string, hint?: string, images?: boolean, middle?: Child, several?: boolean, decide?: Decide | null, off?: string | null }} [how] `middle` is shown between the options and the box
 */
export function replyBox(key, options, sid, { placeholder = options.length ? TEXT.answerPlaceholder : TEXT.replyPlaceholder, hint = TEXT.sendHint, images = true, middle = null, several = false, decide = null, off = null } = {}) {
  const route = routeOf(key);
  if (!route) throw new Error(`a reply box for ${key}, which names no question or session`);
  const boxes = () => boxesOf(key);
  const attached = images && !leftTheBox(key) ? (ui.draftImages.get(key) ?? []) : [];
  const uploading = (ui.uploading.get(key) ?? 0) > 0;
  /** @param {Blob[]} files */
  const attach = (files) => {
    for (const file of files.slice(0, ATTACHED_IMAGES_MAX - attached.length)) {
      ui.uploading.set(key, (ui.uploading.get(key) ?? 0) + 1);
      run(uploadImage(file).then((id) => (ui.draftImages.set(key, [...(ui.draftImages.get(key) ?? []), id]), saveDrafts())), () => ui.uploading.set(key, (ui.uploading.get(key) ?? 1) - 1));
    }
    if (files.length > ATTACHED_IMAGES_MAX - attached.length) toast(TEXT.tooManyImages(ATTACHED_IMAGES_MAX));
  };
  /** @param {Event} e @param {string} [text] what to send: the box's text unless a decision says otherwise */
  const send = (e, text = decide ? denial(decide, box.value) : box.value) => {
    // Read now, not as last drawn: a second click before the redraw must not send twice.
    if (off || (!text.trim() && attached.length === 0) || ui.sending.has(key) || (ui.uploading.get(key) ?? 0) > 0) return;
    // An answered card leaves, and the keyboard with it; a message's box stays, as in a chat app.
    const answer = key.startsWith("answer-");
    const from = (e.currentTarget instanceof Element ? e.currentTarget : box).closest("#arrival, #session")?.id ?? "desk";
    const delivered = () => {
      ui.drafts.delete(key);
      ui.draftImages.delete(key);
      saveDrafts();
      for (const el of boxes()) {
        el.value = "";
        fitBox(el);
      }
      landed(key, sid);
      if (!answer || !(e instanceof KeyboardEvent)) return;
      if (from === "arrival") ui.arrivalFocus = true;
      else if (!document.querySelector("dialog[open]")) ui.focusAfter = key.slice("answer-".length);
    };
    if (answer) box.blur();
    if (from === "session") {
      // In the conversation, as a chat app: the text leaves the box for a bubble that says how its delivery goes.
      const fromBox = text === box.value;
      if (fromBox)
        for (const el of boxes()) {
          el.value = "";
          fitBox(el);
        }
      deliver({ id: `out-${++outgoingSeq}`, key, sid, text, images: attached, state: "sending", before: 0, fromBox }, delivered);
      return;
    }
    ui.sending.add(key);
    markSending(key, true);
    run(post(route, attached.length ? { text, images: attached } : { text }).then(delivered), () => {
      ui.sending.delete(key);
      markSending(key, false);
    });
  };
  /** The options the box holds: one, or with `several` a list of them; null when it holds anything else. @param {string} value */
  const picked = (value) => {
    if (value === "") return [];
    if (!several) return options.includes(value) ? [value] : null;
    const parts = value.split(",").map((p) => p.trim());
    return parts.every((p) => options.includes(p)) ? parts : null;
  };
  /** The option buttons on the page, which are this drawing's or the kept ones. */
  const syncPressed = () => box.parentElement?.querySelectorAll(":scope > .opts > button").forEach((b, i) => b.setAttribute("aria-pressed", String(picked(box.value)?.includes(options[i] ?? "") === true)));
  /** One option picked, or with `several` added or taken out; anything else written is replaced. @param {string} o @param {boolean} focus */
  const pick = (o, focus) => {
    const had = picked(box.value) ?? [];
    box.value = several ? options.filter((x) => (x === o) !== had.includes(x)).join(", ") : o;
    ui.drafts.set(key, box.value);
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
        // A permission's box holds a reason to deny: empty, the keys do nothing rather than deny.
        if (!decide || box.value.trim()) send(e);
      }
      // While the box is empty or holds only options as picked, a digit picks (or toggles) another.
      const option = /^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !off ? options[Number(e.key) - 1] : undefined;
      if (option !== undefined && picked(box.value) !== null) {
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
  box.value = leftTheBox(key) ? "" : (ui.drafts.get(key) ?? "");
  onKept(box, (live) => {
    box = live;
    // Written only when it differs (a message sent empties it): setting a value resets the keyboard too.
    const draft = leftTheBox(key) ? "" : (ui.drafts.get(key) ?? "");
    if (live.value !== draft) {
      live.value = draft;
      fitBox(live);
    }
  });
  const chosen = picked(box.value) ?? [];
  const opts = options.map((o, i) => h("button", { "aria-pressed": String(chosen.includes(o)), disabled: off !== null, onclick: (e) => pick(o, !byFinger(e)) }, several ? h("span", { class: "tick", "aria-hidden": "true" }) : null, i < 9 ? h("kbd", {}, String(i + 1)) : null, o));
  /** @param {Event} e */
  const pickFiles = (e) => {
    const picker = e.currentTarget instanceof Element ? e.currentTarget.parentElement?.querySelector("input") : null;
    picker?.click();
  };
  const busy = ui.sending.has(key);
  const decision = decide
    ? h(
        "div",
        { class: "decide" },
        h("button", { class: "primary allow", disabled: off !== null || busy, onmousedown: (e) => e.preventDefault(), onclick: (e) => send(e, decide.allow) }, icon("check"), TEXT.permission.allow),
        h("button", { class: "secondary danger deny", disabled: off !== null || busy, onmousedown: (e) => e.preventDefault(), onclick: (e) => send(e) }, icon("x"), TEXT.permission.deny),
      )
    : null;
  return h(
    "div",
    { class: `answer${off ? " off" : ""}${decide ? " decides" : ""}` },
    decide ? [middle ? h("div", { class: "answer-middle" }, middle) : null, decision] : null,
    opts.length && several ? h("div", { class: "opts-note faint" }, TEXT.pickSeveral) : null,
    opts.length ? h("div", { class: `opts${several ? " several" : ""}`, role: several ? "group" : null, "aria-label": several ? TEXT.pickSeveral : null }, opts) : null,
    middle && !decide ? h("div", { class: "answer-middle" }, middle) : null,
    attached.length || uploading
      ? h(
          "div",
          { class: "attached" },
          attached.map((id) =>
            h(
              "span",
              { class: "thumb", "data-key": id },
              h("img", { src: imageUrl(id), alt: TEXT.attachedImage }),
              h("button", { class: "icon-btn", title: TEXT.removeImage, "aria-label": TEXT.removeImage, onclick: () => (ui.draftImages.set(key, attached.filter((x) => x !== id)), saveDrafts(), page.render()) }, icon("x")),
            ),
          ),
          uploading ? h("span", { class: "faint" }, TEXT.attaching) : null,
        )
      : null,
    box,
    h(
      "div",
      { class: "row" },
      decide
        ? null
        : h(
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
      h("span", { class: "faint send-hint" }, off ?? [h("span", { class: "keys-only" }, `${decide ? TEXT.permission.keys : TEXT.sendKeys} `), hint, images ? ` ${TEXT.pasteImages}` : ""]),
    ),
  );
}

/**
 * A question's headline is the line that asks (or its first line); when the question is a whole
 * block (a list of pending points), the block follows in full, with its formatting.
 * @param {string} text
 */
function questionText(text) {
  /** @param {string} line */
  const head = (line) => h("div", { class: `qtext${line.length > LONG_QUESTION ? " long" : ""}` }, md(line));
  if (text.split("\n").filter((l) => l.trim()).length <= 1) return head(text);
  return [head(headline(text)), h("div", { class: "qctx md qfull" }, mdBlocks(text))];
}
// Past this many characters a question reads as a paragraph, not a title: it steps down in size and weight.
const LONG_QUESTION = 160;

/** Earlier messages of the asking session, unfolded on demand under the large card. @param {Question} q */
function earlierConversation(q) {
  const open = ui.unfolded.has(q.id);
  const toggle = h("button", {
    class: "linkish faint",
    onclick: () => {
      if (open) ui.unfolded.delete(q.id);
      else {
        ui.unfolded.add(q.id);
        loadConversation(q.sessionId, page.renderView);
      }
      page.renderView();
    },
  }, open ? TEXT.conversation.hideEarlier : TEXT.conversation.showEarlier);
  const list = ui.conversations.get(q.sessionId);
  // Drawn once fetched: an empty block first would say "nothing earlier" and then grow.
  if (!open || !list) return toggle;
  // A turn that ends asking: the question is its message's last part, already on the card with the rest as context.
  const own = (/** @type {ConversationEntry} */ m) => m.from === "session" && m.text.trim().endsWith(q.text.replace(/^…/, "").trim());
  const before = list.filter((m) => m.at <= q.askedAt && !own(m)).slice(-8);
  // It opens on the turn right before the question, so reading goes on into it.
  return [toggle, h("div", { class: "conversation", "data-scroll": `conv-${q.id}`, "data-scroll-end": true, "data-grow": true }, before.length ? conversationView(before) : h("div", { class: "faint" }, TEXT.conversation.none))];
}

/** What the session said around a question, folded when long. @param {Question} q */
function contextFold(q) {
  if (!q.context) return null;
  const long = q.context.length > 320 || q.context.split("\n").length > 5;
  const unfolded = ui.contextOpen.has(q.id);
  return [
    h("div", { class: `qctx md${long && !unfolded ? " folded" : ""}`, "data-scroll": `ctx-${q.id}` }, mdBlocks(q.context)),
    long ? h("button", { class: "linkish", onclick: () => ((unfolded ? ui.contextOpen.delete(q.id) : ui.contextOpen.add(q.id)), page.render()) }, unfolded ? TEXT.foldMessage : TEXT.unfoldMessage) : null,
  ];
}

/**
 * What an item asks and what it takes to answer it: the question, its options, then what the session
 * said around it. Questions asked together come as numbered parts, each answered on its own, under a
 * line saying the session waits for all of them. In the session panel the question shows whole in a
 * box of its own height, the conversation above holding the rest. @param {Item} item @param {{ panel?: boolean }} [where]
 */
export function askBody(item, { panel = false } = {}) {
  /** @param {Question} q */
  const text = (q) => (q.kind === "permission" ? h("pre", { class: "qcode", "data-scroll": `code-${q.id}` }, q.text) : panel ? h("div", { class: "pq-text", "data-scroll": `pq-${q.id}` }, questionText(q.text)) : questionText(q.text));
  /** @param {Question} q @param {Child} [earlier] */
  const ask = (q, earlier = null) => {
    const more = [contextFold(q), earlier].flat().filter(Boolean);
    return [text(q), q.status === "open" ? answerForm(q, more.length ? h("div", { class: "qmore" }, more) : null) : resolvedLine(q)];
  };
  const [first] = item.questions;
  if (!first) return null;
  const earlier = panel ? null : earlierConversation(first);
  if (item.questions.length === 1) return ask(first, earlier);
  const size = item.questions.length;
  return [
    h("div", { class: "group-note", role: "status" }, TEXT.group.waits(size, size - item.open.length)),
    item.questions.map((q, i) => h("section", { class: `qpart${q.status === "open" ? "" : " done"}`, "data-key": `part-${q.id}`, "aria-label": TEXT.group.part(i, size) }, h("div", { class: "qpart-n" }, TEXT.group.part(i, size)), ask(q))),
    earlier ? h("div", { class: "qmore" }, earlier) : null,
  ];
}

/** How a question was settled from the desk: its answer, or for a permission whether it was allowed and why not. @param {Question} q */
function resolvedLine(q) {
  if (q.status === "dismissed") return h("div", { class: "resolved-line quiet", role: "status" }, dot("idle"), h("b", {}, TEXT.kinds.dismissed));
  const decide = decisionOf(q);
  const text = q.answer?.text;
  const allowed = decide !== null && text === decide.allow;
  const reason = decide && text !== undefined && !allowed && text !== decide.deny ? text : null;
  return h(
    "div",
    { class: "resolved-line", role: "status" },
    dot(decide && !allowed ? "failed" : "done"),
    h("b", {}, decide ? (allowed ? TEXT.permission.allowedLine : TEXT.permission.deniedLine) : TEXT.answered),
    decide ? (reason ? h("span", { class: "resolved-answer" }, reason) : null) : text !== undefined ? h("span", { class: "resolved-answer" }, text) : null,
  );
}

let outgoingSeq = 0;
