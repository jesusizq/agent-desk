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
/** The page, its files, the state, conversations and images: what the desk needs to draw itself. The
 * event stream (/api/events) is not among them: it always goes to the network and is never kept. */
const KEPT = /^\/(?:|[\w-]+\.(?:js|css|svg|png|webmanifest)|api\/state|api\/sessions\/[\w-]+\/messages|images\/[\w.-]+)$/;

sw.addEventListener("install", () => sw.skipWaiting());
sw.addEventListener("activate", (e) => e.waitUntil(Promise.all([sw.clients.claim(), dropOtherCaches()])));
sw.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== sw.location.origin || !KEPT.test(url.pathname)) return;
  e.respondWith(networkOrSaved(e.request, url.pathname));
});

async function dropOtherCaches() {
  for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
}

/** @param {Request} request @param {string} key */
async function networkOrSaved(request, key) {
  // Given up on, a hung request is ended: the browser would hold later ones to the same address behind it.
  const giveUp = new AbortController();
  request.signal.addEventListener("abort", () => giveUp.abort());
  const network = fetch(request, { signal: giveUp.signal }).then(async (res) => {
    // The PIN page is not the desk, and says this device's unlock ended: what it kept goes too.
    // A failed delete is logged, not thrown: thrown, it would have the saved copy answer instead of the PIN page.
    if (res.headers.has(LOCKED)) await forget().catch((error) => console.error("agent-desk: could not delete the saved desk once locked:", error));
    else if (res.ok && !unlockEnded(res)) await (await caches.open(CACHE)).put(key, await stamped(res.clone()));
    return res;
  });
  network.catch(() => {}); // a late failure, once the saved copy has answered: nobody waits for it
  try {
    const first = await Promise.race([network, new Promise((/** @type {(v: undefined) => void} */ done) => setTimeout(done, NO_ANSWER_MS))]);
    if (first && !DESK_DOWN.has(first.status)) return first;
    const saved = await savedCopy(key);
    if (saved && !first) giveUp.abort();
    return saved ?? first ?? (await network);
  } catch (error) {
    const saved = await savedCopy(key);
    if (saved) return saved;
    throw error;
  }
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
