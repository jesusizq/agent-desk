// @ts-check
// Talking to the desk server: the state fetched, writes with the secret, and the drafts kept on this device.
import { DRAFTS_KEY, h } from "./dom.js";
import { TEXT } from "./text.js";
import { stamp } from "./format.js";
import { toast } from "./pieces.js";
import { data, ID, ON_THIS_MACHINE, page, S, secret, setData, ui } from "./state.js";

/** @typedef {import("../core/protocol.ts").DeskState} DeskState */
/** @typedef {import("./state.js").Outgoing} Outgoing */

const LOCKED_HEADER = "X-Agent-Desk-Locked";
const UNLOCK_ENDS_HEADER = "X-Agent-Desk-Unlock-Ends";
/** Longer than the service worker's wait (sw.js), so its saved copy arrives first when there is one. */
const NO_ANSWER_MS = 8000;

/** Set once a device behind the PIN learns its unlock ended (endUnlock). */
let unlockEnded = false;
/** What is being written stays on this device: a phone may close the app, and the desk may reload it. */
export function saveDrafts() {
  if (unlockEnded) return; // the reload to the PIN page must not write them back
  const drafts = [...ui.drafts].filter(([, text]) => text);
  const images = [...ui.draftImages].filter(([, ids]) => ids.length);
  // What could not be sent is kept too, until it is sent again or taken back into its box.
  const unsent = [...ui.outbox.values()].filter((o) => o.state === "failed").map(({ id, key, sid, text, images, error }) => ({ id, key, sid, text, images, error }));
  if (drafts.length || images.length || unsent.length) localStorage.setItem(DRAFTS_KEY, JSON.stringify({ drafts, images, unsent }));
  else localStorage.removeItem(DRAFTS_KEY);
}
/** A message kept as not sent, as saveDrafts wrote it. @param {unknown} v @returns {v is Omit<Outgoing, "state" | "before">} */
function isUnsent(v) {
  if (typeof v !== "object" || v === null) return false;
  const o = /** @type {Record<string, unknown>} */ (v);
  const strings = ["id", "key", "sid", "text", "error"].every((k) => typeof o[k] === "string");
  return strings && Array.isArray(o.images) && o.images.every((i) => typeof i === "string") && ID.test(String(o.sid)) && routeOf(String(o.key)) !== null;
}
const savedDrafts = localStorage.getItem(DRAFTS_KEY);
if (savedDrafts !== null) {
  try {
    const kept = /** @type {{ drafts: [string, string][], images: [string, string[]][], unsent?: unknown[] }} */ (JSON.parse(savedDrafts));
    const unsent = kept.unsent ?? [];
    const bad = unsent.find((o) => !isUnsent(o));
    if (bad !== undefined) throw new Error(`a message not sent is unreadable: ${JSON.stringify(bad)}`);
    ui.drafts = new Map(kept.drafts);
    ui.draftImages = new Map(kept.images);
    for (const o of unsent.filter(isUnsent)) ui.outbox.set(o.id, { ...o, state: "failed", before: 0 });
  } catch (error) {
    localStorage.removeItem(DRAFTS_KEY);
    toast(TEXT.pageError(`saved drafts unreadable, dropped: ${/** @type {Error} */ (error).message}`));
  }
}
/** Drafts for a question already closed or a session already gone have nowhere to go. */
function dropStaleDrafts() {
  for (const key of [...ui.drafts.keys(), ...ui.draftImages.keys()]) {
    const alive = data.questions.some((q) => q.status === "open" && key === `answer-${q.id}`) || data.sessions.some((s) => key === `message-${s.id}`);
    if (alive) continue;
    ui.drafts.delete(key);
    ui.draftImages.delete(key);
  }
  for (const [id, o] of ui.outbox) if (!S(o.sid)) ui.outbox.delete(id);
  saveDrafts();
}

/** The unlock ended: the reload brings the PIN page, and the same view after it. @param {Response} res */
const needsPin = (res) => res.status === 401 && res.headers.has(LOCKED_HEADER);

/** Nothing written on a device behind the PIN outlives its unlock: drafts and unsent messages go with the saved desk. */
function endUnlock() {
  unlockEnded = true;
  localStorage.removeItem(DRAFTS_KEY);
  location.reload();
}

let unlockEnds = 0;
let unlockTimer = 0;
/**
 * On a device that entered the PIN, the page reloads when the unlock ends: online that brings the PIN
 * page, offline nothing, since the device deletes its saved desk then (sw.js). @param {Response} res
 */
function reloadAtUnlockEnd(res) {
  const ends = Number(res.headers.get(UNLOCK_ENDS_HEADER));
  // Already past by this device's clock (ahead of the computer's): left to the desk's locked answer, as a reload now would repeat.
  if (!(ends > Date.now()) || ends === unlockEnds) return;
  unlockEnds = ends;
  clearTimeout(unlockTimer);
  unlockTimer = setTimeout(endUnlock, ends - Date.now() + 1);
}

/** A write to the desk; no connection is said as such, not as fetch's own "Load failed". @param {string} route @param {RequestInit} init */
async function write(route, init) {
  const res = await fetch(route, init).catch(() => {
    throw new Error(offlineReason());
  });
  if (needsPin(res)) endUnlock();
  return res;
}

/** Why the desk does not answer, as far as this device can tell. */
function offlineReason() {
  if (ui.refused) return TEXT.offline.refused;
  return ON_THIS_MACHINE ? TEXT.offline.desk : navigator.onLine ? TEXT.offline.computer : TEXT.offline.device;
}
/** What is shown while the desk does not answer: how old the desk shown is, then why. */
function offlineHead() {
  const when = ui.updatedAt ? TEXT.offline.updated(stamp(ui.updatedAt)) : null;
  return [ui.refused ? null : TEXT.offline.title, when].filter(Boolean).join(" · ");
}
export const offlineText = () => [offlineHead(), offlineReason()].filter(Boolean).join(" · ");
/** The calm banner that says so, in the strip or a window. @param {string} cls */
export const offlineNotice = (cls) => h("div", { class: `offline ${cls}`, role: "status" }, h("b", {}, offlineHead()), " ", h("span", { class: "why" }, offlineReason()));

/** @param {string} route @param {unknown} [body] */
export async function post(route, body = {}) {
  const res = await write(route, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-Desk-Secret": secret },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = /** @type {{ error?: string }} */ (await res.json().catch(() => ({})));
    throw new Error(detail.error ?? `${res.status} ${res.statusText}`);
  }
  await refresh();
}

let etag = "";
/** @type {string | null} */
let loadedBuild = null;
let latestRequest = 0;
export let requestsWaiting = 0;
/** When the state was last asked for, by the poll or a change. */
export let askedAt = 0;
/** The desk says its state is now `version` (its ETag): fetched unless it is what is shown. @param {string} version */
export function changed(version) {
  if (version !== etag) refresh();
}
const SAVED_AT = "X-Agent-Desk-Saved-At";
export async function refresh() {
  const request = ++latestRequest;
  /** @type {string | null} */
  let savedAt = null;
  /** @type {DeskState | null} */
  let next = null;
  requestsWaiting++;
  askedAt = Date.now();
  try {
    const res = await fetch("/api/state", { headers: etag ? { "If-None-Match": etag } : {}, signal: AbortSignal.timeout(NO_ANSWER_MS) });
    if (needsPin(res)) return endUnlock();
    reloadAtUnlockEnd(res);
    ui.refused = res.status === 421;
    savedAt = res.headers.get(SAVED_AT);
    if (res.status !== 304) {
      if (!res.ok) throw new Error(`${res.status}`);
      next = /** @type {DeskState} */ (await res.json());
      if (request === latestRequest && !savedAt) etag = res.headers.get("ETag") ?? "";
    }
  } catch {
    if (request === latestRequest) setOffline(true); // shown in the strip; the poll goes on, and tells when it is back
    return;
  } finally {
    requestsWaiting--;
  }
  if (request !== latestRequest) return; // a newer request answers instead; this one may be stale
  ui.savedAt = savedAt;
  ui.updatedAt = savedAt ?? new Date().toISOString();
  if (savedAt) {
    // The computer does not answer and the device shows the desk it saved (sw.js): read only.
    if (next) {
      setData({ ...next, listening: [] });
      ui.loaded = true;
    }
    return setOffline(true, true);
  }
  page.renewPush();
  if (next) {
    if (loadedBuild === null) {
      loadedBuild = next.build;
      setData(next);
      dropStaleDrafts();
    } else if (next.build !== loadedBuild) return location.reload(); // the desk restarted, maybe with new code
    setData(next);
    ui.loaded = true;
    page.noticeArrivals();
  }
  setOffline(false, next !== null);
}

/** @param {boolean} offline @param {boolean} [changed] */
function setOffline(offline, changed = false) {
  if (offline === ui.offline && !changed) return;
  ui.offline = offline;
  page.render();
}

/** Keeps an image in the store for the reply being written; returns its id. @param {Blob} file */
export async function uploadImage(file) {
  const res = await write("/api/images", { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-Agent-Desk-Secret": secret }, body: file });
  const body = /** @type {{ id?: unknown, error?: string }} */ (await res.json().catch(() => ({})));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  if (typeof body.id !== "string") throw new Error(`the desk kept the image but gave no id for it (${JSON.stringify(body)})`);
  return body.id;
}

/** Where the desk serves an image kept in the store. @param {string} id */
export const imageUrl = (id) => `/images/${encodeURIComponent(id)}`;

/** The route a draft's key sends to (an answer to its question, a message to its session), or null for no such key. @param {string} key */
export function routeOf(key) {
  const [, kind, id] = /^(answer|message)-(.+)$/.exec(key) ?? [];
  if (!id || !ID.test(id)) return null;
  return kind === "answer" ? `/api/questions/${id}/answer` : `/api/sessions/${id}/message`;
}

/** Runs a page action; a failure is shown, never swallowed. @param {Promise<unknown>} p @param {() => void} [always] */
export function run(p, always) {
  p.catch((/** @type {Error} */ e) => toast(e.message)).finally(() => {
    always?.();
    page.render();
  });
}
