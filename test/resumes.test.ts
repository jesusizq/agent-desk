// Pending handoffs as resume notes of their project: the Claude Code adapter reads the developer's
// handoff folder at the moments its hooks run anyway, and the store keeps only what the page shows.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { handleHook, type HookContext, readHookInput } from "../adapters/claude-code/hooks.ts";
import { objective, pendingHandoffs } from "../adapters/claude-code/resumes.ts";
import { readProjectResumes } from "../src/core/model.ts";
import { projectId } from "../src/project/scan.ts";
import { StorePaths } from "../src/store/paths.ts";
import { tempHome, testStore } from "./helpers.ts";

const SHOP = projectId("/work/shop");
const HOUR = 3600_000;

/** A cache folder holding the developer's handoffs, and a hook context that reads it. */
function setup() {
  const cache = tempHome();
  const dir = path.join(cache, "claude-handoffs", "shop");
  fs.mkdirSync(dir, { recursive: true });
  const home = tempHome();
  const store = testStore(home);
  const record = new StorePaths(home).resumes(SHOP);
  const ctx: HookContext = { store, env: { CLAUDE_PROJECT_DIR: "/work/shop", XDG_CACHE_HOME: cache }, sessionProcess: () => ({ pid: 4242, ancestors: [4241] }) };
  /** A handoff written `hoursAgo`. */
  const write = (name: string, body: string, hoursAgo: number) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    const t = new Date(Date.now() - hoursAgo * HOUR);
    fs.utimesSync(file, t, t);
    return file;
  };
  const hook = (event: string, extra: Record<string, unknown> = {}) =>
    handleHook(readHookInput(JSON.stringify({ session_id: "cc-1", cwd: "/work/shop", hook_event_name: event, ...extra })), ctx);
  return { cache, dir, store, record, write, hook };
}

describe("pending handoffs", () => {
  it("records each pending handoff's objective line, age and load command at SessionStart, and nothing else of it", () => {
    const { store, record, write, hook } = setup();
    write("2026-11-18-0900.md", "# Handoff: the pay page\n\n## Objetivo\nFinish the pay page, phase B.\nSecond line of the objective.\n\n## Pendiente\n- the secret plan\n", 1);
    write("2026-11-17-2300.md", "## Hecho\n\nNo objective heading: this line names it.\n", 10);
    write("2026-11-17-2000.md.usado", "## Objetivo\nAlready loaded\n", 2);
    write("2026-11-16-0100.md", "## Objetivo\nToo old\n", 49);
    write("notes.txt", "## Objetivo\nNot a handoff\n", 1);
    const out = hook("SessionStart", { source: "startup" });
    assert.equal(out.stderr, undefined, out.stderr);
    const got = store.getResumes(SHOP);
    assert.ok(got);
    assert.equal(got.name, "shop");
    assert.equal(got.dir, "/work/shop");
    assert.deepEqual(got.notes.map((n) => [n.title, n.command]), [
      ["Finish the pay page, phase B.", "/ahorro:handoff-load 1"],
      ["No objective heading: this line names it.", "/ahorro:handoff-load 2"],
    ]);
    const [first] = got.notes;
    assert.ok(first);
    assert.ok(Math.abs(Date.parse(first.writtenAt) - (Date.now() - HOUR)) < 5000, "written when its file was");
    assert.equal(Date.parse(first.expiresAt) - Date.parse(first.writtenAt), 48 * HOUR, "loadable for 48 h");
    const kept = fs.readFileSync(record, "utf8");
    for (const hidden of ["Second line", "secret plan", "Pendiente", "Already loaded", "Too old"]) assert.ok(!kept.includes(hidden), `${hidden} stays in the handoff`);
  });

  it("drops a handoff once it is loaded, at the turn's end, numbering the rest again, and removes the record when none is left", () => {
    const { dir, store, record, write, hook } = setup();
    write("a.md", "## Objetivo\nOlder\n", 3);
    write("b.md", "## Objetivo\nNewer\n", 1);
    hook("SessionStart", { source: "startup" });
    assert.equal(store.getResumes(SHOP)?.notes.length, 2);
    fs.renameSync(path.join(dir, "b.md"), path.join(dir, "b.md.usado"));
    hook("Stop", { last_assistant_message: "Loaded." });
    assert.deepEqual(store.getResumes(SHOP)?.notes.map((n) => [n.title, n.command]), [["Older", "/ahorro:handoff-load"]]);
    fs.renameSync(path.join(dir, "a.md"), path.join(dir, "a.md.usado"));
    hook("Stop", { last_assistant_message: "Loaded." });
    assert.equal(store.getResumes(SHOP), undefined);
    assert.equal(fs.existsSync(record), false);
  });

  it("leaves the record untouched when nothing changed, so the page is not told of a change", () => {
    const { store, write, hook } = setup();
    write("a.md", "## Objetivo\nSame\n", 1);
    hook("SessionStart", { source: "startup" });
    const at = store.getResumes(SHOP)?.at;
    hook("Stop", { last_assistant_message: "Done." });
    assert.equal(store.getResumes(SHOP)?.at, at);
  });

  it("reads the folder again after a Write into it, and not after a Write elsewhere", () => {
    const { cache, store, write, hook } = setup();
    hook("SessionStart", { source: "startup" });
    assert.equal(store.getResumes(SHOP), undefined);
    write("a.md", "## Objetivo\nJust written\n", 0);
    hook("PostToolUse", { tool_name: "Write", tool_input: { file_path: "/work/shop/src/a.ts", content: "" }, tool_response: {} });
    assert.equal(store.getResumes(SHOP), undefined, "a write elsewhere reads nothing");
    hook("PostToolUse", { tool_name: "Write", tool_input: { file_path: path.join(cache, "claude-handoffs", "shop", "a.md"), content: "" }, tool_response: {} });
    assert.equal(store.getResumes(SHOP)?.notes[0]?.title, "Just written");
  });

  it("never writes into the handoff folder", () => {
    const { dir, write, hook } = setup();
    write("a.md", "## Objetivo\nX\n", 1);
    const before = fs.readdirSync(dir).sort();
    hook("SessionStart", { source: "startup" });
    hook("Stop", { last_assistant_message: "Done." });
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
  });

  it("reads nothing for a project name that could leave the folder, nor without a cache folder", () => {
    const { cache } = setup();
    const root = path.join(cache, "claude-handoffs");
    fs.writeFileSync(path.join(cache, "x.md"), "## Objetivo\nOutside\n");
    const problems: string[] = [];
    for (const name of ["..", ".", "", "a/b"]) assert.deepEqual(pendingHandoffs(root, name, new Date(), problems), [], name);
    assert.deepEqual(pendingHandoffs(root, "nope", new Date(), problems), [], "a project with no folder has none");
    assert.deepEqual(problems, []);
    const store = testStore();
    handleHook(readHookInput(JSON.stringify({ session_id: "cc-1", cwd: "/work/shop", hook_event_name: "Stop", last_assistant_message: "x" })), { store, env: { CLAUDE_PROJECT_DIR: "/work/shop" }, sessionProcess: () => undefined });
    assert.equal(store.getResumes(SHOP), undefined);
  });

  it("titles a handoff with the objective's first line, accents and heading level aside, on one line of at most 200 characters", () => {
    assert.equal(objective("# H\n\n### OBJETIVO del día\n\n  Ship it  \n"), "Ship it");
    assert.equal(objective("## Objetivó\nWith an accent\n"), "With an accent");
    assert.equal(objective("# Only a heading\n"), undefined);
    assert.equal(objective("## Objetivo\nA\ttab\n"), "A tab");
    const long = objective(`## Objetivo\n${"x".repeat(300)}\n`);
    assert.equal(long?.length, 200);
    assert.ok(long?.endsWith("…"));
  });
});

describe("resume notes in the store", () => {
  const record = { id: SHOP, name: "shop", dir: "/work/shop", at: "2026-11-18T09:00:00.000Z", notes: [{ title: "Pay page", writtenAt: "2026-11-18T08:00:00.000Z", expiresAt: "2026-11-20T08:00:00.000Z", command: "/load 1" }] };

  it("checks every field: one-line title and command, times, a valid project id", () => {
    assert.deepEqual(readProjectResumes(record), record);
    const bad = (change: (r: typeof record) => unknown, why: RegExp) => assert.throws(() => readProjectResumes(change(structuredClone(record))), why);
    bad((r) => ({ ...r, notes: [{ ...r.notes[0], command: "/load\nrm -rf ~" }] }), /command: one line/);
    bad((r) => ({ ...r, notes: [{ ...r.notes[0], title: "two\nlines" }] }), /title: one line/);
    bad((r) => ({ ...r, notes: [{ ...r.notes[0], writtenAt: "yesterday" }] }), /writtenAt/);
    bad((r) => ({ ...r, id: "../x" }), /id/);
    bad((r) => ({ ...r, notes: Array.from({ length: 21 }, () => r.notes[0]) }), /more than 20/);
  });

  it("lists them in the snapshot the page reads, and keeps no file for a project left with none", () => {
    const store = testStore();
    store.putResumes(record);
    assert.deepEqual(store.snapshot().resumes, [record]);
    store.putResumes({ ...record, notes: [] });
    assert.deepEqual(store.snapshot().resumes, []);
  });
});
