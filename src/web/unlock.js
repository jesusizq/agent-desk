// @ts-check
// The PIN page a device sees when it reaches the desk through the tailnet and has not unlocked it.
import { byId, DRAFTS_KEY, fill, h } from "./dom.js";
import { TEXT } from "./text.js";

// Shown only to a device whose unlock is over: what it was writing went with it.
localStorage.removeItem(DRAFTS_KEY);

const form = /** @type {HTMLFormElement} */ (byId("unlock"));
const input = h("input", { type: "password", inputmode: "numeric", autocomplete: "current-password", "aria-label": TEXT.unlock.label, placeholder: TEXT.unlock.placeholder, required: true });
const message = h("p", { class: "unlock-msg", role: "alert" });
/** What the desk refused, in the page's words; its own text when it is not a refused PIN. @param {string} text */
const say = (text) => {
  message.textContent = text;
  input.setAttribute("aria-invalid", "true");
};
input.addEventListener("input", () => input.removeAttribute("aria-invalid"));
// The message sits between the PIN and the button: its kept line reads as their spacing, not as a gap under the card.
fill(form, h("h1", {}, TEXT.unlock.title), input, message, h("button", { class: "primary", type: "submit" }, TEXT.unlock.submit));
document.title = `${TEXT.appName} · ${TEXT.unlock.title}`;
input.focus();

form.addEventListener("submit", (e) => {
  e.preventDefault();
  message.textContent = "";
  input.removeAttribute("aria-invalid");
  fetch("/api/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: input.value }) })
    .then(async (res) => {
      if (res.ok) return location.reload();
      const detail = /** @type {{ error?: string }} */ (await res.json().catch(() => ({})));
      say(res.status === 401 ? TEXT.unlock.wrong : res.status === 429 ? TEXT.unlock.tooMany : (detail.error ?? `${res.status} ${res.statusText}`));
      input.select();
      input.focus();
    })
    .catch(() => say(TEXT.unlock.noConnection)); // fetch's own text ("Load failed") says nothing
});
