import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { deliverWhileWorking, handleHook, type HookContext, waitForDialog, readablePrompt, readHookInput, splitLastParagraph, turnTexts, waitForAnswer, waitForPermission } from "../adapters/claude-code/hooks.ts";
import { metricsFromStatusLine, sessionNameFromStatusLine } from "../adapters/claude-code/statusline.ts";
import type { Store } from "../src/store/store.ts";
import { PNG, tempHome, testStore } from "./helpers.ts";

const MAIN = path.join(import.meta.dirname, "..", "adapters", "claude-code", "main.ts");

function ctx(store: Store, env: NodeJS.ProcessEnv = {}): HookContext {
  return { store, env: { TERM_PROGRAM: "vscode", CLAUDE_PROJECT_DIR: "/work/shop", ...env }, sessionProcess: () => ({ pid: 4242, ancestors: [4241, 100] }) };
}
const event = (hook_event_name: string, extra: Record<string, unknown> = {}) =>
  readHookInput(JSON.stringify({ session_id: "cc-1", cwd: "/work/shop/sub", hook_event_name, permission_mode: "auto", ...extra }));

describe("Claude Code hooks", () => {
  it("registers the session with its project, terminal and process, and gives the session its instructions", () => {
    const store = testStore();
    const out = handleHook(event("SessionStart", { source: "startup", session_title: "checkout" }), ctx(store));
    const s = store.getSession("cc-1");
    assert.equal(s?.provider, "Claude Code");
    assert.deepEqual(s?.project, { name: "shop", dir: "/work/shop" });
    assert.equal(s?.terminal, "vscode");
    assert.equal(s?.title, "checkout");
    assert.deepEqual(s?.process, { pid: 4242, ancestors: [4241, 100] });
    assert.equal(s?.state, "waiting");
    const context = JSON.parse(out.stdout ?? "{}").hookSpecificOutput.additionalContext as string;
    assert.match(context, /agent-desk ask/);
    assert.equal(store.listMetrics()[0]?.permissionMode, "auto");
  });

  it("inside tmux, events that do not look up the pane keep the terminal found with it", () => {
    const store = testStore();
    handleHook(event("SessionStart", { source: "resume" }), ctx(store));
    handleHook(event("PostToolUse", { tool_name: "Bash", tool_input: {} }), { ...ctx(store, { TERM_PROGRAM: "tmux" }), tmuxLocation: () => assert.fail("looked up the pane") });
    assert.equal(store.getSession("cc-1")?.terminal, "vscode");
  });

  it("puts the end of a turn in Needs you, and the typed prompt closes it as the answer", () => {
    const store = testStore();
    handleHook(event("UserPromptSubmit", { prompt: "go" }), ctx(store));
    handleHook(event("Stop", { last_assistant_message: "Done with the table.\n\nShall I also migrate the old rows?" }), ctx(store));
    const [q] = store.openQuestions("cc-1");
    assert.equal(q?.kind, "waiting");
    assert.equal(q?.text, "Shall I also migrate the old rows?");
    assert.equal(q?.context, "Done with the table.");
    assert.equal(store.getSession("cc-1")?.state, "waiting");

    handleHook(event("UserPromptSubmit", { prompt: "yes, all of them" }), ctx(store));
    assert.deepEqual(store.openQuestions("cc-1"), []);
    assert.equal(store.getQuestion(q?.id ?? "")?.answer?.text, "yes, all of them");
    assert.equal(store.getSession("cc-1")?.state, "working");
  });

  it("closes questions even when the typed prompt is a huge paste", () => {
    const store = testStore();
    handleHook(event("Stop", { last_assistant_message: "Logs?" }), ctx(store));
    handleHook(event("UserPromptSubmit", { prompt: "log line\n".repeat(10_000) }), ctx(store));
    assert.deepEqual(store.openQuestions("cc-1"), []);
    assert.equal(store.getSession("cc-1")?.state, "working");
  });

  it("replaces an answer given on the page but not delivered with what was typed", () => {
    const store = testStore();
    handleHook(event("Stop", { last_assistant_message: "Delete the worktrees?" }), ctx(store));
    const q = store.openQuestions("cc-1")[0];
    const stop = store.listen("cc-1");
    store.answerFromDesk(q?.id ?? "", "yes");
    stop();
    handleHook(event("UserPromptSubmit", { prompt: "no, wait" }), ctx(store));
    assert.deepEqual(store.takeInbox("cc-1"), [], "nothing is left to reach a later turn");
    assert.equal(store.getQuestion(q?.id ?? "")?.answer?.text, "no, wait");
  });

  it("replaces the previous turn's message when a turn ends without a typed prompt", () => {
    const store = testStore();
    handleHook(event("Stop", { last_assistant_message: "Waiting for the build." }), ctx(store));
    handleHook(event("Stop", { last_assistant_message: "Build passed. Deploy?" }), ctx(store));
    assert.deepEqual(store.openQuestions("cc-1").map((q) => q.text), ["Build passed. Deploy?"]);
  });

  it("adds what Claude wrote between its tool calls to the conversation, once", () => {
    const store = testStore();
    const transcript = path.join(tempHome(), "session.jsonl");
    const line = (e: object) => `${JSON.stringify(e)}\n`;
    const said = (text: string, extra = {}) => line({ type: "assistant", message: { content: [{ type: "text", text }, { type: "tool_use", name: "Bash" }] }, ...extra });
    fs.writeFileSync(transcript, line({ type: "assistant", message: { content: [{ type: "text", text: "From an earlier turn." }] } }) + line({ type: "user", message: { content: "fix the build" } }) + said("Looking at the logs first.") + line({ type: "user", message: { content: [{ type: "tool_result" }] } }));
    handleHook(event("UserPromptSubmit", { prompt: "fix the build" }), ctx(store));
    handleHook(event("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, transcript_path: transcript }), ctx(store));
    fs.appendFileSync(transcript, said("A sub-agent's note.", { isSidechain: true }) + said("Found it: a missing import.") + '{"type":"assistant","mess');
    handleHook(event("Stop", { last_assistant_message: "Fixed and tested.", transcript_path: transcript }), ctx(store));
    assert.deepEqual(
      store.listMessages("cc-1").map((m) => [m.from, m.text]),
      [
        ["developer", "fix the build"],
        ["session", "Looking at the logs first."],
        ["session", "Found it: a missing import."],
        ["session", "Fixed and tested."],
      ],
    );
    assert.deepEqual(store.listMessages("cc-1").map((m) => m.step ?? false), [false, true, true, false], "written between tool calls, not the turn's last message");
    assert.deepEqual(turnTexts(path.join(tempHome(), "none.jsonl")), [], "a transcript not written yet holds nothing");
  });

  it("keeps a question open when a turn without a typed prompt ends asking nothing", () => {
    const store = testStore();
    handleHook(event("Stop", { last_assistant_message: "Shall I fix the four of them?" }), ctx(store));
    // A background task wakes the session; its turn ends with a reminder, not a question.
    handleHook(event("Stop", { last_assistant_message: "Still waiting for your answer about the four fixes." }), ctx(store));
    assert.deepEqual(store.openQuestions("cc-1").map((q) => q.text), ["Shall I fix the four of them?"]);
    assert.match(store.getSession("cc-1")?.lastMessage?.text ?? "", /Still waiting/);
    handleHook(event("Stop", { last_assistant_message: "Shall I fix only two?" }), ctx(store));
    assert.deepEqual(store.openQuestions("cc-1").map((q) => q.text), ["Shall I fix only two?"], "a turn that asks again replaces it");
  });

  it("keeps a report that asks nothing out of Needs you, as the session's last message", () => {
    const store = testStore();
    handleHook(event("UserPromptSubmit", { prompt: "relaunch the agents" }), ctx(store));
    handleHook(event("Stop", { last_assistant_message: "Both agents relaunched.\n\n- 3D: starts over\n- fixes: resumes\n\nIf you want the previews, I can start them." }), ctx(store));
    assert.deepEqual(store.openQuestions("cc-1"), []);
    const s = store.getSession("cc-1");
    assert.equal(s?.state, "waiting");
    assert.match(s?.lastMessage?.text ?? "", /^Both agents relaunched\.[\s\S]*I can start them\.$/);
  });

  it("names the session after its first prompt when Claude Code gives no title", () => {
    const store = testStore();
    handleHook(event("UserPromptSubmit", { prompt: "Fix the IVA rounding in invoices\nand add tests" }), ctx(store));
    handleHook(event("UserPromptSubmit", { prompt: "now the PDF" }), ctx(store));
    assert.equal(store.getSession("cc-1")?.title, "Fix the IVA rounding in invoices");
  });

  it("samples what the session and each sub-agent are doing from their tool calls", () => {
    const store = testStore();
    handleHook(event("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" } }), ctx(store));
    assert.equal(store.getSession("cc-1")?.activity, "Bash: npm test");
    handleHook(event("PreToolUse", { tool_name: "Agent", tool_use_id: "t1", tool_input: { description: "Sand room swap", subagent_type: "general-purpose", prompt: "Context…" } }), ctx(store));
    handleHook(event("SubagentStart", { agent_id: "a-1", agent_type: "general-purpose" }), ctx(store));
    handleHook(event("PostToolUse", { agent_id: "a-1", tool_name: "Edit", tool_input: { file_path: "/work/shop/src/room.ts" } }), ctx(store));
    const [agent] = store.listAgents("cc-1");
    assert.equal(agent?.goal, "Sand room swap");
    assert.equal(agent?.activity, "Edit: src/room.ts", "paths are shown relative to the project");
    assert.equal(store.getSession("cc-1")?.activity, "Bash: npm test", "a sub-agent's call does not change the session's line");
    handleHook(event("Stop", { last_assistant_message: "Done." }), ctx(store));
    assert.equal(store.getSession("cc-1")?.activity, undefined);
  });

  it("stamps each recorded tool call and keeps when the latest ones failed", () => {
    const store = testStore();
    handleHook(event("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" } }), ctx(store));
    assert.ok(store.getSession("cc-1")?.activityAt);
    assert.equal(store.getSession("cc-1")?.failedAt, undefined);
    for (let i = 0; i < 12; i++) handleHook(event("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "npm test" } }), ctx(store));
    assert.equal(store.getSession("cc-1")?.failedAt?.length, 10, "only the latest ten are kept");
    assert.equal(store.getSession("cc-1")?.failedWhat, "Bash: npm test");
    handleHook(event("PreToolUse", { tool_name: "Agent", tool_use_id: "t1", tool_input: { description: "Fix the seal", subagent_type: "general-purpose", prompt: "…" } }), ctx(store));
    handleHook(event("SubagentStart", { agent_id: "a-1", agent_type: "general-purpose" }), ctx(store));
    handleHook(event("PostToolUseFailure", { agent_id: "a-1", tool_name: "Bash", tool_input: { command: "make" } }), ctx(store));
    const [agent] = store.listAgents("cc-1");
    assert.equal(agent?.failedAt?.length, 1);
    assert.ok(agent?.activityAt);
  });

  it("keeps what the developer writes while the session works, until the turn that took it in ends", () => {
    const store = testStore();
    handleHook(event("SessionStart", { source: "startup" }), ctx(store));
    handleHook(event("UserPromptSubmit", { prompt: "build the pay page" }), ctx(store));
    handleHook(event("UserPromptSubmit", { prompt: "use the indigo button" }), ctx(store));
    const sent = store.getSession("cc-1")?.sentWhileWorking;
    assert.deepEqual(sent?.map((m) => [m.text, m.turnEndedAt]), [["use the indigo button", undefined]]);
    handleHook(event("Stop", { last_assistant_message: "Done; the button is indigo." }), ctx(store));
    assert.ok(store.getSession("cc-1")?.sentWhileWorking?.[0]?.turnEndedAt);
  });

  it("keeps the conversation: each turn's last message and what the developer answered", () => {
    const store = testStore();
    handleHook(event("SessionStart", { source: "startup" }), ctx(store));
    handleHook(event("UserPromptSubmit", { prompt: "analyse the seal" }), ctx(store));
    handleHook(event("Stop", { last_assistant_message: "It takes 14 minutes; 2 can be saved." }), ctx(store));
    handleHook(event("UserPromptSubmit", { prompt: "ok, do it" }), ctx(store));
    handleHook(event("Stop", { last_assistant_message: "Pending: add the time to the logs?" }), ctx(store));
    assert.deepEqual(store.listMessages("cc-1").map((m) => [m.from, m.text]), [
      ["developer", "analyse the seal"],
      ["session", "It takes 14 minutes; 2 can be saved."],
      ["developer", "ok, do it"],
      ["session", "Pending: add the time to the logs?"],
    ]);
  });

  it("does not add a second item when the model already asked through the CLI", () => {
    const store = testStore();
    handleHook(event("UserPromptSubmit", { prompt: "go" }), ctx(store));
    store.ask({ sessionId: "cc-1", kind: "question", text: "Bars or line?", options: ["Bars", "Line"] });
    handleHook(event("Stop", { last_assistant_message: "The chart is ready:\n\n- 12 months\n- one value each\n\nBars or line?" }), ctx(store));
    assert.deepEqual(store.openQuestions("cc-1").map((q) => q.kind), ["question"]);
    assert.equal(store.openQuestions("cc-1")[0]?.context, "The chart is ready:\n\n- 12 months\n- one value each", "the turn's message explains the question");
  });

  it("keeps a last paragraph that says more than the question asked through the CLI", () => {
    const store = testStore();
    handleHook(event("UserPromptSubmit", { prompt: "go" }), ctx(store));
    store.ask({ sessionId: "cc-1", kind: "question", text: "Which improvements do I make?", options: ["1", "2"] });
    const message = "Two improvements:\n\n1. A cheat sheet\n2. A glossary\n\nI would do both. Which ones? I touch nothing until you say.";
    handleHook(event("Stop", { last_assistant_message: message }), ctx(store));
    assert.equal(store.openQuestions("cc-1")[0]?.context, message, "the recommendation in the last paragraph is not lost");
  });

  it("opens a permission prompt with the tool and settles it when the tool runs", () => {
    const store = testStore();
    handleHook(event("PermissionRequest", { tool_name: "Bash", tool_input: { command: "npm test" } }), ctx(store));
    assert.equal(store.openQuestions("cc-1")[0]?.text, "Bash: npm test");
    const marker = path.join(store.paths.home, ".permission-open");
    assert.ok(fs.existsSync(marker), "tool calls start the adapter while a prompt is open");
    handleHook(event("PostToolUse", { tool_name: "Bash", tool_use_id: "t1" }), ctx(store));
    assert.deepEqual(store.openQuestions("cc-1"), []);
    assert.ok(!fs.existsSync(marker), "and stop starting it once none is open");
  });

  it("follows sub-agents from launch to stop", () => {
    const store = testStore();
    handleHook(event("PreToolUse", { tool_name: "Agent", tool_use_id: "toolu_1", tool_input: { description: "Fix pay button", subagent_type: "general-purpose", prompt: "Fix the pay button\nin checkout" } }), ctx(store));
    handleHook(event("PreToolUse", { tool_name: "Agent", tool_use_id: "toolu_2", tool_input: { description: "Fix pay button", subagent_type: "Explore", prompt: "Look" } }), ctx(store));
    handleHook(event("SubagentStart", { agent_id: "a-1", agent_type: "general-purpose" }), ctx(store));
    handleHook(event("SubagentStart", { agent_id: "a-2", agent_type: "Explore" }), ctx(store));
    handleHook(event("SubagentStop", { agent_id: "a-1", agent_type: "general-purpose", last_assistant_message: "Fixed: the button is fixed at the bottom." }), ctx(store));
    const agents = store.listAgents("cc-1");
    assert.deepEqual(agents.map((a) => [a.name, a.ref, a.state]), [["fix-pay-button", "a-1", "done"], ["fix-pay-button-2", "a-2", "working"]]);
    assert.equal(agents[0]?.goal, "Fix pay button");
    assert.equal(agents[0]?.activity, "Fixed: the button is fixed at the bottom.");
  });

  it("names an agent launched outside the Agent tool (a workflow) after the label Claude Code noted for it", () => {
    const store = testStore();
    const projects = tempHome();
    const transcript = path.join(projects, "cc-1.jsonl");
    const run = path.join(projects, "cc-1", "subagents", "workflows", "wf_1");
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, "agent-a9.meta.json"), JSON.stringify({ agentType: "workflow-subagent", description: "review:aliases batch 4" }));
    handleHook(event("SubagentStart", { agent_id: "a9", agent_type: "workflow-subagent", transcript_path: transcript }), ctx(store));
    assert.deepEqual(store.listAgents("cc-1").map((a) => [a.name, a.goal]), [["review-aliases-batch-4", "review:aliases batch 4"]]);

    // Notes written only after the start: the goal arrives with the stop.
    handleHook(event("SubagentStart", { agent_id: "a10", agent_type: "workflow-subagent", transcript_path: transcript }), ctx(store));
    fs.writeFileSync(path.join(run, "agent-a10.meta.json"), JSON.stringify({ description: "verify:aliases" }));
    handleHook(event("SubagentStop", { agent_id: "a10", agent_type: "workflow-subagent", agent_transcript_path: path.join(run, "agent-a10.jsonl"), last_assistant_message: "Checked." }), ctx(store));
    assert.deepEqual(store.listAgents("cc-1").find((a) => a.ref === "a10")?.goal, "verify:aliases");

    fs.writeFileSync(path.join(run, "agent-a11.meta.json"), "{broken");
    const out = handleHook(event("SubagentStart", { agent_id: "a11", agent_type: "workflow-subagent", transcript_path: transcript }), ctx(store));
    assert.match(out.stderr ?? "", /cannot read the sub-agent's notes/, "a broken note is reported, and the agent still recorded");
    assert.ok(store.listAgents("cc-1").some((a) => a.ref === "a11"));
  });

  it("corrects launches of one type paired the wrong way round, once Claude Code has noted their labels", () => {
    const store = testStore();
    const projects = tempHome();
    const transcript = path.join(projects, "cc-1.jsonl");
    const dir = path.join(projects, "cc-1", "subagents");
    for (const [tool, description] of [["toolu_a", "Alpha check"], ["toolu_b", "Beta check"]]) {
      handleHook(event("PreToolUse", { tool_name: "Agent", tool_use_id: tool, tool_input: { description, subagent_type: "general-purpose" } }), ctx(store));
    }
    // Both start before Claude Code writes its notes: the first start (Beta's) takes Alpha's launch.
    handleHook(event("SubagentStart", { agent_id: "b", agent_type: "general-purpose", transcript_path: transcript }), ctx(store));
    handleHook(event("SubagentStart", { agent_id: "a", agent_type: "general-purpose", transcript_path: transcript }), ctx(store));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "agent-a.meta.json"), JSON.stringify({ description: "Alpha check" }));
    fs.writeFileSync(path.join(dir, "agent-b.meta.json"), JSON.stringify({ description: "Beta check" }));
    // Alpha's first tool call settles both.
    handleHook(event("PostToolUse", { tool_name: "Bash", tool_input: { command: "echo alpha" }, agent_id: "a", transcript_path: transcript }), ctx(store));
    assert.deepEqual(store.listAgents("cc-1").map((a) => [a.goal, a.ref]), [["Alpha check", "a"], ["Beta check", "b"]]);
    assert.equal(store.listAgents("cc-1")[0]?.activity, "Bash: echo alpha");

    // Paired wrong and stopped before any tool call: the stop settles it.
    handleHook(event("PreToolUse", { tool_name: "Agent", tool_use_id: "toolu_c", tool_input: { description: "Gamma check", subagent_type: "general-purpose" } }), ctx(store));
    handleHook(event("PreToolUse", { tool_name: "Agent", tool_use_id: "toolu_d", tool_input: { description: "Delta check", subagent_type: "general-purpose" } }), ctx(store));
    handleHook(event("SubagentStart", { agent_id: "d", agent_type: "general-purpose", transcript_path: transcript }), ctx(store));
    fs.writeFileSync(path.join(dir, "agent-d.meta.json"), JSON.stringify({ description: "Delta check" }));
    handleHook(event("SubagentStop", { agent_id: "d", agent_type: "general-purpose", agent_transcript_path: path.join(dir, "agent-d.jsonl"), last_assistant_message: "delta" }), ctx(store));
    const byGoal = new Map(store.listAgents("cc-1").map((a) => [a.goal, a]));
    assert.deepEqual([byGoal.get("Delta check")?.ref, byGoal.get("Delta check")?.state], ["d", "done"]);
    // Gamma waits for its own start again, as an unpaired launch.
    assert.deepEqual([byGoal.get("Gamma check")?.ref?.startsWith("tool:"), byGoal.get("Gamma check")?.state], [true, "working"]);
  });

  it("treats an agent started again with the same id as the same agent", () => {
    const store = testStore();
    handleHook(event("PreToolUse", { tool_name: "Agent", tool_use_id: "t1", tool_input: { description: "Seal timings", subagent_type: "general-purpose" } }), ctx(store));
    handleHook(event("SubagentStart", { agent_id: "a-7", agent_type: "general-purpose" }), ctx(store));
    handleHook(event("SubagentStop", { agent_id: "a-7", agent_type: "general-purpose", last_assistant_message: "Measured." }), ctx(store));
    handleHook(event("SubagentStart", { agent_id: "a-7", agent_type: "general-purpose" }), ctx(store));
    assert.deepEqual(store.listAgents("cc-1").map((a) => [a.name, a.state]), [["seal-timings", "working"]]);
    handleHook(event("SubagentStop", { agent_id: "a-7", agent_type: "general-purpose", last_assistant_message: "Rebalanced." }), ctx(store));
    assert.deepEqual(store.listAgents("cc-1").map((a) => [a.name, a.state, a.activity]), [["seal-timings", "done", "Rebalanced."]]);
  });

  it("does not take Claude Code's own notifications for the developer's words", () => {
    const store = testStore();
    handleHook(event("Stop", { last_assistant_message: "Shall I launch both agents?" }), ctx(store));
    handleHook(event("UserPromptSubmit", { prompt: "<task-notification>\n<task-id>a1</task-id>\n</task-notification>" }), ctx(store));
    assert.equal(store.openQuestions("cc-1").length, 1, "the question stays open");
    assert.deepEqual(store.listMessages("cc-1").map((m) => m.from), ["session"]);
    assert.equal(store.getSession("cc-1")?.state, "working");
  });

  it("shows pasted text as a block, without Claude Code's paste markers", () => {
    assert.equal(readablePrompt('look:\n<pasted_content id="860f">\nline 1\nline 2\n</pasted_content id="860f">'), "look:\n\n```\nline 1\nline 2\n```");
  });

  it("starts a background worktree scan of the project at the end of a turn", () => {
    const store = testStore();
    const scanned: string[] = [];
    handleHook(event("Stop", { last_assistant_message: "Done." }), { ...ctx(store), startScan: (dir) => scanned.push(dir) });
    assert.deepEqual(scanned, ["/work/shop"]);
  });

  it("ends the session and dismisses what was left open", () => {
    const store = testStore();
    handleHook(event("Stop", { last_assistant_message: "Next?" }), ctx(store));
    handleHook(event("SessionEnd", { reason: "prompt_input_exit" }), ctx(store));
    assert.equal(store.getSession("cc-1")?.state, "ended");
    assert.equal(store.listQuestions()[0]?.status, "dismissed");
  });

  it("rejects hook input without a valid session id", () => {
    assert.throws(() => readHookInput("{}"), /session_id/);
    assert.throws(() => readHookInput('{"session_id":"../x","hook_event_name":"Stop","cwd":"/"}'), /session_id/);
    assert.throws(() => readHookInput("not json"), /not JSON/);
  });

  it("keeps the last paragraph as the question and trims long context", () => {
    const { last, before } = splitLastParagraph(`${"x".repeat(9000)}\n\nOk?`);
    assert.equal(last, "Ok?");
    assert.ok(before.startsWith("…") && before.length <= 8001);
  });

  it("keeps a closing list of several decisions whole as the question", () => {
    const decisions = [
      "Done: the upload test passed 60 of 60 under load.",
      "",
      "Three things are left for you to decide:",
      `1. Shall I push this fix? It will start a new seal, with the right Node. ${"x".repeat(150)}`,
      `2. API errors in production are logged only in debug mode. Shall I log them always? ${"y".repeat(250)}`,
      "3. Your ~/.bashrc has two problems, and it is your file, so I leave it alone:",
      `   - Node 20 first: line 119 puts Node 20.11 before everything. ${"z".repeat(120)}`,
      `   - A token in plain text: your GitLab token is there. ${"w".repeat(120)}`,
    ].join("\n");
    const { last, before } = splitLastParagraph(decisions);
    assert.ok(last.startsWith("Three things are left for you to decide:\n1. Shall I push this fix?"), last.slice(0, 80));
    assert.equal(before, "Done: the upload test passed 60 of 60 under load.");

    const long = Array.from({ length: 40 }, (_, i) => `${i + 1}. Option ${i + 1}: ${"v".repeat(80)}?`).join("\n");
    const split = splitLastParagraph(long);
    assert.ok(split.last.length <= 2000 && /^\d+\. Option/.test(split.last), "cut between lines, never mid-word");
    assert.equal(`${split.before}\n${split.last}`, long, "what does not fit goes to the context, nothing is lost");
  });
});

describe("answers from the desk", () => {
  it("delivers a desk answer verbatim and wakes the session with exit code 2", async () => {
    const store = testStore();
    handleHook(event("Stop", { last_assistant_message: "Which name?" }), ctx(store));
    const q = store.openQuestions("cc-1")[0];
    const waiting = waitForAnswer("cc-1", store, { pollMs: 10, armWithinMs: 1000, deadline: Date.now() + 5000 });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(store.isListening("cc-1"), "the page offers the answer box while the session listens");
    store.answerFromDesk(q?.id ?? "", "«Ñandú»\n  exactly this");
    const out = await waiting;
    assert.equal(out.code, 2);
    assert.match(out.stderr ?? "", /Answer from agent-desk/);
    assert.ok(out.stderr?.endsWith("«Ñandú»\n  exactly this"), "the answer is passed through untouched");
    assert.equal(store.isListening("cc-1"), false);
    assert.equal(store.getSession("cc-1")?.state, "working");
  });

  it("hands over the files of the images attached to a desk answer", async () => {
    const store = testStore();
    handleHook(event("Stop", { last_assistant_message: "Which layout?" }), ctx(store));
    const q = store.openQuestions("cc-1")[0];
    const waiting = waitForAnswer("cc-1", store, { pollMs: 10, armWithinMs: 1000, deadline: Date.now() + 5000 });
    await new Promise((r) => setTimeout(r, 50));
    const image = store.addImage(PNG);
    store.answerFromDesk(q?.id ?? "", "this one", [image]);
    const out = await waiting;
    assert.equal(out.code, 2);
    assert.ok(out.stderr?.endsWith(`this one\n\nImages they attached (open each file to see it):\n${store.imageFile(image)?.file}`), out.stderr);
  });

  it("stops waiting without a message when the developer answers in the terminal", async () => {
    const store = testStore();
    handleHook(event("Stop", { last_assistant_message: "Next?" }), ctx(store));
    const waiting = waitForAnswer("cc-1", store, { pollMs: 10, armWithinMs: 1000, deadline: Date.now() + 5000 });
    await new Promise((r) => setTimeout(r, 50));
    handleHook(event("UserPromptSubmit", { prompt: "carry on" }), ctx(store));
    assert.deepEqual(await waiting, { code: 0 });
  });

  it("delivers a reply to a session that asked nothing, and keeps it in the history", async () => {
    const store = testStore();
    handleHook(event("Stop", { last_assistant_message: "Previews stopped. I can start them again." }), ctx(store));
    const waiting = waitForAnswer("cc-1", store, { pollMs: 10, armWithinMs: 1000, deadline: Date.now() + 5000 });
    await new Promise((r) => setTimeout(r, 50));
    store.messageFromDesk("cc-1", "yes, start them");
    const out = await waiting;
    assert.equal(out.code, 2);
    assert.match(out.stderr ?? "", /I can start them again\.[\s\S]*yes, start them$/);
    const [item] = store.listQuestions();
    assert.equal(item?.status, "answered");
    assert.equal(item?.answer?.via, "desk");
  });

  it("hands a message sent while the session works to its next step, not to a sub-agent's", () => {
    const store = testStore();
    const live = { ...ctx(store), sessionProcess: () => ({ pid: process.pid, ancestors: [] }) };
    handleHook(event("SessionStart", { source: "startup" }), live);
    handleHook(event("UserPromptSubmit", { prompt: "Fix the checkout" }), live);
    assert.equal(store.getSession("cc-1")?.takesMessagesWhileWorking, true);
    store.messageFromDesk("cc-1", "and push it when the tests pass");
    assert.ok(fs.existsSync(store.paths.inboxMarker), "the hook after each tool call finds work to do");
    assert.deepEqual(store.getSession("cc-1")?.sentWhileWorking?.map((m) => m.text), ["and push it when the tests pass"]);

    // Typed in the terminal mid-turn: the desk message is not overtaken, both reach the session.
    handleHook(event("UserPromptSubmit", { prompt: "also run lint" }), live);
    assert.deepEqual(deliverWhileWorking(event("PostToolUse", { tool_name: "Bash", agent_id: "a-1" }), store), { code: 0 }, "a sub-agent's step leaves it");
    const out = deliverWhileWorking(event("PostToolUse", { tool_name: "Bash" }), store);
    const context = JSON.parse(out.stdout ?? "{}").hookSpecificOutput.additionalContext as string;
    assert.match(context, /^Message from agent-desk[\s\S]*Verbatim:\nand push it when the tests pass$/);
    assert.ok(!fs.existsSync(store.paths.inboxMarker), "nothing left: the hook goes quiet");
    assert.deepEqual(deliverWhileWorking(event("PostToolUse", { tool_name: "Bash" }), store), { code: 0 }, "delivered once");
  });

  it("refuses a reply while the session is not listening, leaving nothing open", () => {
    const store = testStore();
    handleHook(event("Stop", { last_assistant_message: "Done." }), ctx(store));
    assert.throws(() => store.messageFromDesk("cc-1", "next"), /not taking messages/);
    assert.deepEqual(store.openQuestions(), []);
  });

  it("shows Claude Code's choice dialog as its questions and answers it from the desk", async () => {
    const store = testStore();
    handleHook(event("SessionStart", { source: "startup" }), ctx(store));
    store.ask({ sessionId: "cc-1", kind: "question", text: "Which layout?", options: ["A", "B"] }); // the model also used agent-desk ask
    const questions = [
      { question: "Which layout?", header: "Layout", options: [{ label: "A", description: "Sidebar" }, { label: "B", description: "Tabs" }], multiSelect: false },
      { question: "Which extras?", header: "Extras", options: [{ label: "Player" }, { label: "Legend" }], multiSelect: true },
    ];
    const out = handleHook(event("PermissionRequest", { tool_name: "AskUserQuestion", tool_input: { questions } }), ctx(store));
    const open = store.openQuestions("cc-1");
    assert.deepEqual(open.map((q) => [q.kind, q.text, q.options, q.dialog]), [["question", "Which layout?", ["A", "B"], true], ["question", "Which extras?", ["Player", "Legend"], true]], "no permission item, and the duplicate is gone");
    assert.match(open[0]?.context ?? "", /\*\*A\*\*: Sidebar/);
    assert.match(open[1]?.context ?? "", /Several can be chosen/);
    assert.ok(out.dialog);

    const waiting = waitForDialog("cc-1", out.dialog, store, { pollMs: 10, armWithinMs: 0, deadline: Date.now() + 5000 });
    await new Promise((r) => setTimeout(r, 30));
    store.answerFromDesk(open[0]?.id ?? "", "A");
    store.answerFromDesk(open[1]?.id ?? "", "Player, Legend");
    const decided = JSON.parse((await waiting).stdout ?? "{}").hookSpecificOutput.decision;
    assert.deepEqual(decided, { behavior: "allow", updatedInput: { questions, answers: { "Which layout?": "A", "Which extras?": "Player, Legend" } } });
  });

  it("closes the dialog's questions with the answer given in the terminal", async () => {
    const store = testStore();
    handleHook(event("SessionStart", { source: "startup" }), ctx(store));
    const questions = [{ question: "Which size?", options: [{ label: "S" }, { label: "M" }] }];
    const out = handleHook(event("PermissionRequest", { tool_name: "AskUserQuestion", tool_input: { questions } }), ctx(store));
    assert.ok(fs.existsSync(path.join(store.paths.home, ".permission-open")), "the next tool call runs the adapter");
    const waiting = waitForDialog("cc-1", out.dialog ?? { input: {}, questions: [] }, store, { pollMs: 10, armWithinMs: 0, deadline: Date.now() + 5000 });
    handleHook(event("PostToolUse", { tool_name: "AskUserQuestion", tool_input: { questions }, tool_response: { questions, answers: { "Which size?": "M" } } }), ctx(store));
    assert.deepEqual(await waiting, { code: 0 }, "the hook gives up: the terminal decided");
    const [q] = store.listQuestions();
    assert.deepEqual([q?.status, q?.answer?.text, q?.answer?.via], ["answered", "M", "terminal"]);
  });

  it("allows or denies a permission prompt from the desk while its hook waits", async () => {
    const store = testStore();
    const opts = () => ({ pollMs: 10, armWithinMs: 0, deadline: Date.now() + 5000 });
    const ask = () => handleHook(event("PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf dist" } }), ctx(store)).questionId ?? "";
    const decision = (out: { stdout?: string }) => JSON.parse(out.stdout ?? "{}").hookSpecificOutput?.decision;

    const first = ask();
    assert.deepEqual(store.getQuestion(first)?.options, ["Allow", "Deny"]);
    const allowing = waitForPermission("cc-1", first, store, opts());
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(store.isListening("cc-1"), "the page offers Allow and Deny while the hook waits");
    store.answerFromDesk(first, "Allow");
    assert.deepEqual(decision(await allowing), { behavior: "allow" });

    const second = ask();
    const denying = waitForPermission("cc-1", second, store, opts());
    await new Promise((r) => setTimeout(r, 30));
    store.answerFromDesk(second, "use npm run clean instead");
    assert.deepEqual(decision(await denying), { behavior: "deny", message: "Denied on agent-desk: use npm run clean instead" });
  });

  it("leaves the decision to the terminal when the prompt is settled there", async () => {
    const store = testStore();
    const qid = handleHook(event("PermissionRequest", { tool_name: "Bash", tool_input: { command: "ls" } }), ctx(store)).questionId ?? "";
    const waiting = waitForPermission("cc-1", qid, store, { pollMs: 10, armWithinMs: 0, deadline: Date.now() + 5000 });
    await new Promise((r) => setTimeout(r, 30));
    handleHook(event("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }), ctx(store));
    assert.deepEqual(await waiting, { code: 0 });
  });

  it("does not let the turn's waiter take a permission answer", async () => {
    const store = testStore();
    handleHook(event("Stop", { last_assistant_message: "Next?" }), ctx(store));
    const waiting = waitForAnswer("cc-1", store, { pollMs: 10, armWithinMs: 1000, deadline: Date.now() + 300 });
    await new Promise((r) => setTimeout(r, 30));
    const qid = store.ask({ sessionId: "cc-1", kind: "permission", text: "Bash: ls", options: ["Allow", "Deny"] }).id;
    store.answerFromDesk(qid, "Allow");
    assert.deepEqual(await waiting, { code: 0 });
    assert.deepEqual(store.takeInbox("cc-1").map((e) => e.answer), ["Allow"]);
  });

  it("gives up when the turn never ends as waiting", async () => {
    const store = testStore();
    handleHook(event("UserPromptSubmit", { prompt: "go" }), ctx(store));
    const out = await waitForAnswer("cc-1", store, { pollMs: 10, armWithinMs: 60, deadline: Date.now() + 5000 });
    assert.deepEqual(out, { code: 0 });
  });

  it("runs end to end through the adapter's entry point", async () => {
    const home = tempHome();
    const env = { ...process.env, AGENT_DESK_HOME: home, TERM_PROGRAM: "vscode", CLAUDE_PROJECT_DIR: "/work/shop" };
    const run = (command: string, input: object) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [MAIN, command], { env });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => (stdout += d));
        child.stderr.on("data", (d: Buffer) => (stderr += d));
        child.on("error", reject);
        child.on("exit", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(JSON.stringify({ session_id: "cc-e2e", cwd: "/work/shop", ...input }));
      });
    assert.equal((await run("hook", { hook_event_name: "SessionStart", source: "startup" })).code, 0);
    assert.equal((await run("hook", { hook_event_name: "Stop", last_assistant_message: "Ship it?" })).code, 0);
    const waiter = run("wait", { hook_event_name: "Stop" });
    const { Store } = await import("../src/store/store.ts");
    const store = new Store(home);
    for (let i = 0; i < 100 && !store.isListening("cc-e2e"); i++) await new Promise((r) => setTimeout(r, 50));
    const q = store.openQuestions("cc-e2e")[0];
    store.answerFromDesk(q?.id ?? "", "Yes, ship it");
    const out = await waiter;
    assert.equal(out.code, 2);
    assert.match(out.stderr, /Ship it\?[\s\S]*Yes, ship it/);
    const session = store.getSession("cc-e2e");
    assert.equal(session?.process?.pid !== undefined, true, "the hook recorded its session process");
  });
});

describe("status line", () => {
  it("maps Claude Code's status-line JSON to provider-free metrics", () => {
    const m = metricsFromStatusLine({
      session_id: "cc-1",
      cwd: "/nonexistent",
      model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
      effort: { level: "high" },
      context_window: { used_percentage: 86.4, total_input_tokens: 172_000, context_window_size: 200_000 },
      cost: { total_cost_usd: 4.2 },
      rate_limits: { five_hour: { used_percentage: 42, resets_at: 1_800_000_000 }, seven_day: { used_percentage: 61 } },
      prompt_cache: { expires_at: "2026-10-28T11:03:00Z" },
      worktree: { branch: "agent/pay" },
    });
    assert.deepEqual(m, {
      sessionId: "cc-1",
      model: "Opus 5.5",
      effort: "high",
      branch: "agent/pay",
      contextPercent: 86.4,
      contextTokens: 172_000,
      costUsd: 4.2,
      planWindows: [{ label: "5 h", percent: 42, resetsAt: new Date(1_800_000_000_000).toISOString() }, { label: "7 d", percent: 61 }],
      cacheExpiresAt: "2026-10-28T11:03:00.000Z",
      suggestion: { reason: "context-full", command: "/compact" },
    });
  });

  it("reads the session's name from the status line", () => {
    assert.equal(sessionNameFromStatusLine({ session_id: "cc-1", session_name: "Checkout on mobile" }), "Checkout on mobile");
    assert.equal(sessionNameFromStatusLine({ session_id: "cc-1" }), undefined);
  });

  it("passes the input through to the status-line command it wraps", async () => {
    const home = tempHome();
    const child = spawn(process.execPath, [MAIN, "statusline", "--", "cat"], { env: { ...process.env, AGENT_DESK_HOME: home } });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    const input = JSON.stringify({ session_id: "cc-9", context_window: { used_percentage: 12 } });
    child.stdin.end(input);
    const code = await new Promise((r) => child.on("exit", r));
    assert.equal(code, 0);
    assert.equal(stdout, input);
    const { Store } = await import("../src/store/store.ts");
    assert.equal(new Store(home).listMetrics()[0]?.contextPercent, 12);
  });
});
