// Handles vscode://agent-desk.agent-desk/focus?session=<id>: brings that session's terminal to the front.
// It only focuses an existing terminal of a registered session: it never types, runs, opens or fetches anything.
import * as fs from "node:fs";
import * as vscode from "vscode";
import { InputError } from "../../../src/core/check.ts";
import { id } from "../../../src/core/ids.ts";
import { readSession, type Session } from "../../../src/core/model.ts";
import { isAlive } from "../../../src/core/proc.ts";
import { StorePaths, storeHome } from "../../../src/store/paths.ts";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) =>
        focusSession(uri).catch((error: unknown) => {
          void vscode.window.showWarningMessage(`agent-desk: ${(error as Error).message}`);
        }),
    }),
  );
}

export function deactivate(): void {}

async function focusSession(uri: vscode.Uri): Promise<void> {
  if (uri.path !== "/focus") throw new InputError(`unknown link ${uri.path}; expected /focus?session=<id>`);
  const sessionId = id(new URLSearchParams(uri.query).get("session"), "session");
  const session = registered(sessionId);
  const own = session.process;
  if (session.state === "ended" || !own || !isAlive(own.pid, own.start)) {
    // Its pid may now belong to another program, so its old terminal is not looked for.
    throw new Error(`the session «${session.title ?? session.id}» of ${session.project.name} is no longer running`);
  }
  // Inside tmux the session descends from the tmux server, not from the editor's terminal; the
  // terminal is then one of the clients attached to the session's tmux session.
  const chain = new Set([session.process?.pid, ...(session.process?.ancestors ?? []), ...(session.tmux?.clients ?? [])]);
  for (const terminal of vscode.window.terminals) {
    const pid = await terminal.processId;
    if (pid !== undefined && chain.has(pid)) {
      terminal.show(false);
      return;
    }
  }
  throw new Error(
    `the session «${session.title ?? session.id}» of ${session.project.name} does not run in a terminal of this VS Code window; it may be in another window`,
  );
}

function registered(sessionId: string): Session {
  const file = new StorePaths(storeHome()).session(sessionId);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`no session ${sessionId} in the agent-desk store (${(error as Error).message})`, { cause: error });
  }
  const session = readSession(JSON.parse(raw) as unknown, file);
  if (!session.process) throw new Error(`session ${sessionId} did not record its process, so its terminal cannot be found`);
  return session;
}
