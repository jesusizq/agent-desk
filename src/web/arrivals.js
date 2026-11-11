// @ts-check
// Arrivals: a question that comes out of sight is a small bubble at the screen's edge.
import { byId, dialog, h, icon, md, patch, WINDOWS } from "./dom.js";
import { arrive, bump, fadeIn, retreat } from "./motion.js";
import { TEXT } from "./text.js";
import { askBody } from "./answer.js";
import { headline } from "./format.js";
import { COARSE, fitNewBoxes, inSight, ONE_COLUMN, showNeedsYou, topDialog } from "./layout.js";
import { badge, where } from "./pieces.js";
import { answeredNow, inProject, itemByKey, S, ui } from "./state.js";

/** @typedef {import("./state.js").Item} Item */

// Collapsed and left alone this long, the bubble goes back into Needs you.
const ARRIVAL_MS = 8000;
let arrivalTimer = 0;
let arrivalHovered = false;
/** @type {Animation | null} the bubble on its way out */
let arrivalLeaving = null;
/** @type {string | null} the item the bubble showed at its last drawing */
let arrivalShown = null;

/** Answered from the bubble a moment ago: it says so before it goes. @param {Item} item */
const answeredHere = (item) => item.questions.some(answeredNow);
/** Expanded, under the pointer or holding the focus: the bubble stays as it is. */
const arrivalHeld = () => ui.arrivalOpen || arrivalHovered || byId("arrival").matches(":focus-within");

/** Where a retreating bubble goes: the needs pill, or on a phone the Needs you tab's count. */
function needsTarget() {
  const tab = document.querySelector("#tabbar > button:first-child");
  const target = ONE_COLUMN.matches ? (tab?.querySelector(".tcount") ?? tab) : byId("needs-pill");
  return target && target.getClientRects().length && getComputedStyle(target).visibility !== "hidden" ? target : null;
}

/**
 * The bubble lives in the window on top, if one is open: a modal window makes everything outside it
 * inert, the top layer too. It comes from the top under that window's head, else from the bottom.
 */
function placeArrival() {
  const el = byId("arrival");
  const host = topDialog() ?? document.body;
  if (el.parentElement !== host) {
    arrivalLeaving?.finish();
    const open = el.matches(":popover-open");
    const focused = el.contains(document.activeElement) ? document.activeElement : null;
    if (open) el.hidePopover();
    host.append(el);
    if (open) el.showPopover();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
  const head = host.querySelector(":scope > :is(.dhead, .rv-head)");
  el.style.setProperty("--dialog-head", `${head ? Math.round(head.getBoundingClientRect().bottom) : 0}px`);
  el.dataset.edge = host === document.body ? "bottom" : "top";
}

/** Draws the arrival bubble: the last question that came out of sight, collapsed or whole, or nothing. */
export function renderArrival() {
  const el = byId("arrival");
  const held = arrivalHeld();
  let toNeeds = false;
  ui.arrivals = ui.arrivals.filter((key) => {
    const item = itemByKey(key);
    if (!item) return false;
    if (answeredHere(item)) return true;
    if (!item.open.length) return false; // answered or dismissed elsewhere
    const lead = item.open[0];
    if ((held && key === arrivalShown) || !lead || !inSight(lead)) return true;
    toNeeds = true; // now in sight where it lives
    return false;
  });
  const key = held && arrivalShown !== null && ui.arrivals.includes(arrivalShown) ? arrivalShown : ui.arrivals.at(-1);
  const item = key === undefined ? undefined : itemByKey(key);
  const lead = item && (item.open[0] ?? item.questions[0]);
  if (!item || !lead) return leaveArrival(toNeeds);
  if (arrivalLeaving) {
    arrivalLeaving.cancel();
    arrivalLeaving = null;
    el.inert = false;
  }
  const changed = arrivalShown !== item.key;
  if (changed && !held) ui.arrivalOpen = false;
  arrivalShown = item.key;
  const open = ui.arrivalOpen;
  const more = ui.arrivals.length - 1;
  const asks = item.questions.length > 1 ? item.open.map((x) => headline(x.text)).join(" · ") || headline(lead.text) : headline(lead.text);
  el.setAttribute("aria-label", TEXT.arrival.label);
  el.classList.toggle("open", open);
  placeArrival();
  patch(
    el,
    h(
      "div",
      { class: "arr-head" },
      h(
        "div",
        { class: "arr-status", role: "status" },
        h("div", { class: "meta" }, lead.kind !== "question" ? badge(lead.kind) : null, where(S(lead.sessionId)), more > 0 ? h("span", { class: "arr-more" }, TEXT.arrival.more(more)) : null),
        h("div", { class: "arr-q", hidden: open }, md(asks)),
      ),
      h("button", { class: "icon-btn arr-x", "aria-label": TEXT.arrival.dismiss, title: TEXT.arrival.dismiss, onclick: dismissArrival }, icon("x")),
    ),
    open ? h("div", { class: "arr-body", id: "arrival-body", "data-key": `body-${item.key}` }, askBody(item, { panel: true })) : null,
    h(
      "div",
      { class: "arr-actions" },
      h("button", { class: "secondary arr-expand", "aria-expanded": String(open), "aria-controls": open ? "arrival-body" : null, onclick: toggleArrival }, open ? TEXT.arrival.collapse : TEXT.arrival.expand),
      h("button", { class: "primary arr-go", title: TEXT.arrival.goTitle, onclick: () => goToArrival(item) }, TEXT.arrival.go),
    ),
  );
  fitNewBoxes(el);
  if (!el.matches(":popover-open")) {
    el.showPopover();
    arrive(el, el.dataset.edge === "top" ? -12 : 12);
  } else if (changed) fadeIn(el.querySelector(".arr-status"));
  if (ui.arrivalFocus) {
    ui.arrivalFocus = false;
    const box = el.querySelector("textarea:not([readonly])");
    if (box instanceof HTMLElement && (document.activeElement === document.body || document.activeElement === null)) box.focus({ preventScroll: true });
  }
  if (changed) scheduleRetreat();
}

/** The bubble goes: into Needs you (`toNeeds`), where the question waits, or fading where it is. @param {boolean} toNeeds */
function leaveArrival(toNeeds) {
  const el = byId("arrival");
  arrivalShown = null;
  ui.arrivalOpen = false;
  clearTimeout(arrivalTimer);
  if (!el.matches(":popover-open") || arrivalLeaving) return;
  const target = toNeeds ? needsTarget() : null;
  const gone = () => {
    el.hidePopover();
    arrivalLeaving?.cancel(); // its end state holds until cancelled: shown again, the bubble would stay invisible
    arrivalLeaving = null;
    el.inert = false;
    el.replaceChildren();
    if (target) bump(target);
  };
  el.inert = true;
  arrivalLeaving = retreat(el, target);
  if (arrivalLeaving) arrivalLeaving.onfinish = gone;
  else gone();
}

/** Left alone and collapsed, the bubble goes back into Needs you after a while; never while it is held. */
function scheduleRetreat() {
  clearTimeout(arrivalTimer);
  if (!ui.arrivals.length || arrivalHeld() || document.hidden) return;
  arrivalTimer = window.setTimeout(() => {
    if (arrivalHeld()) return;
    ui.arrivals = [];
    leaveArrival(true);
  }, ARRIVAL_MS);
}

/** × : the bubble goes; its questions stay open in Needs you. */
function dismissArrival() {
  ui.arrivals = [];
  leaveArrival(false);
}

function toggleArrival() {
  ui.arrivalOpen = !ui.arrivalOpen;
  renderArrival();
  scheduleRetreat();
}

/** Go: the question selected in Needs you, in view, with nothing over it. @param {Item} item */
function goToArrival(item) {
  ui.arrivals = [];
  leaveArrival(false);
  const lead = item.open[0] ?? item.questions[0];
  if (lead && !inProject(lead.sessionId)) ui.project = null;
  ui.sel = item.key;
  showNeedsYou();
  const card = document.querySelector(".next:not([data-leaving])");
  if (!ONE_COLUMN.matches) card?.scrollIntoView({ block: "nearest" });
  // With a mouse or the keys, its box takes the typing; a finger's tap raises no keyboard.
  const box = card?.querySelector("textarea:not([readonly])");
  if (!COARSE.matches && box instanceof HTMLElement) box.focus({ preventScroll: true });
}

{
  const el = byId("arrival");
  el.addEventListener("pointerenter", () => {
    arrivalHovered = true;
    clearTimeout(arrivalTimer);
  });
  el.addEventListener("pointerleave", () => {
    arrivalHovered = false;
    scheduleRetreat();
  });
  el.addEventListener("focusin", () => clearTimeout(arrivalTimer));
  // Once the focus has settled: it may only be moving from one of its buttons to another.
  el.addEventListener("focusout", () => requestAnimationFrame(scheduleRetreat));
  el.addEventListener("keydown", (e) => {
    // Its keys are its own: not the desk's shortcuts, nor those of the window under it.
    e.stopPropagation();
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (!ui.arrivalOpen) return dismissArrival();
    ui.arrivalOpen = false;
    renderArrival();
    /** @type {HTMLButtonElement | null} */ (el.querySelector(".arr-expand"))?.focus();
  });
  document.addEventListener("visibilitychange", scheduleRetreat);
  // A window opening or closing changes where the bubble lives, and what is in sight.
  const hosts = new MutationObserver(() => ui.arrivals.length && renderArrival());
  for (const id of WINDOWS) hosts.observe(dialog(id), { attributes: true, attributeFilter: ["open"], childList: true });
}
