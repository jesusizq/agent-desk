// The instructions a session suggests for its compaction: read from its replies at the end of a turn,
// kept on the session until a compaction is done, printed by PreCompact for one given none, and typed
// by the desk's /compact button (test/server.test.ts) as one line.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { compactSuggestionIn, latestCompactSuggestion } from "../adapters/claude-code/compact.ts";
import { handleHook, type HookContext, readHookInput, recordHandoff } from "../adapters/claude-code/hooks.ts";
import { COMPACT_INSTRUCTIONS_MAX, compactInstructionsLine, readSession } from "../src/core/model.ts";
import { TMUX_ACTIONS, tmuxKeys } from "../src/core/tmux.ts";
import type { Store } from "../src/store/store.ts";
import { tempHome, testStore } from "./helpers.ts";

const MAIN = path.join(import.meta.dirname, "..", "adapters", "claude-code", "main.ts");
const block = (body: string, fence = "```") => `${fence}\n${body}\n${fence}`;
/** Every kind of character that could type something else: line breaks, Enter, Ctrl-C, Escape sequences, bidi overrides. */
const HOSTILE = "keep the plan\r\nand the decisions\n\nthen\tthe next steps\x03\x1b[2J\x7f\u0085 ‮evil‬ done;";
const HOSTILE_LINE = "keep the plan and the decisions then the next steps[2J evil done";

function setup() {
  const dir = fs.realpathSync(tempHome());
  const store = testStore();
  const transcript = path.join(dir, "cc-1.jsonl");
  const ctx: HookContext = { store, env: { TERM_PROGRAM: "vscode", CLAUDE_PROJECT_DIR: dir }, sessionProcess: () => ({ pid: process.pid, ancestors: [] }) };
  const event = (hook_event_name: string, extra: Record<string, unknown> = {}) =>
    readHookInput(JSON.stringify({ session_id: "cc-1", cwd: dir, transcript_path: transcript, hook_event_name, ...extra }));
  handleHook(event("SessionStart", { source: "startup" }), ctx);
  return { dir, store, transcript, ctx, event };
}
const line = (entry: object) => `${JSON.stringify(entry)}\n`;
const said = (text: string) => line({ type: "assistant", message: { content: [{ type: "text", text }] } });
const instructionsOf = (store: Store) => store.getSession("cc-1")?.compactInstructions;

describe("suggested compact instructions", () => {
  it("are one line that can type nothing but itself: no line breaks, control, bidi or invisible characters, no trailing semicolon or backslash", () => {
    assert.equal(compactInstructionsLine(HOSTILE), HOSTILE_LINE);
    assert.equal(compactInstructionsLine("  keep it ;; ; "), "keep it");
    assert.equal(compactInstructionsLine(String.raw`keep it\;\ `), "keep it", "a \\ and Enter could make a new line instead of sending it");
    assert.equal(compactInstructionsLine("keep\u200b \u2060it\u061c"), "keep it", "nothing the preview would not show");
    assert.equal(compactInstructionsLine("keep the plan", 8), "keep the");
    assert.equal(compactInstructionsLine("\n\x1b\x03 ;"), "");
    const long = compactInstructionsLine(`${"word ".repeat(3000)}`);
    assert.ok(long.length <= COMPACT_INSTRUCTIONS_MAX && long.length > COMPACT_INSTRUCTIONS_MAX - 10, `${long.length} characters`);
    const emoji = compactInstructionsLine("a".repeat(COMPACT_INSTRUCTIONS_MAX - 1) + "😀😀");
    assert.equal(emoji, "a".repeat(COMPACT_INSTRUCTIONS_MAX - 1), "a cut never leaves half a character");
    assert.equal(compactInstructionsLine(long), long, "already one line: unchanged");
    // tmux refuses a command of more than about 16 KiB: 10,000 characters of "é" are 20,000 bytes.
    assert.equal(compactInstructionsLine("é".repeat(COMPACT_INSTRUCTIONS_MAX)), "é".repeat(6000));
    assert.equal(compactInstructionsLine("😀".repeat(COMPACT_INSTRUCTIONS_MAX)), "😀".repeat(3000), "cut by bytes, never half a character");
  });

  it("are read from the last code block of a reply that starts with /compact, and from no other", () => {
    assert.equal(compactSuggestionIn(`Done.\n\n${block("/compact keep the plan")}`), "keep the plan");
    assert.equal(compactSuggestionIn(`${block("/compact first")}\n\nthen\n\n${block("/compact second\nover two lines", "~~~")}`), "second over two lines");
    assert.equal(compactSuggestionIn("```text\n/compact with an info string\n```"), "with an info string");
    assert.equal(compactSuggestionIn("  - item\n\n    ```\n    /compact inside a list\n    ```"), "inside a list");
    assert.equal(compactSuggestionIn("````\n/compact a longer fence\n```\nstill inside\n````"), "a longer fence ``` still inside", "a shorter fence does not close it: it is a line of the block");
    assert.equal(compactSuggestionIn(`${block("/compact")}`), undefined, "a bare /compact suggests no instructions");
    assert.equal(compactSuggestionIn(`${block("npm test")}\n\nRun /compact keep it`), undefined, "outside a block, or a block that is another command");
    assert.equal(compactSuggestionIn("```/compact inline```"), undefined, "inline code is no block");
    assert.equal(compactSuggestionIn(`${block("/compact not this one")}\n\n${block("/compact")}`), "not this one", "a bare one after it changes nothing");
    assert.equal(compactSuggestionIn("Paste this:\n```\n/compact left open"), "left open", "a block left open runs to the end");
    assert.equal(compactSuggestionIn(block(`/compact ${HOSTILE}`)), HOSTILE_LINE);
    assert.equal(latestCompactSuggestion([block("/compact older"), "nothing here", block("/compact newer"), "Done."]), "newer");
    assert.equal(latestCompactSuggestion(["nothing", "here"]), undefined);
  });

  it("are kept on the session at the end of the turn that suggests them, with their time, until a compaction is done", () => {
    const { store, transcript, ctx, event } = setup();
    fs.writeFileSync(transcript, "");
    handleHook(event("Stop", { last_assistant_message: "Nothing to compact." }), ctx);
    assert.equal(instructionsOf(store), undefined, "no suggestion, nothing kept");

    fs.writeFileSync(transcript, line({ type: "user", message: { content: "go on" } }) + said(`Half way.\n\n${block(`/compact ${HOSTILE}`)}`) + line({ type: "user", message: { content: [{ type: "tool_result" }] } }));
    handleHook(event("Stop", { last_assistant_message: "Done." }), ctx);
    const kept = instructionsOf(store);
    assert.equal(kept?.text, HOSTILE_LINE, "written between its tool calls, as one line");
    assert.ok(kept && !Number.isNaN(Date.parse(kept.at)));

    fs.writeFileSync(transcript, line({ type: "system", subtype: "turn_duration" }) + line({ type: "user", message: { content: "and now?" } }));
    handleHook(event("Stop", { last_assistant_message: "A turn that suggests nothing." }), ctx);
    assert.deepEqual(instructionsOf(store), kept, "the latest suggestion stays");
    handleHook(event("Stop", { last_assistant_message: `Ready.\n\n${block("/compact keep only the next steps")}` }), ctx);
    assert.equal(instructionsOf(store)?.text, "keep only the next steps", "its last message, newer, replaces it");

    handleHook(event("SessionStart", { source: "resume" }), ctx);
    assert.equal(instructionsOf(store)?.text, "keep only the next steps", "a resume compacted nothing");
    handleHook(event("SessionStart", { source: "compact" }), ctx);
    assert.equal(instructionsOf(store), undefined, "gone once a compaction is done");
  });

  it("are read from a session record as one line, whatever it holds, and refused when nothing is left of them", () => {
    const at = "2026-11-20T10:00:00.000Z";
    const session = { id: "cc-1", provider: "Claude Code", project: { name: "shop", dir: "/work/shop" }, state: "waiting", startedAt: at, updatedAt: at };
    const read = (text: string) => readSession({ ...session, compactInstructions: { text, at } }).compactInstructions?.text;
    for (const text of ["keep it", "keep\nit", "keep it;", " keep it", "keep \u200bit\\"]) assert.equal(read(text), "keep it", JSON.stringify(text));
    assert.equal(read("\x1b[2J"), "[2J");
    for (const text of ["", "\x1b\x03 ;", "a".repeat(COMPACT_INSTRUCTIONS_MAX + 1)]) {
      assert.throws(() => readSession({ ...session, compactInstructions: { text, at } }), /compactInstructions\.text/, JSON.stringify(text.slice(0, 20)));
    }
  });

  it("are printed by PreCompact for a compaction given none, cut to Claude Code's cap, and never once a compaction is done", async () => {
    const { store, transcript, ctx, event } = setup();
    fs.writeFileSync(transcript, "");
    const auto = () => recordHandoff(event("PreCompact", { trigger: "auto", custom_instructions: null }), ctx);

    const none = await auto();
    assert.equal(none.code, 0, none.stderr);
    assert.equal(none.stdout, undefined, "no suggestion: nothing printed, the project's compact instructions apply");
    assert.ok(store.getHandoff("cc-1"), "the handoff is recorded all the same");

    handleHook(event("Stop", { last_assistant_message: block(`/compact ${HOSTILE}`) }), ctx);
    assert.equal((await auto()).stdout, HOSTILE_LINE);
    assert.equal((await recordHandoff(event("PreCompact", { trigger: "manual", custom_instructions: null }), ctx)).stdout, HOSTILE_LINE, "a bare /compact typed in the terminal");
    for (const custom of ["keep the plan", HOSTILE_LINE]) {
      const own = await recordHandoff(event("PreCompact", { trigger: "manual", custom_instructions: custom }), ctx);
      assert.equal(own.stdout, undefined, `a compaction with its own instructions (${custom.slice(0, 13)}) gets no others`);
    }

    handleHook(event("Stop", { last_assistant_message: block(`/compact ${"keep every decision; ".repeat(1000)}`) }), ctx);
    const long = (await auto()).stdout ?? "";
    assert.ok(long.length <= COMPACT_INSTRUCTIONS_MAX && long.startsWith("keep every decision; keep"), `${long.length} characters`);

    // An automatic compaction mid-turn: the turn's suggestion is not on the session yet, and it is the latest.
    fs.writeFileSync(transcript, line({ type: "user", message: { content: "go on" } }) + said(block("/compact from this very turn")) + line({ type: "user", message: { content: [{ type: "tool_result" }] } }));
    assert.equal((await auto()).stdout, "from this very turn");

    handleHook(event("SessionStart", { source: "compact" }), ctx);
    // The compaction summary starts the transcript again: what came before it is the compacted context.
    fs.appendFileSync(transcript, line({ type: "system", subtype: "compact_boundary" }) + line({ type: "user", isCompactSummary: true, message: { content: "This session is being continued…" } }));
    assert.equal((await auto()).stdout, undefined, "an old suggestion never compacts the context that followed it");
    handleHook(event("Stop", { last_assistant_message: "Continued." }), ctx);
    assert.equal(instructionsOf(store), undefined, "nor comes back at the next end of a turn");
  });

  it("reach Claude Code as the PreCompact hook's whole stdout, through the adapter's own process", async () => {
    const { dir, store, transcript, ctx, event } = setup();
    fs.writeFileSync(transcript, "");
    handleHook(event("Stop", { last_assistant_message: block("/compact keep the plan\nand the decisions") }), ctx);
    const run = (extra: object) =>
      new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [MAIN, "hook"], { env: { ...process.env, AGENT_DESK_HOME: store.paths.home, CLAUDE_PROJECT_DIR: dir } });
        let stdout = "";
        child.stdout.on("data", (d: Buffer) => (stdout += d));
        child.on("error", reject);
        child.on("exit", (code) => resolve({ code, stdout }));
        child.stdin.end(JSON.stringify({ session_id: "cc-1", cwd: dir, transcript_path: transcript, hook_event_name: "PreCompact", ...extra }));
      });
    assert.deepEqual(await run({ trigger: "auto", custom_instructions: null }), { code: 0, stdout: "keep the plan and the decisions" });
    assert.deepEqual(await run({ trigger: "manual", custom_instructions: "my own" }), { code: 0, stdout: "" });
  });

  it("are typed after /compact as one line, by the compact action only", () => {
    assert.deepEqual(tmuxKeys("compact"), TMUX_ACTIONS.compact);
    assert.deepEqual(tmuxKeys("compact", HOSTILE), [["-l", `/compact ${HOSTILE_LINE} `], ["Enter"]], "a space last, closing a menu its last word opened");
    // A prompt takes a long burst as a paste, which Enter sends as text: typed in pieces, none ending in ';'.
    for (const text of ["keep every decision; ".repeat(600), `${"x".repeat(390)};;;;;;;;;;;;;;;;;;;;${"y".repeat(500)}`, "😀".repeat(3000), "é".repeat(6000)]) {
      const keys = tmuxKeys("compact", text);
      const typed = keys.slice(0, -1);
      assert.deepEqual(keys.at(-1), ["Enter"]);
      assert.equal(typed.map((k) => k[1]).join(""), `/compact ${compactInstructionsLine(text)} `, "the whole line, in order");
      for (const [flag, chunk = ""] of typed) {
        assert.equal(flag, "-l");
        assert.ok(chunk.length <= 400 && !/[;\\\ud800-\udbff]$/.test(chunk), `${chunk.length} characters ending ${JSON.stringify(chunk.slice(-3))}`);
      }
    }
    assert.throws(() => tmuxKeys("compact", `a${";".repeat(500)}b`), /all ';' or '\\'; nothing was sent/);
    assert.deepEqual(tmuxKeys("compact", "\n\x03;"), TMUX_ACTIONS.compact, "nothing left of them: /compact alone");
    assert.throws(() => tmuxKeys("enter", "keep it"), /only \/compact takes instructions, not enter/);
  });
});
