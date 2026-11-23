// @ts-check
// Session control: the tmux keys the desk may send a session, ending its process, and forgetting it once
// it ended, each after a confirming click.
import { dialog, h, icon } from "./dom.js";
import { TEXT } from "./text.js";
import { copy, toast } from "./pieces.js";
import { post, run } from "./server.js";
import { asksOf, isLive, label, ON_THIS_MACHINE, ui } from "./state.js";
import { stamp } from "./format.js";

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

/** The last shell command shown on a button, kept so that button can show it was sent after the server dropped it. */
let shownShell = { key: "", text: "" };
/**
 * The reply's code block holding the shell command the session asked for, made a two-tap button that
 * runs it, showing the command until armed.
 * @param {Session} s @param {string} shell @param {() => void} redraw
 * @param {string} key the button's key: the one it was fired under, once the server dropped the command
 */
function shellButton(s, shell, redraw, key) {
  shownShell = { key, text: shell };
  return armedButton({
    key,
    id: "shell",
    text: shell,
    idle: h("pre", {}, shell),
    ask: TEXT.control.shellAsk,
    title: TEXT.control.shellHint,
    cls: "secondary shell-run",
    redraw,
    act: () => post(`/api/sessions/${s.id}/keys`, { action: "shell", command: shell }).then(() => toast(TEXT.control.sent(TEXT.control.shellSent, label(s)))),
  });
}

/**
 * Makes the reply's code block holding the shell command the session asks for a two-tap button that
 * runs it, while the session waits in tmux; once sent, until its outcome has shown.
 * @param {Session} s @param {Node[]} view @param {() => void} redraw
 */
export function runnableShell(s, view, redraw) {
  const asked = s.tmux && s.state === "waiting" ? (s.shellSuggestion?.text ?? "") : "";
  const firing = ui.fired?.key === shownShell.key && shownShell.key.startsWith(`${s.id} shell `) ? shownShell.text : "";
  const sent = sentOf(s, "shell");
  const shell = asked || firing || (sent?.text ?? "");
  if (!shell) return view;
  const blocks = view.flatMap((n) => (n instanceof Element ? [...n.querySelectorAll("pre[data-copy]")] : []));
  const block = blocks.reverse().find((b) => b.textContent === shell);
  if (!block) return view;
  // Sent: the server dropped the command, so the button keeps the key it was fired under.
  if (asked || firing) block.replaceWith(shellButton(s, shell, redraw, asked ? `${s.id} shell ${s.shellSuggestion?.at ?? ""}` : shownShell.key));
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
    // Each tap shows on the button itself: armed, then sending, then sent or not; a toast is easy to miss on a phone.
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
