// @ts-check
// Keeps on the device the last desk it saw, to show it when the computer does not answer (off or
// asleep). Network first, always: the saved copy is used only when the request fails, and it is read
// only, since an answer needs the computer.
/// <reference lib="webworker" />
const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));
const CACHE = "agent-desk";
const SAVED_AT = "X-Agent-Desk-Saved-At";
/** A computer asleep leaves requests hanging, not failing: past this the saved copy answers. */
const NO_ANSWER_MS = 5000;
/** What Tailscale Serve answers when the computer is up and the desk is not. */
const DESK_DOWN = new Set([502, 503, 504]);
/** The page, its files, the state, conversations and images: what the desk needs to draw itself. */
const KEPT = /^\/(?:|[\w-]+\.(?:js|css|svg|png|webmanifest)|api\/state|api\/sessions\/[\w-]+\/messages|images\/[\w.-]+)$/;

sw.addEventListener("install", () => sw.skipWaiting());
sw.addEventListener("activate", (e) => e.waitUntil(sw.clients.claim()));
sw.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== sw.location.origin || !KEPT.test(url.pathname)) return;
  e.respondWith(networkOrSaved(e.request, url.pathname));
});

/** @param {Request} request @param {string} key */
async function networkOrSaved(request, key) {
  const cache = await caches.open(CACHE);
  // Given up on, a hung request is ended: the browser would hold later ones to the same address behind it.
  const giveUp = new AbortController();
  request.signal.addEventListener("abort", () => giveUp.abort());
  const network = fetch(request, { signal: giveUp.signal }).then(async (res) => {
    // The PIN page is not the desk: a locked answer is never kept.
    if (res.ok && !res.headers.has("X-Agent-Desk-Locked")) await cache.put(key, await stamped(res.clone()));
    return res;
  });
  network.catch(() => {}); // a late failure, once the saved copy has answered: nobody waits for it
  try {
    const first = await Promise.race([network, new Promise((/** @type {(v: undefined) => void} */ done) => setTimeout(done, NO_ANSWER_MS))]);
    if (first && !DESK_DOWN.has(first.status)) return first;
    const saved = await cache.match(key);
    if (saved && !first) giveUp.abort();
    return saved ?? first ?? (await network);
  } catch (error) {
    const saved = await cache.match(key);
    if (saved) return saved;
    throw error;
  }
}

/** A copy that says when it was saved, so the page can tell the developer how old it is. @param {Response} res */
async function stamped(res) {
  const headers = new Headers(res.headers);
  headers.set(SAVED_AT, new Date().toISOString());
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers });
}

// A push says only how many questions wait (src/server/push.ts); what they ask is read in the desk.
sw.addEventListener("push", (e) => {
  let count = 0;
  try {
    count = Number(/** @type {{ count?: unknown }} */ (e.data?.json() ?? {}).count) || 0;
  } catch {
    count = 0; // an unreadable payload still says something waits: iOS requires a notification for every push
  }
  const body = count > 1 ? `${count} need you` : "Something needs you";
  const shown = sw.registration.showNotification("Agent Desk", { body, tag: "needs-you", icon: "/icon-192.png" });
  // The number is a nicety: a browser that refuses it still shows the notification.
  e.waitUntil(Promise.all([shown, count > 0 && "setAppBadge" in sw.navigator ? sw.navigator.setAppBadge(count).catch(() => {}) : null]));
});
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
