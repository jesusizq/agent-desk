// @ts-check
// Session control: the tmux keys the desk may send a session, ending its process, and forgetting it once
// it ended, each after a confirming click.
import { dialog, h, icon } from "./dom.js";
import { TEXT } from "./text.js";
import { copy, copyClicked, toast } from "./pieces.js";
import { post, run } from "./server.js";
import { asksOf, data, isLive, label, ON_THIS_MACHINE, ui } from "./state.js";
import { stamp } from "./format.js";
import { COARSE } from "./layout.js";

/** @typedef {import("../core/protocol.ts").Session} Session */
/** @typedef {import("../core/protocol.ts").Metrics} Metrics */
/** @typedef {import("../core/protocol.ts").DeskCommand} DeskCommand */

/**
 * What the desk last typed of `command` into the session, while no turn has ended since: until the
 * session has acted on it, its button says it was sent, so it is not sent twice.
 * @param {Session} s @param {DeskCommand} command
 */
export function sentOf(s, command) {
  const sent = s.deskSent?.[command];
  return sent && sent.at > (s.turnEndedAt ?? "") ? sent : null;
}
/** @param {string} at */
const sentMark = (at) => h("span", { class: "sent-mark", title: TEXT.control.sentMarkHint(stamp(at)) }, icon("check"), TEXT.control.sentMark(stamp(at)));

/** The last shell command shown runnable, kept so its block can show it was sent after the server dropped it. */
let shownShell = { key: "", text: "" };
/** The last click on a runnable command: another on it within DOUBLE_MS makes a double click, or a double tap. */
let lastClick = { key: "", at: 0 };
const DOUBLE_MS = 500;
/** How long Run stays inert once the confirmation opens, so the clicks or taps that opened it cannot press it. */
const HOLD_MS = 1000;

/**
 * The reply's code block holding the shell command the session asked for, made runnable: a double
 * click on it (a double tap on a phone), or Run under it, opens a confirmation in its place that shows
 * the command whole, with Run and Cancel; only that Run types it.
 * @param {Session} s @param {string} shell @param {() => void} redraw
 * @param {string} key one per command asked: the one it was fired under, once the server dropped the command
 */
function runnableCommand(s, shell, redraw, key) {
  shownShell = { key, text: shell };
  const t = TEXT.control;
  const fired = ui.fired?.key === key ? ui.fired.state : null;
  const openedAt = !fired && ui.confirmShell?.key === key ? ui.confirmShell.at : 0;
  const confirm = () => {
    const at = Date.now();
    ui.confirmShell = { key, at };
    setTimeout(() => ui.confirmShell?.at === at && redraw(), HOLD_MS);
    redraw();
    /** @type {HTMLElement | null} */ (document.querySelector(".shell-run.confirming [data-key=shell-cancel]"))?.focus({ preventScroll: true });
  };
  if (openedAt) {
    const held = Date.now() - openedAt < HOLD_MS;
    const cancel = () => ((ui.confirmShell = null), redraw());
    const go = () => {
      if (Date.now() - openedAt < HOLD_MS) return;
      ui.confirmShell = null;
      fire(key, () => post(`/api/sessions/${s.id}/keys`, { action: "shell", command: shell }).then(() => toast(t.sent(t.shellSent, label(s)))), redraw);
    };
    const marked = markedCommand(shell);
    return h(
      "div",
      { class: "shell-run confirming", "data-key": "shell-run", role: "group", "aria-label": t.shellConfirm },
      h("p", { class: "shell-ask" }, h("b", {}, t.shellConfirm), " ", t.shellCheck, marked.some((p) => typeof p !== "string") ? [" ", t.shellNotAscii] : null),
      h("pre", { class: "shell-cmd" }, marked),
      // Run at the far end, never where the clicks that opened it were: one more by habit finds Cancel or nothing.
      h("div", { class: "shell-foot" }, h("button", { class: "secondary", "data-key": "shell-cancel", onclick: cancel }, t.shellCancel), h("button", { class: "primary shell-go", "data-key": "shell-go", disabled: held, onclick: go }, t.shellGo)),
    );
  }
  const clicked = () => {
    const now = Date.now();
    if (lastClick.key === key && now - lastClick.at < DOUBLE_MS) {
      lastClick = { key: "", at: 0 };
      return confirm();
    }
    lastClick = { key, at: now };
    copyClicked(shell); // as every code block
  };
  const twice = COARSE.matches ? t.shellTapTwice : t.shellClickTwice;
  return h(
    "div",
    { class: "shell-run", "data-key": "shell-run" },
    h("pre", { class: "shell-cmd", onclick: fired ? null : clicked }, shell),
    h(
      "div",
      { class: "shell-foot" },
      fired
        ? h("span", { class: `shell-fired ${fired}`, role: "status" }, fired === "sent" ? icon("check") : null, t.fired[fired])
        : [h("button", { class: "secondary", "data-key": "shell", title: t.shellHint, onclick: confirm }, t.shellRun), h("span", { class: "faint" }, twice)],
    ),
  );
}

/**
 * The command as typed, each character outside ASCII in a mark that shows its code point after it
 * (a ::after, so the text stays the command's alone): some look like others (а, U+0430, is not a).
 * @param {string} shell @returns {(string | HTMLElement)[]}
 */
function markedCommand(shell) {
  /** @type {(string | HTMLElement)[]} */
  const parts = [];
  let plain = "";
  for (const c of shell) {
    const code = c.codePointAt(0) ?? 0;
    if (code < 0x80) {
      plain += c;
      continue;
    }
    if (plain) parts.push(plain);
    plain = "";
    parts.push(h("mark", { class: "shell-cp", "data-cp": `U+${code.toString(16).toUpperCase().padStart(4, "0")}` }, c));
  }
  if (plain) parts.push(plain);
  return parts;
}

/**
 * Makes the code block holding the shell command the session asks for runnable (runnableCommand),
 * in the reply that ended its turn and while it waits live in tmux, its turn-end checks done; once sent,
 * until its outcome has shown.
 * @param {Session} s @param {Node[]} view @param {() => void} redraw
 */
export function runnableShell(s, view, redraw) {
  // Waiting while the checks at its turn's end still run is not waiting yet: they may send it back to work.
  const asked = s.tmux && s.state === "waiting" && isLive(s) && !data.checking.includes(s.id) ? (s.shellSuggestion?.text ?? "") : "";
  const firing = ui.fired?.key === shownShell.key && shownShell.key.startsWith(`${s.id} shell `) ? shownShell.text : "";
  const sent = sentOf(s, "shell");
  const shell = asked || firing || (sent?.text ?? "");
  if (!shell) return view;
  // The session's own last reply, which asked for it: a block the developer or an agent wrote never runs.
  const reply = view.filter((n) => n instanceof Element && n.matches(".msg.from-session:not(.step)")).at(-1);
  const block = reply instanceof Element ? [...reply.querySelectorAll("pre[data-copy]")].reverse().find((b) => b.textContent === shell) : undefined;
  if (!block) return view;
  // Sent: the server dropped the command, so the block keeps the key it was fired under.
  if (asked || firing) block.replaceWith(runnableCommand(s, shell, redraw, asked ? `${s.id} shell ${s.shellSuggestion?.at ?? ""}` : shownShell.key));
  else if (sent) {
    const done = h("div", { class: "shell-sent" });
    block.replaceWith(done);
    done.append(block, sentMark(sent.at));
  }
  return view;
}

/**
 * A button that acts only on a second click within 3 s, so a stray click does nothing. Armed in
 * `ui`, not in the button: what shows it redraws as the session changes.
 * @param {{ key: string, id: string, text: string, ask: string, act: () => Promise<unknown>, redraw: () => void, cls?: string, title?: string, idle?: import("./dom.js").Child, sentAt?: string }} b
 * `key`: one per record and action; `ask`: the armed button's question; `redraw`: draws what shows it;
 * `idle`: what it shows unarmed, when not `text` (which stays its accessible name); `sentAt`: when
 * what it sends was sent already, marked on it
 */
export function armedButton({ key, id, text, ask, act, redraw, cls = "secondary", title, idle, sentAt }) {
  const armed = () => ui.armed?.key === key && ui.armed.until > Date.now();
  const click = () => {
    if (!armed()) {
      const until = Date.now() + ARM_MS;
      ui.armed = { key, until };
      setTimeout(() => {
        if (ui.armed?.until !== until) return;
        ui.armed = null;
        redraw();
      }, ARM_MS);
      return redraw();
    }
    ui.armed = null;
    fire(key, act, redraw);
  };
  const on = armed();
  const fired = ui.fired?.key === key ? ui.fired.state : null;
  // Every label shares one cell, so a tap changes the words, not the button's width under the pointer.
  return h(
    "button",
    {
      class: `${cls} arm${on ? " armed" : ""}${fired ? ` fired ${fired}` : ""}`,
      "data-key": id,
      "aria-label": fired ? TEXT.control.fired[fired] : on ? ask : sentAt ? `${text} · ${TEXT.control.sentMarkHint(stamp(sentAt))}` : text,
      "aria-busy": fired === "sending" ? "true" : null,
      title,
      onclick: fired === "sending" ? null : click,
    },
    h(
      "span",
      { class: "arm-lbl", "aria-hidden": "true" },
      h("span", { class: "arm-idle" }, idle ?? text, sentAt ? sentMark(sentAt) : null),
      h("span", { class: "arm-ask" }, ask),
      fired ? h("span", { class: "arm-done" }, fired === "sent" ? icon("check") : null, TEXT.control.fired[fired]) : null,
    ),
  );
}
/** How long a confirmed control shows how it went. */
const FIRED_MS = 2500;

/**
 * Sends what a control was confirmed for. It shows on the control itself (`ui.fired`): sending, then
 * sent or not for FIRED_MS; a toast is easy to miss on a phone.
 * @param {string} key the control's @param {() => Promise<unknown>} act @param {() => void} redraw
 */
function fire(key, act, redraw) {
  const fired = { key, state: /** @type {"sending" | "sent" | "failed"} */ ("sending") };
  ui.fired = fired;
  redraw();
  /** @param {"sent" | "failed"} state */
  const settle = (state) => {
    fired.state = state;
    redraw();
    setTimeout(() => ui.fired === fired && ((ui.fired = null), redraw()), FIRED_MS);
  };
  run(
    act().then(
      () => settle("sent"),
      (/** @type {Error} */ e) => {
        settle("failed");
        throw e; // run() shows why in a toast
      },
    ),
  );
}

/**
 * Forgetting a session that ended or whose process is gone: it leaves the desk at once, what it
 * asked dismissed, its results and decisions kept in History. Never offered for a live session.
 * @param {Session} s @param {() => void} redraw @param {string} cls
 */
export function forgetButton(s, redraw, cls) {
  if (isLive(s)) return null;
  const t = TEXT.control;
  const act = () =>
    post(`/api/sessions/${encodeURIComponent(s.id)}/forget`, {}).then(() => {
      if (ui.panelSession === s.id) dialog("session").close();
      toast(t.forgot(label(s)));
    });
  return armedButton({ key: `${s.id} forget`, id: "forget", text: t.forget, ask: t.forgetConfirm, act, redraw, cls, title: t.forgetHint });
}

/**
 * Keys the desk may send a session that runs inside tmux, and ending the session's process, each
 * after a confirming click.
 * @param {Session} s @param {Metrics | undefined} m @param {() => void} redraw redraws the panel that shows them
 */
export function controlSection(s, m, redraw) {
  const endable = Boolean(s.process?.start);
  if ((!s.tmux && !endable) || !isLive(s)) return null;
  /** @param {string} id @param {string} text @param {string} ask the armed button's question @param {() => Promise<unknown>} act @param {string} [cls] */
  const confirmed = (id, text, ask, act, cls) => armedButton({ key: `${s.id} ${id}`, id, text, ask, act, redraw, cls });
  /** @param {string} action @param {string} text @param {string} [ask] */
  const key = (action, text, ask = TEXT.control.confirm(text)) => confirmed(action, text, ask, () => post(`/api/sessions/${s.id}/keys`, { action }).then(() => toast(TEXT.control.sent(text, label(s)))));
  // With the instructions the session suggested, the button shows the start of what it types; the
  // server types them only while they are still these.
  const instructions = s.compactInstructions?.text ?? "";
  const compacted = sentOf(s, "compact");
  // A bare /compact is marked after any: the instructions are dropped once the context is compacted.
  const compactSentAt = compacted && (!instructions || compacted.text === instructions) ? compacted.at : undefined;
  const compactKey = instructions
    ? armedButton({
        key: `${s.id} compact ${s.compactInstructions?.at}`,
        id: "compact",
        text: TEXT.control.compactWith(instructions),
        ask: TEXT.control.confirm("/compact"),
        title: `/compact ${instructions}`,
        idle: h("span", { class: "compact-with" }, h("span", {}, "/compact"), h("span", { class: "compact-preview" }, instructions)),
        act: () => post(`/api/sessions/${s.id}/keys`, { action: "compact", instructions }).then(() => toast(TEXT.control.sent(TEXT.control.compactSent, label(s)))),
        redraw,
        sentAt: compactSentAt,
      })
    : armedButton({ key: `${s.id} compact`, id: "compact", text: "/compact", ask: TEXT.control.confirm("/compact"), redraw, sentAt: compactSentAt, act: () => post(`/api/sessions/${s.id}/keys`, { action: "compact" }).then(() => toast(TEXT.control.sent("/compact", label(s)))) });
  // What its adapter says starts the session afresh (a handoff), when it is not /compact itself; the server types it only while it is still this one.
  const fresh = m?.coldResume?.command;
  const freshSent = sentOf(s, "fresh");
  const freshKey =
    fresh && fresh !== "/compact"
      ? armedButton({ key: `${s.id} fresh ${fresh}`, id: "fresh", text: fresh, ask: TEXT.control.confirm(fresh), title: TEXT.control.freshHint, redraw, sentAt: freshSent?.text === fresh ? freshSent.at : undefined, act: () => post(`/api/sessions/${s.id}/keys`, { action: "fresh", command: fresh }).then(() => toast(TEXT.control.sent(fresh, label(s)))) })
      : null;
  // The terminal shows a dialog (a permission prompt, a question with options) only while the
  // session has one open; the keys that answer it are offered only then.
  const asksInDialog = asksOf(s.id).some((q) => q.kind === "permission" || q.kind === "question");
  return [
    s.tmux
      ? h(
          "div",
          { class: "rsec" },
          h("h4", {}, TEXT.control.title),
          h(
            "div",
            { class: "row wt-actions" },
            compactKey,
            freshKey,
            key("interrupt", TEXT.control.interrupt),
            asksInDialog ? [h("span", { class: "faint" }, TEXT.control.dialog), ...[1, 2, 3, 4, 5].map((n) => key(`option-${n}`, String(n), TEXT.control.confirmShort(String(n)))), key("enter", "Enter", TEXT.control.confirmShort("Enter"))] : null,
          ),
          !ON_THIS_MACHINE ? attachLine(s.tmux) : null,
        )
      : null,
    endable
      ? h(
          "div",
          { class: "rsec" },
          h("h4", {}, TEXT.control.session),
          h(
            "div",
            { class: "row wt-actions" },
            confirmed("end", TEXT.control.end, TEXT.control.endConfirm, () => post(`/api/sessions/${s.id}/end`, {}).then(() => toast(TEXT.control.ended(label(s)))), "secondary danger"),
            h("span", { class: "faint" }, TEXT.control.endHint),
          ),
        )
      : null,
  ];
}
const ARM_MS = 3000;

/**
 * The command that opens the session's terminal from another one (an SSH client on a phone). The
 * socket is a path the session reported: shown only when it cannot carry shell syntax.
 * @param {{ socket: string, pane: string }} where
 */
function attachLine({ socket, pane }) {
  const plain = /\/tmux-\d+\/default$/.test(socket);
  if (!plain && !/^[\w./-]+$/.test(socket)) return null;
  const command = `tmux ${plain ? "" : `-S ${socket} `}attach -t ${pane}`;
  return h("div", { class: "attach" }, h("span", {}, TEXT.control.attach), h("code", {}, command), h("button", { class: "secondary", onclick: () => copy(command) }, icon("copy"), TEXT.copy));
}
