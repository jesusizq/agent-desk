// @ts-check
// Session control: the tmux keys the desk may send a session, ending its process, and forgetting it once
// it ended, each after a confirming click.
import { dialog, h, icon } from "./dom.js";
import { TEXT } from "./text.js";
import { copy, toast } from "./pieces.js";
import { post, run } from "./server.js";
import { asksOf, isLive, label, ON_THIS_MACHINE, ui } from "./state.js";

/** @typedef {import("../core/protocol.ts").Session} Session */

/**
 * A button that acts only on a second click within 3 s, so a stray click does nothing. Armed in
 * `ui`, not in the button: what shows it redraws as the session changes.
 * @param {{ key: string, id: string, text: string, ask: string, act: () => Promise<unknown>, redraw: () => void, cls?: string, title?: string, idle?: import("./dom.js").Child }} b
 * `key`: one per record and action; `ask`: the armed button's question; `redraw`: draws what shows it;
 * `idle`: what it shows unarmed, when not `text` (which stays its accessible name)
 */
export function armedButton({ key, id, text, ask, act, redraw, cls = "secondary", title, idle }) {
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
    redraw();
    run(act());
  };
  const on = armed();
  // Both labels share one cell, so arming changes the words, not the button's width under the pointer.
  return h(
    "button",
    { class: `${cls} arm${on ? " armed" : ""}`, "data-key": id, "aria-label": on ? ask : text, title, onclick: click },
    h("span", { class: "arm-lbl", "aria-hidden": "true" }, h("span", { class: "arm-idle" }, idle ?? text), h("span", { class: "arm-ask" }, ask)),
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
 * @param {Session} s @param {() => void} redraw redraws the panel that shows them
 */
export function controlSection(s, redraw) {
  const endable = Boolean(s.process?.start);
  if ((!s.tmux && !endable) || !isLive(s)) return null;
  /** @param {string} id @param {string} text @param {string} ask the armed button's question @param {() => Promise<unknown>} act @param {string} [cls] */
  const confirmed = (id, text, ask, act, cls) => armedButton({ key: `${s.id} ${id}`, id, text, ask, act, redraw, cls });
  /** @param {string} action @param {string} text @param {string} [ask] */
  const key = (action, text, ask = TEXT.control.confirm(text)) => confirmed(action, text, ask, () => post(`/api/sessions/${s.id}/keys`, { action }).then(() => toast(TEXT.control.sent(text, label(s)))));
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
            key("compact", "/compact"),
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
