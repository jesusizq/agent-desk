// Entry point for Claude Code: `agent-desk-claude hook|wait|statusline`. See adapters/claude-code/README.md.
import { spawn } from "node:child_process";
import * as path from "node:path";
import { sessionProcess } from "../../src/core/proc.ts";
import { tmuxLocation } from "../../src/core/tmux.ts";
import { storeHome } from "../../src/store/paths.ts";
import { Store } from "../../src/store/store.ts";
import { handleHook, type HookOutput, readHookInput, waitForAnswer, waitForPermission } from "./hooks.ts";
import { metricsFromStatusLine, sessionNameFromStatusLine } from "./statusline.ts";

const WAIT_POLL_MS = 500;
const WAIT_ARM_MS = 10_000;
// Below the hook's configured timeout (hooks/hooks.json), so the waiter ends on its own terms.
const WAIT_MAX_MS = 23 * 3600_000;
const PERMISSION_POLL_MS = 300;
// Below the PermissionRequest hook's timeout in hooks/hooks.json (600 s).
const PERMISSION_WAIT_MS = 590_000;

const CLI = path.join(import.meta.dirname, "..", "..", "src", "cli", "main.ts");
const SCAN_EVERY_S = 600;

/** A detached `agent-desk scan`, so measuring folders never delays the end of a turn. */
function startScan(projectDir: string): void {
  const child = spawn(process.execPath, [CLI, "scan", projectDir, "--if-older-than", String(SCAN_EVERY_S)], { detached: true, stdio: "ignore" });
  child.on("error", (error) => process.stderr.write(`agent-desk: could not start the worktree scan: ${error.message}\n`));
  child.unref();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function finish(out: HookOutput): never {
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(`${out.stderr}\n`);
  process.exit(out.code);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const input = await readStdin();
  const store = new Store(storeHome());

  if (command === "hook") {
    const hook = readHookInput(input);
    const out = handleHook(hook, { store, env: process.env, sessionProcess: () => sessionProcess(), startScan, tmuxLocation: () => tmuxLocation(process.env) });
    if (hook.event === "PermissionRequest" && out.questionId) {
      const stop = new AbortController();
      for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => stop.abort());
      const decided = await waitForPermission(hook.sessionId, out.questionId, store, { pollMs: PERMISSION_POLL_MS, armWithinMs: 0, deadline: Date.now() + PERMISSION_WAIT_MS, signal: stop.signal });
      finish({ ...decided, ...(out.stderr ? { stderr: out.stderr } : {}) });
    }
    finish(out);
  }

  if (command === "wait") {
    const { sessionId } = readHookInput(input);
    const stop = new AbortController();
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => stop.abort());
    finish(await waitForAnswer(sessionId, store, { pollMs: WAIT_POLL_MS, armWithinMs: WAIT_ARM_MS, deadline: Date.now() + WAIT_MAX_MS, signal: stop.signal }));
  }

  if (command === "statusline") {
    // `statusline -- <program> [args…]`: records the metrics, then hands the same input to the
    // program that draws the status line, so the terminal shows exactly what it showed before.
    // The program runs without a shell; a pipeline goes in as `sh -c '…'`.
    const separator = rest.indexOf("--");
    const original = separator < 0 ? [] : rest.slice(separator + 1);
    try {
      const status = JSON.parse(input) as unknown;
      const metrics = store.mergeMetrics(metricsFromStatusLine(status));
      const name = sessionNameFromStatusLine(status);
      const session = name ? store.getSession(metrics.sessionId) : undefined;
      if (name && session && session.title !== name) store.updateSession(session.id, (s) => ({ ...s, title: name }));
    } catch (error) {
      process.stderr.write(`agent-desk: status line not recorded: ${(error as Error).message}\n`);
    }
    const [program, ...args] = original;
    if (program === undefined) return;
    const child = spawn(program, args, { stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", (error) => {
      process.stderr.write(`agent-desk: could not run the status-line command ${JSON.stringify(program)}: ${error.message}\n`);
      process.exit(1);
    });
    child.stdin.end(input);
    child.on("exit", (code) => process.exit(code ?? 1));
    return;
  }

  process.stderr.write("usage: agent-desk-claude hook | wait | statusline [-- <status-line command>]  (input on stdin)\n");
  process.exit(2);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // A hook must never break the session: report and exit with a non-blocking code.
  process.stderr.write(`agent-desk: ${(error as Error).message}\n`);
  process.exit(1);
});
