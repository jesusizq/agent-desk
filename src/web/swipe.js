// @ts-check
// On a phone, a sideways swipe across the session panel's body opens the next (left) or previous
// (right) session the Needs you list asks for, without going back to the desk.
import { dialog, h } from "./dom.js";
import { slideIn, springBack } from "./motion.js";
import { TEXT } from "./text.js";
import { ONE_COLUMN } from "./layout.js";
import { openSession, renderPanel } from "./session.js";
import { askingSessions, S, sessionName, ui } from "./state.js";

/** A touch that starts this close to the screen's left edge takes the panel back (app.js), not to another session. */
export const EDGE_PX = 24;
const LOCK_PX = 10; // past this the finger says whether it goes sideways or scrolls
const SWITCH_PX = 60;
const FLICK_PX = 30;
const FLICK_SPEED = 0.4; // px/ms
const FOLLOW = { rate: 0.35, max: 80 };
const RESIST = { rate: 0.12, max: 20 }; // nowhere to go: the body only gives a little
const SLIDE_PX = 48;

/**
 * The session a swipe goes to, in the Needs you list's order, round from either end: the first (step 1)
 * or last (-1) when the panel's session is not in it; none while no other session needs the developer.
 * @param {string} sid @param {1 | -1} step
 */
function target(sid, step) {
  const ids = askingSessions();
  if (!ids.some((id) => id !== sid)) return undefined;
  const i = ids.indexOf(sid);
  const id = i < 0 ? (step > 0 ? ids[0] : ids.at(-1)) : ids[(i + step + ids.length) % ids.length];
  return id === undefined ? undefined : S(id);
}

/** Whether `el` or what holds it, up to `stop`, still scrolls sideways the way a finger moving `dir` pushes it. @param {Element} el @param {Element} stop @param {number} dir */
function scrollsSideways(el, stop, dir) {
  for (let at = /** @type {Element | null} */ (el); at && at !== stop; at = at.parentElement) {
    if (!/^(auto|scroll)$/.test(getComputedStyle(at).overflowX)) continue;
    const room = dir < 0 ? at.scrollWidth - at.clientWidth - at.scrollLeft : at.scrollLeft;
    if (room > 1) return true;
  }
  return false;
}

const selecting = () => {
  const sel = getSelection();
  return !!sel && !sel.isCollapsed && sel.toString() !== "";
};

export function sessionSwipe() {
  const d = dialog("session");
  const tag = h("div", { class: "swipe-to", "data-visitor": "", "aria-hidden": "true" });
  /** @type {{ x: number, y: number, at: number, from: Element, body: HTMLElement } | null} */
  let start = null;
  let engaged = false;
  /** @type {import("../core/protocol.ts").Session | undefined} */
  let to;
  let mx = 0;
  let my = 0;
  let dir = 0; // the way the finger went when the swipe was recognised: -1 left, 1 right

  /** The gesture is over: what it followed is let go. */
  const stop = () => {
    if (start) follow(start.from, false);
    tag.remove();
    start = null;
    engaged = false;
    to = undefined;
  };
  /** The gesture ends without a switch: the body springs back and the label goes. */
  const release = () => {
    if (start && engaged) springBack(start.body);
    stop();
  };

  d.addEventListener(
    "touchstart",
    (e) => {
      if (start) release();
      const t = e.touches[0];
      const from = e.target instanceof Element ? e.target : null;
      const body = from?.closest(".session-body");
      const allowed = ONE_COLUMN.matches && e.touches.length === 1 && t && t.clientX >= EDGE_PX && !ui.panelPart && !selecting();
      if (!allowed || !from || !(body instanceof HTMLElement) || from.closest("input, textarea, select, [contenteditable]")) return;
      start = { x: t.clientX, y: t.clientY, at: e.timeStamp, from, body };
      mx = my = 0;
      // A touch's later events go to the element it started on even once a redraw took it out of the
      // page, where they reach no ancestor: listened on that element, the gesture always ends.
      follow(from, true);
    },
    { passive: true },
  );
  /** Listened on the touched element only for touch events (follow). @param {Event} ev */
  const move = (ev) => {
    const e = /** @type {TouchEvent} */ (ev);
    const t = e.touches[0];
    if (!start || !t) return;
    if (e.touches.length > 1 || selecting()) return release();
    mx = t.clientX - start.x;
    my = t.clientY - start.y;
    if (!engaged) {
      if (Math.abs(mx) < LOCK_PX && Math.abs(my) < LOCK_PX) return;
      dir = Math.sign(mx);
      if (Math.abs(mx) < 2 * Math.abs(my) || scrollsSideways(start.from, start.body, dir)) return stop();
      engaged = true;
      to = target(ui.panelSession ?? "", dir < 0 ? 1 : -1);
      if (to) {
        tag.textContent = dir < 0 ? TEXT.swipe.next(sessionName(to)) : TEXT.swipe.previous(sessionName(to));
        tag.dataset.side = dir < 0 ? "right" : "left";
        d.append(tag);
      }
    }
    if (e.cancelable) e.preventDefault();
    // Brought back past where it started, the swipe goes nowhere.
    const along = Math.max(0, mx * dir);
    const { rate, max } = to ? FOLLOW : RESIST;
    start.body.style.transform = `translateX(${dir * Math.min(max, along * rate)}px)`;
    tag.style.opacity = String(Math.min(1, along / SWITCH_PX));
  };
  /** @param {Event} ev */
  const end = (ev) => {
    const e = /** @type {TouchEvent} */ (ev);
    if (!start || !engaged) return release();
    const t = e.changedTouches[0];
    if (t) [mx, my] = [t.clientX - start.x, t.clientY - start.y];
    const along = mx * dir;
    const far = along >= SWITCH_PX || (along >= FLICK_PX && along / Math.max(1, e.timeStamp - start.at) >= FLICK_SPEED);
    const next = to && S(to.id);
    if (e.type !== "touchend" || !next || !far || along < 2 * Math.abs(my) || !d.open) return release();
    start.body.style.transform = "";
    stop();
    // As opening it from the desk: its conversation fetched, marked read, shown from its end; the
    // finger has left, so the redraw need not wait for a scroll to rest.
    ui.panelTouchedAt = 0;
    ui.panelHeard = null;
    openSession(next.id);
    renderPanel();
    const body = d.querySelector(".session-body");
    if (body) slideIn(body, -dir * SLIDE_PX);
  };
  /** @param {Element} el @param {boolean} on */
  const follow = (el, on) => {
    if (!on) {
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      return;
    }
    // Not passive: once the swipe is recognised as sideways, the page must not move under it.
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
  };
}
