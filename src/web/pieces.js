// @ts-check
// Small pieces shared by every part of the page: marks, links to sessions, toasts, switches and menus.
import { byId, h, icon } from "./dom.js";
import { grow } from "./motion.js";
import { TEXT } from "./text.js";
import { color, heat, providerMark } from "./format.js";
import { CONTEXT_WARN, ID, label, ON_THIS_MACHINE, sessionName } from "./state.js";

/** @typedef {import("../core/protocol.ts").Session} Session */
/** @typedef {import("../core/protocol.ts").Metrics} Metrics */
/** @typedef {import("./dom.js").Child} Child */
/** @typedef {import("./state.js").DotState} DotState */

/** How to bring a session's terminal to the front, per terminal program (TERM_PROGRAM). */
const SESSION_LINKS = /** @type {Record<string, (id: string) => string>} */ ({
  vscode: (id) => `vscode://agent-desk.agent-desk/focus?session=${encodeURIComponent(id)}`,
});

/** @param {DotState} st */
export const dot = (st) => h("span", { class: `dot st-${st}`, title: TEXT.state[st] });
/** @param {keyof typeof TEXT.kinds} kind */
export const badge = (kind) => h("span", { class: `badge k-${kind}` }, TEXT.kinds[kind]);
/** @param {string} iso */
export const beacon = (iso) => h("span", { class: `beacon${heat(iso)}`, "aria-hidden": "true" });
/** @param {string} c */
export function tagIcon(c) {
  const i = icon("tag", "tag");
  i.style.setProperty("--g", c);
  return i;
}
/** A project's tag and name, both in the project's colour. @param {string} name @param {string} [cls] */
export function projectMark(name, cls = "pname") {
  const c = color(name);
  const n = h("span", { class: cls }, name);
  n.style.setProperty("--g", c);
  return [tagIcon(c), n];
}
/** @param {Session | undefined} s @param {string} [name] */
export function where(s, name) {
  if (!s) return h("span", { class: "where" }, "?");
  const mark = h("span", { class: "prov", title: s.provider }, providerMark(s.provider));
  mark.style.setProperty("--p", color(s.provider));
  return h("span", { class: "where" }, projectMark(s.project.name), h("span", { class: "sep" }, "›"), mark, h("span", { class: "wname" }, name ?? sessionName(s)));
}
/** @param {number} v */
export function bar(v) {
  const fill = h("i", {});
  fill.style.width = `${Math.min(100, Math.max(0, v))}%`;
  return h("span", { class: `mini${v >= CONTEXT_WARN ? " warn" : ""}` }, fill);
}
/** @param {string} msg */
export function toast(msg) {
  const box = byId("toasts");
  const t = h("div", { class: "toast" }, msg);
  // A toast on screen stays at the edge it came in from, even when a window closes or the keyboard drops under it.
  if (!box.childElementCount) {
    const head = [...document.querySelectorAll("dialog[open] > .dhead")].at(-1);
    box.style.setProperty("--dialog-head", `${head ? Math.round(head.getBoundingClientRect().bottom) : 0}px`);
    box.dataset.edge = document.querySelector("dialog[open]") || document.documentElement.hasAttribute("data-keyboard") ? "top" : "bottom";
  }
  box.append(t);
  // Re-shown each time so it sits above any open dialog in the browser's top layer.
  if (box.matches(":popover-open")) box.hidePopover();
  box.showPopover();
  grow(t); // the toasts above it slide up instead of jumping
  setTimeout(() => t.classList.add("leaving"), 3400);
  setTimeout(() => {
    t.remove();
    if (!box.childElementCount && box.matches(":popover-open")) box.hidePopover();
  }, 3600);
}
/** @param {string} text */
export function copy(text) {
  const lines = text.split("\n");
  const shown = (lines[0] ?? "").length > 80 || lines.length > 1 ? `${(lines[0] ?? "").slice(0, 79)}…` : text;
  navigator.clipboard.writeText(text).then(
    () => toast(TEXT.copied(shown)),
    (/** @type {Error} */ e) => toast(e.message),
  );
}
// A command or path in session text is copied with a click, before the card around it opens;
// a click that ends a text selection leaves the selection alone.
document.addEventListener("click", (e) => {
  const code = e.target instanceof Element ? e.target.closest("[data-copy]") : null;
  if (!code || !document.getSelection()?.isCollapsed) return;
  e.stopPropagation();
  copy(code.textContent ?? "");
}, true);
export const LOCAL_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?=[:/]|$)/;
/**
 * A link to a local preview. From another device localhost is that device, so the preview is only
 * named there, as running on the computer. @param {string} url @param {Child} content @param {string} [cls]
 */
export function localLink(url, content, cls) {
  if (ON_THIS_MACHINE || !LOCAL_URL.test(url)) return h("a", { class: cls, href: url, target: "_blank", rel: "noopener noreferrer" }, content);
  return h("span", { class: "faint", title: url }, TEXT.onComputer(url.replace(/^https?:\/\//, "").replace(/\/$/, "")));
}

/** The link that brings a session's terminal to the front, or why there is none. @param {Session | undefined} s */
export function sessionLink(s) {
  if (!ON_THIS_MACHINE) return { href: null, why: TEXT.remoteNoLink };
  if (!s || !ID.test(s.id)) return { href: null, why: TEXT.noTerminal };
  if (!s.terminal) return { href: null, why: TEXT.noTerminal };
  const build = SESSION_LINKS[s.terminal];
  return build ? { href: build(s.id), why: TEXT.goToTitle(label(s)) } : { href: null, why: TEXT.noLink(s.terminal) };
}
/** @param {Session | undefined} s @param {string} cls @param {Child[]} content */
export function goLink(s, cls, ...content) {
  if (!ON_THIS_MACHINE) return null; // its terminal is on the computer, not on this device
  const { href, why } = sessionLink(s);
  if (!href) return h("button", { class: cls, disabled: true, title: why }, ...content);
  return h("a", { class: cls, href, title: why, onclick: (e) => e.stopPropagation() }, ...content);
}

/**
 * The one shape of "nothing here" in every column: an optional mark, one line, and at most one way on.
 * @param {string} key @param {string} text @param {{ mark?: Child, action?: Child }} [more]
 */
export function emptyState(key, text, { mark, action } = {}) {
  return h("div", { class: "empty", role: "status", "data-key": key }, mark ?? null, h("p", {}, text), action ?? null);
}

/**
 * The command a session's state calls for, copied with a click, on its card and in its panel alike.
 * @param {NonNullable<Metrics["suggestion"]>} suggestion @param {number} context @param {string} text
 */
export function suggestionChip(suggestion, context, text) {
  const { command, reason } = suggestion;
  return h("button", { class: "chip warn", title: TEXT.suggest[reason](context), onclick: (/** @type {Event} */ e) => (e.stopPropagation(), copy(command)) }, icon("copy"), text);
}

/** The menus' switches, made once and updated in place: a change keeps the focus on its box. @type {Map<string, { label: HTMLLabelElement, box: HTMLInputElement, hint: HTMLElement }>} */
const switches = new Map();
/**
 * @param {string} key @param {string} text @param {(box: HTMLInputElement) => void} change
 * @param {{ checked: boolean, disabled: boolean, hint: string, off: boolean }} state
 */
export function switchRow(key, text, change, { checked, disabled, hint, off }) {
  let row = switches.get(key);
  if (!row) {
    const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox" }));
    box.addEventListener("change", () => change(box));
    const small = h("small", {});
    row = { label: h("label", {}, box, h("span", {}, text), small), box, hint: small };
    switches.set(key, row);
  }
  row.box.checked = checked;
  row.box.disabled = disabled;
  row.hint.textContent = hint;
  row.label.className = off ? "off" : "";
  return row.label;
}

/**
 * A header button that opens its menu; a click anywhere else or Escape closes it. The path is read
 * as dispatched. @param {string} buttonId @param {string} menuId @param {() => void} fill
 */
export function headerMenu(buttonId, menuId, fill) {
  const menu = byId(menuId);
  const button = byId(buttonId);
  button.setAttribute("aria-controls", menuId);
  /** @param {boolean} open */
  const show = (open) => {
    if (open) fill();
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };
  show(false);
  button.onclick = () => show(menu.hidden);
  document.addEventListener("click", (e) => {
    if (!menu.hidden && menu.parentElement && !e.composedPath().includes(menu.parentElement)) show(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || menu.hidden) return;
    e.preventDefault();
    const inside = menu.contains(document.activeElement);
    show(false);
    if (inside) button.focus();
  });
}
