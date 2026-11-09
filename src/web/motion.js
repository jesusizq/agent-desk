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
  const before = lists.map((list) => ({ list, items: itemsOf(list).filter(shown).map((el) => ({ el, rect: el.getBoundingClientRect() })) }));
  update();
  /** @typedef {{ el: HTMLElement, rect: DOMRect }} Seen */
  /** @type {Map<string, Seen & { list: Element }>} cards no longer in their list, by what they show */
  const gone = new Map();
  for (const { list, items } of before) for (const it of items) if (it.el.parentElement !== list) gone.set(flipId(it.el), { ...it, list });
  const changes = before
    .filter(({ list }) => list.isConnected && shown(list))
    .map(({ list, items }) => {
      const was = new Map(items.map((it) => [it.el, it.rect]));
      const now = itemsOf(list);
      return { list, items, was, now, added: now.filter((el) => !was.has(el)) };
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
    else animateColumn(change, leaving, outOf, t);
  }
}

/**
 * @param {{ list: Element, items: { el: HTMLElement, rect: DOMRect }[], was: Map<HTMLElement, DOMRect>, now: HTMLElement[], added: HTMLElement[] }} change
 * @param {{ el: HTMLElement, rect: DOMRect }[]} leaving @param {Map<HTMLElement, { el: HTMLElement, rect: DOMRect }>} outOf @param {Tokens} t
 */
function animateColumn({ list, items, was, now, added }, leaving, outOf, t) {
  for (const el of now) stop(el);
  // Gone cards come back for the length of their exit, where they were among the others.
  for (const g of [...leaving].reverse()) {
    const after = items.slice(items.indexOf(g) + 1).map((it) => (it.el.parentElement === list ? it.el : [...outOf].find(([, o]) => o.el === it.el)?.[0]));
    leave(g.el);
    list.insertBefore(g.el, after.find((el) => el?.parentElement === list) ?? null);
  }
  const gap = gapOf(list);
  const ends = new Map(added.map((el) => [el, tall(el)]));
  const options = { duration: t.move, easing: t.easing, id: MOTION };
  // A card that stays but grows or shrinks (answered, a line more) changes height along the same curve.
  for (const el of now) {
    const old = was.get(el);
    const height = el.getBoundingClientRect().height;
    if (old && Math.abs(old.height - height) > 0.5) el.animate([{ height: `${old.height}px`, overflow: "hidden" }, { height: `${height}px`, overflow: "hidden" }], options);
  }
  for (const g of leaving) {
    const side = gapSide(g.el);
    const fold = g.el.animate(
      [
        { ...tall(g.el, g.rect.height), overflow: "hidden", ...(side ? { [side]: "0px" } : {}) },
        { ...FLAT, overflow: "hidden", ...(side ? { [side]: `${-gap}px` } : {}) },
      ],
      options,
    );
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
  // Measured with the folds and openings at their start: as those run, the layout carries each card
  // the rest of the way, along the same curve, so it ends where the redraw put it.
  /** @type {[HTMLElement, DOMRect][]} */
  const moves = [];
  for (const el of now) {
    const old = was.get(el) ?? outOf.get(el)?.rect;
    if (old) moves.push([el, old]);
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
