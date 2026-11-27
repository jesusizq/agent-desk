// @ts-check
// Saved replies: the phrases the developer sends sessions again and again, kept on the desk for every
// device and sent with one tap from above a reply box; and the sheet that changes them.
import { dialog, h, icon, patch } from "./dom.js";
import { TEXT } from "./text.js";
import { toast } from "./pieces.js";
import { DeskError, getJson, OfflineError, postJson } from "./server.js";
import { page } from "./state.js";

/** As the desk checks them (readSavedReplies in src/core/model.ts), which refuses a list past them. */
const REPLIES_MAX = 20;
const REPLY_MAX = 500;
/** A finger held this long on a chip puts its reply in the box instead of sending it. */
const LONG_PRESS_MS = 500;
/** A finger that moves farther than this is scrolling the row, not pressing a chip. */
const SLOP_PX = 10;

/** The saved replies as the desk last gave them, and their revision there: a save from an older one is refused. @type {string[]} */
let saved = [];
let savedRev = 0;
/** Why the desk could not read the file it keeps them in, when it could not. @type {string | null} */
let unreadable = null;

/** The saved replies the chips show, for a view that redraws only when what it shows changed. */
export const shownReplies = () => saved;

/** What the desk answers for the saved replies, checked. @param {unknown} body */
function repliesOf(body) {
  const b = /** @type {{ replies?: unknown, rev?: unknown, problem?: unknown }} */ (typeof body === "object" && body !== null ? body : {});
  const { replies, rev, problem } = b;
  if (!Array.isArray(replies) || !replies.every((r) => typeof r === "string") || !Number.isInteger(rev)) throw new Error(`the desk's saved replies are unreadable: ${JSON.stringify(body).slice(0, 80)}`);
  return { replies: /** @type {string[]} */ (replies), rev: /** @type {number} */ (rev), problem: typeof problem === "string" ? problem : null };
}

/** Fetched when the page starts, after a save and when the window comes back to the front; never at a redraw. */
export function loadReplies() {
  getJson("/api/replies")
    .then((body) => {
      const got = repliesOf(body);
      const changed = JSON.stringify(got.replies) !== JSON.stringify(saved);
      saved = got.replies;
      savedRev = got.rev;
      unreadable = got.problem;
      if (changed) page.render();
    })
    .catch((/** @type {Error} */ e) => {
      // Offline the page says so already, and keeps the replies it has until the next fetch.
      if (!(e instanceof OfflineError)) toast(e.message);
    });
}

/** The finger on a chip until it lifts, moves or has held long enough. @type {{ x: number, y: number, timer: number } | null} */
let press = null;
/** The chip whose reply a long press or right-click just put in the box: the click that follows sends nothing. @type {EventTarget | null} */
let held = null;

/** @param {Event} e */
function pressStart(e) {
  held = null;
  pressEnd();
  const chip = e.currentTarget;
  if (!(e instanceof PointerEvent) || e.pointerType === "mouse" || !e.isPrimary || !chip) return;
  const timer = setTimeout(() => {
    press = null;
    held = chip;
    // To the chip's handler of the latest drawing: the page may have redrawn under the finger.
    chip.dispatchEvent(new Event("replyhold"));
  }, LONG_PRESS_MS);
  press = { x: e.clientX, y: e.clientY, timer };
}
/** @param {Event} e */
function pressMove(e) {
  if (press && e instanceof PointerEvent && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP_PX) pressEnd();
}
function pressEnd() {
  if (press) clearTimeout(press.timer);
  press = null;
}

/**
 * The saved replies above a reply box, then the chip that edits them. A tap or click sends a reply
 * exactly as saved (`send`); a long press or right-click hands it to `insert`, to change before sending.
 * @param {{ disabled: boolean, send: (e: Event, reply: string) => void, insert: (reply: string) => void }} how
 */
export function repliesRow({ disabled, send, insert }) {
  const chips = saved.map((reply) =>
    h(
      "button",
      {
        class: "chip reply",
        type: "button",
        "data-key": `r:${reply}`,
        title: reply,
        "aria-label": TEXT.replies.use(reply),
        disabled,
        // The focus stays in the box, as the Send button leaves it.
        onmousedown: (e) => e.preventDefault(),
        onpointerdown: pressStart,
        onpointermove: pressMove,
        onpointerup: pressEnd,
        onpointercancel: pressEnd,
        onreplyhold: () => insert(reply),
        oncontextmenu: (e) => {
          e.preventDefault();
          if (held === e.currentTarget) return; // the long press put it in already
          pressEnd();
          held = e.currentTarget;
          insert(reply);
        },
        onclick: (e) => {
          const after = held === e.currentTarget;
          held = null;
          // A click from the keys (detail 0) is the developer's own, never the end of a long press.
          if (after && e instanceof MouseEvent && e.detail !== 0) return;
          send(e, reply);
        },
      },
      h("span", {}, reply),
    ),
  );
  const edit = h(
    "button",
    { class: `chip reply-edit${saved.length ? " icon-only" : ""}`, type: "button", "data-key": "edit", "aria-haspopup": "dialog", title: TEXT.replies.edit, "aria-label": saved.length ? TEXT.replies.edit : null, onclick: openEditor },
    icon("pencil"),
    saved.length ? null : TEXT.replies.add,
  );
  return h("div", { class: "replies", role: "group", "aria-label": TEXT.replies.row }, chips, edit);
}

/** @typedef {{ text: string, rev: number, error: string | null, saving: boolean }} Editor */
/** The editor while it is open: the text as typed, the revision it edits, and why the desk refused it. @type {Editor | null} */
let editing = null;

function openEditor() {
  editing = { text: saved.join("\n"), rev: savedRev, error: unreadable ? TEXT.replies.unreadable(unreadable) : null, saving: false };
  drawEditor();
  const d = dialog("replies-edit");
  if (!d.open) d.showModal();
  d.querySelector("textarea")?.focus();
}

function drawEditor() {
  const ed = editing;
  if (!ed) return;
  const t = TEXT.replies;
  const d = dialog("replies-edit");
  patch(
    d,
    h(
      "form",
      { method: "dialog", class: "rv-form replies-form", onsubmit: (e) => (e.preventDefault(), saveEditor()) },
      h("h2", { id: "replies-title" }, t.title),
      h("p", { class: "lead" }, t.lead(REPLIES_MAX, REPLY_MAX)),
      h(
        "label",
        { class: "rv-note" },
        h("span", { class: "rv-eyebrow" }, t.field),
        h("textarea", { "data-key": "replies-text", rows: 8, placeholder: t.placeholder, readonly: ed.saving, oninput: (e) => (ed.text = /** @type {HTMLTextAreaElement} */ (e.target).value) }),
      ),
      ed.error ? h("p", { class: "replies-error", role: "alert" }, ed.error) : null,
      h(
        "div",
        { class: "rv-row" },
        h("button", { type: "button", class: "secondary", onclick: () => d.close() }, t.cancel),
        h("button", { type: "submit", class: "primary", disabled: ed.saving, "aria-busy": ed.saving ? "true" : null }, ed.saving ? t.saving : t.save),
      ),
    ),
  );
  // patch keeps what a kept box holds: the text is set only when it differs.
  const box = d.querySelector("textarea");
  if (box instanceof HTMLTextAreaElement && box.value !== ed.text) box.value = ed.text;
}

/**
 * Saves one reply per line of the editor; refused, the reason shows in it and the text stays, its empty
 * lines and the spaces around each reply gone, so the line a refusal names is the one shown. Closed
 * before the desk answered, a refusal shows as a toast.
 */
function saveEditor() {
  const ed = editing;
  if (!ed || ed.saving) return;
  const replies = ed.text.split("\n").map((line) => line.trim()).filter(Boolean);
  ed.text = replies.join("\n");
  ed.saving = true;
  ed.error = null;
  drawEditor();
  postJson("/api/replies", { replies, rev: ed.rev }, "PUT")
    .then((body) => {
      const got = repliesOf(body);
      saved = got.replies;
      savedRev = got.rev;
      unreadable = null;
      if (onScreen(ed)) dialog("replies-edit").close();
    })
    .catch((/** @type {Error} */ e) => {
      const refused = e instanceof DeskError && e.status === 409 ? /** @type {{ stale?: unknown, rev?: unknown }} */ (e.body) : null;
      // Saved from another device since this editor opened: a second Save puts this text over that list.
      if (refused?.stale === true && Number.isInteger(refused.rev)) {
        ed.rev = /** @type {number} */ (refused.rev);
        loadReplies();
      }
      if (onScreen(ed)) ed.error = e.message;
      else toast(TEXT.replies.notSaved(e.message));
    })
    .finally(() => {
      ed.saving = false;
      if (onScreen(ed)) drawEditor();
      page.render();
    });
}
/** Whether the editor still shows `ed`: its close event comes a task after it closed, so `editing` alone may name one already closed. @param {Editor} ed */
const onScreen = (ed) => editing === ed && dialog("replies-edit").open;
// A close event that arrives once the editor was opened again belongs to the editor that closed.
dialog("replies-edit").addEventListener("close", () => {
  if (!dialog("replies-edit").open) editing = null;
});
