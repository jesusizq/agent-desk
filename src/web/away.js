// @ts-check
// While you were away: back after a while, or at the day's first look, one calm summary of what
// happened since this device last looked, in the strip, until it is dismissed.
import { h, icon } from "./dom.js";
import { TEXT } from "./text.js";
import { firstLine, headline, stamp } from "./format.js";
import { ONE_COLUMN, showNeedsYou } from "./layout.js";
import { beacon, dot } from "./pieces.js";
import { openResult } from "./result.js";
import { openSession } from "./session.js";
import { data, inProject, openItems, page, S, ui } from "./state.js";

/** @typedef {import("../core/protocol.ts").Question} Question */
/** @typedef {import("./dom.js").Child} Child */

/** When this device last showed the desk, kept by the browser (ms since the epoch). */
const LOOKED_KEY = "agent-desk:last-looked";
/** Away longer than this, the desk says what happened meanwhile. */
const AWAY_MS = 20 * 60_000;
/** How often a desk in view says it is looked at: a computer that slept with it open wakes to a gap. */
const LOOK_MS = 30_000;

/** @type {{ since: string, until: string } | null} the time away the summary covers, while it is shown */
let away = null;

/** @param {number} a @param {number} b */
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/**
 * The desk is in view now: after a long gap, or on a new day, the summary covers the time away (and
 * the time of a summary not dismissed yet); hidden, the device notes when it stopped looking.
 */
function looked() {
  const now = Date.now();
  if (!document.hidden) {
    const last = Number(localStorage.getItem(LOOKED_KEY)) || 0;
    if (last > 0 && (now - last > AWAY_MS || !sameDay(last, now))) {
      const since = new Date(last).toISOString();
      away = { since: away && away.since < since ? away.since : since, until: new Date(now).toISOString() };
      page.render();
    }
  }
  localStorage.setItem(LOOKED_KEY, String(now));
}

/** Starts keeping when this device looks at the desk; the first look may already come back from a while away. */
export function watchAway() {
  looked();
  document.addEventListener("visibilitychange", looked);
  addEventListener("pagehide", looked);
  addEventListener("pageshow", (e) => /** @type {PageTransitionEvent} */ (e).persisted && looked()); // back from the browser's page cache
  // A hidden page's timers still run now and then: only a page in view counts as looking.
  setInterval(() => document.hidden || looked(), LOOK_MS);
}

/** @param {string} iso */
const during = (iso) => away !== null && iso > away.since && iso <= away.until;

/**
 * What happened while away, in the projects shown: what waits oldest first, as Needs you orders it;
 * what finished, failed or was answered newest first, the latest being what the developer left for.
 */
function happened() {
  const newest = (/** @type {string} */ a, /** @type {string} */ b) => b.localeCompare(a);
  const results = data.results.filter((r) => inProject(r.sessionId) && during(r.at)).sort((a, b) => newest(a.at, b.at));
  const failedAgents = data.agents.filter((a) => a.state === "failed" && a.endedAt && during(a.endedAt) && inProject(a.sessionId));
  const failed = [...results.filter((r) => r.status === "failed"), ...failedAgents];
  /** @param {Question} q */
  const inTerminal = (q) => q.status === "answered" && q.answer?.via === "terminal" && during(q.closedAt ?? q.askedAt) && inProject(q.sessionId);
  const items = openItems();
  return {
    finished: results.filter((r) => r.status !== "failed"),
    failed: failed.sort((a, b) => newest("at" in a ? a.at : (a.endedAt ?? ""), "at" in b ? b.at : (b.endedAt ?? ""))),
    answered: data.questions.filter(inTerminal).sort((a, b) => newest(a.closedAt ?? "", b.closedAt ?? "")),
    waits: items,
    asked: items.filter((it) => it.questions.some((q) => during(q.askedAt))).length,
  };
}

/**
 * The summary, in the strip's place for what is new, or null when the developer has not been away
 * or nothing happened meanwhile. A line opens what it names; nothing in it stands between the
 * developer and answering.
 */
export function awaySummary() {
  if (!away || !ui.loaded || ui.view !== "desk") return null;
  const t = TEXT.away;
  const { finished, failed, answered, waits, asked } = happened();
  if (!finished.length && !failed.length && !answered.length && !asked) return null;
  // A phone shows one line per group, so the summary leaves Needs you in view.
  const shown = ONE_COLUMN.matches ? 1 : 3;
  /**
   * @template T @param {string} key @param {string} title @param {T[]} list
   * @param {(x: T) => [mark: Child, text: Child, open: () => void]} line @param {() => void} more
   */
  const group = (key, title, list, line, more) =>
    list.length
      ? h(
          "div",
          { class: "away-group", "data-key": key },
          h("h4", {}, title),
          list.slice(0, shown).map((x) => {
            const [mark, text, open] = line(x);
            return h("button", { class: "away-line", onclick: open }, mark, h("span", { class: "away-t" }, text));
          }),
          list.length > shown ? h("button", { class: "linkish away-more", onclick: more }, t.more(list.length - shown)) : null,
        )
      : null;
  /** @param {"result" | "decision"} filter */
  const history = (filter) => () => ((ui.view = "history"), (ui.hfilter = filter), page.render());
  /** @param {string} sid */
  const session = (sid) => () => (S(sid) ? openSession(sid) : history("decision")());
  const where = (/** @type {string} */ sid) => h("span", { class: "away-where" }, S(sid)?.project.name ?? "");
  return h(
    "section",
    { class: "away", "aria-labelledby": "away-title", "data-key": "away" },
    h(
      "div",
      { class: "away-head" },
      h("b", { id: "away-title" }, t.title),
      h("span", { class: "muted" }, t.since(stamp(away.since)), " · ", t.summary(finished.length, failed.length, answered.length)),
      h("span", { class: "spacer" }),
      h("button", { class: "icon-btn away-close", "aria-label": t.dismiss, title: t.dismiss, onclick: () => ((away = null), page.render()) }, icon("x")),
    ),
    h(
      "div",
      { class: "away-groups" },
      group("waits", t.waits, waits, (it) => {
        const q = it.open[0] ?? it.questions[0];
        return [beacon(q?.askedAt ?? ""), [headline(q?.text ?? ""), " ", where(q?.sessionId ?? "")], () => ((ui.sel = it.key), showNeedsYou())];
      }, showNeedsYou),
      group("failed", t.failed, failed, (x) =>
        "title" in x ? [dot("failed"), [x.title, " ", where(x.sessionId)], () => openResult(x)] : [dot("failed"), [x.goal ?? x.name, " ", where(x.sessionId)], session(x.sessionId)],
      history("result")),
      group("finished", t.finished, finished, (r) => [dot("done"), [r.title, " ", where(r.sessionId)], () => openResult(r)], history("result")),
      group("answered", t.answered, answered, (q) => [
        icon("terminal"),
        [headline(q.text), q.answer ? [" → ", h("b", {}, firstLine(q.answer.text))] : null, " ", where(q.sessionId)],
        session(q.sessionId),
      ], history("decision")),
    ),
  );
}
