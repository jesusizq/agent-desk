// @ts-check
// The PIN page a device sees when it reaches the desk through the tailnet and has not unlocked it.
import { byId, fill, h } from "./dom.js";
import { TEXT } from "./text.js";

const form = /** @type {HTMLFormElement} */ (byId("unlock"));
const input = h("input", { type: "password", inputmode: "numeric", autocomplete: "current-password", "aria-label": TEXT.unlock.label, placeholder: TEXT.unlock.placeholder, required: true });
const message = h("p", { class: "unlock-msg", role: "alert" });
fill(form, h("h1", {}, TEXT.unlock.title), h("p", { class: "faint" }, TEXT.unlock.why), input, h("button", { class: "primary", type: "submit" }, TEXT.unlock.submit), message);
document.title = `${TEXT.appName} · ${TEXT.unlock.title}`;
input.focus();

form.addEventListener("submit", (e) => {
  e.preventDefault();
  message.textContent = "";
  fetch("/api/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: input.value }) })
    .then(async (res) => {
      if (res.ok) return location.reload();
      const detail = /** @type {{ error?: string }} */ (await res.json().catch(() => ({})));
      message.textContent = detail.error ?? `${res.status} ${res.statusText}`;
      input.value = "";
      input.focus();
    })
    .catch((/** @type {Error} */ error) => (message.textContent = error.message));
});
