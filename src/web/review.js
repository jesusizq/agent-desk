// @ts-check
// Reviews: a page a session made for the developer to review, published to the desk. It opens filling
// the window in a sandboxed frame, under a slim bar; what the page saves goes to the desk, so the
// review goes on from any device, days later, and its answers are sent to the session from here.
import { dialog, h, icon, isLocalPreview, patch, REVIEWS_KEY } from "./dom.js";
import { TEXT } from "./text.js";
import { ago, dayLabel } from "./format.js";
import { armedButton } from "./control.js";
import { localLink, projectMark, shortUrl, toast } from "./pieces.js";
import { DeskError, getJson, OfflineError, post, postJson, refresh, run, unlockEnded } from "./server.js";
import { data, ID, isLive, label, ON_THIS_MACHINE, page, projectColor, S, takesMessages, ui } from "./state.js";

/** @typedef {import("../core/protocol.ts").Review} Review */
/** `options`: what the options marked in the page read as, built by the desk (src/core/options.ts). @typedef {{ data: Record<string, string>, summary?: string, options?: string, rev: number }} Saved */
/** @typedef {{ op: "set", key: string, value: string } | { op: "remove", key: string } | { op: "clear" }} Op */
/**
 * What the page changed and the desk has not saved yet: a clear first, then the last change of each key
 * (the desk keeps the last write of a key, so earlier ones need not travel).
 * @typedef {{ clear: boolean, keys: Map<string, string | null>, progress?: string, summary?: string }} Pending
 */

// The desk's limits on what a review saves (REVIEW_*_MAX in protocol.ts), checked before anything travels.
const KEY_MAX = 200;
const STATE_MAX = 2 * 1024 * 1024;
const SUMMARY_MAX = 200 * 1024;
const PROGRESS_MAX = 200;
const NOTICE_MAX = 500;
/** A link the page asks the desk to open (localUrl in check.ts). */
const URL_MAX = 2000;
/** The developer's note sent with a review (REVIEW_NOTE_MAX in protocol.ts). */
const NOTE_MAX = 4096;
/** The page's changes travel together, at most this often. */
const BATCH_MS = 400;
/** How long Send waits for the page to hand over its answers before the sheet opens without them. */
const COLLECT_MS = 250;
/** Untouched this long, a review open says so, calmly. */
const UNTOUCHED_MS = 2 * 24 * 3600_000;

/** @param {string} id */
const R = (id) => data.reviews.find((r) => r.id === id);
/** @param {{ done: number, total: number } | undefined} p */
const countOf = (p) => (p ? TEXT.review.count(p.done, p.total) : TEXT.review.notStarted);
/** @param {{ done: number, total: number } | undefined} p */
const percentOf = (p) => (p && p.total > 0 ? Math.min(100, Math.round((100 * p.done) / p.total)) : 0);
/** The counter's text as numbers, as the desk reads it: "12/97", "12 of 97", "12 de 97". @param {string} text */
function parseProgress(text) {
  const m = /(\d+)\s*(?:\/|of|de)\s*(\d+)/i.exec(text);
  return m ? { done: Number(m[1]), total: Number(m[2]) } : undefined;
}
/** When the developer last did something with it: a change, else its latest round. @param {Review} r */
export const touchedAt = (r) => [r.updatedAt, r.rounds.at(-1)?.at, r.openedAt].filter((x) => typeof x === "string").sort().at(-1) ?? "";
/** Open and left alone for two days or more. @param {Review} r */
export const untouched = (r) => !r.closedAt && Date.now() - Date.parse(touchedAt(r)) >= UNTOUCHED_MS;
/** The other device, as the desk tells them apart. */
const otherDevice = () => (ON_THIS_MACHINE ? "phone" : "computer");

// ---------- Kept on this device ----------

/** @typedef {{ ops?: Op[], progress?: string, summary?: string, at?: number, raw?: number }} Kept */
/** @returns {Record<string, Kept>} */
function kept() {
  const raw = localStorage.getItem(REVIEWS_KEY);
  if (raw === null) return {};
  try {
    const v = /** @type {unknown} */ (JSON.parse(raw));
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
    return /** @type {Record<string, Kept>} */ (Object.fromEntries(Object.entries(v).filter(([id]) => ID.test(id))));
  } catch (error) {
    localStorage.removeItem(REVIEWS_KEY);
    toast(TEXT.pageError(`saved review changes unreadable, dropped: ${/** @type {Error} */ (error).message}`));
    return {};
  }
}
/** @param {string} id @param {(k: Kept) => Kept} change */
function keep(id, change) {
  if (unlockEnded) return; // the reload to the PIN page must not write them back
  const all = kept();
  const next = change(all[id] ?? {});
  if (Object.values(next).some((v) => v !== undefined)) all[id] = next;
  else delete all[id];
  if (Object.keys(all).length) localStorage.setItem(REVIEWS_KEY, JSON.stringify(all));
  else localStorage.removeItem(REVIEWS_KEY);
}
/** @param {Pending} p @returns {Op[]} */
const opsOf = (p) => [...(p.clear ? [/** @type {Op} */ ({ op: "clear" })] : []), ...[...p.keys].map(([key, value]) => /** @type {Op} */ (value === null ? { op: "remove", key } : { op: "set", key, value }))];
/** @param {Kept} k @returns {Pending | undefined} */
function pendingOf(k) {
  if (!k.ops?.length && k.progress === undefined && k.summary === undefined) return undefined;
  /** @type {Pending} */
  const p = { clear: false, keys: new Map() };
  for (const o of k.ops ?? []) {
    if (o.op === "clear") ((p.clear = true), p.keys.clear());
    else if (o.op === "set" && typeof o.key === "string" && typeof o.value === "string") p.keys.set(o.key, o.value);
    else if (o.op === "remove" && typeof o.key === "string") p.keys.set(o.key, null);
  }
  if (typeof k.progress === "string") p.progress = k.progress;
  if (typeof k.summary === "string") p.summary = k.summary;
  return p;
}
/** `later` on top of `earlier`. @param {Pending} earlier @param {Pending} later @returns {Pending} */
function combine(earlier, later) {
  const keys = later.clear ? new Map(later.keys) : new Map([...earlier.keys, ...later.keys]);
  return { clear: earlier.clear || later.clear, keys, progress: later.progress ?? earlier.progress, summary: later.summary ?? earlier.summary };
}

// ---------- Saving to the desk ----------

/** @type {Map<string, Pending>} changes of each review waiting to travel */
const pending = new Map();
for (const [id, k] of Object.entries(kept())) {
  const p = pendingOf(k);
  if (p) pending.set(id, p);
}
/** @type {Set<string>} reviews whose changes are on their way */
const flying = new Set();
/** @type {Map<string, number>} */
const timers = new Map();
/** @type {Map<string, "saving" | "saved" | "kept" | { error: string }>} */
const status = new Map();

/** @param {string} id @param {Pending} change */
function queue(id, change) {
  const p = combine(pending.get(id) ?? { clear: false, keys: new Map() }, change);
  pending.set(id, p);
  keep(id, (k) => ({ ...k, ops: opsOf(p), progress: p.progress, summary: p.summary }));
  status.set(id, "saving");
  paintBar();
  clearTimeout(timers.get(id));
  timers.set(id, window.setTimeout(() => void flush(id), BATCH_MS));
}

/**
 * Sends what waits for one review. Offline it stays on this device and goes when the desk answers;
 * refused, it is dropped and the bar says why (it would be refused again).
 * @param {string} id
 */
async function flush(id) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const p = pending.get(id);
  if (!p || flying.has(id)) return;
  pending.delete(id);
  flying.add(id);
  try {
    const reply = await postJson(`/api/reviews/${id}/state`, { ops: opsOf(p), ...(p.progress !== undefined ? { progress: p.progress } : {}), ...(p.summary !== undefined ? { summary: p.summary } : {}) });
    if (typeof (/** @type {{ rev?: unknown }} */ (reply).rev) !== "number") throw new Error(`the desk saved the review but gave no revision (${JSON.stringify(reply)})`);
    status.set(id, pending.has(id) ? "saving" : "saved");
    if (!pending.has(id)) keep(id, (k) => ({ ...k, ops: undefined, progress: undefined, summary: undefined }));
  } catch (error) {
    if (error instanceof OfflineError) {
      const back = combine(p, pending.get(id) ?? { clear: false, keys: new Map() });
      pending.set(id, back);
      keep(id, (k) => ({ ...k, ops: opsOf(back), progress: back.progress, summary: back.summary }));
      status.set(id, "kept");
    } else {
      const why = /** @type {Error} */ (error).message;
      status.set(id, { error: why });
      toast(TEXT.review.notSaved(why));
      keep(id, (k) => ({ ...k, ops: pending.has(id) ? k.ops : undefined, progress: undefined, summary: undefined }));
    }
  } finally {
    flying.delete(id);
  }
  paintBar();
  if (pending.has(id) && status.get(id) !== "kept") await flush(id);
  else await refresh(); // the review's progress, as the desk now reads it, before anything relies on it (Send's line)
}
/** Everything one review has waiting, sent now, and the desk's state fetched after. @param {string} id */
async function flushNow(id) {
  while (flying.has(id)) await new Promise((r) => setTimeout(r, 50));
  if (pending.has(id)) await flush(id);
}
/** Changes kept offline go once the desk answers again. */
export function sendKept() {
  if (ui.offline || !ui.loaded) return;
  for (const id of [...pending.keys()]) {
    if (flying.has(id) || timers.has(id)) continue;
    if (R(id)) void flush(id);
    else (pending.delete(id), keep(id, () => ({}))); // the review is gone from the desk: its changes have nowhere to go
  }
}

// ---------- The review open ----------

/**
 * `data`: the page's saved state as this page's frame has it, once `known`: what the desk holds besides
 * is another device's change. `edits`: how many changes the page made to `data`. `link`: a local preview the page
 * asked to open that the browser did not let open.
 * @typedef {{ id: string, frame: HTMLIFrameElement, known: boolean, seen: string | undefined, data: Map<string, string>, edits: number,
 *   summary: string, options: string, progress: { done: number, total: number } | undefined, sync: boolean, collecting: number, strayed: boolean,
 *   link: string | null }} Current
 */
/** @type {Current | null} */
let current = null;

/** Where this device was in a review, 0..1. @param {string} id */
const scrolledTo = (id) => {
  const at = Number(kept()[id]?.at);
  return at > 0 && at <= 1 ? at : 0;
};
/** @param {string} id */
const frameSrc = (id) => `/review/${encodeURIComponent(id)}${scrolledTo(id) ? `#at=${scrolledTo(id).toFixed(4)}` : ""}`;

/**
 * A new frame for the page: a sandbox without the desk's origin, scripts only, no referrer and no
 * permissions. A scripted page can still navigate its own frame: its one expected load is counted, and
 * a second means it went elsewhere, so the frame goes at once (`strayed`). @param {string} id
 */
function newFrame(id) {
  const frame = h("iframe", { class: "rv-frame", src: frameSrc(id), sandbox: "allow-scripts", referrerpolicy: "no-referrer", allow: "", title: TEXT.review.frameTitle });
  let loads = 0;
  frame.addEventListener("load", () => {
    if (++loads > 1 && current?.frame === frame) strayed();
  });
  return frame;
}

/** The page loaded another address in its frame: nothing of it stays, and the review can be opened again. */
function strayed() {
  if (!current) return;
  current.frame.remove();
  current.strayed = true;
  drawView();
}

/** What the desk holds of the page's saved state now. @param {string} id */
async function fetchSaved(id) {
  const v = /** @type {Saved} */ (await getJson(`/api/reviews/${id}/state`));
  if (typeof v !== "object" || v === null || typeof v.rev !== "number" || typeof v.data !== "object") throw new Error(`the desk's saved state of review ${id} is unreadable`);
  return v;
}
/** @param {Saved} saved */
function took(saved) {
  if (!current) return;
  current.known = true;
  current.data = new Map(Object.entries(saved.data));
  current.summary = saved.summary ?? "";
  current.options = saved.options ?? "";
}

/**
 * Opens a review filling the window. `fromRoute`: the page was loaded at its address (#rv=…), whose
 * entry becomes the desk's, so going back closes the review as it would have.
 * @param {string} id @param {{ fromRoute?: boolean }} [how]
 */
export function openReview(id, { fromRoute = false } = {}) {
  const r = R(id);
  if (!r || !ID.test(id)) return;
  const d = dialog("review");
  if (current?.id === id && d.open) return;
  if (current) closeFrame();
  if (fromRoute) history.replaceState(null, "", location.pathname + location.search);
  if (history.state?.review !== id) history.pushState({ review: id }, "", `#rv=${encodeURIComponent(id)}`);
  const frame = newFrame(id);
  current = { id, frame, known: false, seen: r.updatedAt, data: new Map(), edits: 0, summary: "", options: "", progress: r.progress, sync: false, collecting: 0, strayed: false, link: null };
  const shown = current;
  if (unseenRound(r)) run(post(`/api/reviews/${id}/opened`));
  drawView();
  if (!d.open) d.showModal();
  // Changes kept from before go first: the page then loads with them.
  run(
    flushNow(id).then(async () => {
      if (current !== shown) return;
      d.append(frame);
      const saved = await fetchSaved(id).catch((error) => {
        if (!(error instanceof OfflineError)) throw error;
        status.set(id, "kept"); // offline: what is done now is kept here, and saved once the desk answers
        return null;
      });
      if (current !== shown || !saved) return drawView();
      took(saved);
      drawView();
      keepForOffline(r);
    }),
  );
}

/** The page, its saved state and the shim kept by this device's service worker (sw.js), to open it offline. @param {Review} r */
function keepForOffline(r) {
  if (!navigator.serviceWorker?.controller || kept()[r.id]?.raw === r.rounds.length) return;
  const get = (/** @type {string} */ url) => fetch(url).then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`${url}: ${res.status}`))));
  run(Promise.all([get(`/review/${encodeURIComponent(r.id)}/raw`), get("/review-shim.js")]).then(() => keep(r.id, (k) => ({ ...k, raw: r.rounds.length }))));
}

/** Leaves the page: what it changed is sent, the frame emptied. */
function closeFrame() {
  if (!current) return;
  const { id, frame } = current;
  current = null;
  frame.remove();
  if (pending.has(id)) void flush(id);
}

/** The bar and the frame, drawn again: the frame is kept unless replaced (Update). */
function drawView() {
  const d = dialog("review");
  if (!current) return;
  const r = R(current.id);
  if (!r) return;
  const t = TEXT.review;
  const s = S(r.sessionId);
  const st = status.get(r.id);
  const saved = st === "saving" ? t.saving : st === "kept" ? t.offlineSaved : typeof st === "object" ? t.notSaved(st.error) : t.saved;
  const everywhere = st === undefined || st === "saved" ? (ON_THIS_MACHINE ? h("span", { class: "lbl-long" }, t.savedEverywhere) : null) : null;
  const name = projectMark(r.project.name)[1];
  const line = h("i", {});
  line.style.width = `${percentOf(current.progress ?? r.progress)}%`;
  // The bar is redrawn; the frame is only ever placed, as moving it would load the page again.
  const head = d.querySelector(":scope > .rv-head") ?? d.appendChild(h("div", { class: "rv-head" }));
  for (const f of d.querySelectorAll(":scope > iframe")) if (f !== current.frame || current.strayed) f.remove();
  const away = d.querySelector(":scope > .rv-strayed");
  if (current.strayed && !away) d.append(h("div", { class: "rv-strayed", role: "status" }, h("p", {}, t.strayed), h("button", { class: "primary", onclick: reloadPage }, t.reopen)));
  else if (!current.strayed) away?.remove();
  patch(
    head,
    h(
      "header",
      { class: "rv-bar" },
      h("button", { class: "rv-back", "aria-label": t.backTitle, title: t.backTitle, onclick: () => d.close() }, icon("back"), h("span", { class: "lbl" }, t.back)),
      h(
        "div",
        { class: "rv-name" },
        h("b", { title: r.title }, r.title),
        h(
          "span",
          { class: "rv-sub" },
          name,
          h("span", { class: "rv-dot pdot" }, "·"),
          h("span", { class: "rv-count num" }, countOf(current.progress ?? r.progress)),
          h("span", { class: "rv-dot" }, "·"),
          h("span", { class: `rv-saved${st === "saving" ? " saving" : typeof st === "object" ? " failed" : ""}`, title: saved, role: "status" }, typeof st === "object" ? icon("x") : icon("check"), h("span", {}, saved, everywhere)),
        ),
      ),
      current.sync
        ? h(
            "span",
            { class: "rv-sync", "data-key": "sync" },
            h("span", {}, t.sync(r.updatedFrom === "remote" && ON_THIS_MACHINE ? "phone" : r.updatedFrom === "local" && !ON_THIS_MACHINE ? "computer" : null)),
            h("button", { onclick: reloadPage }, t.update),
          )
        : null,
      current.link ? h("span", { class: "rv-link", "data-key": "link", title: t.linkTitle }, localLink(current.link, [h("span", {}, t.openLink(shortUrl(current.link))), icon("go")], "chip")) : null,
      r.closedAt ? null : closeButton(r, "secondary danger rv-close-bar", [icon("archive"), h("span", { class: "lbl" }, t.close)], t.closeConfirm, drawView),
      h(
        "button",
        { class: "primary rv-send", onclick: collect },
        icon("send"),
        h("span", {}, t.send, s ? h("span", { class: "lbl-long" }, t.sendTo(s.provider)) : null),
      ),
    ),
    h("div", { class: "rv-line" }, line),
  );
}

/** Another device changed the review: the page is updated on a tap, never under the developer's finger. */
function showSync() {
  if (!current || current.sync) return;
  current.sync = true;
  drawView();
}
/** The page again, with the desk's latest, at the same place. */
function reloadPage() {
  if (!current) return;
  const shown = current;
  run(
    flushNow(shown.id)
      .then(() => fetchSaved(shown.id))
      .then((saved) => {
        if (current !== shown) return;
        took(saved);
        shown.sync = false;
        shown.strayed = false;
        shown.frame = newFrame(shown.id);
        drawView();
        dialog("review").append(shown.frame);
      }),
  );
}

/** @param {Record<string, string>} saved @param {Map<string, string>} mine */
const sameData = (saved, mine) => Object.keys(saved).length === mine.size && Object.entries(saved).every(([k, v]) => mine.get(k) === v);

/** The review open, redrawn with the desk's latest: its progress, and whether another device changed it. */
export function renderReview() {
  sendKept();
  const d = dialog("review");
  if (!current) return;
  if (sheet?.open) drawSheet();
  const r = R(current.id);
  if (!r) return d.close(); // gone from the desk (closed elsewhere)
  if (r.updatedAt !== current.seen && !flying.has(r.id) && !pending.has(r.id) && !current.sync) {
    current.seen = r.updatedAt;
    const shown = current;
    const edits = shown.edits;
    run(
      fetchSaved(r.id).then((saved) => {
        if (current !== shown || !shown.known) return;
        // The page changed while the desk answered: what it sent is older than this frame's, so it is checked again later.
        if (shown.edits !== edits) shown.seen = undefined;
        else if (!sameData(saved.data, shown.data)) showSync();
      }),
    );
  }
  if (current.progress && r.progress && !pending.has(r.id) && !flying.has(r.id)) current.progress = r.progress;
  drawView();
}
/** The bar's progress and Saved, after a change. */
function paintBar() {
  if (current) drawView();
}

// The review's window: closing it (its button, Escape, a phone's back) leaves the page and its history entry.
const view = dialog("review");
view.addEventListener("close", () => {
  closeFrame();
  if (history.state?.review) history.back();
  page.render();
});
addEventListener("popstate", () => {
  const id = /** @type {{ review?: unknown } | null} */ (history.state)?.review;
  if (typeof id === "string") openReview(id);
  else if (view.open) view.close();
});

// ---------- The page's messages ----------

/** @param {unknown} v @param {number} max */
const text = (v, max) => typeof v === "string" && v.length <= max;

addEventListener("message", (e) => {
  // Only the frame of the review open speaks here, and nothing it says is a command.
  // A sandboxed page has no origin: its messages come as from "null". The review is the one this page framed, never one a message names.
  if (!current || current.strayed || e.source !== current.frame.contentWindow || e.origin !== "null") return;
  const m = /** @type {Record<string, unknown>} */ (e.data);
  if (typeof m !== "object" || m === null || m.agentDesk !== 1) return;
  const id = current.id;
  const bad = (/** @type {string} */ what) => toast(TEXT.review.badMessage(what));
  switch (m.type) {
    case "set":
      if (!text(m.key, KEY_MAX) || !text(m.value, STATE_MAX)) return bad(`a value for "${String(m.key).slice(0, 40)}" too large or not text`);
      current.data.set(/** @type {string} */ (m.key), /** @type {string} */ (m.value));
      current.edits++;
      return queue(id, { clear: false, keys: new Map([[/** @type {string} */ (m.key), /** @type {string} */ (m.value)]]) });
    case "remove":
      if (!text(m.key, KEY_MAX)) return bad("a key too long or not text");
      current.data.delete(/** @type {string} */ (m.key));
      current.edits++;
      return queue(id, { clear: false, keys: new Map([[/** @type {string} */ (m.key), null]]) });
    case "clear":
      current.data.clear();
      current.edits++;
      return queue(id, { clear: true, keys: new Map() });
    case "progress": {
      if (!text(m.text, PROGRESS_MAX)) return bad("a progress text too long");
      const p = parseProgress(/** @type {string} */ (m.text));
      const known = R(id)?.progress;
      if (p) current.progress = p;
      // The counter as the page loads says what the desk already knows: nothing to save.
      if (p && known && p.done === known.done && p.total === known.total && !pending.get(id)?.progress) return paintBar();
      return queue(id, { clear: false, keys: new Map(), progress: /** @type {string} */ (m.text) });
    }
    case "scroll": {
      const at = Number(m.at);
      if (!(at >= 0 && at <= 1)) return bad("a scroll position out of 0..1");
      return keep(id, (k) => ({ ...k, at: at || undefined }));
    }
    case "copy": {
      if (!text(m.text, SUMMARY_MAX)) return bad("answers too long to keep");
      const answers = /** @type {string} */ (m.text);
      if (answers) {
        current.summary = answers;
        queue(id, { clear: false, keys: new Map(), summary: answers });
      }
      // The page's own "copy answers" opens Send too: it is what the developer was going to do with them.
      clearTimeout(current.collecting);
      current.collecting = 0;
      return openSend();
    }
    case "notice":
      if (!text(m.text, NOTICE_MAX)) return bad("a notice too long");
      return toast(/** @type {string} */ (m.text));
    case "open":
      if (!text(m.url, URL_MAX) || !URL.canParse(/** @type {string} */ (m.url))) return bad("a link that is not a web address");
      return openLink(/** @type {string} */ (m.url));
    default:
      return bad(`a message of type "${String(m.type).slice(0, 40)}"`);
  }
});

/**
 * A link the page asks to open, in a tab of its own, only to a local preview, and only on this computer: on
 * another device localhost is that device. A browser opens a tab only within the developer's click; when
 * the click in the frame did not reach the desk (Safari), the bar offers the link to click once.
 * @param {string} url
 */
function openLink(url) {
  if (!current) return;
  if (!isLocalPreview(url)) return toast(TEXT.review.outside(url));
  if (!ON_THIS_MACHINE) return toast(TEXT.onComputer(shortUrl(url)));
  // With noopener, open() returns null even when it opens: the click's activation says whether it may.
  if (navigator.userActivation?.isActive) {
    window.open(url, "_blank", "noopener,noreferrer");
    current.link = null;
  } else current.link = url;
  drawView();
}

/** Send asks the page for its answers first (the button it marked), then opens the sheet, with them or without. */
function collect() {
  if (!current) return;
  current.frame.contentWindow?.postMessage({ type: "collect" }, "*"); // the sandboxed page has no origin to name
  clearTimeout(current.collecting);
  const shown = current;
  current.collecting = window.setTimeout(() => {
    shown.collecting = 0;
    if (current === shown) openSend();
  }, COLLECT_MS);
}

// ---------- Send ----------

/**
 * The message the desk sends or copies, as the desk writes it (reviewLine in model.ts): its line, then
 * the developer's note verbatim. @param {Review} r @param {"session" | "other"} to @param {string} note trimmed; "" for none
 */
function sendLine(r, to, note) {
  const p = r.progress;
  const where = `round ${r.rounds.length}${p ? `, ${p.done} of ${p.total} reviewed` : ""}`;
  const line =
    to === "session"
      ? `Review «${r.title}» sent from agent-desk (${where}). Read the answers with: agent-desk review ${r.id}`
      : `Pick up the review «${r.title}» from agent-desk (${where}): agent-desk review ${r.id}`;
  return note ? `${line}\n\n${note}` : line;
}

/** Why the session that asked cannot get it now, or null when it can. @param {Review} r */
function sessionRefusal(r) {
  const s = S(r.sessionId);
  if (!s || !isLive(s)) return TEXT.review.sheet.ended;
  return takesMessages(s) ? null : TEXT.review.sheet.notTaking;
}

/**
 * The sheet's choices while it is open, and the revision of the answers it shows; its note stays for
 * the same review until it is sent.
 * @type {{ id: string, to: "session" | "other", keep: boolean, refused: string | null, open: boolean, rev: number, note: string } | null}
 */
let sheet = null;
/** What the sheet showed when it was last drawn. */
let sheetDrawn = "";

/** Opens the Send sheet once what the page changed is saved, so the line and the answers are the desk's. */
function openSend() {
  if (!current) return;
  const shown = current;
  run(
    flushNow(shown.id).then(async () => {
      // The answers and the revision as the desk holds them: what a send records.
      const saved = await fetchSaved(shown.id);
      const r = R(shown.id);
      if (current !== shown || !r) return;
      shown.summary = saved.summary ?? "";
      shown.options = saved.options ?? "";
      const refused = sessionRefusal(r);
      const p = r.progress;
      if (!sheet?.open) sheet = { id: r.id, to: refused ? "other" : "session", keep: !(p && p.done >= p.total), refused, open: true, rev: saved.rev, note: sheet?.id === r.id ? sheet.note : "" };
      else sheet.rev = saved.rev;
      drawSheet();
      const d = dialog("review-send");
      if (!d.open) d.showModal();
    }),
  );
}

function drawSheet() {
  const d = dialog("review-send");
  const r = current && R(current.id);
  if (!r || !sheet || !current) return;
  const t = TEXT.review.sheet;
  const s = S(r.sessionId);
  const p = r.progress;
  const choice = sheet;
  const lead = p ? (p.done >= p.total ? t.complete(p.total) : t.partial(countOf(p), otherDevice())) : t.none;
  const sessionHint = choice.refused ?? (s && data.listening.includes(s.id) ? t.sessionNow : t.sessionNext);
  /** @param {"session" | "other"} to @param {string} title @param {string} hint @param {boolean} off */
  const option = (to, title, hint, off) =>
    h(
      "label",
      { class: `rv-opt${off ? " off" : ""}` },
      h("input", { type: "radio", name: "rv-dest", value: to, checked: choice.to === to, disabled: off, onchange: () => ((choice.to = to), drawSheet()) }),
      h("span", {}, h("b", {}, title), h("small", {}, hint)),
    );
  const note = choice.note.trim();
  const line = sendLine(r, choice.to, note);
  // What the decision records, the page's words: the options marked, then what it copied.
  const answers = [current.options, current.summary].filter(Boolean).join("\n\n");
  const provider = s?.provider ?? data.sessions.find((x) => x.project.name === r.project.name)?.provider ?? "";
  // Redrawn only when what it shows changed: the answers can be long, and a redraw at every fetch would be for nothing.
  const shows = JSON.stringify([lead, sessionHint, s && label(s), choice, line, answers, current.data.size, provider]);
  if (shows === sheetDrawn) return;
  sheetDrawn = shows;
  patch(
    d,
    h(
      "form",
      { method: "dialog", class: "rv-form", onsubmit: (e) => (e.preventDefault(), submit(r, line)) },
      h("h2", { id: "rv-sheet-title", tabindex: "-1", autofocus: true }, t.title),
      h("p", { class: "lead" }, lead),
      h("fieldset", { class: "rv-dest" }, option("session", t.session, [s ? `${label(s)} · ` : "", sessionHint].join(""), choice.refused !== null), option("other", t.other, t.otherHint(provider), false)),
      h(
        "label",
        { class: "rv-note" },
        h("span", { class: "rv-eyebrow" }, t.note),
        h(
          "textarea",
          {
            "data-key": "rv-note",
            rows: 3,
            maxlength: NOTE_MAX,
            placeholder: t.notePlaceholder,
            oninput: (e) => {
              choice.note = /** @type {HTMLTextAreaElement} */ (e.target).value;
              drawSheet();
            },
          },
          choice.note,
        ),
      ),
      h("div", { class: "rv-msg" }, h("span", { class: "rv-eyebrow" }, choice.to === "session" ? t.sessionLine : t.otherLine), h("pre", { class: "rv-line-text" }, line)),
      h("details", { class: "rv-answers", open: true }, h("summary", {}, t.answers), answers ? h("pre", {}, answers) : h("p", { class: "muted" }, t.noSummary(current.data.size))),
      h("label", { class: "rv-keep" }, h("input", { type: "checkbox", checked: choice.keep, onchange: (e) => (choice.keep = /** @type {HTMLInputElement} */ (e.target).checked) }), t.keep),
      h(
        "div",
        { class: "rv-row" },
        h("button", { type: "button", class: "secondary", onclick: () => d.close() }, t.cancel),
        h("button", { type: "submit", class: "primary" }, choice.to === "session" ? [icon("send"), t.go] : [icon("copy"), t.copyLine]),
      ),
    ),
  );
  d.setAttribute("aria-labelledby", "rv-sheet-title");
  // patch keeps what a kept box holds; a note emptied once sent must leave the box too.
  const box = d.querySelector(".rv-note textarea");
  if (box instanceof HTMLTextAreaElement && box.value !== choice.note) box.value = choice.note;
}
dialog("review-send").addEventListener("close", () => {
  if (sheet) sheet.open = false;
  sheetDrawn = "";
});

/** Sends, or copies, the line shown: exactly that line, never another. @param {Review} r @param {string} line */
function submit(r, line) {
  if (!sheet) return;
  const choice = sheet;
  const t = TEXT.review.sheet;
  const d = dialog("review-send");
  // Copied at the click itself, while the browser still counts it as the developer's.
  const copied = choice.to === "other" ? navigator.clipboard.writeText(line) : null;
  run(
    (async () => {
      if (copied) await copied.catch(() => Promise.reject(new Error(t.copyFailed)));
      // What the page changed last goes first: the line the desk then builds must be the one shown.
      await flushNow(r.id);
      const now = R(r.id);
      if (!now || sendLine(now, choice.to, choice.note.trim()) !== line) {
        drawSheet();
        throw new Error(t.changed);
      }
      try {
        const note = choice.note.trim();
        const reply = /** @type {{ line?: unknown }} */ (await postJson(`/api/reviews/${r.id}/send`, { to: choice.to, rev: choice.rev, options: current?.options ?? "", ...(note ? { note } : {}) }));
        if (reply.line !== line) throw new Error(`the desk sent "${String(reply.line)}", not the line shown`);
      } catch (error) {
        if (error instanceof DeskError && error.status === 409) {
          const body = /** @type {{ stale?: unknown }} */ (error.body);
          // The answers changed since the sheet showed them (another device): shown again, not sent.
          if (body.stale === true) {
            openSend();
            throw new Error(t.changed);
          }
          // The session could not take it after all: the line goes to another conversation instead.
          if (choice.to === "session") {
            choice.refused = error.message;
            choice.to = "other";
            drawSheet();
          }
        }
        throw error;
      }
      toast(copied ? t.copied : t.sent(label(S(r.sessionId))));
      choice.note = "";
      d.close();
      if (!choice.keep) {
        await post(`/api/reviews/${r.id}/close`);
        dialog("review").close();
      }
      await refresh();
    })(),
  );
}

// ---------- Closing ----------

/**
 * Closes the review without sending it, after a confirming click: it leaves To review and stays in
 * History. What the page changed last is saved first.
 * @param {Review} r @param {string} cls @param {import("./dom.js").Child} idle @param {string} ask @param {() => void} redraw
 */
function closeButton(r, cls, idle, ask, redraw) {
  const t = TEXT.review;
  const act = () =>
    flushNow(r.id)
      .then(() => post(`/api/reviews/${encodeURIComponent(r.id)}/close`))
      .then(() => {
        if (current?.id === r.id) dialog("review").close();
        toast(t.closed(r.title));
      });
  return armedButton({ key: `${r.id} close`, id: "rv-close", text: t.closeTitle, ask, act, redraw, cls: `${cls} arm-swap`, title: t.closeHint, idle });
}

/** Its own clicks and keys: not the tile's, which open the review. @param {Event} e */
const stop = (e) => e.stopPropagation();

// ---------- On the desk ----------

/** Not opened on the desk since its latest round was published ("New" until then). @param {Review} r */
const unseenRound = (r) => !r.openedAt || r.openedAt < (r.rounds.at(-1)?.at ?? "");

/** Where the last change was made, from this device's side. @param {Review} r */
function changedOn(r) {
  const w = TEXT.review.where;
  if (r.updatedFrom === "remote") return w.phone;
  return ON_THIS_MACHINE ? w.thisComputer : w.yourComputer;
}

/** The last send, and whether a session has read it since. @param {Review} r */
function sentLine(r) {
  const last = r.sends.at(-1);
  if (!last) return null;
  const read = r.collected && r.collected.at >= last.at ? ago(r.collected.at) : null;
  return h("div", { class: "rv-sent" }, icon("check"), h("span", {}, last.to ? TEXT.review.sentSession(ago(last.at), read) : TEXT.review.sentOther(ago(last.at), read)));
}

/** A review in To review: what it is, how far along, and when it was last touched. @param {Review} r */
export function reviewTile(r) {
  const t = TEXT.review;
  const s = S(r.sessionId);
  const fresh = unseenRound(r);
  const latest = r.rounds.at(-1);
  const bar = h("i", {});
  bar.style.width = `${percentOf(r.progress)}%`;
  // A round newer than the developer's last change replaced what they saw: the foot says so first.
  const replaced = latest && r.rounds.length > 1 && latest.at > (r.updatedAt ?? "");
  const foot = untouched(r)
    ? t.untouched(dayLabel(touchedAt(r)))
    : replaced
      ? t.newRound(latest.n, ago(latest.at))
      : r.updatedAt
        ? t.lastChange(changedOn(r), ago(r.updatedAt))
        : t.published(ago(latest?.at ?? ""));
  const open = () => openReview(r.id);
  const tile = h(
    "article",
    {
      class: `rv-tile${untouched(r) ? " still" : ""}`,
      role: "button",
      tabindex: "0",
      "data-key": `rv-${r.id}`,
      onclick: open,
      onkeydown: (e) => {
        const k = /** @type {KeyboardEvent} */ (e).key;
        if (k === "Enter" || k === " ") (e.preventDefault(), open());
      },
    },
    h(
      "div",
      { class: "rv-top" },
      h("span", { class: "rv-ico" }, icon("doc")),
      h("div", { class: "rv-titles" }, h("b", {}, r.title), h("span", { class: "rv-from" }, projectMark(r.project.name)[1], s ? [h("span", { class: "sep" }, "›"), s.title ?? ""] : null)),
      h("span", { class: "rv-badges" }, r.rounds.length > 1 ? h("span", { class: "badge rv-round" }, t.round(r.rounds.length)) : null, fresh ? h("span", { class: "badge rv-new" }, t.new) : null),
    ),
    h("div", { class: "rv-prog" }, h("span", { class: "rv-meter" }, bar), h("span", { class: "num" }, countOf(r.progress))),
    h(
      "div",
      { class: "rv-foot" },
      h("span", { class: "faint" }, foot),
      h("span", { class: "rv-x", onclick: stop, onkeydown: stop }, closeButton(r, "icon-btn", icon("x"), t.closeShort, () => page.renderView())),
      h("span", { class: "rv-go" }, fresh ? t.open : t.continue, icon("arrow")),
    ),
    sentLine(r),
  );
  tile.style.setProperty("--g", projectColor(r.project.name));
  return tile;
}

/** A review's line on its session's card: one click opens it. @param {Review} r */
export function reviewLine(r) {
  const line = h(
    "div",
    {
      class: "rv-sline",
      role: "button",
      tabindex: "0",
      title: r.title,
      onclick: (e) => (e.stopPropagation(), openReview(r.id)),
      onkeydown: (e) => /** @type {KeyboardEvent} */ (e).key === "Enter" && (e.stopPropagation(), openReview(r.id)),
    },
    icon("doc"),
    h("span", { class: "rv-sl-t" }, h("b", {}, TEXT.review.line), " · ", r.title),
    h("span", { class: "num" }, countOf(r.progress)),
  );
  line.style.setProperty("--g", projectColor(r.project.name));
  return line;
}
