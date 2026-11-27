// @ts-check
// Says why the page did not start, instead of leaving it blank: a module of app.js the desk does not
// serve (a file added since the desk started), a script error before the desk ran, or no start at all.
// A classic script, loaded before app.js, so it runs even when the modules cannot.
/** Past this with no start, the page says so; it goes once the desk starts after all. */
const BOOT_MS = 12000;
const BOOT_TEXT = {
  files: "The page could not load all its files. The desk on the computer was probably updated while it ran: restart it there, then reload.",
  /** @param {string} message */
  error: (message) => `The page failed to start: ${message}. Reload; if it fails again, restart the desk on the computer.`,
  slow: "The page has not started yet. Check that this device reaches the computer (Tailscale connected, the computer awake), then reload.",
  reload: "Reload",
};
let started = false;
/** @param {string} why */
function bootFailed(why) {
  if (started) return;
  let box = document.getElementById("boot-failed");
  if (!box) {
    box = document.createElement("div");
    box.id = "boot-failed";
    box.className = "boot-failed";
    box.setAttribute("role", "alert");
    const text = document.createElement("p");
    const reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = BOOT_TEXT.reload;
    reload.addEventListener("click", () => location.reload());
    box.append(text, reload);
    document.body.append(box);
  }
  const text = box.querySelector("p");
  if (text) text.textContent = why;
}
const whenReady = (/** @type {() => void} */ fn) => (document.body ? fn() : document.addEventListener("DOMContentLoaded", fn, { once: true }));
// A module that fails to load fires `error` on its script element, which does not bubble: caught on the way down.
addEventListener("error", (e) => {
  if (e.target instanceof HTMLScriptElement) whenReady(() => bootFailed(BOOT_TEXT.files));
  else if (e instanceof ErrorEvent && !started) whenReady(() => bootFailed(BOOT_TEXT.error(e.message)));
}, true);
const slow = setTimeout(() => whenReady(() => bootFailed(BOOT_TEXT.slow)), BOOT_MS);
addEventListener("agent-desk:started", () => {
  started = true;
  clearTimeout(slow);
  document.getElementById("boot-failed")?.remove();
}, { once: true });
