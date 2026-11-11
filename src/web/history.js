// @ts-check
// History: past decisions with their answers and past results, searchable.
import { byId, h, icon } from "./dom.js";
import { TEXT } from "./text.js";
import { attachedImages } from "./conversation.js";
import { dayLabel } from "./format.js";
import { badge, emptyState } from "./pieces.js";
import { openResult } from "./result.js";
import { openReview } from "./review.js";
import { data, inProject, label, page, S, ui } from "./state.js";

/** @typedef {import("../core/protocol.ts").DeskState} DeskState */
/** @typedef {import("../core/protocol.ts").Result} Result */

/** Every place `q` occurs in `text`, marked. @param {string} text @param {string} q */
function highlight(text, q) {
  if (!q) return text;
  return text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi")).map((part, i) => (i % 2 ? h("mark", {}, part) : part));
}
/**
 * @typedef {{ at: string, sid: string, type: "decision" | "result", kind: keyof typeof TEXT.kinds,
 *   title: string, answer?: string, viaDesk?: boolean, copied?: boolean, reviewNote?: boolean, images?: string[], note?: string, closed?: string, result?: Result, review?: string, where: string, hay: string }} Entry
 */
// History draws this many entries at first, and this many more on demand: a search redraws only those.
const HISTORY_PAGE = 50;
/** @type {{ from: DeskState | null, entries: Entry[] }} the entries of the data last drawn, newest first, each with the text a search looks in */
let historyMemo = { from: null, entries: [] };
function historyEntries() {
  if (historyMemo.from === data) return historyMemo.entries;
  /** @type {Omit<Entry, "where" | "hay">[]} */
  const decisions = data.questions
    .filter((x) => x.status !== "open")
    .map((x) => ({
      at: x.closedAt ?? x.askedAt,
      sid: x.sessionId,
      type: "decision",
      // A review sent from the desk: its answers, kept as a decision (never in Needs you).
      kind: x.review ? "review" : x.status === "dismissed" ? "dismissed" : x.kind === "permission" ? "permission" : "decision",
      ...(x.review ? { review: x.review.id, reviewNote: x.review.note === true } : {}),
      title: x.text,
      ...(x.answer ? { answer: x.answer.text, viaDesk: x.answer.via === "desk", copied: x.answer.via === "review", images: x.answer.images ?? [] } : {}),
      ...(x.interpretation ? { note: x.interpretation } : {}),
    }));
  /** @type {Omit<Entry, "where" | "hay">[]} */
  const results = data.results.map((r) => ({ at: r.at, sid: r.sessionId, type: "result", kind: r.status === "failed" ? "failed" : "result", title: r.title, note: r.summary, result: r }));
  // A review closed, sent or not: when, by which session if one closed it, and why.
  /** @type {Omit<Entry, "where" | "hay">[]} */
  const closed = data.reviews.flatMap((r) => {
    if (!r.closedAt) return [];
    const by = r.closedBy === undefined ? null : r.closedBy === r.sessionId ? TEXT.history.theSession : label(S(r.closedBy));
    return [{ at: r.closedAt, sid: r.sessionId, type: "decision", kind: "review", review: r.id, title: r.title, closed: TEXT.history.reviewClosed(by, r.closedReason) }];
  });
  const entries = [...decisions, ...results, ...closed]
    .map((e) => {
      const where = label(S(e.sid));
      return { ...e, where, hay: [e.title, e.answer, e.note, e.closed, where].join(" ").toLowerCase() };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
  historyMemo = { from: data, entries };
  return entries;
}
/** Redraws the view once per frame however many keys were typed in it. */
let viewFrame = 0;
function renderViewSoon() {
  viewFrame ||= requestAnimationFrame(() => {
    viewFrame = 0;
    page.renderView();
  });
}
export function historyView() {
  const q = ui.hq.trim();
  const t = TEXT.history;
  const needle = q.toLowerCase();
  const entries = historyEntries().filter((e) => inProject(e.sid) && (ui.hfilter === "all" || e.type === ui.hfilter) && (!needle || e.hay.includes(needle)));
  const shown = entries.slice(0, Math.max(ui.hshown, HISTORY_PAGE));
  const input = h("input", {
    type: "search",
    value: ui.hq,
    placeholder: t.search,
    "aria-label": t.search,
    "data-key": "history-search",
    oninput: (e) => {
      ui.hq = /** @type {HTMLInputElement} */ (e.target).value;
      /** @type {HTMLInputElement} */ (byId("q")).value = ui.hq;
      ui.hshown = 0;
      renderViewSoon();
    },
  });
  return h(
    "div",
    { class: "page", "data-scroll": "history" },
    h(
      "div",
      { class: "wrap" },
      h("h1", { class: "title" }, t.title),
      h("div", { class: "hsearch" }, h("label", { class: "search" }, icon("search"), input), h("div", { class: "seg" }, (/** @type {const} */ ([["all", t.all], ["decision", t.decisions], ["result", t.results]])).map(([k, l]) => h("button", { "aria-pressed": String(ui.hfilter === k), onclick: () => ((ui.hfilter = k), page.render()) }, l)))),
      entries.length ? h("div", { class: "faint hcount" }, t.entries(entries.length)) : null,
      entries.length
        ? h("div", { class: "hlist" }, shown.map((e) => {
            const result = e.result;
            const review = e.review && data.reviews.some((r) => r.id === e.review) ? e.review : undefined;
            const open = result ? () => openResult(result) : review ? () => openReview(review) : null;
            return h(
              open ? "button" : "div",
              { class: `hitem${open ? " open" : ""}`, onclick: open },
              h("div", { class: "hwhen" }, dayLabel(e.at)),
              h(
                "div",
                {},
                h("div", { class: "meta" }, badge(e.kind), highlight(e.where, q)),
                h("div", { class: "hq" }, highlight(e.title, q)),
                e.answer !== undefined
                  ? e.kind === "review"
                    ? h("div", { class: "ha rv-ha" }, e.copied ? t.reviewCopied : e.reviewNote ? t.reviewNote : t.answers, h("span", {}, highlight(e.answer, q)))
                    : h("div", { class: "ha" }, t.answer, h("b", {}, highlight(e.answer, q)), e.viaDesk ? t.viaDesk : "")
                  : null,
                e.images?.length ? attachedImages(e.images) : null,
                e.note ? h("div", { class: "hi" }, e.type === "decision" ? t.understood : "", highlight(e.note, q)) : null,
                e.closed ? h("div", { class: "hi rv-hclosed" }, highlight(e.closed, q)) : null,
              ),
            );
          }))
        : emptyState("no-history", t.none(q)),
      entries.length > shown.length ? h("button", { class: "linkish hmore", onclick: () => ((ui.hshown = shown.length + HISTORY_PAGE), page.renderView()) }, t.more(Math.min(HISTORY_PAGE, entries.length - shown.length))) : null,
    ),
  );
}

/** The typing carries on in History's own box, the header's being hidden there. */
export function focusHistorySearch() {
  const box = document.querySelector('[data-key="history-search"]');
  if (!(box instanceof HTMLInputElement)) return;
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}
