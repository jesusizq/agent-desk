// @ts-check
// The session panel's conversation keeps to its newest message whatever changes its size (a phone
// turned, a picture loaded, a box growing) unless the developer scrolled up to read; then a button brings it down.
import { dialog, h, icon } from "./dom.js";
import { TEXT } from "./text.js";
import { ui } from "./state.js";

/** Closer to the end than this, the conversation counts as at its end, as openSession counts it. */
export const NEAR_END = 40;
/** @param {Element} b */
export const fromEnd = (b) => b.scrollHeight - b.scrollTop - b.clientHeight;
const body = () => dialog("session").querySelector(".session-body");

/** @param {Element} b */
function toEnd(b) {
  b.scrollTop = b.scrollHeight - b.clientHeight;
}

/**
 * Brings the conversation to its end and holds it there until it rests: iOS scrolls an element apart
 * from the script, and a scroll still gliding there wins over the one set here. A touch, the wheel or a
 * key hands the scroll back to the developer.
 */
const SETTLE_MS = 1000;
let settling = 0;
let jumping = false;
/** @param {Element} b */
function settle(b) {
  cancelAnimationFrame(settling);
  jumping = true;
  ui.panelStick = true;
  const until = performance.now() + SETTLE_MS;
  let resting = 0;
  const frame = () => {
    if (!jumping || !b.isConnected) return void (jumping = false);
    if (fromEnd(b) > 1) (toEnd(b), (resting = 0));
    else resting++;
    if (resting < 3 && performance.now() < until) settling = requestAnimationFrame(frame);
    else jumping = false;
  };
  toEnd(b);
  settling = requestAnimationFrame(frame);
}
for (const event of ["touchstart", "wheel", "pointerdown", "keydown"])
  dialog("session").addEventListener(event, (e) => {
    if (!jumping || (e.target instanceof Element && e.target.closest(".to-end"))) return;
    jumping = false;
    cancelAnimationFrame(settling);
  }, { capture: true, passive: true });

/** Farther from the end than this the button shows: closer, the end is in sight and the button would cover it. */
const SHOW_FROM = 240;
/** Not while a confirmation is open: its Run sits near the end, where the button would cover it. */
const away = () => {
  const b = body();
  return !!b && !ui.panelStick && !ui.panelPart && !ui.confirmShell && fromEnd(b) > SHOW_FROM;
};

/** The button shows while the conversation is far from its end; it brings it down at once. */
export function toEndButton() {
  return h(
    "button",
    {
      class: "to-end icon-btn",
      "data-key": "to-end",
      "aria-label": TEXT.conversation.toEnd,
      title: TEXT.conversation.toEnd,
      hidden: !away(),
      onclick: () => {
        const b = body();
        if (!b) return;
        settle(b);
        showButton();
      },
    },
    icon("down"),
  );
}

function showButton() {
  const d = dialog("session");
  const button = d.querySelector(".to-end");
  const hide = !away();
  if (button instanceof HTMLElement && button.hidden !== hide) button.hidden = hide;
}

// Layout runs these before the scroll events it causes, so a size change is followed before a scroll reads it.
const sizes = new ResizeObserver(() => {
  const d = dialog("session");
  const b = body();
  const foot = d.querySelector(".chat-footer");
  if (foot instanceof HTMLElement) d.style.setProperty("--chat-foot", `${foot.offsetHeight}px`);
  // An open confirmation keeps its distance from the end (openSession): its Run must not move under the pointer.
  if (!b || ui.panelPart) return;
  if (ui.panelStick && !ui.confirmShell && fromEnd(b) > 0) toEnd(b);
  // Shrunk to its end (a fold closed below) with no scroll event: from now on it follows the end again.
  else if (!ui.panelStick && fromEnd(b) < NEAR_END) ui.panelStick = true;
  showButton();
});
/** @type {Element[]} */
let watched = [];

/** After each drawing of the panel: follows the sizes of what is shown now. */
export function followPanel() {
  const d = dialog("session");
  const now = [d.querySelector(".session-body"), d.querySelector(".session-body > .conversation.chat"), d.querySelector(".chat-footer")].filter((el) => el !== null);
  if (now.length === watched.length && now.every((el, i) => el === watched[i])) return showButton();
  sizes.disconnect();
  for (const el of now) sizes.observe(el);
  watched = now;
  showButton();
}

// Whatever moved it (a finger, a wheel, the keys, a jump to a match), where the scroll rests says whether to follow.
dialog("session").addEventListener(
  "scroll",
  (e) => {
    const b = e.target;
    if (!(b instanceof Element) || !b.classList.contains("session-body") || ui.panelPart || jumping) return;
    ui.panelStick = fromEnd(b) < NEAR_END;
    showButton();
  },
  { capture: true, passive: true },
);
