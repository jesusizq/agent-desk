// The handoff around a compaction: PreCompact records where the session's work stands, and the session
// gets it back when it starts again compacted or resumed. Sub-agents' worktrees come from their calls.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { handleHook, type HookContext, readHookInput, recordHandoff } from "../adapters/claude-code/hooks.ts";
import { HANDOFF_MAX } from "../src/core/model.ts";
import type { Store } from "../src/store/store.ts";
import { tempHome, testStore } from "./helpers.ts";

const MAIN = path.join(import.meta.dirname, "..", "adapters", "claude-code", "main.ts");
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { env: ENV }).toString();

/** A project with one agent worktree two commits ahead. */
function project() {
  const root = fs.realpathSync(tempHome());
  const dir = path.join(root, "shop");
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), "");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "first");
  const wt = path.join(dir, ".claude", "worktrees", "agent-1");
  git(dir, "worktree", "add", "-q", "-b", "agent/summary", wt);
  for (const n of [1, 2]) {
    fs.writeFileSync(path.join(wt, `f${n}.txt`), String(n));
    git(wt, "add", ".");
    git(wt, "commit", "-qm", `Summary step ${n}`);
  }
  fs.writeFileSync(path.join(wt, "draft.txt"), "not committed");
  fs.mkdirSync(path.join(wt, "src"));
  return { dir, wt };
}

function ctx(store: Store, dir: string): HookContext {
  return { store, env: { TERM_PROGRAM: "vscode", CLAUDE_PROJECT_DIR: dir }, sessionProcess: () => ({ pid: process.pid, ancestors: [] }) };
}
const event = (dir: string, hook_event_name: string, extra: Record<string, unknown> = {}) => readHookInput(JSON.stringify({ session_id: "cc-1", cwd: dir, hook_event_name, ...extra }));
const contextOf = (out: { stdout?: string }) => JSON.parse(out.stdout ?? "{}").hookSpecificOutput.additionalContext as string;

describe("handoff around a compaction", () => {
  it("records the branches, agents, questions and servers before the compaction, and gives them back after it and on resume only", async () => {
    const { dir, wt } = project();
    const store = testStore();
    const c = ctx(store, dir);
    handleHook(event(dir, "SessionStart", { source: "startup" }), c);
    handleHook(event(dir, "PreToolUse", { tool_name: "Agent", tool_use_id: "toolu_1", tool_input: { description: "Order summary", subagent_type: "general-purpose", prompt: "Build the order summary." } }), c);
    handleHook(event(dir, "SubagentStart", { agent_id: "a1", agent_type: "general-purpose" }), c);
    // The sub-agent's calls run in its worktree: its record learns where it works.
    handleHook(event(path.join(wt, "src"), "PostToolUse", { agent_id: "a1", tool_name: "Bash", tool_input: { command: "npm test" } }), c);
    assert.equal(store.listAgents("cc-1")[0]?.worktree, wt, "its root, from a call in a subfolder");
    store.ask({ sessionId: "cc-1", kind: "question", text: "Ship the summary today?", options: ["Yes", "No"] });
    store.addService({ sessionId: "cc-1", name: "storybook", url: "http://localhost:6006" });

    const out = await recordHandoff(event(dir, "PreCompact", { trigger: "auto", custom_instructions: null }), c);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout ?? "", /^agent-desk recorded this session's branches, agents, open questions, local servers and open reviews/);
    const handoff = store.getHandoff("cc-1");
    assert.ok(handoff);
    assert.equal(handoff.trigger, "auto");
    assert.match(handoff.text, /^Branches \(git read <1 min ago; compared with main\):/);
    assert.match(handoff.text, /- agent order-summary \(working\) · agent\/summary · \.claude\/worktrees\/agent-1 · 2 ahead, 0 behind · 1 changed file · last «Summary step 2» <1 min ago/);
    assert.match(handoff.text, /Open on the desk, waiting for the developer:\n- Ship the summary today\? \(asked/);
    assert.match(handoff.text, /Local servers:\n- storybook http:\/\/localhost:6006/);
    assert.ok(store.getProjectScan(store.listProjectScans()[0]?.id ?? "")?.worktrees.some((w) => w.branch === "agent/summary"), "the scan read for it is kept for the desk");

    const label = /^agent-desk recorded where this session's work stood when it was last compacted \(auto\), at \d{4}-\d\d-\d\d \d\d:\d\d UTC, from its own records and git; not written by you or the developer/m;
    for (const source of ["compact", "resume"]) {
      const context = contextOf(handleHook(event(dir, "SessionStart", { source }), c));
      assert.match(context, label, source);
      assert.ok(context.endsWith(handoff.text), `${source}: the handoff closes the context`);
    }
    for (const source of ["startup", "clear"]) assert.doesNotMatch(contextOf(handleHook(event(dir, "SessionStart", { source }), c)), label, source);
  });

  it("keeps the handoff within its bound, cut at a line's end, and says it was cut", async () => {
    const { dir } = project();
    const store = testStore();
    const c = ctx(store, dir);
    handleHook(event(dir, "SessionStart", { source: "startup" }), c);
    for (let i = 0; i < 30; i++) store.ask({ sessionId: "cc-1", kind: "question", text: `Question ${i}: ${"a long question with many words ".repeat(8)}?` });
    for (let i = 0; i < 30; i++) store.upsertAgent("cc-1", `agent-${i}`, { goal: `Goal ${i} ${"word ".repeat(30)}`, state: "working" });
    for (let i = 0; i < 30; i++) store.addService({ sessionId: "cc-1", name: `server-${i}-${"x".repeat(60)}`, url: `http://localhost:${5000 + i}` });
    await recordHandoff(event(dir, "PreCompact", { trigger: "manual" }), c);
    const text = store.getHandoff("cc-1")?.text ?? "";
    assert.ok(text.length <= HANDOFF_MAX, `${text.length} characters`);
    assert.match(text, /- … 18 more agents/, "each part names a few and counts the rest");
    assert.match(text, /\n… \(cut here; agent-desk status shows all of it\)$/);
  });

  it("falls back to the last scan, saying why, when git cannot be read; never blocks the compaction", async () => {
    const dir = fs.realpathSync(tempHome()); // not a repository
    const store = testStore();
    const c = ctx(store, dir);
    const out = await recordHandoff(event(dir, "PreCompact", { trigger: "auto" }), c);
    assert.equal(out.code, 0);
    assert.match(out.stderr ?? "", /git not read for the handoff, the last scan kept instead: git worktree list --porcelain in .* failed/);
    assert.match(store.getHandoff("cc-1")?.text ?? "", /^Branches: none read for .* \(git worktree list --porcelain in .* failed/);

    // Through the adapter's own process: a broken input exits 1 (never 2, which would block) and prints nothing on stdout.
    const env = { ...process.env, AGENT_DESK_HOME: store.paths.home, CLAUDE_PROJECT_DIR: dir };
    const run = (input: string) =>
      new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [MAIN, "hook"], { env });
        let stdout = "";
        child.stdout.on("data", (d: Buffer) => (stdout += d));
        child.on("error", reject);
        child.on("exit", (code) => resolve({ code, stdout }));
        child.stdin.end(input);
      });
    const ok = await run(JSON.stringify({ session_id: "cc-2", cwd: dir, hook_event_name: "PreCompact", trigger: "manual", custom_instructions: "keep the plan" }));
    assert.equal(ok.code, 0);
    assert.match(ok.stdout, /^agent-desk recorded/);
    assert.ok(store.getHandoff("cc-2"));
    const broken = await run(JSON.stringify({ session_id: "../x", cwd: dir, hook_event_name: "PreCompact" }));
    assert.deepEqual([broken.code, broken.stdout], [1, ""]);
  });

  it("records the worktree an agent working from the main checkout reaches into: a file it reads or writes, a folder it searches, a leading cd", () => {
    const { dir, wt } = project();
    const store = testStore();
    const c = ctx(store, dir);
    handleHook(event(dir, "SessionStart", { source: "startup" }), c);
    const other = path.join(dir, ".claude", "worktrees", "agent-2");
    git(dir, "worktree", "add", "-q", "-b", "agent/other", other);
    const call = (agent_id: string, tool_name: string, tool_input: Record<string, unknown>, cwd = dir) =>
      handleHook(event(cwd, "PostToolUse", { agent_id, tool_name, tool_input }), c);
    const at = (name: string) => {
      const a = store.getAgent("cc-1", name);
      return [a?.worktree, a?.branch];
    };
    handleHook(event(dir, "SubagentStart", { agent_id: "r1", agent_type: "workflow-subagent" }), c);
    call("r1", "Bash", { command: "git diff main...agent/summary" });
    assert.deepEqual(at("workflow-subagent"), [undefined, undefined], "a command that enters no worktree names none");
    call("r1", "Bash", { command: "cd .claude/worktrees/agent-1 && node --test" });
    assert.deepEqual(at("workflow-subagent"), [wt, "agent/summary"], "a leading relative cd");
    call("r1", "Read", { file_path: path.join(other, "src", "new", "lab.ts") });
    assert.deepEqual(at("workflow-subagent"), [other, "agent/other"], "the folder of a file, even one not made yet, maps to its worktree's root");
    call("r1", "Bash", { command: "npm test" });
    assert.deepEqual(at("workflow-subagent"), [other, "agent/other"], "a later call naming no worktree keeps the last one");
    call("r1", "Grep", { pattern: "x", path: ".claude/worktrees/agent-1/src" });
    assert.deepEqual(at("workflow-subagent"), [wt, "agent/summary"], "a search path, relative to the call's folder");
    call("r1", "Bash", { command: `cd "${other}"; npm test` }, path.join(wt, "src"));
    assert.deepEqual(at("workflow-subagent"), [wt, "agent/summary"], "the worktree its cwd lies in wins over the one its call names");

    // Folders outside the project's worktrees, and cd paths the shell would expand, name none.
    const foreign = fs.realpathSync(tempHome());
    git(foreign, "init", "-q", "-b", "main");
    git(foreign, "commit", "-q", "--allow-empty", "-m", "first");
    const foreignWt = path.join(foreign, "wt");
    git(foreign, "worktree", "add", "-q", "-b", "elsewhere", foreignWt);
    handleHook(event(dir, "SubagentStart", { agent_id: "r2", agent_type: "Explore" }), c);
    call("r2", "Bash", { command: `cd ${foreignWt} && ls` });
    call("r2", "Bash", { command: "cd $WT && ls" });
    call("r2", "Edit", { file_path: path.join(dir, "README.md") });
    assert.deepEqual(at("explore"), [undefined, undefined]);
  });

  it("shows a workflow agent handing back its result as that, not as a StructuredOutput call", () => {
    const { dir } = project();
    const store = testStore();
    const c = ctx(store, dir);
    handleHook(event(dir, "SessionStart", { source: "startup" }), c);
    handleHook(event(dir, "SubagentStart", { agent_id: "w1", agent_type: "workflow-subagent" }), c);
    const call = (hook: string, tool_name: string) => handleHook(event(dir, hook, { agent_id: "w1", tool_name, tool_input: { verdict: "ok" } }), c);
    const shown = () => {
      const a = store.getAgent("cc-1", "workflow-subagent");
      return [a?.activity, a?.activityIsCall];
    };
    call("PostToolUseFailure", "StructuredOutput");
    assert.deepEqual(shown(), ["StructuredOutput", true], "a result refused by its schema is a failed call like any other");
    call("PostToolUse", "StructuredOutput");
    assert.deepEqual(shown(), ["Handed back its result", undefined]);
  });

  it("records the branch checked out in an agent's worktree, following a switch there, kept once the worktree is gone, never over one the session reported", async () => {
    const { dir, wt } = project();
    const store = testStore();
    const c = ctx(store, dir);
    handleHook(event(dir, "SessionStart", { source: "startup" }), c);
    const call = (agent_id: string, at = wt) => handleHook(event(path.join(at, "src"), "PostToolUse", { agent_id, tool_name: "Bash", tool_input: { command: "npm test" } }), c);
    handleHook(event(dir, "SubagentStart", { agent_id: "a1", agent_type: "general-purpose" }), c);
    call("a1");
    const branchOf = (name = "general-purpose") => {
      const a = store.getAgent("cc-1", name);
      return [a?.branch, a?.branchFromWorktree];
    };
    assert.deepEqual(branchOf(), ["agent/summary", true], "read from the worktree's git files at its call, no --branch");
    git(wt, "checkout", "-q", "-b", "agent/summary-2");
    call("a1");
    assert.deepEqual(branchOf(), ["agent/summary-2", true], "a branch switched in the worktree is followed");
    git(wt, "checkout", "-q", "--detach");
    call("a1");
    assert.deepEqual(branchOf(), ["agent/summary-2", true], "a detached head (a rebase) keeps the branch it was on");

    // Once the worktree is removed, the scan still finds where its branch stands.
    git(dir, "worktree", "remove", "--force", wt);
    const { refreshScan } = await import("../src/project/refresh.ts");
    const scanned = await refreshScan(store, dir, { sizes: false, whenBusy: "skip" }, []);
    assert.deepEqual(scanned?.scan.branches?.map((b) => [b.name, b.exists, b.ahead]), [["agent/summary-2", true, 2]]);
    assert.deepEqual(branchOf(), ["agent/summary-2", true]);

    // A branch the session reports wins, and a later call in a worktree does not replace it.
    const other = path.join(dir, ".claude", "worktrees", "agent-2");
    git(dir, "worktree", "add", "-q", "-b", "agent/other", other);
    fs.mkdirSync(path.join(other, "src"));
    handleHook(event(dir, "SubagentStart", { agent_id: "a2", agent_type: "Explore" }), c);
    store.reportAgent("cc-1", "explore", { branch: "agent/named" });
    call("a2", other);
    assert.deepEqual(branchOf("explore"), ["agent/named", undefined]);
    // And reported over one read from the worktree, it replaces it for good.
    store.reportAgent("cc-1", "general-purpose", { branch: "agent/final" });
    assert.deepEqual(branchOf(), ["agent/final", undefined]);
  });

  it("records no worktree for a call outside the project's linked worktrees", () => {
    const { dir } = project();
    const store = testStore();
    const c = ctx(store, dir);
    handleHook(event(dir, "SubagentStart", { agent_id: "a1", agent_type: "Explore" }), c);
    handleHook(event(dir, "PostToolUse", { agent_id: "a1", tool_name: "Read", tool_input: { file_path: "x" } }), c);
    handleHook(event(tempHome(), "PostToolUse", { agent_id: "a1", tool_name: "Read", tool_input: { file_path: "x" } }), c);
    assert.equal(store.listAgents("cc-1")[0]?.worktree, undefined);
  });
});
