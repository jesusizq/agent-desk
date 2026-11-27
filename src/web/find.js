// @ts-check
// Find in the session panel's conversation: matched on the fetched messages (not the page), each
// shown in turn, its fold opened, the words marked with the CSS Custom Highlight API (no change to the page).
import { dialog, h, icon } from "./dom.js";
import { TEXT } from "./text.js";
import { groupsOf } from "./conversation.js";
import { fromEnd, NEAR_END } from "./follow.js";
import { ui } from "./state.js";

/** @typedef {import("../core/protocol.ts").ConversationEntry} ConversationEntry */

/** Fewer letters match nearly every message: nothing is searched until then. */
const MIN_LETTERS = 2;
const TYPING_MS = 150;

export const find = {
  open: false,
  query: "",
  /** @type {{ id: string, n: number }[]} each match: its message and which of its matches, oldest first */ hits: [],
  /** which of them is shown, -1 for none */ at: -1,
};

/** Lower case, without accents: "busqueda" finds "Búsqueda". @param {string} text */
const fold = (text) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
/** What a message shows once its Markdown is drawn, near enough: link targets and marks of emphasis or code are not read. @param {string} text */
const shown = (text) =>
  text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "");
/** Each message's folded text, worked out once: a fetch brings new entries, and the old ones go with their list. @type {WeakMap<ConversationEntry, string>} */
const folded = new WeakMap();
/** @param {ConversationEntry} m */
function foldedOf(m) {
  let f = folded.get(m);
  if (f === undefined) folded.set(m, (f = fold(shown(m.text))));
  return f;
}

/** What the hits were worked out from: a redraw with the same list and query reuses them. */
let searched = { list: /** @type {ConversationEntry[] | undefined} */ (undefined), q: "" };
/** @param {string} sid */
function search(sid) {
  const q = fold(find.query.trim());
  const list = ui.conversations.get(sid);
  if (searched.list === list && searched.q === q) return;
  const was = searched.q === q ? find.hits[find.at] : undefined;
  searched = { list, q };
  /** @type {{ id: string, n: number }[]} */
  const hits = [];
  if (q.length >= MIN_LETTERS) for (const m of list ?? []) {
    const f = foldedOf(m);
    for (let i = f.indexOf(q), n = 0; i >= 0; i = f.indexOf(q, i + q.length), n++) hits.push({ id: m.id, n });
  }
  find.hits = hits;
  // A new message that matches does not move the one being read; a new query starts from the newest.
  const kept = was ? hits.findIndex((x) => x.id === was.id && x.n === was.n) : -1;
  find.at = kept >= 0 ? kept : find.hits.length - 1;
}

/** @type {(() => void) | null} */
let redraw = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let typing;

/** Opens the bar, or takes the focus back to it. @param {() => void} draw redraws the panel */
export function openFind(draw) {
  redraw = draw;
  find.open = true;
  draw();
  const input = dialog("session").querySelector(".find-bar input");
  if (input instanceof HTMLInputElement) (input.focus(), input.select());
}

export function closeFind() {
  clearTimeout(typing);
  Object.assign(find, { open: false, query: "", hits: [], at: -1 });
  searched = { list: undefined, q: "" };
  CSS.highlights?.delete("find");
  CSS.highlights?.delete("find-now");
}

/** @param {string} sid @param {number} step -1 for the older match, 1 for the newer */
function go(sid, step) {
  if (!find.hits.length) return;
  find.at = (find.at + step + find.hits.length) % find.hits.length;
  show(sid);
}

/** Opens the fold the shown match is in, then brings it to the middle of what the answer box leaves in sight. @param {string} sid */
function show(sid) {
  const hit = find.hits[find.at];
  const id = hit?.id;
  const list = ui.conversations.get(sid) ?? [];
  const g = groupsOf(list).find((x) => x.run.some((m) => m.id === id));
  if (g && g.kind !== "message" && !ui.stepsOpen.has(g.key)) ui.stepsOpen.add(g.key);
  ui.panelTouchedAt = 0; // the developer's own action: not a scroll to wait out
  ui.panelStick = false; // before the redraw, which would otherwise pull the conversation back to its end
  redraw?.();
  const d = dialog("session");
  const b = d.querySelector(".session-body");
  const el = id ? b?.querySelector(`.msg[data-key="${CSS.escape(id)}"]`) : null;
  if (!b || !el) return;
  const box = b.getBoundingClientRect();
  const foot = b.querySelector(".chat-footer")?.getBoundingClientRect().top ?? box.bottom;
  const top = Math.max(box.top, b.querySelector(".pchips")?.getBoundingClientRect().bottom ?? box.top);
  // The match itself, not its message, which may be taller than the room: the words drawn, else the message.
  const md = el.querySelector(".md");
  const ranges = md && hit ? rangesOf(md, fold(find.query.trim())) : [];
  const word = ranges[Math.min(hit?.n ?? 0, ranges.length - 1)];
  const r = (word ?? el).getBoundingClientRect();
  const room = Math.max(0, foot - top);
  b.scrollTop += r.top + r.height / 2 - (top + room / 2);
  // A match already in place moves nothing, and no scroll event says where the conversation rests.
  ui.panelStick = fromEnd(b) < NEAR_END;
}

/** Marks the matched words in what is drawn: the shown match apart. Called after each drawing of the panel. */
export function paintFind() {
  if (!CSS.highlights) return;
  const q = fold(find.query.trim());
  const b = dialog("session").querySelector(".session-body");
  if (!find.open || q.length < MIN_LETTERS || !b || !find.hits.length) return void (CSS.highlights.delete("find"), CSS.highlights.delete("find-now"));
  const all = new Highlight();
  const now = new Highlight();
  const hits = new Set(find.hits.map((x) => x.id));
  const current = find.hits[find.at];
  for (const msg of b.querySelectorAll(".msg[data-key]")) {
    const id = msg.getAttribute("data-key") ?? "";
    const md = hits.has(id) ? msg.querySelector(".md") : null;
    if (!md) continue;
    const ranges = rangesOf(md, q);
    // The text searched and the words drawn may count differently (Markdown): the last drawn stands in.
    const shown = current?.id === id ? Math.min(current.n, ranges.length - 1) : -1;
    ranges.forEach((r, i) => (i === shown ? now : all).add(r));
  }
  CSS.highlights.set("find", all);
  CSS.highlights.set("find-now", now);
}

/** The ranges of the folded query `q` in what `el` shows, across its inline parts (bold, code, links). @param {Element} el @param {string} q */
function rangesOf(el, q) {
  /** @type {Text[]} */
  const nodes = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n instanceof Text) nodes.push(n);
  const text = nodes.map((n) => n.data).join("");
  const whole = fold(text);
  if (!whole.includes(q)) return [];
  // Folding keeps the length of nearly every text (an accent drops with its mark): offsets then carry over as they are.
  /** @type {number[] | null} for each code unit of the folded text, where its character starts in `text` */
  let at = null;
  let f = whole;
  if (whole.length !== text.length) {
    at = [];
    f = "";
    for (let i = 0; i < text.length; ) {
      const c = String.fromCodePoint(/** @type {number} */ (text.codePointAt(i)));
      const piece = fold(c);
      for (let k = 0; k < piece.length; k++) at.push(i);
      f += piece;
      i += c.length;
    }
  }
  /** @param {number} i */
  const origin = (i) => (at ? (at[i] ?? text.length) : i);
  /** @param {number} offset @returns {[Text, number]} */
  const point = (offset) => {
    let rest = offset;
    for (const n of nodes) {
      if (rest <= n.data.length) return [n, rest];
      rest -= n.data.length;
    }
    const last = /** @type {Text} */ (nodes.at(-1));
    return [last, last.data.length];
  };
  /** @type {Range[]} */
  const out = [];
  for (let i = f.indexOf(q); i >= 0; i = f.indexOf(q, i + q.length)) {
    const from = origin(i);
    const to = Math.max(origin(i + q.length), origin(i + q.length - 1) + 1);
    const r = new Range();
    r.setStart(...point(from));
    r.setEnd(...point(Math.min(to, text.length)));
    out.push(r);
  }
  return out;
}

/** The bar under the panel's head: the box, how many match, the older and newer match, and closing. @param {string} sid @param {() => void} draw */
export function findBar(sid, draw) {
  redraw = draw;
  search(sid);
  const t = TEXT.find;
  const q = find.query.trim();
  const count = q.length < MIN_LETTERS ? "" : find.hits.length ? t.of(find.at + 1, find.hits.length) : t.none;
  const close = () => {
    closeFind();
    draw();
    // The focus was in the bar, gone now: back to the button that opens it, inside the panel.
    const opener = dialog("session").querySelector(".find-open");
    if (opener instanceof HTMLElement) opener.focus();
  };
  return h(
    "div",
    {
      class: "find-bar",
      "data-key": "find-bar",
      role: "search",
      // On the bar, so Escape from its buttons too closes the search, not the panel.
      onkeydown: (/** @type {Event} */ e) => {
        if (!(e instanceof KeyboardEvent) || e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        close();
      },
    },
    h("input", {
      type: "search",
      "data-key": "find-input",
      "aria-label": t.label,
      placeholder: t.placeholder,
      value: find.query,
      enterkeyhint: "search",
      oninput: (/** @type {Event} */ e) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        find.query = e.target.value;
        clearTimeout(typing);
        typing = setTimeout(() => {
          search(sid);
          if (find.hits.length) show(sid);
          else draw();
        }, TYPING_MS);
      },
      onkeydown: (/** @type {Event} */ e) => {
        if (!(e instanceof KeyboardEvent) || e.key !== "Enter" || e.isComposing) return;
        e.preventDefault();
        clearTimeout(typing);
        search(sid);
        go(sid, e.shiftKey ? 1 : -1); // reading bottom up: Enter goes to the older match
      },
    }),
    h("span", { class: "find-count faint num", role: "status" }, count),
    h("button", { class: "icon-btn", "aria-label": t.older, title: t.older, disabled: !find.hits.length, onclick: () => go(sid, -1) }, icon("chevUp")),
    h("button", { class: "icon-btn", "aria-label": t.newer, title: t.newer, disabled: !find.hits.length, onclick: () => go(sid, 1) }, icon("chevDown")),
    h("button", { class: "icon-btn", "aria-label": t.close, title: t.close, onclick: close }, icon("x")),
  );
}
