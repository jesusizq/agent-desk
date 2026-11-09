// @ts-check
// The full-screen viewer for a result's pictures.
import { dialog, h, icon } from "./dom.js";
import { reducedMotion } from "./motion.js";
import { TEXT } from "./text.js";

/** @typedef {{ src: string, caption: string }} Picture */

/**
 * Full-screen viewer for a result's pictures, as a phone's photo viewer: a picture opens at most at
 * its own size; wheel, pinch and double-tap zoom around the pointer; drag pans; ← → or a sideways
 * swipe (at fit size) slides to the next picture; what overshoots springs back; a click beside it closes it.
 * @param {Picture[]} gallery @param {number} start
 */
export function zoom(gallery, start) {
  const d = dialog("zoom");
  const many = gallery.length > 1;
  const GAP = 24;
  const MAX = 8;
  /** @param {number} i */
  const wrap = (i) => (i + gallery.length) % gallery.length;
  // Three slides: the picture shown, and its neighbours already loaded beside it for a swipe.
  const slide = () => h("img", { alt: "", draggable: "false", hidden: !many });
  let prev = slide(), next = slide();
  let cur = h("img", { alt: "", draggable: "false", class: "cur" });
  const stage = h("div", { class: "zstage" }, prev, cur, next);
  let index = wrap(start);
  // Scale, pan of the picture shown, and the sideways offset of all three during a swipe.
  let k = 1, x = 0, y = 0, dx = 0;
  // While true the picture follows the fit size (its load, a turned screen); a zoom ends it.
  let fitted = true;
  const pct = h("span", { class: "num zfine" });
  const caption = h("span", { class: "faint zcaption" });
  const counter = h("span", { class: "num faint zcount" });
  const settleMs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dur-3")) * 1000 || 280;

  /** The scale that fits a picture in the stage, never above its own size: a screenshot opens sharp. @param {HTMLImageElement} img */
  const fitOf = (img) => (img.naturalWidth ? Math.min((stage.clientWidth * 0.9) / img.naturalWidth, (stage.clientHeight * 0.82) / img.naturalHeight, 1) : 1);
  const atFit = () => k <= fitOf(cur) * 1.05;
  /** @param {HTMLImageElement} img @param {number} tx @param {number} ty @param {number} s */
  const place = (img, tx, ty, s) => (img.style.transform = `translate(${tx}px, ${ty}px) scale(${s}) translate(-50%, -50%)`);
  const apply = () => {
    const step = stage.clientWidth + GAP;
    place(cur, x + dx, y, k);
    place(prev, dx - step, 0, fitOf(prev));
    place(next, dx + step, 0, fitOf(next));
    stage.classList.toggle("zoomed", !atFit());
    pct.textContent = `${Math.round(k * 100)} %`;
  };
  /** The pan that keeps a picture of scale s on the screen: centred when smaller, edge to edge when larger. @param {number} s @param {number} px @param {number} py @returns {[number, number]} */
  const clamp = (s, px, py) => {
    const mx = Math.max(0, (cur.naturalWidth * s - stage.clientWidth) / 2);
    const my = Math.max(0, (cur.naturalHeight * s - stage.clientHeight) / 2);
    return [Math.min(mx, Math.max(-mx, px)), Math.min(my, Math.max(-my, py))];
  };
  /** Scales to s around a point of the screen, which stays under the fingers or the pointer. @param {number} s @param {number} px @param {number} py */
  const zoomAt = (s, px, py) => {
    const r = stage.getBoundingClientRect();
    const cx = px - (r.left + r.width / 2);
    const cy = py - (r.top + r.height / 2);
    x = cx - ((cx - x) * s) / k;
    y = cy - ((cy - y) * s) / k;
    k = s;
  };

  /** @type {{ timer: number, then?: () => void } | null} */
  let moving = null;
  /** Ends a movement under way at its target, so a new gesture starts from where it was going. */
  const finish = () => {
    if (!moving) return;
    const { timer, then } = moving;
    moving = null;
    clearTimeout(timer);
    stage.classList.remove("settling");
    then?.();
  };
  /** Draws a change as a short movement, then runs what follows it. @param {() => void} draw @param {() => void} [then] */
  const animated = (draw, then) => {
    finish();
    if (reducedMotion()) {
      draw();
      return then?.();
    }
    stage.classList.add("settling");
    draw();
    moving = { timer: setTimeout(finish, settleMs), then };
  };
  /** Moves to a scale and pan, kept on the screen and within limits. @param {number} s @param {number} px @param {number} py */
  const settle = (s, px, py) =>
    animated(() => {
      const fit = fitOf(cur);
      k = Math.min(MAX, Math.max(fit, s));
      fitted = k === fit;
      [x, y] = fitted ? [0, 0] : clamp(k, px, py);
      dx = 0;
      apply();
    });
  /** @param {number} s */
  const zoomCentre = (s) => {
    const r = stage.getBoundingClientRect();
    zoomAt(s, r.left + r.width / 2, r.top + r.height / 2);
    settle(k, x, y);
  };

  /** @param {HTMLImageElement} img @param {number} i */
  const load = (img, i) => {
    const picture = gallery[wrap(i)];
    if (!picture) return;
    if (img.getAttribute("src") !== picture.src) img.src = picture.src;
    img.alt = picture.caption;
  };
  const show = () => {
    load(cur, index);
    if (many) {
      load(prev, index - 1);
      load(next, index + 1);
    }
    const picture = gallery[index];
    caption.textContent = picture?.caption ?? "";
    counter.textContent = many ? `${index + 1} / ${gallery.length}` : "";
  };
  /** Slides the next (1) or previous (-1) picture in, the way a swipe ends. @param {number} step */
  const go = (step) => {
    if (!many) return;
    animated(
      () => {
        k = fitOf(cur);
        x = y = 0;
        dx = -step * (stage.clientWidth + GAP);
        apply();
      },
      () => {
        index = wrap(index + step);
        [prev, cur, next] = step > 0 ? [cur, next, prev] : [next, prev, cur];
        for (const img of [prev, cur, next]) img.classList.toggle("cur", img === cur);
        show();
        fitted = true;
        k = fitOf(cur);
        dx = 0;
        apply();
      },
    );
  };
  for (const img of [prev, cur, next]) {
    img.addEventListener("load", () => {
      if (img === cur && fitted) k = fitOf(cur);
      apply();
    });
  }

  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      finish();
      zoomAt(Math.min(MAX, Math.max(fitOf(cur), k * Math.exp(-e.deltaY * 0.0022))), e.clientX, e.clientY);
      [x, y] = clamp(k, x, y);
      fitted = k <= fitOf(cur);
      apply();
    },
    { passive: false },
  );

  // One finger or the mouse pans (or swipes, at fit size); two fingers pinch and pan together.
  /** @type {Map<number, [number, number]>} */
  const pointers = new Map();
  /** @type {"pan" | "swipe" | "pinch"} */
  let mode = "pan";
  /** @type {[number, number]} */
  let last = [0, 0];
  let spread = 0;
  let moved = 0;
  let downAt = 0;
  /** @type {EventTarget | null} */
  let downOn = null;
  let lastTap = { at: 0, x: 0, y: 0 };
  /** The fingers' midpoint and spread. @returns {[number, number, number]} */
  const centre = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.hypot(a[0] - b[0], a[1] - b[1])] : [0, 0, 0];
  };
  stage.addEventListener("pointerdown", (e) => {
    finish();
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    stage.setPointerCapture(e.pointerId);
    stage.classList.add("grabbing");
    if (pointers.size === 1) {
      mode = atFit() && many ? "swipe" : "pan";
      last = [e.clientX, e.clientY];
      moved = 0;
      downAt = e.timeStamp;
      downOn = e.target;
    } else if (pointers.size === 2) {
      mode = "pinch";
      moved = Infinity; // a pinch is never a tap
      dx = 0;
      const [mx, my, sp] = centre();
      last = [mx, my];
      spread = sp;
    }
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (mode === "pinch") {
      if (pointers.size < 2) return;
      const [mx, my, sp] = centre();
      x += mx - last[0];
      y += my - last[1];
      if (spread && sp) zoomAt(Math.min(MAX, Math.max(fitOf(cur) * 0.5, (k * sp) / spread)), mx, my);
      last = [mx, my];
      spread = sp;
      fitted = false;
    } else {
      const mx = e.clientX - last[0];
      const my = e.clientY - last[1];
      last = [e.clientX, e.clientY];
      moved += Math.abs(mx) + Math.abs(my);
      if (mode === "swipe") dx += mx;
      else {
        x += mx;
        y += my;
      }
    }
    apply();
  });
  /** @param {PointerEvent} e */
  const release = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size === 1 && mode === "pinch") {
      // One finger stays: it pans on from where it is.
      mode = "pan";
      last = [...pointers.values()][0] ?? [0, 0];
      return;
    }
    if (pointers.size) return;
    stage.classList.remove("grabbing");
    const tap = e.type === "pointerup" && moved < 6;
    if (mode === "swipe" && !tap) {
      const quick = Math.abs(dx) > 30 && Math.abs(dx) / Math.max(1, e.timeStamp - downAt) > 0.4;
      if (e.type === "pointerup" && (Math.abs(dx) > stage.clientWidth * 0.2 || quick)) return go(dx < 0 ? 1 : -1);
      return settle(k, x, y);
    }
    if (!tap) return settle(k < fitOf(cur) ? fitOf(cur) : k, x, y);
    if (downOn !== cur) return d.close();
    // A second tap on the picture: in to its detail under the finger, or back to the fit size.
    if (e.timeStamp - lastTap.at < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      lastTap.at = 0;
      if (!atFit()) return settle(fitOf(cur), 0, 0);
      zoomAt(Math.min(MAX, Math.max(1, fitOf(cur) * 2.5)), e.clientX, e.clientY);
      return settle(k, x, y);
    }
    lastTap = { at: e.timeStamp, x: e.clientX, y: e.clientY };
    dx = 0;
    apply();
  };
  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);
  d.onkeydown = (e) => {
    if (e.key === "ArrowRight") go(1);
    else if (e.key === "ArrowLeft") go(-1);
    else return;
    e.preventDefault();
  };
  const resized = () => {
    finish();
    if (fitted) k = fitOf(cur);
    [x, y] = clamp(k, x, y);
    apply();
  };
  addEventListener("resize", resized);
  d.addEventListener("close", () => (finish(), removeEventListener("resize", resized)), { once: true });
  d.replaceChildren(
    stage,
    h(
      "div",
      { class: "zbar" },
      many ? h("button", { onclick: () => go(-1), "aria-label": TEXT.zoom.previous }, "‹") : null,
      many ? counter : null,
      many ? h("button", { onclick: () => go(1), "aria-label": TEXT.zoom.next }, "›") : null,
      // A finger pinches instead: on touch screens the step buttons give their room to the caption.
      h("button", { class: "zfine", onclick: () => zoomCentre(k / 1.25), "aria-label": TEXT.zoom.out }, "−"),
      pct,
      h("button", { class: "zfine", onclick: () => zoomCentre(k * 1.25), "aria-label": TEXT.zoom.in }, "+"),
      h("button", { onclick: () => settle(fitOf(cur), 0, 0) }, TEXT.zoom.fit),
      h("button", { class: "zfine", onclick: () => settle(1, 0, 0) }, "100 %"),
      caption,
      h("button", { onclick: () => d.close(), "aria-label": TEXT.close }, icon("x")),
    ),
  );
  d.showModal();
  show();
  // A picture already in memory has its size now; others fit when they load.
  if (cur.complete) k = fitOf(cur);
  apply();
}
