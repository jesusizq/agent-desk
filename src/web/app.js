// @ts-check
// The desk page: follows the store through the local server and renders it. All strings live in text.js.
// This entry draws the view and wires the page; each area lives in its own module.
import { byId, dialog, patch } from "./dom.js";
import { animateLists, fadeIn, stopLists } from "./motion.js";
import { TEXT } from "./text.js";
import { renderAlerts } from "./alerts.js";
import { renderArrival } from "./arrivals.js";
import { board, skeleton } from "./desk.js";
import { renderDisplay, renderHeader, renderStrip } from "./header.js";
import { focusHistorySearch, historyView } from "./history.js";
import { fitNewBoxes, followKeyboard, markCuts, ONE_COLUMN, showNeedsYou, watchCuts } from "./layout.js";
import { noticeArrivals, remindWaiting } from "./notice.js";
import { renewPush, watchPush } from "./push.js";
import { headerMenu, sessionLink, toast } from "./pieces.js";
import { openResult } from "./result.js";
import { follow } from "./live.js";
import { refresh } from "./server.js";
import { openSession, renderPanel } from "./session.js";
import { data, itemKey, openItems, page, S, ui } from "./state.js";

const TICK_MS = 30_000;

/**
 * Redraws the view: only what changed changes, so the scroll of every part, the focused element, the
 * text selected and what is under the pointer stay; cards that come, go or move are animated, unless
 * `instant` (the developer switched what is shown: it changes at once, as a navigation does).
 * @param {{ instant?: boolean }} [how]
 */
function renderView({ instant = false } = {}) {
  document.body.dataset.tab = ui.tab;
  const view = byId("view");
  const placeholder = view.querySelector(".board[aria-busy]") !== null;
  /** @type {Map<string, number>} */
  const scrolls = new Map();
  for (const el of view.querySelectorAll("[data-scroll]")) if (el instanceof HTMLElement && el.dataset.scroll) scrolls.set(el.dataset.scroll, el.scrollTop);
  const pageScroll = window.scrollY;
  // The scrolls come back as part of the redraw: the motion then starts from them, and may move them on.
  const draw = () => {
    patch(view, !ui.loaded ? skeleton() : ui.view === "history" ? historyView() : board());
    fitNewBoxes(view);
    for (const el of view.querySelectorAll("[data-scroll]")) {
      const top = el instanceof HTMLElement && el.dataset.scroll ? scrolls.get(el.dataset.scroll) : undefined;
      if (top !== undefined) el.scrollTop = top;
      else if (el.hasAttribute("data-scroll-end")) el.scrollTop = el.scrollHeight; // just shown: from its newest end
    }
    window.scrollTo(0, pageScroll);
  };
  if (instant) {
    stopLists(view);
    draw();
  } else animateLists(view, draw);
  focusNextCard(view);
  // The first data takes the placeholders' place by fading in, not in one frame.
  if (placeholder && ui.loaded) fadeIn(view.firstElementChild, byId("needs-pill"), byId("strip"));
  markCuts();
}

/**
 * Answered with the keys, the question that takes the answered one's place (in its card, or the next
 * card) is ready to type in, once drawn (the answered card stays a moment first), unless the developer
 * went elsewhere.
 * @param {Element} view
 */
function focusNextCard(view) {
  if (ui.focusAfter === null) return;
  const card = view.querySelector(".next:not([data-leaving])");
  const answered = data.questions.find((q) => q.id === ui.focusAfter);
  // Still the answered one: its box, or its item answered in full. Questions asked together share one card.
  const same = card instanceof HTMLElement && answered !== undefined && card.dataset.flip === `q-${itemKey(answered)}`;
  if (same && (card.classList.contains("resolved") || card.querySelector(`textarea[data-key="answer-${CSS.escape(answered.id)}"]`))) return;
  ui.focusAfter = null;
  const box = card?.querySelector("textarea:not([readonly])");
  if (box instanceof HTMLElement && document.activeElement === document.body && !document.querySelector("dialog[open]")) box.focus({ preventScroll: true });
}

/** @param {{ instant?: boolean }} [how] */
function render(how) {
  renderHeader();
  renderStrip();
  renderView(how);
  renderPanel();
  renderArrival();
}
Object.assign(page, { render, renderView, renderPanel, noticeArrivals, renewPush });

// ---------- Wiring ----------
watchCuts();
// A page error is shown, never left in the console only.
// Browsers inject scripts of their own (Firefox and Brave for iOS: reader mode), and WebKit reports
// their errors against the page's address; only errors from the page's own script files are its own.
addEventListener("error", (e) => {
  if (e.filename.startsWith(`${location.origin}/`) && e.filename.endsWith(".js")) toast(TEXT.pageError(e.message));
});
addEventListener("unhandledrejection", (e) => toast(TEXT.pageError(e.reason instanceof Error ? e.reason.message : String(e.reason))));

watchPush(renderAlerts);
headerMenu("alerts", "alerts-menu", renderAlerts);
renderAlerts();

headerMenu("theme", "display-menu", renderDisplay);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderDisplay);
byId("q").addEventListener("input", (e) => {
  ui.hq = /** @type {HTMLInputElement} */ (e.target).value;
  ui.hshown = 0;
  ui.view = "history";
  render();
  focusHistorySearch();
});

document.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]")) return;
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "");
  if (e.key === "/" && !typing) {
    e.preventDefault();
    if (ui.view === "history") focusHistorySearch();
    else byId("q").focus();
    return;
  }
  if (typing || ui.view !== "desk") return;
  const list = openItems();
  const i = list.findIndex((it) => it.key === ui.sel);
  if (/^[1-9]$/.test(e.key)) {
    // 1–9 pick an option of the large card's first open question; the box keeps focus so Ctrl+Enter sends it.
    const option = document.querySelector(".next .opts")?.children[Number(e.key) - 1];
    if (option instanceof HTMLButtonElement) {
      e.preventDefault();
      option.click();
    }
    return;
  }
  const step = /** @type {Record<string, number>} */ ({ ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 })[e.key];
  if (step && list.length) {
    e.preventDefault();
    ui.sel = list[Math.max(0, Math.min(list.length - 1, i + step))]?.key ?? null;
    renderView();
  } else if (e.key === "Enter" && ui.sel && document.activeElement === document.body) {
    const q = list.find((x) => x.key === ui.sel)?.open[0];
    const { href } = sessionLink(q && S(q.sessionId));
    if (href) {
      e.preventDefault();
      location.href = href;
    }
  }
});
// iOS Safari applies :active (the desk's pressed look) only on pages that listen to touchstart.
document.addEventListener("touchstart", () => {}, { passive: true });
// A tap is not a scroll: counted, it put off the redraw that shows what the tap did.
for (const event of ["scroll", "touchmove"]) dialog("session").addEventListener(event, () => (ui.panelTouchedAt = Date.now()), { capture: true, passive: true });
for (const id of ["result", "session", "zoom"]) {
  const d = dialog(id);
  // A press inside that is released on the backdrop (selecting text) clicks the dialog itself: only one that starts there closes it.
  let pressedBackdrop = false;
  d.addEventListener("pointerdown", (e) => (pressedBackdrop = e.target === d));
  d.addEventListener("click", (e) => {
    if (e.target === d && pressedBackdrop) d.close();
    pressedBackdrop = false;
  });
}
for (const id of ["result", "session"]) edgeSwipe(dialog(id));
/**
 * On a phone, a swipe from the screen's left edge takes a session or result back off to the right,
 * as a native screen; released early, it slides back. @param {HTMLDialogElement} d
 */
function edgeSwipe(d) {
  /** @type {{ x: number, y: number, at: number } | null} */
  let from = null;
  let engaged = false;
  let dx = 0;
  d.addEventListener(
    "touchstart",
    (e) => {
      const t = e.touches[0];
      const inBubble = e.target instanceof Element && e.target.closest("#arrival") !== null;
      from = ONE_COLUMN.matches && !inBubble && e.touches.length === 1 && t && t.clientX < 24 ? { x: t.clientX, y: t.clientY, at: e.timeStamp } : null;
      engaged = false;
    },
    { passive: true },
  );
  // Not passive: once the swipe is the panel's, the page must not scroll under it.
  d.addEventListener(
    "touchmove",
    (e) => {
      const t = e.touches[0];
      if (!from || !t) return;
      const mx = t.clientX - from.x;
      const my = t.clientY - from.y;
      if (!engaged) {
        if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) return void (from = null);
        if (mx < 10) return;
        engaged = true;
        d.classList.add("swiping");
      }
      e.preventDefault();
      dx = Math.max(0, mx);
      d.style.transform = `translateX(${dx}px)`;
    },
    { passive: false },
  );
  /** @param {TouchEvent} e */
  const end = (e) => {
    const start = from;
    from = null;
    if (!start || !engaged) return;
    engaged = false;
    // Back to the stylesheet's movement: it finishes from where the finger left the panel.
    d.classList.remove("swiping");
    d.style.transform = "";
    const quick = dx > 40 && dx / Math.max(1, e.timeStamp - start.at) > 0.5;
    if (e.type === "touchend" && (dx > d.clientWidth / 3 || quick)) d.close();
  };
  d.addEventListener("touchend", end);
  d.addEventListener("touchcancel", end);
}
/** Links into the page: #history, #needs, #s=<session id>, #r=<result id>. */
export function route() {
  const [k, v] = location.hash.slice(1).split("=");
  if (k === "needs") {
    ui.sel = null;
    showNeedsYou();
  }
  if (k === "history") {
    ui.view = "history";
    render();
  }
  const s = k === "s" && v ? S(v) : undefined;
  if (s) openSession(s.id);
  const r = k === "r" && v ? data.results.find((x) => x.id === v) : undefined;
  if (r) openResult(r, { markSeen: false });
}
addEventListener("hashchange", route);
// The device keeps the last desk it saw, shown when the computer is off or asleep (sw.js). Some
// browsers (third-party ones on iOS) have no service workers: the desk works there without it.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((/** @type {Error} */ e) => toast(TEXT.pageError(e.message)));
  // A notification tapped while the app is open (sw.js).
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.show !== "needs") return;
    ui.sel = null;
    showNeedsYou();
  });
}
renderDisplay();
render();
await refresh();
route();
follow();
followKeyboard();
// A phone puts a hidden tab's timers to sleep: coming back, the desk is fetched at once, not at the next tick.
document.addEventListener("visibilitychange", () => document.hidden || refresh());
addEventListener("pageshow", (e) => /** @type {PageTransitionEvent} */ (e).persisted && refresh());
for (const change of ["online", "offline"]) addEventListener(change, () => (render(), refresh()));
setInterval(render, TICK_MS);
setInterval(remindWaiting, TICK_MS);
