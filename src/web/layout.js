// @ts-check
// Where things are on the screen: one column or two, what is in sight, the boxes' height, the edges
// that hide more, the keyboard over the page.
import { dialog, WINDOWS } from "./dom.js";
import { inProject, page, ui } from "./state.js";

/** @typedef {import("../core/protocol.ts").Question} Question */

// In one column (a phone) the large card sits above the queue, maybe off screen. Same query as style.css.
export const ONE_COLUMN = matchMedia("(max-width: 700px), (max-height: 500px)");
/** A finger, not a mouse: no hover, and a focused box raises a keyboard. */
export const COARSE = matchMedia("(pointer: coarse)");
/** @param {ScrollLogicalPosition} [block] */
export function revealNext(block = "nearest") {
  if (ONE_COLUMN.matches) document.querySelector(".next")?.scrollIntoView({ block });
}

/** The window on top, if one is open over the desk. */
export const topDialog = () => /** @type {HTMLDialogElement | undefined} */ ([...document.querySelectorAll("dialog[open]")].at(-1));
/** The session's panel is open on top, on its conversation: what the session asks appears there. @param {string} sid */
export const panelShowsConversation = (sid) => topDialog()?.id === "session" && ui.panelSession === sid && ui.panelPart === null;
/** The question shows where it lives: in its session's open panel, or under Needs you with nothing over it. @param {Question} q */
export function inSight(q) {
  if (panelShowsConversation(q.sessionId)) return true;
  return !topDialog() && ui.view === "desk" && (!ONE_COLUMN.matches || ui.tab === "inbox") && inProject(q.sessionId);
}

/** Back to the desk, on what needs the developer: nothing left open on top of it. */
export function showNeedsYou() {
  ui.view = "desk";
  ui.tab = "inbox";
  for (const id of WINDOWS) dialog(id).close();
  page.render();
  revealNext("start");
}

/** A text box is one line when empty and grows with what is written; style.css caps it, past that it scrolls. @param {HTMLTextAreaElement} box */
export function fitBox(box) {
  if (!box.getClientRects().length) return; // not laid out yet (a window still closed): fitted when it is
  const was = box.offsetHeight;
  box.style.height = "auto";
  // What the panel's foot holds besides the box, at the box's smallest: style.css gives the box the rest of the foot's cap.
  const foot = box.closest(".chat-footer");
  if (foot instanceof HTMLElement) foot.style.setProperty("--footer-rest", `${foot.scrollHeight + foot.clientTop - box.offsetHeight}px`);
  box.style.height = `${box.scrollHeight + 2}px`;
  // A box on the page grows down under a keyboard that covers it (the panel's foot sits on the keyboard instead).
  if (!foot && box === document.activeElement && box.offsetHeight > was && document.documentElement.hasAttribute("data-keyboard")) showAboveKeyboard(box);
}
/** Scrolls the page so the box being typed in, with its Send button, ends above the visual viewport's bottom. @param {HTMLTextAreaElement} box */
function showAboveKeyboard(box) {
  const vv = window.visualViewport;
  if (!vv) return;
  const send = box.closest(".answer")?.querySelector(".send-col");
  const bottom = Math.max(box.getBoundingClientRect().bottom, send?.getBoundingClientRect().bottom ?? 0);
  window.scrollBy(0, Math.max(0, bottom + 16 - (vv.offsetTop + vv.height)));
}
/** Fits the boxes a redraw just placed, in the same frame: one drawn at its default height first would push the page down a frame later. @param {ParentNode} root */
export function fitNewBoxes(root) {
  for (const box of root.querySelectorAll("textarea[data-key]")) if (box instanceof HTMLTextAreaElement && !box.style.height) fitBox(box);
}

// Scroll areas whose edge hides more of their list; style.css fades that edge.
const CUT = "#projects, .board .col-body";
/** @param {Element} el */
export function markCut(el) {
  if (!(el instanceof HTMLElement)) return;
  const across = el.id === "projects";
  const at = across ? el.scrollLeft : el.scrollTop;
  const rest = across ? el.scrollWidth - el.clientWidth - at : el.scrollHeight - el.clientHeight - at;
  const cut = [at > 1 ? "start" : "", rest > 1 ? "end" : ""].filter(Boolean).join(" ");
  if (cut) el.dataset.cut = cut;
  else delete el.dataset.cut;
}
export function markCuts() {
  for (const el of document.querySelectorAll(CUT)) markCut(el);
}
/** Keeps the cut edges marked as their areas scroll. */
export function watchCuts() {
  document.addEventListener("scroll", (e) => e.target instanceof Element && e.target.matches(CUT) && markCut(e.target), { capture: true, passive: true });
  // A draft growing its box, or a window or column resized, changes what fits without a redraw.
  document.addEventListener("input", markCuts, { capture: true, passive: true });
  addEventListener("resize", markCuts);
}

/**
 * iOS ignores interactive-widget: its keyboard covers the page, whose layout keeps its height. Only the
 * visual viewport knows what is left, so the layout is told, and the box being typed in brought above it.
 * Android resizes the layout instead. On both, `data-keyboard` says a keyboard is up, and `data-compact`
 * that the screen is short (that, or landscape), for style.css.
 */
export function followKeyboard() {
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
    else showAboveKeyboard(box);
  };
  follow();
  vv?.addEventListener("resize", follow);
  vv?.addEventListener("scroll", follow);
  short.addEventListener("change", follow);
  // The keyboard comes and goes with the focus; measured once the focus has settled on its new element.
  for (const event of ["focusin", "focusout"]) document.addEventListener(event, () => requestAnimationFrame(follow));
}
