// @ts-check
// What is new since the last fetch: questions, failures and messages, told by sound, toast and notification.
import { byId, dialog } from "./dom.js";
import { bump } from "./motion.js";
import { TEXT } from "./text.js";
import { alertOn, chime, notify } from "./alerts.js";
import { inSight, panelShowsConversation } from "./layout.js";
import { toast } from "./pieces.js";
import { openResult } from "./result.js";
import { openSession } from "./session.js";
import { asksOf, data, itemKey, itemOf, label, page, S, ui, unread } from "./state.js";

export function noticeArrivals() {
  const open = data.questions.filter((q) => q.status === "open");
  if (ui.known === null) {
    ui.known = new Set(open.map((q) => q.id));
    // What already waits long when the page opens is in sight: no reminder for it.
    for (const q of open) if (Date.now() - Date.parse(q.askedAt) >= REMIND_MS) ui.reminded.add(q.id);
    ui.failuresSeen = new Set(failures());
    noticeMessages(); // what each session last said when the page opened: only what follows is new
    return;
  }
  noticeFailures();
  let chimed = false;
  /** @type {Set<string>} */
  const told = new Set();
  for (const q of open) {
    if (ui.known.has(q.id)) continue;
    ui.known.add(q.id);
    // Questions asked together arrive together: one call for them.
    if (told.has(itemKey(q))) continue;
    told.add(itemKey(q));
    const where = label(S(q.sessionId));
    if (!chimed) chime();
    chimed = true;
    bump(byId("needs-pill"));
    // Where it is already in sight, it comes in there; elsewhere a small bubble tells of it.
    if (panelShowsConversation(q.sessionId)) ui.panelArrival = itemKey(q);
    else if (!inSight(q)) ui.arrivals = [...ui.arrivals.filter((k) => k !== itemKey(q)), itemKey(q)];
    notify(TEXT.newQuestion(where), q.text, q.id, () => {
      ui.view = "desk";
      ui.sel = itemKey(q);
      page.render();
    });
  }
  noticeMessages();
}

// A question unanswered this long is brought up once more, in case the first call was missed.
const REMIND_MS = 15 * 60_000;
export function remindWaiting() {
  if (ui.known === null) return;
  for (const q of data.questions) {
    if (q.status !== "open" || ui.reminded.has(q.id) || Date.now() - Date.parse(q.askedAt) < REMIND_MS) continue;
    for (const x of itemOf(q).questions) ui.reminded.add(x.id);
    const where = label(S(q.sessionId));
    toast(TEXT.reminder(where));
    chime();
    notify(TEXT.reminder(where), q.text, `again-${q.id}`, () => {
      ui.view = "desk";
      ui.sel = itemKey(q);
      page.render();
    });
  }
}

/** Keys of what has failed: results, and agents (by session and name). */
export const failures = () => [...data.results.filter((r) => r.status === "failed").map((r) => `r ${r.id}`), ...data.agents.filter((a) => a.state === "failed").map((a) => `a ${a.sessionId} ${a.name}`)];

/** A new failure, when the developer asked to hear of failures too (off by default: they need no answer). */
function noticeFailures() {
  const seen = (ui.failuresSeen ??= new Set(failures()));
  for (const key of failures()) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (!alertOn("failures")) continue;
    const [kind, a, b] = key.split(" ");
    const result = kind === "r" ? data.results.find((r) => r.id === a) : undefined;
    const agent = kind === "a" ? data.agents.find((x) => x.sessionId === a && x.name === b) : undefined;
    const sid = result?.sessionId ?? agent?.sessionId ?? "";
    const what = result?.title ?? agent?.goal ?? agent?.name ?? "";
    toast(TEXT.failedAlert(what, label(S(sid))));
    chime();
    notify(TEXT.failedAlert(what, label(S(sid))), result?.summary ?? agent?.activity ?? "", key, () => (result ? openResult(result) : openSession(sid)));
  }
}

/**
 * A session that finished and wrote something new, without asking (questions are noticed above),
 * gets a toast, unless its panel is open and in view; no desktop notification, as it needs no answer.
 */
function noticeMessages() {
  const first = ui.heardAt === null;
  const heardAt = (ui.heardAt ??= new Map());
  for (const s of data.sessions) {
    const at = s.lastMessage?.at;
    if (!at || heardAt.get(s.id) === at) continue;
    heardAt.set(s.id, at);
    if (first || !unread(s) || asksOf(s.id).length > 0) continue;
    if (ui.panelSession === s.id && dialog("session").open && !document.hidden) continue;
    toast(TEXT.newMessage(label(s)));
  }
}
