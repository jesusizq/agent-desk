// @ts-check
// Hearing of the desk's changes as they happen: the desk's event stream (/api/events), one per
// browser and shared by its tabs, says when its state changed. Polling stays behind it: slow while
// the stream carries the changes, as fast as before while it does not.
import { askedAt, changed, refresh, requestsWaiting } from "./server.js";
import { ui } from "./state.js";

/** Without the stream: the pace the desk has always been polled at. */
const FAST_MS = 1500;
/** With it: a fetch now and then all the same, so a stream gone quiet (a computer asleep) is noticed. */
const SLOW_MS = 15_000;
/** Failures in a row before the stream is left alone for a while: something on the way does not carry it. */
const GIVE_UP_AFTER = 3;
const RETRY_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;
/** Opened, a stream sends the desk's version at once: one silent this long carries nothing (a buffering proxy). */
const FIRST_EVENT_MS = 10_000;
const NAME = "agent-desk:events";

/** @type {EventSource | null} this tab's stream, while it holds the browser's */
let stream = null;
let openedAt = 0;
/** Changes arrive, by this tab's stream or by the one of the tab that holds it. */
let up = false;
let holder = false;
let failures = 0;
let retryAt = 0;
let wasOffline = false;
/** Some browsers have no event streams (and tests take them away): the poll alone keeps the pace. */
const streams = typeof EventSource === "function";
// The tabs of one browser share one stream: each would hold one of the few connections a browser
// keeps to one address (six over HTTP/1.1), and past them the desk's requests would wait.
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(NAME) : null;

/** @param {boolean} now */
function setUp(now) {
  if (now === up) return;
  up = now;
  document.documentElement.dataset.live = up ? "stream" : "poll";
  if (holder) channel?.postMessage({ up });
}

function open() {
  const es = new EventSource("/api/events");
  stream = es;
  openedAt = Date.now();
  es.addEventListener("changed", (e) => {
    failures = 0;
    setUp(true);
    channel?.postMessage({ version: e.data });
    changed(e.data);
  });
  es.addEventListener("error", () => {
    if (stream !== es) return;
    setUp(false);
    failures++;
    // Closed by the browser (the desk answered with no stream) or failing again and again: left for a while.
    if (es.readyState === EventSource.CLOSED || failures >= GIVE_UP_AFTER) drop();
  });
}

/** Closes the stream; it is opened again later, sooner if the desk was only away. */
function drop() {
  stream?.close();
  stream = null;
  setUp(false);
  retryAt = Date.now() + Math.min(RETRY_MS * 2 ** Math.max(0, failures - GIVE_UP_AFTER), RETRY_MAX_MS);
}

function tick() {
  // The desk answers again after it did not: its stream was away with it, not refused.
  if (wasOffline && !ui.offline) failures = retryAt = 0;
  wasOffline = ui.offline;
  if (holder && streams) {
    if (stream && (stream.readyState === EventSource.CLOSED || (!up && Date.now() - openedAt > FIRST_EVENT_MS))) {
      failures++;
      drop();
    }
    if (!stream && !ui.offline && Date.now() >= retryAt) open();
  }
  // A new fetch over one still waiting would make the waiting one stale, and a hung connection would
  // never get to report itself: only the fetch's own limit bounds the wait. Offline, the poll is what
  // tells the desk is back, whatever the stream seems to do.
  if (requestsWaiting > 0 || (up && !ui.offline && Date.now() - askedAt < SLOW_MS)) return;
  refresh();
}

/** Starts hearing of changes: this tab opens the stream if no other tab of the browser holds it. */
export function follow() {
  document.documentElement.dataset.live = "poll";
  const hold = () => {
    holder = true;
    setUp(false);
    if (streams) open();
  };
  if (channel) {
    channel.addEventListener("message", (e) => {
      const m = /** @type {unknown} */ (e.data);
      if (typeof m !== "object" || m === null) return;
      const { up: on, version, ask } = /** @type {Record<string, unknown>} */ (m);
      if (holder) {
        if (ask === true) channel.postMessage({ up });
        return;
      }
      if (typeof on === "boolean") setUp(on);
      if (typeof version === "string") changed(version);
    });
    channel.postMessage({ ask: true });
  }
  // The lock is held as long as the tab lives; when it closes, the next tab takes the stream over.
  if (channel && navigator.locks) {
    navigator.locks
      .request(NAME, () => (hold(), new Promise(() => {})))
      .catch((/** @type {unknown} */ error) => {
        if (holder) throw error; // the stream failed to open: the page reports it
        hold(); // no lock to be had (an opaque origin): this tab keeps a stream of its own
      });
  } else hold();
  setInterval(tick, FAST_MS);
}
