// @ts-check
// Keeps on the device the last desk it saw, to show it when the computer does not answer (off or
// asleep). Network first, always: the saved copy is used only when the request fails, and it is read
// only, since an answer needs the computer. A device that entered the PIN keeps it only while that
// unlock lasts: the copy is deleted when the device learns the unlock ended, and never served after.
/// <reference lib="webworker" />
const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));
/** Caches of any other name are an earlier worker's, whose copies do not say when their unlock ends. */
const CACHE = "agent-desk-2";
const SAVED_AT = "X-Agent-Desk-Saved-At";
/** What the desk answers a device whose unlock ended: the PIN page, or 401 to anything else. */
const LOCKED = "X-Agent-Desk-Locked";
/** When the unlock of a device that entered the PIN ends (ms); this computer's answers never carry it. */
const UNLOCK_ENDS = "X-Agent-Desk-Unlock-Ends";
/** A computer asleep leaves requests hanging, not failing: past this the saved copy answers. */
const NO_ANSWER_MS = 5000;
/** What Tailscale Serve answers when the computer is up and the desk is not. */
const DESK_DOWN = new Set([502, 503, 504]);
/** The page, its files, the state, conversations and images: what the desk needs to draw itself; and
 * each review's page and saved state, to open it offline. The event stream (/api/events) is not among
 * them: it always goes to the network and is never kept. */
const KEPT = /^\/(?:|[\w-]+\.(?:js|css|svg|png|webmanifest)|api\/state|api\/sessions\/[\w-]+\/messages|images\/[\w.-]+|review\/[\w-]+\/raw|api\/reviews\/[\w-]+\/state)$/;
/** A review's page as the desk serves it (src/server: the review routes), built here from its kept parts when the computer does not answer. */
const REVIEW_PAGE = /^\/review\/([\w-]+)$/;
const REVIEW_STATE = /^\/api\/reviews\/([\w-]+)\/state$/;
/** The headers the desk serves a review's page with: the same sandbox offline as online (a test compares them with the server's). */
const REVIEW_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

sw.addEventListener("install", () => sw.skipWaiting());
sw.addEventListener("activate", (e) => e.waitUntil(Promise.all([sw.clients.claim(), dropOtherCaches()])));
sw.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== sw.location.origin) return;
  const review = REVIEW_PAGE.exec(url.pathname)?.[1];
  const saving = REVIEW_STATE.exec(url.pathname)?.[1];
  if (e.request.method === "POST" && saving) return e.respondWith(saveReview(e.request, saving));
  if (e.request.method !== "GET") return;
  if (review) return e.respondWith(networkOrSaved(e.request, url.pathname, () => reviewOffline(review)));
  if (KEPT.test(url.pathname)) e.respondWith(networkOrSaved(e.request, url.pathname));
});

async function dropOtherCaches() {
  for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
}

/**
 * @param {Request} request @param {string} key
 * @param {(key: string) => Promise<Response | undefined>} [saved] what answers when the network does not: the copy kept for `key`, or one built
 */
async function networkOrSaved(request, key, saved = savedCopy) {
  // Given up on, a hung request is ended: the browser would hold later ones to the same address behind it.
  const giveUp = new AbortController();
  request.signal.addEventListener("abort", () => giveUp.abort());
  const network = fetch(request, { signal: giveUp.signal }).then(async (res) => {
    // The PIN page is not the desk, and says this device's unlock ended: what it kept goes too.
    // A failed delete is logged, not thrown: thrown, it would have the saved copy answer instead of the PIN page.
    if (res.headers.has(LOCKED)) await forget().catch((error) => console.error("agent-desk: could not delete the saved desk once locked:", error));
    else if (res.ok && !unlockEnded(res) && saved === savedCopy) await (await caches.open(CACHE)).put(key, await stamped(res.clone()));
    return res;
  });
  network.catch(() => {}); // a late failure, once the saved copy has answered: nobody waits for it
  try {
    const first = await Promise.race([network, new Promise((/** @type {(v: undefined) => void} */ done) => setTimeout(done, NO_ANSWER_MS))]);
    if (first && !DESK_DOWN.has(first.status)) return first;
    const copy = await saved(key);
    if (copy && !first) giveUp.abort();
    return copy ?? first ?? (await network);
  } catch (error) {
    const copy = await saved(key);
    if (copy) return copy;
    throw error;
  }
}

/** One change of the kept reviews at a time: two saves must not read the same copy and each drop the other's change. */
let reviewsKept = Promise.resolve();

/**
 * A review's changes go to the desk; this device's copy of its saved state takes them too (sent or
 * not), so the review opened offline shows them. A change the desk refused is not kept.
 * @param {Request} request @param {string} id
 */
async function saveReview(request, id) {
  const sent = await request.clone().json();
  /** @type {Response | undefined} */
  let res;
  try {
    res = await fetch(request);
  } finally {
    if (!res || res.ok || DESK_DOWN.has(res.status)) {
      const reply = res?.ok ? await res.clone().json() : {};
      const change = (reviewsKept = reviewsKept.then(() => keepChanges(id, sent, reply.rev)));
      // Logged, not thrown: the desk's answer, or its absence, is what the page must hear.
      await change.catch((error) => console.error(`agent-desk: could not keep review ${id}'s changes on this device:`, error));
    }
  }
  return res;
}

/** @param {string} id @param {{ ops?: unknown, summary?: unknown }} sent @param {unknown} rev */
async function keepChanges(id, sent, rev) {
  const key = `/api/reviews/${id}/state`;
  const kept = await savedCopy(key);
  if (!kept) return; // never opened on this device: nothing to keep up to date
  const state = await kept.json();
  for (const o of Array.isArray(sent.ops) ? sent.ops : []) {
    if (o?.op === "clear") state.data = {};
    else if (o?.op === "set" && typeof o.key === "string" && typeof o.value === "string") state.data[o.key] = o.value;
    else if (o?.op === "remove" && typeof o.key === "string") delete state.data[o.key];
  }
  if (typeof sent.summary === "string") state.summary = sent.summary || undefined;
  if (typeof rev === "number") state.rev = rev;
  const headers = new Headers(kept.headers);
  await (await caches.open(CACHE)).put(key, new Response(JSON.stringify(state), { status: 200, headers }));
}

/**
 * A review's page built from what this device kept: its page, the shim and its saved state, injected as
 * the desk injects them, under the same headers. None while one of them is missing or its unlock ended.
 * @param {string} id
 */
async function reviewOffline(id) {
  const [raw, shim, state] = await Promise.all([savedCopy(`/review/${id}/raw`), savedCopy("/review-shim.js"), savedCopy(`/api/reviews/${id}/state`)]);
  if (!raw || !shim || !state) return undefined;
  const html = injectReview(await raw.text(), await state.json(), await shim.text());
  const headers = new Headers(raw.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", REVIEW_CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(html, { status: 200, headers });
}

/**
 * The page with the shim first in it and its saved state for the shim, right after `<head…>` (or first
 * when it has none), as the desk does (src/server). @param {string} html @param {unknown} state @param {string} shim
 */
function injectReview(html, state, shim) {
  const json = JSON.stringify(state).replace(/</g, "\\u003c");
  const tags = `<script>window.__agentDeskReview=${json};</script><script>${shim}</script>`;
  const head = /<head(?=[\s>/])[^>]*>/i.exec(html);
  if (!head) return tags + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + tags + html.slice(at);
}

/** The copy saved for `key`; none once its unlock has ended, and then every copy is deleted. @param {string} key */
async function savedCopy(key) {
  const saved = await caches.match(key, { cacheName: CACHE });
  if (!saved || !unlockEnded(saved)) return saved;
  await forget();
  return undefined;
}

/** Whether the unlock an answer was given under has ended; an unreadable end counts as ended. @param {Response} res */
function unlockEnded(res) {
  const ends = res.headers.get(UNLOCK_ENDS);
  return ends !== null && !(Number(ends) > Date.now());
}

/** Deletes every copy this device kept of the desk. */
async function forget() {
  await caches.delete(CACHE);
}

/** A copy that says when it was saved, so the page can tell the developer how old it is. @param {Response} res */
async function stamped(res) {
  const headers = new Headers(res.headers);
  headers.set(SAVED_AT, new Date().toISOString());
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers });
}

// A push says only how many questions wait (src/server/push.ts); what they ask is read in the desk.
sw.addEventListener("push", (e) => {
  /** @type {{ count?: unknown, pinEnded?: unknown }} */
  let message = {};
  try {
    message = e.data?.json() ?? {};
  } catch {
    message = {}; // an unreadable payload still says something waits: iOS requires a notification for every push
  }
  const pinEnded = message.pinEnded === true;
  const count = Number(message.count) || 0;
  const body = pinEnded ? "Enter the PIN to keep getting notifications" : count > 1 ? `${count} need you` : "Something needs you";
  e.waitUntil(
    Promise.all([
      replaceNotification(body),
      // The number is a nicety: a browser that refuses it still shows the notification.
      count > 0 && "setAppBadge" in sw.navigator ? sw.navigator.setAppBadge(count).catch(() => {}) : null,
      // Logged, not thrown: the notice must still show, since iOS requires a notification for every push.
      pinEnded ? forget().catch((error) => console.error("agent-desk: could not delete the saved desk after the PIN ended:", error)) : null,
    ]),
  );
});

/**
 * Leaves one notification on the screen. iOS stacks them whatever their `tag` (WebKit bug 258922), and a
 * same-tag one drops the older from getNotifications while it stays on screen, out of reach: so no tag.
 * @param {string} body
 */
async function replaceNotification(body) {
  try {
    for (const old of await sw.registration.getNotifications()) old.close();
  } catch (error) {
    console.error("agent-desk: could not clear the previous notifications:", error); // old ones stay on screen; iOS still requires a notification for this push
  }
  await sw.registration.showNotification("Agent Desk", { body, icon: "/icon-192.png" });
}

sw.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    sw.clients.matchAll({ type: "window" }).then(async (open) => {
      if (!open[0]) return sw.clients.openWindow("/#needs");
      await open[0].focus();
      open[0].postMessage({ show: "needs" });
      return null;
    }),
  );
});
