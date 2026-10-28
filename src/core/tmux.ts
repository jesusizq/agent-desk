// tmux: where a session runs when it runs inside tmux, and the few keys the desk may send it.
// Every call is `tmux` with an argument list (no shell), against the socket the session reported.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { TMUX_PANE } from "./model.ts";

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
 * Sends one allowed action to a pane, after checking that the pane still hosts the session: the
 * pane's own process must be the session process or one of its ancestors.
 */
export function sendTmuxAction(where: { socket: string; pane: string }, sessionPids: number[], action: TmuxAction): void {
  if (!TMUX_PANE.test(where.pane)) throw new Error(`not a tmux pane: ${where.pane}`);
  const panePid = Number(tmux(where.socket, "display-message", "-p", "-t", where.pane, "#{pane_pid}").trim());
  if (!sessionPids.includes(panePid)) throw new Error(`tmux pane ${where.pane} no longer hosts this session; nothing was sent`);
  for (const keys of TMUX_ACTIONS[action]) tmux(where.socket, "send-keys", "-t", where.pane, ...keys);
}
