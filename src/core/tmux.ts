// tmux: where a session runs when it runs inside tmux, and the few keys the desk may send it.
// Every call is `tmux` with an argument list (no shell), against the socket the session reported.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { compactInstructionsLine, TMUX_PANE } from "./model.ts";

const TIMEOUT_MS = 3000;

function tmux(socket: string, ...args: string[]): string {
  return execFileSync("tmux", ["-S", socket, ...args], { timeout: TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * From the environment tmux gives the processes in a pane (TMUX="socket,pid,index", TMUX_PANE="%3"):
 * the socket, the pane and the processes of the terminals attached to its tmux session.
 */
export function tmuxLocation(env: NodeJS.ProcessEnv): { socket: string; pane: string; clients: number[] } | undefined {
  const socket = env.TMUX?.split(",")[0];
  const pane = env.TMUX_PANE;
  if (!socket || !pane || !TMUX_PANE.test(pane)) return undefined;
  const session = tmux(socket, "display-message", "-p", "-t", pane, "#{session_id}").trim();
  const clients = tmux(socket, "list-clients", "-t", session, "-F", "#{client_pid}")
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 1);
  return { socket, pane, clients };
}

/**
 * Inside tmux, TERM_PROGRAM says "tmux"; the terminal the developer actually looks at is the one
 * attached to it, whose own TERM_PROGRAM (e.g. "vscode") is read from /proc.
 */
export function outerTerminal(clients: number[]): string | undefined {
  for (const pid of clients) {
    let environ: string;
    try {
      environ = readFileSync(`/proc/${pid}/environ`, "utf8");
    } catch {
      continue; // a client that detached or belongs to someone else tells nothing
    }
    const value = environ.split("\0").find((v) => v.startsWith("TERM_PROGRAM="))?.slice("TERM_PROGRAM=".length);
    if (value && value !== "tmux") return value;
  }
  return undefined;
}

/** The keys the desk may send a session, by name; nothing else can be sent. */
export const TMUX_ACTIONS = {
  compact: [["-l", "/compact"], ["Enter"]],
  interrupt: [["Escape"]],
  enter: [["Enter"]],
  "option-1": [["-l", "1"]],
  "option-2": [["-l", "2"]],
  "option-3": [["-l", "3"]],
  "option-4": [["-l", "4"]],
  "option-5": [["-l", "5"]],
} as const satisfies Record<string, readonly (readonly string[])[]>;
export type TmuxAction = keyof typeof TMUX_ACTIONS;

/**
 * Characters typed by one send-keys: a terminal prompt may take a longer burst as a paste, which Enter
 * then sends as text instead of running the command (one was seen to from about 850).
 */
const TYPED_CHUNK = 400;

/**
 * The keys of an action. `compact` alone carries text: the instructions the session suggested for
 * its compaction, typed as one line after `/compact` (compactInstructionsLine), so they can type no
 * other key; without them it is `/compact` alone. The line ends in a space, which closes a completion
 * menu its last word opened (an `@file`), so Enter sends it instead of picking from that menu.
 */
export function tmuxKeys(action: TmuxAction, instructions = ""): readonly (readonly string[])[] {
  if (instructions === "") return TMUX_ACTIONS[action];
  if (action !== "compact") throw new Error(`only /compact takes instructions, not ${action}; nothing was sent`);
  const line = compactInstructionsLine(instructions);
  if (line === "") return TMUX_ACTIONS.compact;
  return [...typedChunks(`/compact ${line} `).map((chunk) => ["-l", chunk]), ["Enter"]];
}

/**
 * `text` in pieces of at most TYPED_CHUNK characters, each cut after a space where it has one, and
 * never after a `;` (tmux reads an argument ending in one as the end of its command and drops it),
 * a `\` or half a character.
 */
function typedChunks(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > TYPED_CHUNK) {
    let cut = rest.lastIndexOf(" ", TYPED_CHUNK - 1) + 1;
    if (cut === 0) for (cut = TYPED_CHUNK; cut > 0 && /[;\\\ud800-\udbff]/.test(rest.charAt(cut - 1)); cut--);
    if (cut === 0) throw new Error(`the instructions hold ${TYPED_CHUNK} characters in a row that are all ';' or '\\'; nothing was sent`);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return [...chunks, rest];
}

/**
 * Sends one allowed action to a pane, after checking that the pane still hosts the session: the
 * pane's own process must be the session process or one of its ancestors.
 */
export function sendTmuxAction(where: { socket: string; pane: string }, sessionPids: number[], action: TmuxAction, instructions = ""): void {
  if (!TMUX_PANE.test(where.pane)) throw new Error(`not a tmux pane: ${where.pane}`);
  const keys = tmuxKeys(action, instructions);
  const panePid = Number(tmux(where.socket, "display-message", "-p", "-t", where.pane, "#{pane_pid}").trim());
  if (!sessionPids.includes(panePid)) throw new Error(`tmux pane ${where.pane} no longer hosts this session; nothing was sent`);
  for (const k of keys) tmux(where.socket, "send-keys", "-t", where.pane, ...k);
}
