// @ts-check
// Motion for what the desk redraws. Cards of a list glide to their new place, new ones open where they
// land and gone ones fold away, each inside its own column: Web Animations on the cards themselves,
// so nothing paints outside its column's clip and no click waits for a picture of the page. Lengths
// and easing are style.css's motion tokens; nothing moves for a developer who prefers reduced motion.

const MOTION = "motion"; // the id of every animation started here

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function tokens() {
  const css = getComputedStyle(document.documentElement);
  /** @param {string} name @param {number} fallback */
  const ms = (name, fallback) => {
    const v = css.getPropertyValue(name).trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? (v.endsWith("ms") ? n : n * 1000) : fallback;
  };
  return { move: ms("--dur-3", 280), fade: ms("--dur-2", 180), easing: css.getPropertyValue("--ease-out").trim() || "ease-out" };
}
/** @typedef {ReturnType<typeof tokens>} Tokens */
/** @typedef {Map<Element, { top: number, edge: number }>} Scrolls */

/** The element whose scroll carries a list: the first one up that scrolls, else the document (a phone's). @param {Element} el */
function scrollerOf(el) {
  for (let e = /** @type {Element | null} */ (el); e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    const y = getComputedStyle(e).overflowY;
    if ((y === "auto" || y === "scroll") && e.scrollHeight > e.clientHeight) return e;
  }
  return document.scrollingElement ?? document.documentElement;
}
/** Where a scroll area starts showing its content, in the window. @param {Element} scroller */
const viewTop = (scroller) => (scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top + scroller.clientTop);

/** @param {Element} el */
const shown = (el) => el.getClientRects().length > 0;
/** The cards of a list: its children with a key, not those on their way out. @param {Element} list */
const itemsOf = (list) => [...list.children].filter(/** @returns {el is HTMLElement} */ (el) => el instanceof HTMLElement && el.dataset.key !== undefined && !el.hasAttribute("data-leaving"));
/** What a card shows, whatever its shape: a question's row and its large card share it. @param {HTMLElement} el */
const flipId = (el) => el.dataset.flip ?? el.dataset.key ?? "";
/** @param {Element} el */
const stop = (el) => {
  for (const a of el.getAnimations()) if (a.id === MOTION) a.cancel();
};
/** @param {Element} list */
const gapOf = (list) => parseFloat(getComputedStyle(list).rowGap) || 0;
/** The side of a card that touches a neighbour, where a list's gap sits. @param {Element} el */
const gapSide = (el) => (el.nextElementSibling ? "marginBottom" : el.previousElementSibling ? "marginTop" : null);
const FLAT = { height: "0px", paddingTop: "0px", paddingBottom: "0px", borderTopWidth: "0px", borderBottomWidth: "0px" };
/** A card's height and what makes it, as keyframe values. @param {HTMLElement} el @param {number} [height] */
function tall(el, height = el.getBoundingClientRect().height) {
  const cs = getComputedStyle(el);
  return { height: `${height}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, borderTopWidth: cs.borderTopWidth, borderBottomWidth: cs.borderBottomWidth };
}

/**
 * Runs `update` (a redraw) and animates what it changed in the lists under `scope`, the elements
 * marked `data-list`, whose cards carry `data-key`. In a column, a new card opens from no height and a
 * gone one folds to none, so its neighbours glide with the layout; cards that changed places slide
 * from where they were. A new card whose `data-flip` names a smaller one that just left (a question's
 * row becoming the large card) grows out of it. In a grid, gone cards fade where they were.
 * @param {Element} scope @param {() => void} update
 */
export function animateLists(scope, update) {
  if (reducedMotion() || document.hidden) return update();
  const lists = [...scope.querySelectorAll("[data-list]")].filter(shown);
  const before = lists.map((list) => ({ list, scroller: scrollerOf(list), items: itemsOf(list).filter(shown).map((el) => ({ el, rect: el.getBoundingClientRect() })) }));
  /** @type {Scrolls} where each list's scroll area stood, and where it is to stand once its cards start moving */
  const scrolls = new Map(before.map(({ scroller }) => [scroller, { top: scroller.scrollTop, edge: viewTop(scroller) }]));
  /** @type {Map<Element, number>} */
  const grows = new Map([...scope.querySelectorAll("[data-grow]")].map((el) => [el, el.getBoundingClientRect().height]));
  update();
  /** @typedef {{ el: HTMLElement, rect: DOMRect }} Seen */
  /** @type {Map<string, Seen & { list: Element }>} cards no longer in their list, by what they show */
  const gone = new Map();
  for (const { list, items } of before) for (const it of items) if (it.el.parentElement !== list) gone.set(flipId(it.el), { ...it, list });
  const changes = before
    .filter(({ list }) => list.isConnected && shown(list))
    .map(({ list, scroller, items }) => {
      const was = new Map(items.map((it) => [it.el, it.rect]));
      const now = itemsOf(list);
      return { list, scroller, items, was, now, added: now.filter((el) => !was.has(el)) };
    });
  /** @type {Map<HTMLElement, Seen>} a new card, and the gone one it grows out of */
  const outOf = new Map();
  for (const { added } of changes) {
    for (const el of added) {
      const g = gone.get(flipId(el));
      // Only a card growing out of a smaller one (a row picked up): a large card squeezed into a row
      // would show an empty box over its neighbours, so it folds away and the row opens on its own.
      if (!g || g.rect.height > el.getBoundingClientRect().height + 0.5) continue;
      outOf.set(el, g);
      gone.delete(flipId(el));
    }
  }
  const t = tokens();
  for (const change of changes) {
    const leaving = change.items.filter((it) => it.el.parentElement !== change.list && gone.get(flipId(it.el))?.el === it.el);
    const moved = change.now.some((el) => {
      const old = change.was.get(el);
      const r = el.getBoundingClientRect();
      return old && (Math.abs(old.left - r.left) > 0.5 || Math.abs(old.top - r.top) > 0.5 || Math.abs(old.height - r.height) > 0.5);
    });
    // A redraw that changed nothing here leaves what is still moving alone.
    if (!change.added.length && !leaving.length && !moved) continue;
    if (getComputedStyle(change.list).display === "grid") animateGrid(change, leaving, t);
    else animateColumn(change, leaving, outOf, grows, scrolls, t);
  }
}

/**
 * @param {{ list: Element, scroller: Element, items: { el: HTMLElement, rect: DOMRect }[], was: Map<HTMLElement, DOMRect>, now: HTMLElement[], added: HTMLElement[] }} change
 * @param {{ el: HTMLElement, rect: DOMRect }[]} leaving @param {Map<HTMLElement, { el: HTMLElement, rect: DOMRect }>} outOf
 * @param {Map<Element, number>} grows the heights of the `data-grow` blocks before the redraw
 * @param {Scrolls} scrolls where each scroll area stood before the redraw @param {Tokens} t
 */
function animateColumn({ list, scroller, items, was, now, added }, leaving, outOf, grows, scrolls, t) {
  for (const el of now) stop(el);
  const gap = gapOf(list);
  const scroll = scrolls.get(scroller) ?? { top: scroller.scrollTop, edge: viewTop(scroller) };
  // A card that shrinks or folds from above the top of its scroll area loses its hidden part at once, the
  // scroll going up as much: the motion starts from what shows, and the browser never clamps the scroll
  // mid-way (the rows below would jump, the card's content scroll back).
  /** @type {{ top: number, cut: number }[]} */
  const cuts = [];
  const cutSum = () => cuts.reduce((sum, c) => sum + c.cut, 0);
  /** @param {DOMRect} rect @param {number} want */
  const cutOf = (rect, want) => {
    const cut = Math.min(want, scroll.top - cutSum());
    if (cut <= 0.5) return 0;
    cuts.push({ top: rect.top, cut });
    return cut;
  };
  /** @param {DOMRect} rect */
  const hidden = (rect) => Math.min(scroll.edge - rect.top, rect.height);
  /** @type {{ el: HTMLElement, rect: DOMRect, cut: number }[]} */
  const folding = [];
  for (const g of leaving) {
    const above = hidden(g.rect) >= g.rect.height - 0.5;
    // Wholly out of sight, it goes at once, with the gap it held.
    const cut = cutOf(g.rect, above ? g.rect.height + (items.length > 1 ? gap : 0) : hidden(g.rect));
    if (cut < g.rect.height - 0.5) folding.push({ ...g, cut });
  }
  // Gone cards come back for the length of their exit, where they were among the others.
  for (const g of [...folding].reverse()) {
    const after = items.slice(items.findIndex((it) => it.el === g.el) + 1).map((it) => (it.el.parentElement === list ? it.el : [...outOf].find(([, o]) => o.el === it.el)?.[0]));
    leave(g.el);
    list.insertBefore(g.el, after.find((el) => el?.parentElement === list) ?? null);
  }
  const ends = new Map(added.map((el) => [el, tall(el)]));
  const options = { duration: t.move, easing: t.easing, id: MOTION };
  // A card that stays but grows or shrinks (answered, a line more) changes height along the same curve.
  // A block marked `data-grow` that opened or changed inside it grows itself instead: what follows it in
  // the card (its answer box) is carried down, never clipped by the card's own height.
  for (const el of now) {
    const old = was.get(el);
    const height = el.getBoundingClientRect().height;
    if (!old || Math.abs(old.height - height) <= 0.5) continue;
    const inner = [...el.querySelectorAll("[data-grow]")].map((g) => ({ g, from: grows.get(g) ?? 0, to: g.getBoundingClientRect().height })).filter(({ from, to }) => Math.abs(from - to) > 0.5);
    if (inner.length) {
      for (const { g, from, to } of inner) g.animate([{ height: `${from}px`, overflow: "hidden" }, { height: `${to}px`, overflow: "hidden" }], options);
      continue;
    }
    const from = old.height - (height < old.height ? cutOf(old, Math.min(hidden(old), old.height - height)) : 0);
    if (Math.abs(from - height) > 0.5) el.animate([{ height: `${from}px`, overflow: "hidden" }, { height: `${height}px`, overflow: "hidden" }], options);
  }
  for (const g of folding) {
    const side = gapSide(g.el);
    const fold = g.el.animate(
      [
        { ...tall(g.el, g.rect.height - g.cut), overflow: "hidden", ...(side ? { [side]: "0px" } : {}) },
        { ...FLAT, overflow: "hidden", ...(side ? { [side]: `${-gap}px` } : {}) },
      ],
      options,
    );
    g.el.scrollTop = g.cut; // what showed of it stays in place as it folds
    fold.onfinish = fold.oncancel = () => g.el.remove();
    g.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: t.fade, easing: "ease-in", fill: "forwards", id: MOTION });
  }
  for (const [el, end] of ends) {
    const from = outOf.get(el);
    if (from) {
      el.animate([{ height: `${from.rect.height}px`, overflow: "hidden" }, { height: end.height, overflow: "hidden" }], options);
      el.animate([{ zIndex: 2 }, { zIndex: 2 }], options); // over the cards it crosses
      continue;
    }
    const side = gapSide(el);
    el.animate(
      [
        { ...FLAT, overflow: "hidden", opacity: 0, transform: "translateY(8px)", ...(side ? { [side]: `${-gap}px` } : {}) },
        { ...end, overflow: "hidden", opacity: 1, transform: "none", ...(side ? { [side]: "0px" } : {}) },
      ],
      options,
    );
  }
  // With every card at its start the content is as tall as before the redraw, less the cuts: the scroll
  // goes back where it stood (the redraw may have clamped it), less the cuts, and what showed stays put.
  scroll.top -= cutSum();
  scrolls.set(scroller, scroll);
  scroller.scrollTop = scroll.top;
  // Measured with the folds and openings at their start: as those run, the layout carries each card
  // the rest of the way, along the same curve, so it ends where the redraw put it. A card cut, and those
  // above it, came down with the scroll: they start from there.
  /** @param {DOMRect} rect */
  const scrolled = (rect) => {
    const by = cuts.reduce((sum, c) => (rect.top <= c.top + 0.5 ? sum + c.cut : sum), 0);
    return by ? new DOMRect(rect.x, rect.y + by, rect.width, rect.height) : rect;
  };
  /** @type {[HTMLElement, DOMRect][]} */
  const moves = [];
  for (const el of now) {
    const old = was.get(el) ?? outOf.get(el)?.rect;
    if (old) moves.push([el, scrolled(old)]);
  }
  const starts = moves.map(([el]) => el.getBoundingClientRect());
  moves.forEach(([el, old], i) => slide(el, old, starts[i], t));
}

/**
 * @param {{ list: Element, was: Map<HTMLElement, DOMRect>, now: HTMLElement[], added: HTMLElement[] }} change
 * @param {{ el: HTMLElement, rect: DOMRect }[]} leaving @param {Tokens} t
 */
function animateGrid({ list, was, now, added }, leaving, t) {
  for (const el of now) stop(el);
  const box = list.getBoundingClientRect();
  for (const g of leaving) {
    leave(g.el);
    list.insertBefore(g.el, list.firstChild); // first, so the cards moving over it paint above it
    Object.assign(g.el.style, {
      position: "absolute",
      margin: "0",
      top: `${g.rect.top - box.top - list.clientTop + list.scrollTop}px`,
      left: `${g.rect.left - box.left - list.clientLeft + list.scrollLeft}px`,
      width: `${g.rect.width}px`,
      height: `${g.rect.height}px`,
    });
    const fade = g.el.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(.96)" }], { duration: t.fade, easing: "ease-in", fill: "forwards", id: MOTION });
    fade.onfinish = fade.oncancel = () => g.el.remove();
  }
  for (const el of added) el.animate([{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "none" }], { duration: t.move, easing: t.easing, id: MOTION });
  const kept = now.filter((el) => was.has(el));
  const starts = kept.map((el) => el.getBoundingClientRect());
  kept.forEach((el, i) => slide(el, /** @type {DOMRect} */ (was.get(el)), starts[i], t));
}

/** Ends at once every movement under `scope`: gone cards leave, the rest stand where the layout puts them. @param {Element} scope */
export function stopLists(scope) {
  for (const a of scope.getAnimations({ subtree: true })) if (a.id === MOTION) a.cancel();
}

/** A card on its way out: not focusable, not clickable, not read aloud, left alone by the redraws. @param {HTMLElement} el */
function leave(el) {
  stop(el);
  el.setAttribute("data-leaving", "");
  el.setAttribute("aria-hidden", "true");
  el.inert = true;
}

/** From where it was to where it is, as a transform added to its own. @param {HTMLElement} el @param {DOMRect} from @param {DOMRect | undefined} to @param {Tokens} t */
function slide(el, from, to, t) {
  if (!to) return;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
  el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }], { duration: t.move, easing: t.easing, composite: "add", id: MOTION });
  // A card moving up passes the ones making room for it: it goes over them, not under.
  if (dy > 0.5) el.animate([{ zIndex: 1 }, { zIndex: 1 }], { duration: t.move, id: MOTION });
}

/** An element just added to a column (a toast): it opens from no height, so the ones beside it glide. @param {HTMLElement} el */
export function grow(el) {
  const list = el.parentElement;
  if (reducedMotion() || !list) return;
  const t = tokens();
  const side = gapSide(el);
  const gap = gapOf(list);
  el.animate(
    [
      { ...FLAT, ...(side ? { [side]: `${-gap}px` } : {}) },
      { ...tall(el), ...(side ? { [side]: "0px" } : {}) },
    ],
    { duration: t.move, easing: t.easing, id: MOTION },
  );
}

/** Something that comes into a place already shown (a question into a conversation, a bubble at the screen's edge): it rises in from `dy` px off. @param {Element} el @param {number} [dy] */
export function arrive(el, dy = 10) {
  if (reducedMotion()) return;
  const t = tokens();
  el.animate([{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, transform: "none" }], { duration: t.move, easing: t.easing, id: MOTION });
}

/**
 * Shrinks `el` into `to` (where what it showed now lives), or fades it where it is when there is
 * nowhere to go. Returns the animation, or null when nothing moves (reduced motion).
 * @param {HTMLElement} el @param {Element | null} to
 */
export function retreat(el, to) {
  if (reducedMotion()) return null;
  const t = tokens();
  for (const a of el.getAnimations()) if (a.id === MOTION) a.cancel();
  const from = el.getBoundingClientRect();
  const at = to?.getClientRects().length ? to.getBoundingClientRect() : null;
  const end = at
    ? { opacity: 0, transform: `translate(${at.left + at.width / 2 - (from.left + from.width / 2)}px, ${at.top + at.height / 2 - (from.top + from.height / 2)}px) scale(.12)` }
    : { opacity: 0, transform: "scale(.96)" };
  return el.animate([{ opacity: 1, transform: "none" }, end], { duration: at ? t.move : t.fade, easing: "ease-in", fill: "forwards", id: MOTION });
}

/** What replaces a placeholder fades in, rather than appearing in one frame. @param {(Element | null)[]} els */
export function fadeIn(...els) {
  if (reducedMotion()) return;
  const t = tokens();
  for (const el of els) el?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: t.fade, easing: t.easing, id: MOTION });
}

/** A short double bump, the one loud cue of the header. @param {Element} el */
export function bump(el) {
  if (reducedMotion()) return;
  for (const a of el.getAnimations()) if (a.id === "bump") a.cancel();
  el.animate([{ transform: "scale(1)" }, { transform: "scale(1.08)", offset: 0.3 }, { transform: "scale(1)" }], { duration: 500, iterations: 2, easing: "ease-out", id: "bump" });
}
