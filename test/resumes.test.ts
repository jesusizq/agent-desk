// Pending handoffs as resume notes of their project: the Claude Code adapter reads the developer's
// handoff folder at the moments its hooks run anyway, and the store keeps only what the page shows.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { handleHook, type HookContext, readHookInput } from "../adapters/claude-code/hooks.ts";
import { handoffFolder, objective, pendingHandoffs, RESUMES_SOURCE } from "../adapters/claude-code/resumes.ts";
import { readProjectResumes, type ResumeNote } from "../src/core/model.ts";
import { projectId } from "../src/project/scan.ts";
import { StorePaths } from "../src/store/paths.ts";
import { gitIn, tempHome, testStore } from "./helpers.ts";

const run = promisify(execFile);

const SHOP = projectId("/work/shop");
const HOUR = 3600_000;
const WORKER = path.join(import.meta.dirname, "fixtures", "worker.ts");

/** A note still offered, written an hour ago. */
const note = (title: string, command: string): ResumeNote => ({ title, writtenAt: new Date(Date.now() - HOUR).toISOString(), expiresAt: new Date(Date.now() + 47 * HOUR).toISOString(), command });

/**
 * Another process holding the project's resumes lock for a second (fixtures/worker.ts): `reading`
 * once it holds it, `done` once it wrote and let go.
 */
function holding(home: string, task: "slow-resumes" | "corrupt-resumes", project: { id: string; name: string; dir: string }, notes: ResumeNote[]) {
  fs.writeFileSync(path.join(home, "resumes.json"), JSON.stringify({ project, notes }));
  const done = run(process.execPath, [WORKER, home, task, "1000"]);
  const reading = (async () => {
    for (let waited = 0; !fs.existsSync(path.join(home, "reading")); waited += 10) {
      if (waited > 10_000) throw new Error("the worker never took the lock");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  return { reading, done };
}

/** The folder name the plugin's loader (`project_name`) gives `cwd`, asking git as it does. */
function loaderName(cwd: string): string {
  const ask = (...args: string[]) => {
    try {
      return execFileSync("git", ["-C", cwd, "rev-parse", ...args], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return ""; // outside git: the loader keeps the folder itself
    }
  };
  const common = ask("--path-format=absolute", "--git-common-dir");
  return path.basename(common.endsWith("/.git") ? common.slice(0, -5) : ask("--show-toplevel") || cwd);
}

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

  it("drops a handoff loaded in a turn that was interrupted, at the next prompt, since no Stop ran", () => {
    const { dir, store, write, hook } = setup();
    write("a.md", "## Objetivo\nLoaded then interrupted\n", 1);
    hook("SessionStart", { source: "startup" });
    assert.equal(store.getResumes(SHOP)?.notes.length, 1);
    fs.renameSync(path.join(dir, "a.md"), path.join(dir, "a.md.usado"));
    hook("UserPromptSubmit", { prompt: "go on" });
    assert.equal(store.getResumes(SHOP), undefined);
  });

  it("replaces a stored record it cannot read with what it reads now, saying so", () => {
    const { store, record, write, hook } = setup();
    write("a.md", "## Objetivo\nStill pending\n", 1);
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify({ id: SHOP, name: "shop", dir: "/work/shop", at: "yesterday", notes: [] }));
    const out = hook("SessionStart", { source: "startup" });
    assert.match(out.stderr ?? "", /resumes.*at.*replaced by the notes read now/s);
    assert.equal(store.getResumes(SHOP)?.notes[0]?.title, "Still pending", "rewritten, so the next hook is quiet");
    assert.equal(hook("Stop", { last_assistant_message: "Done." }).stderr, undefined);
  });

  it("removes a stored record it cannot read when no handoff is pending, saying it removed it", () => {
    const { store, record, hook } = setup();
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify({ id: SHOP, name: "shop", dir: "/work/shop", at: "yesterday", notes: [] }));
    const out = hook("SessionStart", { source: "startup" });
    assert.match(out.stderr ?? "", /resumes.*at.*removed, since no notes are read now/s);
    assert.doesNotMatch(out.stderr ?? "", /replaced/);
    assert.equal(fs.existsSync(record), false);
    assert.equal(store.getResumes(SHOP), undefined);
  });

  it("reads the notes and writes them under the record's lock: of two overlapping refreshes, the later read is what stays", async () => {
    const home = tempHome();
    const store = testStore(home);
    const project = { id: SHOP, name: "shop", dir: "/work/shop" };
    const stale = [note("Loaded meanwhile", "/ahorro:handoff-load 1"), note("Still pending", "/ahorro:handoff-load 2")];
    const fresh = [note("Still pending", "/ahorro:handoff-load")];
    // Another hook reads the folder before the handoff is loaded, and is slow to write what it read.
    const other = holding(home, "slow-resumes", project, stale);
    await other.reading;
    store.refreshResumes(project, () => fresh, []);
    await other.done;
    assert.deepEqual(store.getResumes(SHOP)?.notes, fresh, "the stale read was written before this one was taken, not after");
  });

  it("keeps one list per handoff folder: sessions in the repository and in its subfolder share it, numbered as now", () => {
    const cache = tempHome();
    const repo = path.join(fs.realpathSync(tempHome()), "shop");
    const sub = path.join(repo, "web");
    fs.mkdirSync(sub, { recursive: true });
    gitIn(repo, "init", "-q");
    const folder = path.join(cache, "claude-handoffs", "shop");
    fs.mkdirSync(folder, { recursive: true });
    for (const [name, hoursAgo] of [["a.md", 2], ["b.md", 1]] as const) {
      const file = path.join(folder, name);
      fs.writeFileSync(file, `## Objetivo\nHandoff ${name}\n`);
      const t = new Date(Date.now() - hoursAgo * HOUR);
      fs.utimesSync(file, t, t);
    }
    const store = testStore();
    const hookIn = (dir: string) => handleHook(readHookInput(JSON.stringify({ session_id: "cc-1", cwd: dir, hook_event_name: "Stop", last_assistant_message: "x" })), { store, env: { CLAUDE_PROJECT_DIR: dir, XDG_CACHE_HOME: cache }, sessionProcess: () => undefined });
    hookIn(sub);
    hookIn(repo);
    // Kept as the handoff folder's, not the subfolder session's own project ("web"): a record per
    // session project gave the same handoffs twice, and loading one from the repository left the
    // subfolder's list numbered as before, so its "/ahorro:handoff-load 1" loaded another handoff.
    assert.deepEqual(store.listResumes().map((r) => [r.id, r.name, r.dir, r.notes.length]), [[projectId(repo), "shop", repo, 2]]);
    fs.renameSync(path.join(folder, "b.md"), path.join(folder, "b.md.usado"));
    hookIn(repo);
    assert.deepEqual(store.listResumes().map((r) => r.notes.map((n) => [n.title, n.command])), [[["Handoff a.md", "/ahorro:handoff-load"]]], "the one list the subfolder's session shows too");
  });

  it("removes the list an earlier version kept for the session's own folder, a subfolder or a path through a symlink, and names the one it files under", () => {
    const cache = tempHome();
    const root = fs.realpathSync(tempHome());
    const repo = path.join(root, "shop");
    const sub = path.join(repo, "web");
    const link = path.join(root, "link");
    fs.mkdirSync(sub, { recursive: true });
    gitIn(repo, "init", "-q");
    fs.symlinkSync(repo, link);
    const folder = path.join(cache, "claude-handoffs", "shop");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "a.md"), "## Objetivo\nHandoff a\n");
    const store = testStore();
    // As the version before one record per handoff folder left them: numbered before b.md was loaded.
    const before = [note("Handoff b", "/ahorro:handoff-load 1"), note("Handoff a", "/ahorro:handoff-load 2")];
    for (const dir of [sub, link]) store.putResumes({ id: projectId(dir), name: path.basename(dir), dir, at: new Date().toISOString(), notes: before });
    // Another handoff folder's list stays.
    const other = path.join(root, "elsewhere");
    store.putResumes({ id: projectId(other), name: "elsewhere", dir: other, at: new Date().toISOString(), notes: before });
    const hookIn = (dir: string) => handleHook(readHookInput(JSON.stringify({ session_id: `cc-${path.basename(dir)}`, cwd: dir, hook_event_name: "Stop", last_assistant_message: "x" })), { store, env: { CLAUDE_PROJECT_DIR: dir, XDG_CACHE_HOME: cache }, sessionProcess: () => undefined });
    hookIn(sub);
    hookIn(link);
    assert.deepEqual(
      store.listResumes().map((r) => [r.name, r.notes.map((n) => n.command)]).sort(),
      [["elsewhere", ["/ahorro:handoff-load 1", "/ahorro:handoff-load 2"]], ["shop", ["/ahorro:handoff-load"]]],
      "no stale list still offers /ahorro:handoff-load 1, which now loads another handoff",
    );
    assert.deepEqual(store.listSessions().map((x) => [x.project.name, x.resumesId]).sort(), [["link", projectId(repo)], ["web", projectId(repo)]], "each session names the list it files under");
  });

  it("removes those lists when the folder's own list is refreshed, from a session in another folder, and keeps the lists it did not write or that list another folder", () => {
    const cache = tempHome();
    const root = fs.realpathSync(tempHome());
    const repo = path.join(root, "shop");
    const sub = path.join(repo, "web");
    const docs = path.join(repo, "docs");
    const link = path.join(root, "link");
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(docs);
    gitIn(repo, "init", "-q");
    fs.symlinkSync(repo, link);
    const folder = path.join(cache, "claude-handoffs", "shop");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "a.md"), "## Objetivo\nHandoff a\n");
    const store = testStore();
    const at = new Date().toISOString();
    const before = [note("Handoff b", "/ahorro:handoff-load 1"), note("Handoff a", "/ahorro:handoff-load 2")];
    // Written before records named their source: this adapter's, so removed like one that names it.
    store.putResumes({ id: projectId(sub), name: "web", dir: sub, at, notes: before });
    store.putResumes({ id: projectId(link), name: "link", dir: link, source: RESUMES_SOURCE, at, notes: before });
    // Another adapter's notes kept per project, under the id this cleanup would match: not this adapter's to remove.
    const theirs = { id: projectId(docs), name: "docs", dir: docs, source: "other-tool-notes", at, notes: [note("Their note", "other-tool resume")] };
    store.putResumes(theirs);
    // This adapter's list of another handoff folder.
    const other = path.join(root, "elsewhere");
    fs.mkdirSync(other);
    store.putResumes({ id: projectId(other), name: "elsewhere", dir: other, source: RESUMES_SOURCE, at, notes: before });
    // No session ever works in the subfolder or through the link: the repository's own session cleans up.
    const out = handleHook(readHookInput(JSON.stringify({ session_id: "cc-shop", cwd: repo, hook_event_name: "Stop", last_assistant_message: "x" })), { store, env: { CLAUDE_PROJECT_DIR: repo, XDG_CACHE_HOME: cache }, sessionProcess: () => undefined });
    assert.equal(out.stderr, undefined, out.stderr);
    assert.deepEqual(
      store.listResumes().map((r) => [r.name, r.source, r.notes.map((n) => n.command)]).sort(),
      [
        ["docs", "other-tool-notes", ["other-tool resume"]],
        ["elsewhere", RESUMES_SOURCE, ["/ahorro:handoff-load 1", "/ahorro:handoff-load 2"]],
        ["shop", RESUMES_SOURCE, ["/ahorro:handoff-load"]],
      ],
      "neither stale list offers /ahorro:handoff-load 1 in All or the away summary",
    );
    assert.deepEqual(store.getResumes(theirs.id), theirs, "another adapter's record untouched");
  });

  it("names the handoff folder as the plugin's loader does, from git's common dir, symlinks resolved", () => {
    const root = fs.realpathSync(tempHome());
    const repo = path.join(root, "shop");
    fs.mkdirSync(path.join(repo, "web"), { recursive: true });
    gitIn(repo, "init", "-q");
    gitIn(repo, "commit", "-q", "--allow-empty", "-m", "first");
    const linked = path.join(repo, ".claude", "worktrees", "agent-a");
    gitIn(repo, "worktree", "add", "-q", "-b", "agent/a", linked);
    fs.mkdirSync(path.join(linked, "src"));
    fs.symlinkSync(repo, path.join(root, "link"));
    fs.symlinkSync(linked, path.join(root, "wt-link"));
    // A bare repository with its worktrees beside it: git's common dir is `.bare`, not a `.git` folder.
    gitIn(root, "clone", "-q", "--bare", repo, path.join(root, "bare", ".bare"));
    gitIn(path.join(root, "bare", ".bare"), "worktree", "add", "-q", path.join(root, "bare", "trunk"));
    fs.mkdirSync(path.join(root, "bare", "trunk", "lib"));
    fs.mkdirSync(path.join(root, "plain"));
    const cases: [string, string][] = [
      [repo, "shop"],
      [path.join(repo, "web"), "shop"],
      [linked, "shop"],
      [path.join(linked, "src"), "shop"],
      [path.join(root, "link"), "shop"],
      [path.join(root, "link", "web"), "shop"],
      [path.join(root, "wt-link", "src"), "shop"],
      [path.join(root, "bare", "trunk"), "trunk"],
      [path.join(root, "bare", "trunk", "lib"), "trunk"],
      [path.join(root, "plain"), "plain"],
    ];
    for (const [dir, name] of cases) {
      assert.equal(handoffFolder(dir), name, dir);
      assert.equal(handoffFolder(dir), loaderName(dir), `${dir}: as /ahorro:handoff-load finds it`);
    }
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
    assert.deepEqual(readProjectResumes({ ...record, source: "some-adapter" }), { ...record, source: "some-adapter" });
    bad((r) => ({ ...r, source: "a b" }), /source/);
  });

  it("removes a record only when it is stale as read under its lock, and reports and leaves one it cannot read", () => {
    const home = tempHome();
    const store = testStore(home);
    const problems: string[] = [];
    store.putResumes(record);
    store.removeResumesIf(SHOP, (r) => r.dir !== record.dir, problems);
    assert.deepEqual(store.getResumes(SHOP), record, "not stale: kept");
    store.removeResumesIf(SHOP, (r) => r.dir === record.dir, problems);
    assert.equal(store.getResumes(SHOP), undefined);
    store.removeResumesIf(SHOP, () => true, problems);
    assert.deepEqual(problems, [], "an absent record is nothing to report");
    const file = new StorePaths(home).resumes(SHOP);
    fs.writeFileSync(file, "{ cut");
    store.removeResumesIf(SHOP, () => true, problems);
    assert.equal(fs.readFileSync(file, "utf8"), "{ cut", "left as it is");
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /not removed/);
  });

  it("lists them in the snapshot the page reads, and keeps no file for a project left with none", () => {
    const store = testStore();
    store.putResumes(record);
    assert.deepEqual(store.snapshot().resumes, [record]);
    store.putResumes({ ...record, notes: [] });
    assert.deepEqual(store.snapshot().resumes, []);
  });

  const ended = { id: SHOP, name: "shop", dir: "/work/shop", at: "2026-01-01T09:00:00.000Z", notes: [{ writtenAt: "2026-01-01T08:00:00.000Z", expiresAt: "2026-01-03T08:00:00.000Z", command: "/load" }] };
  const cutoff = new Date("2026-03-01T00:00:00.000Z");

  it("archives a project's record each time its notes all ended, overwriting none archived before", () => {
    const store = testStore();
    const archived = path.dirname(store.paths.archived(store.paths.resumes(SHOP)));
    for (let i = 0; i < 2; i++) {
      store.putResumes(ended); // the same project, even at the same time, ends twice
      store.archiveOlderThan(cutoff);
    }
    const kept = fs.readdirSync(archived);
    assert.equal(kept.length, 2, kept.join(", "));
    for (const name of kept) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(archived, name), "utf8")), ended);
  });

  it("leaves a record that was refreshed after it was listed, and reports one that turned unreadable, archiving the rest", async () => {
    const home = tempHome();
    const store = testStore(home);
    const project = { id: SHOP, name: "shop", dir: "/work/shop" };
    const offered = [note("Written meanwhile", "/ahorro:handoff-load")];
    store.putResumes(ended);
    const refresh = holding(home, "slow-resumes", project, offered);
    await refresh.reading;
    store.archiveOlderThan(cutoff); // lists the ended record, then waits for the refresh's lock
    await refresh.done;
    assert.deepEqual(store.getResumes(SHOP)?.notes, offered, "not refreshed meanwhile is checked again under the lock");

    const pay = { ...ended, id: projectId("/work/pay"), name: "pay", dir: "/work/pay" };
    store.putResumes(ended);
    store.putResumes(pay);
    fs.rmSync(path.join(home, "reading"));
    const corrupt = holding(home, "corrupt-resumes", project, offered);
    await corrupt.reading;
    const problems: string[] = [];
    store.archiveOlderThan(cutoff, problems);
    await corrupt.done;
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0] ?? "", /resumes.*at.*not archived/s);
    assert.ok(fs.existsSync(store.paths.resumes(SHOP)), "left for its adapter to replace");
    assert.equal(fs.existsSync(store.paths.resumes(pay.id)), false, "the next record is archived all the same");
  });

  it("moves a project's record to the archive once all its notes ended before the cutoff, and keeps one still offered", () => {
    const store = testStore();
    const kept = { ...ended, id: projectId("/work/pay"), name: "pay", dir: "/work/pay", notes: [...ended.notes, { writtenAt: "2026-03-10T08:00:00.000Z", expiresAt: "2026-03-12T08:00:00.000Z", command: "/load 1" }] };
    store.putResumes(ended);
    store.putResumes(kept);
    store.archiveOlderThan(cutoff);
    assert.deepEqual(store.listResumes().map((r) => r.name), ["pay"]);
    const archived = path.dirname(store.paths.archived(store.paths.resumes(SHOP)));
    assert.deepEqual(fs.readdirSync(archived).filter((n) => n.startsWith(SHOP)).length, 1, "moved, not deleted");
  });
});
