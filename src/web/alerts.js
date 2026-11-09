// @ts-check
// Alerts: desktop notifications and sound, each switched off on the page.
import { byId, icon } from "./dom.js";
import { TEXT } from "./text.js";
import { switchRow, toast } from "./pieces.js";
import { pushOn, pushRow } from "./push.js";
import { run } from "./server.js";
import { ON_THIS_MACHINE } from "./state.js";

const ALERTS = { notify: "agent-desk:notify", sound: "agent-desk:sound", failures: "agent-desk:failures" };
const ALERTS_ON = { notify: true, sound: true, failures: false };
/** As the developer set it in this browser, or its default. @param {keyof typeof ALERTS} k */
export const alertOn = (k) => {
  const set = localStorage.getItem(ALERTS[k]);
  return set === null ? ALERTS_ON[k] : set !== "off";
};
/** @type {AudioContext | null} */
let audio = null;
let audioUnlocked = false;
let chiming = 0;
/**
 * Browsers keep a page's audio muted until it is clicked once: the first click unlocks the chime. The
 * context then sleeps between chimes, since a running one holds a sound stream open all day, and a
 * browser allows only so many (past that, it reports an error from the audio device).
 */
addEventListener(
  "pointerdown",
  () => {
    if (audioUnlocked) return;
    const ctx = (audio ??= new AudioContext());
    ctx
      .resume()
      .then(() => {
        audioUnlocked = true;
        return chiming ? undefined : ctx.suspend();
      })
      .catch((/** @type {Error} */ e) => toast(TEXT.pageError(e.message)));
  },
  { capture: true },
);
/** Two short notes made by the browser, no file to load. */
export function chime() {
  const ctx = audio;
  if (!alertOn("sound") || !ctx || !audioUnlocked) return;
  chiming++;
  ctx
    .resume()
    .then(() => {
      const t = ctx.currentTime;
      [880, 1320].forEach((freq, i) => {
        const start = t + i * 0.12;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.32);
        if (i === 1)
          osc.onended = () => {
            if (--chiming === 0) ctx.suspend().catch((/** @type {Error} */ e) => toast(TEXT.pageError(e.message)));
          };
      });
    })
    .catch((/** @type {Error} */ e) => {
      chiming--;
      toast(TEXT.pageError(e.message));
    });
}

/** A desktop notification while the page is hidden, when the developer allowed them. @param {string} title @param {string} body @param {string} tag @param {() => void} open */
export function notify(title, body, tag, open) {
  // A phone is told by the push alone: the permission push needs would also put the question's text on its lock screen.
  if (!ON_THIS_MACHINE || !document.hidden || !alertOn("notify") || !("Notification" in window) || Notification.permission !== "granted") return;
  const n = new Notification(title, { body: body.slice(0, 200), tag });
  n.onclick = () => {
    window.focus();
    open();
  };
}

export function renderAlerts() {
  const can = "Notification" in window;
  const allowed = can && Notification.permission === "granted";
  const notifyOn = alertOn("notify") && allowed;
  const button = byId("alerts");
  button.title = TEXT.alerts.title;
  button.setAttribute("aria-label", TEXT.alerts.title);
  button.replaceChildren(icon((ON_THIS_MACHINE ? notifyOn : pushOn === true) || alertOn("sound") ? "bell" : "bellOff"));
  /** @param {keyof typeof ALERTS} k @param {string} text @param {string} hint @param {boolean} checked @param {boolean} disabled */
  const row = (k, text, hint, checked, disabled) =>
    switchRow(
      k,
      text,
      (box) => {
        localStorage.setItem(ALERTS[k], box.checked ? "on" : "off");
        if (k === "notify" && box.checked && Notification.permission === "default") run(Notification.requestPermission().then(renderAlerts));
        if (k === "sound" && box.checked) chime();
        renderAlerts();
      },
      { checked, disabled, hint, off: disabled },
    );
  const rows = [
    // One notifications switch per device: the page's own on the computer, push on the phone.
    ON_THIS_MACHINE ? row("notify", TEXT.alerts.notify, !can ? TEXT.alerts.unavailable : Notification.permission === "denied" ? TEXT.alerts.blocked : TEXT.alerts.notifyHint, notifyOn, !can || Notification.permission === "denied") : pushRow(renderAlerts),
    row("sound", TEXT.alerts.sound, TEXT.alerts.soundHint, alertOn("sound"), false),
    row("failures", TEXT.alerts.failures, TEXT.alerts.failuresHint, alertOn("failures"), false),
  ];
  const menu = byId("alerts-menu");
  if (rows.some((r, i) => menu.children[i] !== r)) menu.replaceChildren(...rows);
}
