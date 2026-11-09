// @ts-check
// A result's window: its summary, its pictures side by side or compared with a slider.
import { dialog, h, icon, md } from "./dom.js";
import { TEXT } from "./text.js";
import { stamp } from "./format.js";
import { badge, dot, goLink, localLink, where } from "./pieces.js";
import { post, run } from "./server.js";
import { isNew, S } from "./state.js";
import { zoom } from "./zoom.js";

/** @typedef {import("../core/protocol.ts").Result} Result */
/** @typedef {import("./zoom.js").Picture} Picture */

/** @param {Result} r @param {{ markSeen?: boolean }} [opts] */
export function openResult(r, { markSeen = true } = {}) {
  const d = dialog("result");
  const s = S(r.sessionId);
  // Only a click marks a result seen: a link from elsewhere (#r=…) must not write anything.
  if (markSeen && isNew(r)) run(post(`/api/results/${r.id}/seen`));
  const imgs = r.images.map((i) => ({ src: `/images/${i.id}`, cap: i.caption ?? "" }));
  const before = r.compare && imgs[r.images.findIndex((i) => i.id === r.compare?.before)];
  const after = r.compare && imgs[r.images.findIndex((i) => i.id === r.compare?.after)];
  let mode = before && after ? "slider" : "side";
  const viewer = h("div", { class: "viewer" });
  const drawViewer = () => {
    const tools = h(
      "div",
      { class: "vtools" },
      before && after
        ? h("div", { class: "seg" }, (/** @type {const} */ ([["slider", TEXT.slider], ["side", TEXT.sideBySide]])).map(([k, l]) => h("button", { "aria-pressed": String(mode === k), onclick: () => ((mode = k), drawViewer()) }, l)))
        : null,
      h("span", { class: "faint" }, h("span", { class: "mouse-only" }, TEXT.zoomHint), h("span", { class: "touch-only" }, TEXT.zoomHintTouch)),
    );
    viewer.replaceChildren(
      tools,
      mode === "slider" && before && after
        ? compareView(before, after, gallery)
        : h("div", { class: `vimgs${before && after ? " pair" : ""}` }, imgs.map(({ src, cap }, i) => h("figure", {}, h("img", { src, alt: cap, onclick: () => zoom(gallery, i) }), cap ? h("figcaption", {}, cap) : null))),
    );
  };
  const gallery = imgs.map(({ src, cap }) => ({ src, caption: cap ? `${r.title} · ${cap}` : r.title }));
  if (imgs.length) drawViewer();
  /** @param {string} title @param {string[]} items */
  const list = (title, items) => (items.length ? h("div", { class: "rsec" }, h("h4", {}, title), h("ul", { class: "plain" }, items.map((a) => h("li", {}, md(a))))) : null);
  d.replaceChildren(
    h(
      "div",
      { class: "dhead" },
      h("div", {}, h("div", { class: "meta" }, badge(r.status === "failed" ? "failed" : "result"), where(s), h("span", { class: "sep" }, "·"), h("span", { class: "num" }, stamp(r.at))), h("h3", {}, r.title)),
      h("span", { class: "spacer" }),
      r.url ? localLink(r.url, [icon("link"), TEXT.openLive], "secondary") : null,
      goLink(s, "primary", icon("go"), TEXT.goTo),
      h("button", { class: "icon-btn", "aria-label": TEXT.close, onclick: () => d.close() }, icon("x")),
    ),
    h(
      "div",
      { class: "dbody" },
      imgs.length ? viewer : null,
      r.summary ? h("div", { class: "rsec" }, h("p", { class: "lead" }, md(r.summary))) : null,
      list(TEXT.assumed, r.assumptions),
      list(TEXT.taste, r.decisions),
      r.checks.length
        ? h("div", { class: "rsec" }, h("h4", {}, TEXT.criteria), h("table", { class: "crit" }, h("tbody", {}, r.checks.map((c) => h("tr", {}, h("td", {}, dot("done")), h("td", {}, md(c.criterion)), h("td", { class: "muted" }, md(c.verification)))))))
        : null,
    ),
  );
  if (!d.open) d.showModal();
}

/** @param {{ src: string, cap: string }} a @param {{ src: string, cap: string }} b @param {Picture[]} gallery */
function compareView(a, b, gallery) {
  const top = h("img", { src: b.src, alt: b.cap, class: "top", draggable: "false" });
  const handle = h("div", { class: "handle", role: "slider", tabindex: 0, "aria-label": `${a.cap} / ${b.cap}`, "aria-valuemin": 0, "aria-valuemax": 100 }, icon("chev", "i back"), icon("chev"));
  const line = h("div", { class: "line" }, handle);
  const box = h("div", { class: "compare" }, h("img", { src: a.src, alt: a.cap, draggable: "false" }), top, line);
  let at = 50;
  /** @param {number} v */
  const set = (v) => {
    at = Math.min(100, Math.max(0, v));
    top.style.clipPath = `inset(0 0 0 ${at}%)`;
    line.style.left = `${at}%`;
    handle.setAttribute("aria-valuenow", String(Math.round(at)));
  };
  /** @param {number} clientX */
  const percent = (clientX) => {
    const r = box.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * 100;
  };
  // The divider follows a press on its line, or a sideways drag anywhere on the picture (a vertical
  // one scrolls the page); a press that does not move zooms the picture on its side of the line.
  /** @type {{ id: number, x: number, y: number, moving: boolean } | null} */
  let press = null;
  let dragged = false;
  /** @param {PointerEvent} e */
  const grab = (e) => {
    if (!press) return;
    press.moving = true;
    box.setPointerCapture(e.pointerId);
    box.classList.add("dragging");
    set(percent(e.clientX));
  };
  box.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, moving: false };
    dragged = false;
    if (e.target instanceof Node && line.contains(e.target)) grab(e);
  });
  box.addEventListener("pointermove", (e) => {
    if (!press || e.pointerId !== press.id) return;
    const dx = Math.abs(e.clientX - press.x);
    if (!press.moving && dx > 6 && dx > Math.abs(e.clientY - press.y)) grab(e);
    if (press.moving) set(percent(e.clientX));
  });
  /** @param {PointerEvent} e */
  const release = (e) => {
    if (!press || e.pointerId !== press.id) return;
    dragged = press.moving;
    press = null;
    box.classList.remove("dragging");
  };
  box.addEventListener("pointerup", release);
  box.addEventListener("pointercancel", release);
  box.addEventListener("click", (e) => {
    if (dragged || (e.target instanceof Node && line.contains(e.target))) return;
    const side = percent(e.clientX) < at ? a : b;
    zoom(gallery, Math.max(0, gallery.findIndex((g) => g.src === side.src)));
  });
  handle.addEventListener("keydown", (e) => {
    const step = /** @type {Record<string, number>} */ ({ ArrowLeft: -2, ArrowDown: -2, ArrowRight: 2, ArrowUp: 2, PageDown: -10, PageUp: 10, Home: -100, End: 100 })[e.key];
    if (step === undefined) return;
    e.preventDefault();
    set(at + (e.shiftKey ? step * 5 : step));
  });
  set(50);
  return h("div", { class: "cmp" }, box, a.cap || b.cap ? h("div", { class: "cmp-caps" }, h("span", {}, a.cap), h("span", {}, b.cap)) : null);
}
