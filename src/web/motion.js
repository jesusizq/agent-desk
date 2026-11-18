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
/**
 * Where a scroll area stood before a redraw, where it starts showing, and what its cards lose at once
 * above its top (each cut at its top before the redraw), the scroll going up as much.
 * @typedef {{ top: number, edge: number, cuts: { top: number, cut: number }[] }} Scroll
 */
/** @typedef {{ el: HTMLElement, rect: DOMRect }} Seen */

/** @type {WeakSet<Animation>} the slides of cards from where they showed, which a later redraw restarts from where they are */
const slides = new WeakSet();
/** @type {WeakMap<Element, Animation[]>} what a redraw under a scope slid in the content of its scroll areas, which may lie outside it */
const shifts = new WeakMap();

/** Whether an element scrolls its content: it may, and it has more than it shows. @param {Element} e */
function scrolls(e) {
  const y = getComputedStyle(e).overflowY;
  return (y === "auto" || y === "scroll") && e.scrollHeight > e.clientHeight;
}
/** The element whose scroll carries a list: the first one up that scrolls, else the document (a phone's). @param {Element} el */
function scrollerOf(el) {
  for (let e = /** @type {Element | null} */ (el); e && e !== document.body && e !== document.documentElement; e = e.parentElement) if (scrolls(e)) return e;
  return document.scrollingElement ?? document.documentElement;
}
/** The element whose children a scroll area's scroll carries: the body, for the document's. @param {Element} scroller */
const holderOf = (scroller) => (scroller === document.scrollingElement ? document.body : scroller);
/** What shows over the page: an open dialog or popover, out of the scroll of what lies under it. */
const OVER = ":modal, :popover-open";
/** Where a scroll area starts showing its content, in the window. @param {Element} scroller */
const viewTop = (scroller) => (scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top + scroller.clientTop);
/**
 * What a scroll area's scroll carries: the boxes of its children, those of a child without a box of its own
 * (`display: contents`, as a phone's #view) included, not those fixed to the window or over the page.
 * @param {Element} scroller
 */
function contentOf(scroller) {
  /** @type {HTMLElement[]} */
  const boxes = [];
  /** @param {Element} parent */
  const walk = (parent) => {
    for (const el of parent.children) {
      if (!(el instanceof HTMLElement)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "contents") walk(el);
      else if (shown(el) && cs.position !== "fixed" && !el.matches(OVER)) boxes.push(el);
    }
  };
  walk(holderOf(scroller));
  return boxes;
}

/** The dialog or popover over the page that holds `el`, if any. @param {Element} el */
const layerOf = (el) => el.closest(OVER);
/**
 * Whether a scroll area's scroll carries `el`: inside it, with no area between them that scrolls it instead
 * (a desktop column's own, within the document), and not in a layer over the page (an open session panel
 * over a phone's page) unless the area is too.
 * @param {Element} scroller @param {Element} el
 */
function carries(scroller, el) {
  if (!holderOf(scroller).contains(el) || layerOf(el) !== layerOf(scroller)) return false;
  for (let e = el.parentElement; e && e !== scroller && e !== document.body; e = e.parentElement) if (scrolls(e)) return false;
  return true;
}

/**
 * How far each scroll area can scroll once every motion has ended: measured with the motions of what it
 * carries taken off and its cards on their way out hidden, then all put back, and the scrolls the measure
 * clamped with it, before anything is painted. What the areas do not carry is left alone: restoring a
 * scroll ends any smooth scroll it was in, the developer's own in a panel.
 * @param {Element[]} scrollers @param {Animation[]} animations the page's
 */
function finalReaches(scrollers, animations) {
  /** @param {Element} el */
  const carried = (el) => scrollers.some((s) => carries(s, el));
  const running = animations.flatMap((a) => (a.id === MOTION && a.effect instanceof KeyframeEffect && a.effect.target && carried(a.effect.target) ? [{ effect: a.effect, target: a.effect.target }] : []));
  const leaving = [...document.querySelectorAll("[data-leaving]")].filter(/** @returns {el is HTMLElement} */ (el) => el instanceof HTMLElement && carried(el));
  /** @type {Set<Element>} */
  const areas = new Set(scrollers);
  for (const el of [...running.map((r) => r.target), ...leaving]) for (let e = /** @type {Element | null} */ (el); e; e = e.parentElement) if (e.scrollTop || e.scrollLeft) areas.add(e);
  const scrolled = [...areas].map((e) => ({ e, top: e.scrollTop, left: e.scrollLeft }));
  const display = leaving.map((el) => ({ el, value: el.style.getPropertyValue("display"), priority: el.style.getPropertyPriority("display") }));
  try {
    for (const { effect } of running) effect.target = null;
    for (const el of leaving) el.style.setProperty("display", "none", "important");
    return new Map(scrollers.map((s) => [s, s.scrollHeight - s.clientHeight]));
  } finally {
    // Also when the measure fails: no motion is left off its element, no card hidden, no scroll clamped.
    for (const { el, value, priority } of display) el.style.setProperty("display", value, priority);
    for (const { effect, target } of running) effect.target = target;
    for (const { e, top, left } of scrolled) Object.assign(e, { scrollTop: top, scrollLeft: left });
  }
}

/** @param {Element} el */
const shown = (el) => el.getClientRects().length > 0;
/** The cards of a list: its children with a key, not those on their way out. @param {Element} list */
const itemsOf = (list) => [...list.children].filter(/** @returns {el is HTMLElement} */ (el) => el instanceof HTMLElement && el.dataset.key !== undefined && !el.hasAttribute("data-leaving"));
/** The cards of a list still on their way out from an earlier redraw. @param {Element} list */
const leftoversOf = (list) => [...list.children].filter(/** @returns {el is HTMLElement} */ (el) => el instanceof HTMLElement && el.hasAttribute("data-leaving") && shown(el));
/** Two places differ, by more than rounding. @param {DOMRect} a @param {DOMRect} b */
const differ = (a, b) => Math.abs(a.left - b.left) > 0.5 || Math.abs(a.top - b.top) > 0.5 || Math.abs(a.height - b.height) > 0.5;
/** What a card shows, whatever its shape: a question's row and its large card share it. @param {HTMLElement} el */
const flipId = (el) => el.dataset.flip ?? el.dataset.key ?? "";
/** All a scroll area's cards lost at once above its top. @param {Scroll} scroll */
const cutTotal = (scroll) => scroll.cuts.reduce((sum, c) => sum + c.cut, 0);
/** Where a card that showed at `rect` before the redraw shows once its scroll area lost its cuts: one cut, and those above it, came down with the scroll. @param {Scroll} scroll @param {DOMRect} rect */
function cutAbove(scroll, rect) {
  const by = scroll.cuts.reduce((sum, c) => (rect.top <= c.top + 0.5 ? sum + c.cut : sum), 0);
  return by ? new DOMRect(rect.x, rect.y + by, rect.width, rect.height) : rect;
}
/** @param {Element} el */
const stop = (el) => {
  for (const a of el.getAnimations()) if (a.id === MOTION) a.cancel();
};
/** A card on its way out keeps folding and fading: only its slide stops, to start again from where it is. @param {Element} el */
const unslide = (el) => {
  for (const a of el.getAnimations()) if (slides.has(a)) a.cancel();
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
  /** @param {HTMLElement} el @returns {Seen} */
  const seen = (el) => ({ el, rect: el.getBoundingClientRect() });
  const before = lists.map((list) => ({ list, scroller: scrollerOf(list), items: itemsOf(list).filter(shown).map(seen), leftovers: leftoversOf(list).map(seen) }));
  /** @type {Map<Element, Scroll>} */
  const scrolls = new Map(before.map(({ scroller }) => [scroller, { top: scroller.scrollTop, edge: viewTop(scroller), cuts: [] }]));
  /** @type {Map<Element, number>} */
  const grows = new Map([...scope.querySelectorAll("[data-grow]")].map((el) => [el, el.getBoundingClientRect().height]));
  /** @type {Map<Element, DOMRect>} */
  const glides = new Map([...scope.querySelectorAll("[data-glide]")].map((el) => [el, el.getBoundingClientRect()]));
  update();
  /** @type {Map<string, Seen & { list: Element }>} cards no longer in their list, by what they show */
  const gone = new Map();
  for (const { list, items } of before) for (const it of items) if (it.el.parentElement !== list) gone.set(flipId(it.el), { ...it, list });
  const changes = before
    .filter(({ list }) => list.isConnected && shown(list))
    .map(({ list, scroller, items, leftovers }) => {
      const was = new Map(items.map((it) => [it.el, it.rect]));
      const now = itemsOf(list);
      return { list, scroller, grid: getComputedStyle(list).display === "grid", items, was, now, added: now.filter((el) => !was.has(el)), leftovers: leftovers.filter((it) => it.el.parentElement === list) };
    });
  const columns = [...new Set(changes.filter((c) => !c.grid).map((c) => c.scroller))];
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
  /** @type {(() => void)[]} each list's slides, measured once every list is at its start */
  const slidesOf = [];
  /** @type {Set<Element>} */
  const scrolling = new Set();
  /** @type {Animation[]} what runs before the columns move, taken only for a redraw that moves one: it forces a style pass */
  let earlier = [];
  /** @type {Map<Element, number> | null} measured only for a redraw that moves a column: it forces a layout */
  let reaches = null;
  for (const change of changes) {
    const leaving = change.items.filter((it) => it.el.parentElement !== change.list && gone.get(flipId(it.el))?.el === it.el);
    const moved = [...change.now.map((el) => ({ el, rect: change.was.get(el) })), ...change.leftovers].some(({ el, rect }) => rect && differ(rect, el.getBoundingClientRect()));
    // A redraw that changed nothing here leaves what is still moving alone.
    if (!change.added.length && !leaving.length && !moved) continue;
    const scroll = /** @type {Scroll} */ (scrolls.get(change.scroller));
    if (change.grid) slidesOf.push(animateGrid(change, leaving, scroll, t));
    else {
      // Before any column's motion starts: an earlier column's folds back at their height would count, and
      // be started again. A grid's motions may be in by then: none changes a height.
      if (!reaches) {
        earlier = document.getAnimations();
        reaches = finalReaches(columns, earlier);
      }
      slidesOf.push(animateColumn(change, leaving, outOf, grows, scroll, t));
      scrolling.add(change.scroller);
    }
  }
  for (const scroller of scrolling) retime(earlier, scroller, t);
  // With every card at its start the content is as tall as before the redraw, less the cuts: each scroll goes
  // back where it stood (the redraw may have clamped it), less the cuts, and what showed stays put.
  for (const scroller of scrolling) {
    const scroll = /** @type {Scroll} */ (scrolls.get(scroller));
    scroller.scrollTop = scroll.top - cutTotal(scroll);
  }
  for (const slide of slidesOf) slide();
  glide(scope, glides, t);
  for (const scroller of scrolling) shift(scope, scroller, reaches?.get(scroller) ?? Infinity, t);
}

const TIMING = new Set(["offset", "computedOffset", "easing", "composite"]);
/** @type {WeakMap<Animation, number>} when the change of height a redraw started again first started, on the document's timeline */
const origins = new WeakMap();
/**
 * Every change of height an earlier redraw started in a scroll area (a card still folding away) starts again
 * from where it is, with this redraw's: on one curve from one start, the area's content grows or shrinks
 * steadily to its end, where one ending first while another just starts would dip below the scroll, and
 * the browser would pull it down mid-way. Never past two lengths from its first start, however many redraws
 * follow (a burst of the event stream): a card on its way out leaves by then. What holds the element's
 * stacking while it changes goes on as long; each keeps its play state.
 * @param {Animation[]} earlier the animations running before this redraw's @param {Element} scroller @param {Tokens} t
 */
function retime(earlier, scroller, t) {
  const now = Number(document.timeline.currentTime ?? performance.now());
  const ours = earlier.flatMap((a) => {
    const effect = a.effect;
    const el = effect instanceof KeyframeEffect ? effect.target : null;
    const end = effect instanceof KeyframeEffect ? effect.getKeyframes().at(-1) : undefined;
    const live = a.playState === "running" || a.playState === "paused";
    return a.id === MOTION && live && effect instanceof KeyframeEffect && el && end && carries(scroller, el) ? [{ a, effect, el, end }] : [];
  });
  const changing = new Set(ours.filter(({ end }) => "height" in end).map(({ el }) => el));
  for (const { a, effect, el, end } of ours) {
    if (!changing.has(el) || !("height" in end || "zIndex" in end)) continue;
    const origin = origins.get(a) ?? now - Number(a.currentTime ?? 0);
    const duration = Math.min(t.move, origin + 2 * t.move - now);
    if (duration <= 0) continue;
    const props = Object.keys(end).filter((k) => !TIMING.has(k));
    const style = getComputedStyle(el);
    /** @param {string} prop */
    const value = (prop) => style.getPropertyValue(prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
    const from = Object.fromEntries(props.map((p) => [p, value(p)]));
    const to = Object.fromEntries(props.map((p) => [p, end[p]]));
    const paused = a.playState === "paused";
    const next = el.animate([from, to], { duration, easing: t.easing, fill: effect.getTiming().fill, id: MOTION });
    origins.set(next, origin);
    if (paused) next.pause();
    Object.assign(next, { onfinish: a.onfinish, oncancel: a.oncancel });
    Object.assign(a, { onfinish: null, oncancel: null });
    a.cancel();
  }
}

/**
 * What is left ending above its scroll area's bottom, the browser would pull the scroll down mid-way, in
 * whole pixels as the cards shrink by fractions, and all below would shake: the scroll goes where it ends
 * at once, and all it carries slides down from where it showed, along the cards' curve.
 * @param {Element} scope @param {Element} scroller @param {number} reach how far it scrolls once the motion ends @param {Tokens} t
 */
function shift(scope, scroller, reach, t) {
  const from = scroller.scrollTop;
  if (from - reach <= 0.5) return;
  scroller.scrollTop = reach;
  const by = from - scroller.scrollTop;
  const running = (shifts.get(scope) ?? []).filter((a) => a.playState === "running" || a.playState === "paused");
  for (const el of contentOf(scroller)) {
    running.push(el.animate([{ transform: `translateY(${-by}px)` }, { transform: "translateY(0px)" }], { duration: t.move, easing: t.easing, composite: "add", id: MOTION }));
  }
  shifts.set(scope, running);
}

/**
 * The parts of a layout outside its lists, marked `data-glide` (a column's head and foot), follow its
 * new shape: each slides from where it was (or lands, when it crossed to another column), and one that
 * a redraw of the same layout added fades in. Never inside a list's card, which carries them already.
 * @param {Element} scope @param {Map<Element, DOMRect>} before where each stood before the redraw @param {Tokens} t
 */
function glide(scope, before, t) {
  for (const el of scope.querySelectorAll("[data-glide]")) {
    if (!(el instanceof HTMLElement) || !shown(el)) continue;
    const was = before.get(el);
    if (!was) {
      if (before.size) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: t.fade, easing: t.easing, id: MOTION });
      continue;
    }
    if (!was.width && !was.height) continue; // not shown before (a phone's other tab): it appears, it does not travel
    stop(el);
    const now = el.getBoundingClientRect();
    if (Math.abs(was.left - now.left) < 0.5 && Math.abs(was.top - now.top) < 0.5) continue;
    // Across to another column it would pass over what lies between: it lands there, as the cards do.
    if (apart(was, now)) land(el, was, now, t);
    else {
      slide(el, was, now, t);
      // Pushed along by the cards of a column that grew into its place, it passes under them.
      el.animate([{ zIndex: -1 }, { zIndex: -1 }], { duration: t.move, id: MOTION });
    }
  }
}

/** @typedef {{ list: Element, items: Seen[], was: Map<HTMLElement, DOMRect>, now: HTMLElement[], added: HTMLElement[], leftovers: Seen[] }} Change */

/**
 * Starts a column's folds, openings and changes of height, and returns its slides, to run once every
 * list is at its start and the scroll back where it stood.
 * @param {Change} change @param {Seen[]} leaving @param {Map<HTMLElement, Seen>} outOf
 * @param {Map<Element, number>} grows the heights of the `data-grow` blocks before the redraw
 * @param {Scroll} scroll where its scroll area stood before the redraw @param {Tokens} t
 */
function animateColumn({ list, items, was, now, added, leftovers }, leaving, outOf, grows, scroll, t) {
  for (const el of now) stop(el);
  for (const { el } of leftovers) unslide(el);
  const gap = gapOf(list);
  // A card that shrinks or folds from above the top of its scroll area loses its hidden part at once, the
  // scroll going up as much: the motion starts from what shows, and the browser never clamps the scroll
  // mid-way (the rows below would jump, the card's content scroll back).
  const { cuts } = scroll;
  /** @param {DOMRect} rect @param {number} want */
  const cutOf = (rect, want) => {
    const cut = Math.min(want, scroll.top - cutTotal(scroll));
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
    list.insertBefore(g.el, after.find((el) => el?.parentElement === list) ?? null);
    leave(g.el); // back in the page first: out of it, an element lists none of its animations, which would go on
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
  // Measured with the folds and openings at their start: as those run, the layout carries each card
  // the rest of the way, along the same curve, so it ends where the redraw put it. A card cut, and those
  // above it, came down with the scroll: they start from there. A card leaving, now or since an earlier
  // redraw, goes along with its neighbours from where it showed.
  return () => {
    /** @type {[HTMLElement, DOMRect, boolean][]} */
    const moves = [];
    for (const el of now) {
      const old = was.get(el) ?? outOf.get(el)?.rect;
      if (old) moves.push([el, cutAbove(scroll, old), false]);
    }
    for (const { el, rect } of [...folding, ...leftovers]) moves.push([el, cutAbove(scroll, rect), true]);
    const starts = moves.map(([el]) => el.getBoundingClientRect());
    moves.forEach(([el, old, out], i) => {
      if (!cameFromAside(old, list)) slide(el, old, starts[i], t);
      else if (!out) land(el, old, starts[i], t); // one leaving goes on with its fold, never fading back in
    });
  };
}

/**
 * Starts a grid's fades, and returns its slides, to run once every list is at its start.
 * @param {Change} change @param {Seen[]} leaving @param {Scroll} scroll where its scroll area stood before the redraw @param {Tokens} t
 */
function animateGrid({ list, was, now, added, leftovers }, leaving, scroll, t) {
  for (const el of now) stop(el);
  for (const { el } of leftovers) unslide(el);
  const box = list.getBoundingClientRect();
  for (const g of leaving) {
    list.insertBefore(g.el, list.firstChild); // first, so the cards moving over it paint above it
    leave(g.el); // once back in the page, where its animations are found
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
  return () => {
    // A card of a column sharing its scroll was cut: what lies above the cut came down with the scroll.
    const kept = now.filter((el) => was.has(el));
    const starts = kept.map((el) => el.getBoundingClientRect());
    kept.forEach((el, i) => {
      const old = cutAbove(scroll, /** @type {DOMRect} */ (was.get(el)));
      if (cameFromAside(old, list)) land(el, old, starts[i], t);
      else slide(el, old, starts[i], t);
    });
    // One still fading from an earlier redraw stays where its neighbours showed it.
    const gone = leftovers.filter(({ rect }) => !cameFromAside(rect, list)).map(({ el, rect }) => ({ el, from: cutAbove(scroll, rect), to: el.getBoundingClientRect() }));
    for (const { el, from, to } of gone) slide(el, from, to, t);
  };
}

/**
 * A card whose list moved to another column (the board changed shape): where it was shares no width with
 * the box that clips it now (its list or its column), which would hide the whole of its way there.
 * @param {DOMRect} from @param {Element} list
 */
function cameFromAside(from, list) {
  for (let e = /** @type {Element | null} */ (list); e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    if (getComputedStyle(e).overflowX !== "visible") return apart(from, e.getBoundingClientRect());
  }
  return false;
}
/** Side by side, sharing no width: a move from one to the other crosses columns. @param {DOMRect} a @param {DOMRect} b */
const apart = (a, b) => a.right <= b.left + 0.5 || a.left >= b.right - 0.5;

/** What crossed to another column fades in where it lands, from a little on the side it came from. @param {HTMLElement} el @param {DOMRect} from @param {DOMRect | undefined} to @param {Tokens} t */
function land(el, from, to, t) {
  const dx = to ? Math.sign(from.left - to.left) * 16 : 0;
  el.animate([{ transform: `translateX(${dx}px)` }, { transform: "translateX(0px)" }], { duration: t.move, easing: t.easing, composite: "add", id: MOTION });
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: t.move, easing: t.easing, id: MOTION });
}

/**
 * Ends at once every movement under `scope`, and the slides its redraws started outside it (a phone's header
 * carried with the page): gone cards leave, the rest stand where the layout puts them.
 * @param {Element} scope
 */
export function stopLists(scope) {
  for (const a of scope.getAnimations({ subtree: true })) if (a.id === MOTION) a.cancel();
  for (const a of shifts.get(scope) ?? []) a.cancel();
  shifts.delete(scope);
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
  slides.add(el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }], { duration: t.move, easing: t.easing, composite: "add", id: MOTION }));
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
