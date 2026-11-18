import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { handleHook, type HookContext, readHookInput } from "../adapters/claude-code/hooks.ts";
import { costOf } from "../adapters/claude-code/prices.ts";
import { freshCommand, metricsFromStatusLine } from "../adapters/claude-code/statusline.ts";
import { readTally, tallyTranscript } from "../adapters/claude-code/usage.ts";
import type { Metrics, Suggestion } from "../src/core/model.ts";
import type { Store } from "../src/store/store.ts";
import { tempHome, testStore } from "./helpers.ts";

/** A reply's usage line as Claude Code writes it: one per block of the reply, each with the reply's usage. */
function reply(id: string, model: string, usage: Record<string, unknown>): string {
  return JSON.stringify({ type: "assistant", isSidechain: true, requestId: `req_${id}`, message: { id, model, role: "assistant", content: [{ type: "text", text: "…" }], usage } });
}
const opus = (input: number, write5m: number, read: number, output: number) =>
  ({ input_tokens: input, cache_creation_input_tokens: write5m, cache_read_input_tokens: read, output_tokens: output, cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: 0 }, service_tier: "standard", inference_geo: "global", speed: "standard" });

// The record keeps a millionth of a dollar.
const near = (actual: number | undefined, expected: number, within = 1e-9) => assert.ok(actual !== undefined && Math.abs(actual - expected) <= within, `${actual} ≈ ${expected}`);

describe("agent cost", () => {
  it("prices each kind of token at its model's rate, the cache writes by their lifetime", () => {
    // Claude Opus 5.5: $4 input, $5 5-minute writes, $8 1-hour writes, $0.20 reads, $20 output per million.
    near(costOf("claude-opus-5-5", { input: 2, write5m: 24_474, write1h: 0, read: 0, output: 193 }), (2 * 4 + 24_474 * 5 + 193 * 20) / 1e6);
    near(costOf("claude-opus-5-5", { input: 10, write5m: 0, write1h: 1000, read: 50_000, output: 500 }), (10 * 4 + 1000 * 8 + 50_000 * 0.2 + 500 * 20) / 1e6);
    // A dated id, or a context tag, is the same model.
    near(costOf("claude-haiku-4-5-20251001", { input: 1000, write5m: 0, write1h: 0, read: 0, output: 0 }), 0.001);
    near(costOf("claude-opus-4-6[1m]", { input: 1000, write5m: 0, write1h: 0, read: 0, output: 0 }), 0.005);
  });

  it("prices Claude Haiku 5.5 by the prompt's length, and US-only inference at 1.1x", () => {
    near(costOf("claude-haiku-5-5", { input: 1000, write5m: 0, write1h: 0, read: 50_000, output: 100 }), (1000 * 0.1 + 50_000 * 0.01 + 100 * 0.5) / 1e6);
    near(costOf("claude-haiku-5-5", { input: 1000, write5m: 0, write1h: 0, read: 120_000, output: 100 }), (1000 * 0.5 + 120_000 * 0.05 + 100 * 2.5) / 1e6);
    near(costOf("claude-opus-5-5", { input: 1_000_000, write5m: 0, write1h: 0, read: 0, output: 0 }, { geo: "us" }), 4.4);
  });

  it("gives no cost for a model, a speed, a tier or a region the table does not price", () => {
    const usage = { input: 1000, write5m: 0, write1h: 0, read: 0, output: 100 };
    assert.equal(costOf("claude-nonexistent-model-1", usage), undefined);
    assert.equal(costOf("claude-opus-5-5-fast", usage), undefined);
    assert.equal(costOf("us.anthropic.claude-opus-5-5", usage), undefined, "a partner platform's id has its own prices");
    assert.equal(costOf("claude-opus-5-5", usage, { speed: "fast" }), undefined);
    assert.equal(costOf("claude-opus-5-5", usage, { tier: "priority" }), undefined);
    assert.equal(costOf("claude-opus-5-5", usage, { geo: "eu" }), undefined);
    assert.equal(costOf("claude-opus-4-5", usage, { geo: "us" }), undefined, "US-only pricing is given for Claude 4.6 and later only");
  });

  it("sums a transcript's replies once each, the 5-minute writes when the row does not split them", () => {
    const file = path.join(tempHome(), "agent-a1.jsonl");
    const sonnet = { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10_000, output_tokens: 1000 };
    fs.writeFileSync(file, [JSON.stringify({ type: "user", message: { role: "user", content: "what is the usage of this?" } }), reply("m1", "claude-opus-5-5", opus(2, 24_474, 0, 193)), reply("m1", "claude-opus-5-5", opus(2, 24_474, 0, 193)), reply("m2", "claude-sonnet-5-5", sonnet), ""].join("\n"));
    const problems: string[] = [];
    const t = tallyTranscript(file, undefined, problems);
    assert.deepEqual(problems, []);
    assert.equal(t?.tokens, 2 + 24_474 + 193 + 100 + 2000 + 10_000 + 1000);
    near(t?.costUsd, (2 * 4 + 24_474 * 5 + 193 * 20) / 1e6 + (100 * 2 + 2000 * 2.5 + 10_000 * 0.1 + 1000 * 10) / 1e6);
    assert.equal(t?.unpriced, false);
  });

  it("counts the tokens of a reply it cannot price, and leaves the cost unknown rather than short", () => {
    const file = path.join(tempHome(), "agent-a1.jsonl");
    fs.writeFileSync(file, `${reply("m1", "claude-opus-5-5", opus(2, 100, 0, 10))}\n${reply("m2", "claude-nonexistent-model-1", opus(5, 0, 0, 5))}\n`);
    const t = tallyTranscript(file, undefined, []);
    assert.deepEqual([t?.tokens, t?.unpriced], [122, true]);
  });

  it("reads on from where it stopped: only what was written since, never a line still being written", () => {
    const file = path.join(tempHome(), "agent-a1.jsonl");
    const first = `${reply("m1", "claude-opus-5-5", opus(2, 100, 0, 10))}\n`;
    fs.writeFileSync(file, first);
    const one = tallyTranscript(file, undefined, []);
    assert.equal(one?.offset, Buffer.byteLength(first));
    // The first reply rewritten in place, same length: read already, so not read again.
    fs.writeFileSync(file, first.replace('"output_tokens":10', '"output_tokens":90'));
    const half = reply("m2", "claude-opus-5-5", opus(1, 0, 1000, 20));
    fs.appendFileSync(file, `${reply("m1", "claude-opus-5-5", opus(2, 100, 0, 10))}\n${half.slice(0, 40)}`);
    const two = tallyTranscript(file, one, []);
    assert.equal(two?.tokens, 112, "the same reply's next line, and a half-written one, add nothing");
    assert.equal(tallyTranscript(file, two, []), two, "nothing new: the same tally");
    fs.appendFileSync(file, `${half.slice(40)}\n`);
    const three = tallyTranscript(file, two, []);
    assert.equal(three?.tokens, 112 + 1021);
    near(three?.costUsd, (2 * 4 + 100 * 5 + 10 * 20 + 1 * 4 + 1000 * 0.2 + 20 * 20) / 1e6);
    // Replaced by a shorter file: counted again from its start.
    fs.writeFileSync(file, `${reply("m9", "claude-opus-5-5", opus(1, 0, 0, 1))}\n`);
    assert.equal(tallyTranscript(file, three, [])?.tokens, 2);
    assert.equal(tallyTranscript(path.join(path.dirname(file), "missing.jsonl"), undefined, []), undefined);
  });

  it("reports a reply whose usage it cannot read, and leaves the cost unknown", () => {
    const file = path.join(tempHome(), "agent-a1.jsonl");
    fs.writeFileSync(file, `${reply("m1", "claude-opus-5-5", { input_tokens: -3, output_tokens: 1 })}\n{"usage": broken\n`);
    const problems: string[] = [];
    const t = tallyTranscript(file, undefined, problems);
    assert.equal(t?.unpriced, true);
    assert.equal(problems.length, 2);
    assert.match(problems[0] ?? "", /usage of m1\.input_tokens/);
    assert.throws(() => readTally({ file, ino: 1, offset: -1, tokens: 0, costUsd: 0, unpriced: false }, "note"), /note\.offset/);
  });

  it("records on a sub-agent's calls and at its stop its tokens and cost so far, from its own transcript", () => {
    const store = testStore();
    const projects = tempHome();
    const transcript = path.join(projects, "cc-1.jsonl");
    const subagents = path.join(projects, "cc-1", "subagents");
    fs.mkdirSync(subagents, { recursive: true });
    fs.writeFileSync(path.join(subagents, "agent-a1.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Fix pay button" }));
    const own = path.join(subagents, "agent-a1.jsonl");
    const ctx: HookContext = { store, env: { CLAUDE_PROJECT_DIR: "/work/shop" }, sessionProcess: () => undefined };
    const event = (hook_event_name: string, extra: Record<string, unknown>) => readHookInput(JSON.stringify({ session_id: "cc-1", cwd: "/work/shop", hook_event_name, transcript_path: transcript, ...extra }));
    handleHook(event("SubagentStart", { agent_id: "a1", agent_type: "general-purpose" }), ctx);
    fs.writeFileSync(own, `${reply("m1", "claude-opus-5-5", opus(2, 24_474, 0, 193))}\n`);
    handleHook(event("PostToolUse", { agent_id: "a1", tool_name: "Bash", tool_input: { command: "npm test" } }), ctx);
    const working = only(store);
    assert.equal(working.tokens, 24_669);
    near(working.costUsd, 0.126238);
    fs.appendFileSync(own, `${reply("m2", "claude-opus-5-5", opus(1, 0, 24_474, 100))}\n`);
    handleHook(event("SubagentStop", { agent_id: "a1", agent_type: "general-purpose", agent_transcript_path: own, last_assistant_message: "Fixed." }), ctx);
    const done = only(store);
    assert.deepEqual([done.state, done.tokens], ["done", 24_669 + 24_575]);
    near(done.costUsd, 0.126238 + (4 + 24_474 * 0.2 + 100 * 20) / 1e6, 1e-6);
    assert.ok(fs.existsSync(path.join(store.paths.home, "notes", "cc-1", "usage-a1.json")), "where it stopped reading is noted with the session");
    // A model the table does not price: the tokens still count, the cost is no longer known.
    fs.appendFileSync(own, `${reply("m3", "claude-nonexistent-model-1", opus(1, 0, 0, 1))}\n`);
    handleHook(event("SubagentStop", { agent_id: "a1", agent_type: "general-purpose", agent_transcript_path: own, last_assistant_message: "Fixed." }), ctx);
    assert.deepEqual([only(store).tokens, only(store).costUsd], [24_669 + 24_575 + 2, undefined]);
  });

  it("keeps an adapter's notes inside the session's folder of the store, private", () => {
    const store = testStore();
    store.updateNote("cc-1", "usage-a1", () => ({ offset: 1 }));
    const file = path.join(store.paths.home, "notes", "cc-1", "usage-a1.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(store.updateNote("cc-1", "usage-a1", (before) => before), { offset: 1 });
    assert.throws(() => store.updateNote("cc-1", "../secret", () => ({})), /note key/);
    assert.throws(() => store.updateNote("../cc-1", "k", () => ({})), /session id/);
  });
});

const only = (store: Store) => {
  const [agent, ...rest] = store.listAgents("cc-1");
  assert.ok(agent && rest.length === 0);
  return agent;
};

describe("cold resume", () => {
  const status = (extra: Record<string, unknown>) => ({ session_id: "cc-1", cwd: "/nonexistent", model: { id: "claude-opus-5-5", display_name: "Opus 5.5" }, context_window: { used_percentage: 17.2, total_input_tokens: 172_000 }, ...extra });

  it("says what rewriting the whole context to the cache costs, at the price of the cache's lifetime", () => {
    near(metricsFromStatusLine(status({}), "/compact").coldResume?.costUsd, 0.86);
    near(metricsFromStatusLine(status({ prompt_cache: { ttl: "1h", expires_at: 1_800_000_000 } }), "/compact").coldResume?.costUsd, 172_000 * 8 / 1e6);
    assert.deepEqual(metricsFromStatusLine(status({ model: { id: "claude-nonexistent-model-1" } }), "/ahorro:handoff").coldResume, { command: "/ahorro:handoff" }, "no price: only the command");
    assert.deepEqual(metricsFromStatusLine(status({ prompt_cache: { ttl: "2h" } })).coldResume, { command: "/compact" }, "a lifetime with no price");
  });

  it("starts afresh with a handoff when the plugin that writes one is enabled, else compacts", () => {
    const dir = tempHome();
    const settings = path.join(dir, "settings.json");
    assert.equal(freshCommand(settings), "/compact", "no settings file");
    fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: { "ahorro@ahorro": true, "other@x": true } }));
    assert.equal(freshCommand(settings), "/ahorro:handoff");
    fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: { "ahorro@ahorro": false, "ahorro-extra@x": true } }));
    assert.equal(freshCommand(settings), "/compact", "disabled, or another plugin's name");
    fs.writeFileSync(settings, "{ not json");
    assert.throws(() => freshCommand(settings), /settings\.json: not valid JSON/);
  });

  it("suggests starting afresh once the cache has expired on a context of 150k tokens or half its window, as time passes", async () => {
    const at = Date.parse("2026-11-18T12:00:00Z");
    const suggest = (await import(path.join(import.meta.dirname, "../src/web/suggest.js"))) as { suggestionOf: (m: Metrics | undefined, now?: number) => Suggestion | undefined };
    const full: Suggestion = { reason: "context-full", command: "/compact" };
    const m = (contextTokens: number, contextPercent: number, cacheExpiresAt = "2026-11-18T11:59:59Z"): Metrics =>
      ({ sessionId: "cc-1", at: "2026-11-18T11:00:00Z", contextTokens, contextPercent, cacheExpiresAt, suggestion: full, coldResume: { command: "/ahorro:handoff", costUsd: 1.2 } });
    const cold = { reason: "cache-cold", command: "/ahorro:handoff" };
    assert.deepEqual(suggest.suggestionOf(m(150_000, 15), at), cold);
    assert.deepEqual(suggest.suggestionOf(m(149_999, 15), at), full, "below both thresholds: what the adapter suggested");
    assert.deepEqual(suggest.suggestionOf(m(100_000, 50), at), cold, "half of a 200k window");
    assert.deepEqual(suggest.suggestionOf(m(99_800, 49.9), at), full);
    assert.deepEqual(suggest.suggestionOf(m(400_000, 40, "2026-11-18T12:00:01Z"), at), full, "the cache still warm");
    assert.deepEqual(suggest.suggestionOf(m(400_000, 40, "2026-11-18T12:00:01Z"), at + 1000), cold, "the same metrics, a second later");
    assert.equal(suggest.suggestionOf({ sessionId: "cc-1", at: "2026-11-18T11:00:00Z", contextTokens: 400_000, cacheExpiresAt: "2026-11-18T11:00:00Z" }, at), undefined, "an adapter that offers no command");
  });
});
