// @ts-check
// Session control: the tmux keys the desk may send a session, and ending its process, each after a confirming click.
import { h, icon } from "./dom.js";
import { TEXT } from "./text.js";
import { copy, toast } from "./pieces.js";
import { post, run } from "./server.js";
import { data, isLive, label, ON_THIS_MACHINE, ui } from "./state.js";

/** @typedef {import("../core/protocol.ts").Session} Session */

/**
 * Keys the desk may send a session that runs inside tmux, and ending the session's process. Each
 * button asks for a second click within 3 s before acting, so a stray click does nothing.
 * @param {Session} s @param {() => void} redraw redraws the panel that shows them
 */
export function controlSection(s, redraw) {
  const endable = Boolean(s.process?.start);
  if ((!s.tmux && !endable) || !isLive(s)) return null;
  // Armed in `ui`, not in the button: the panel redraws as the session's metrics change.
  /** @param {string} id @param {string} text @param {string} ask the armed button's question @param {() => Promise<unknown>} act @param {string} [cls] */
  const confirmed = (id, text, ask, act, cls = "secondary") => {
    const key = `${s.id} ${id}`;
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
      { class: `${cls} arm${on ? " armed" : ""}`, "data-key": id, "aria-label": on ? ask : text, onclick: click },
      h("span", { class: "arm-lbl", "aria-hidden": "true" }, h("span", { class: "arm-idle" }, text), h("span", { class: "arm-ask" }, ask)),
    );
  };
  /** @param {string} action @param {string} text @param {string} [ask] */
  const key = (action, text, ask = TEXT.control.confirm(text)) => confirmed(action, text, ask, () => post(`/api/sessions/${s.id}/keys`, { action }).then(() => toast(TEXT.control.sent(text, label(s)))));
  // The terminal shows a dialog (a permission prompt, a question with options) only while the
  // session has one open; the keys that answer it are offered only then.
  const dialog = data.questions.some((q) => q.status === "open" && q.sessionId === s.id && (q.kind === "permission" || q.kind === "question"));
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
            dialog ? [h("span", { class: "faint" }, TEXT.control.dialog), ...[1, 2, 3, 4, 5].map((n) => key(`option-${n}`, String(n), TEXT.control.confirmShort(String(n)))), key("enter", "Enter", TEXT.control.confirmShort("Enter"))] : null,
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
