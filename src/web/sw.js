// @ts-check
// Keeps on the device the last desk it saw, to show it when the computer does not answer (off or
// asleep). Network first, always: the saved copy is used only when the request fails, and it is read
// only, since an answer needs the computer.
/// <reference lib="webworker" />
const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));
const CACHE = "agent-desk";
const SAVED_AT = "X-Agent-Desk-Saved-At";
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
  try {
    const res = await fetch(request);
    // The PIN page is not the desk: a locked answer is never kept.
    if (res.ok && !res.headers.has("X-Agent-Desk-Locked")) await cache.put(key, await stamped(res.clone()));
    return res;
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
