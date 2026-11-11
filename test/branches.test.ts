// Where each agent's branch stands: git read without writing, joined to the session's agents, and
// worded for the session.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { sessionBranches } from "../src/core/branches.ts";
import type { Agent, ProjectScan, Session } from "../src/core/model.ts";
import { fitText, statusLines } from "../src/core/status.ts";
import { branchRef, GitError } from "../src/project/git.ts";
import { refreshScan } from "../src/project/refresh.ts";
import { scanProject } from "../src/project/scan.ts";
import { Store } from "../src/store/store.ts";
import { tempHome } from "./helpers.ts";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { env: ENV }).toString();
const commit = (dir: string, file: string, message: string) => {
  fs.writeFileSync(path.join(dir, file), `${message}\n`);
  git(dir, "add", file);
  git(dir, "commit", "-qm", message);
};

/** shop (main) with worktrees: ahead 2 and behind 1 (and dirty), merged, detached. */
function repo() {
  const root = fs.realpathSync(tempHome());
  const main = path.join(root, "shop");
  fs.mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  commit(main, "a.txt", "first");
  const wip = path.join(main, ".claude", "worktrees", "wip");
  const done = path.join(root, "shop-done");
  const loose = path.join(root, "shop-loose");
  git(main, "worktree", "add", "-q", "-b", "agent/wip", wip);
  git(main, "worktree", "add", "-q", "-b", "agent/done", done);
  commit(wip, "b.txt", "wip one");
  commit(wip, "c.txt", "Wip two, the last");
  commit(main, "d.txt", "main moves on");
  git(main, "worktree", "add", "-q", "--detach", loose, "HEAD~1");
  fs.writeFileSync(path.join(wip, "b.txt"), "changed\n");
  fs.writeFileSync(path.join(wip, "new.txt"), "untracked\n");
  return { root, main, wip, done, loose };
}

describe("git state of a project's checkouts", () => {
  it("reads branch, commits ahead and behind, uncommitted files, last commit, detached heads and merged ones", async () => {
    const { main, wip, done, loose } = repo();
    const scan = await scanProject(main, undefined, new Date(), { sizes: false });
    const by = new Map(scan.worktrees.map((w) => [w.path, w]));
    assert.equal(scan.baseBranch, "main");
    assert.deepEqual(pick(by.get(main)), { branch: "main", main: true, dirty: 0, subject: "main moves on" });
    assert.deepEqual(pick(by.get(wip)), { branch: "agent/wip", main: false, merged: false, ahead: 2, behind: 1, dirty: 2, subject: "Wip two, the last" });
    assert.deepEqual(pick(by.get(done)), { branch: "agent/done", main: false, merged: true, ahead: 0, behind: 1, dirty: 0, subject: "first" });
    assert.deepEqual(pick(by.get(loose)), { main: false, merged: true, ahead: 0, behind: 1, dirty: 0, subject: "first" });
    assert.ok(scan.worktrees.every((w) => w.bytes === undefined), "without sizes, nothing is walked");
    assert.ok(Math.abs(Date.parse(by.get(wip)?.committedAt ?? "") - Date.now()) < 120_000, "the commit time is the commit's");
  });

  it("writes nothing in the repository: no index refresh, no lock", async () => {
    const { main, wip } = repo();
    // A file touched but not changed leaves the index stale: a plain `git status` would rewrite it.
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(main, "a.txt"), later, later);
    const index = path.join(main, ".git", "index");
    const before = fs.statSync(index).mtimeMs;
    const listing = (dir: string) => fs.readdirSync(dir, { recursive: true }).map(String).sort();
    const gitFiles = listing(path.join(main, ".git"));
    await scanProject(main, undefined, new Date(), { sizes: false, branches: ["agent/gone"] });
    assert.equal(fs.statSync(index).mtimeMs, before, "the index was not refreshed");
    assert.deepEqual(listing(path.join(main, ".git")), gitFiles, "no file was added or removed under .git");
    assert.equal(git(wip, "status", "--porcelain").includes("new.txt"), true, "the checkout itself is as it was");
  });

  it("looks up the branches agents named that no checkout has: existing, missing, and names git must not take", async () => {
    const { main } = repo();
    git(main, "branch", "agent/parked", "HEAD~1");
    const scan = await scanProject(main, undefined, new Date(), { sizes: false, branches: ["agent/parked", "agent/never", "agent/wip", "--output=/tmp/x", "a..b"] });
    const by = new Map((scan.branches ?? []).map((b) => [b.name, b]));
    assert.deepEqual([by.get("agent/parked")?.exists, by.get("agent/parked")?.merged, by.get("agent/parked")?.behind], [true, true, 1]);
    assert.deepEqual(by.get("agent/never"), { name: "agent/never", exists: false });
    assert.equal(by.has("agent/wip"), false, "a branch checked out is read with its checkout");
    for (const bad of ["--output=/tmp/x", "a..b"]) {
      assert.equal(by.get(bad)?.exists, false);
      assert.match(by.get(bad)?.error ?? "", /not a branch name git takes/);
    }
    assert.equal(branchRef("feature/x"), "refs/heads/feature/x");
    assert.equal(branchRef("-x"), undefined);
  });

  it("names the processes working in a checkout, the deepest one holding their folder, shells left out", async () => {
    const { main, wip } = repo();
    const sleeper = spawn("sleep", ["30"], { cwd: path.join(wip, ".") , stdio: "ignore" });
    const shell = spawn("sh", ["-c", "read x"], { cwd: main, stdio: ["pipe", "ignore", "ignore"] });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const scan = await scanProject(main, undefined, new Date(), { sizes: false });
      const by = new Map(scan.worktrees.map((w) => [w.path, w]));
      assert.deepEqual(by.get(wip)?.busy, ["sleep"]);
      assert.equal(by.get(main)?.busy?.includes("sleep") ?? false, false, "a nested worktree keeps its own processes");
      assert.equal(by.get(main)?.busy?.includes("sh") ?? false, false, "an open shell is no work");
    } finally {
      sleeper.kill();
      shell.kill();
    }
  });

  it("stops a git command that does not answer, saying which and where, and goes on with the other checkouts", async () => {
    const { main } = repo();
    // A git that hangs on `status`, as one stuck on a lock or a slow hook would.
    const bin = path.join(tempHome(), "bin");
    fs.mkdirSync(bin);
    const real = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\ncase " $* " in *" status "*) exec sleep 30;; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      const started = Date.now();
      const scan = await scanProject(main, undefined, new Date(), { sizes: false, timeoutMs: 300 });
      assert.ok(Date.now() - started < 10_000, "each command is stopped at its timeout");
      for (const w of scan.worktrees) {
        assert.match(w.error ?? "", /git status --porcelain=v1 -z --untracked-files=normal.* in .* did not finish within 0\.3 s/);
        assert.equal(w.subject !== undefined, true, "what was read before the timeout is kept");
      }
      assert.equal(scan.problems.length, scan.worktrees.length, "every failure is reported");
    } finally {
      process.env.PATH = saved;
    }
  });

  it("fails loudly on a folder that is not a repository", async () => {
    const dir = tempHome();
    await assert.rejects(scanProject(dir, undefined, new Date(), { sizes: false }), (error: unknown) => error instanceof GitError && /git worktree list --porcelain in .* failed \(exit 128\)/.test(error.message));
  });

  it("keeps known sizes when it does not walk, and stores the scan once, the agents' branches looked up", async () => {
    const { main } = repo();
    const store = new Store(tempHome());
    store.upsertSession({ id: "s1", provider: "Test", project: { name: "shop", dir: main } });
    store.upsertAgent("s1", "parked", { branch: "agent/never", state: "working" });
    const problems: string[] = [];
    const full = await refreshScan(store, main, { sizes: true, whenBusy: "skip" }, problems);
    assert.ok(full?.stored);
    const sized = full.scan.worktrees.find((w) => w.main);
    assert.ok(sized?.bytes !== undefined && sized.sizedAt !== undefined);
    const quick = await refreshScan(store, main, { sizes: false, whenBusy: "skip" }, problems);
    assert.equal(quick?.scan.worktrees.find((w) => w.main)?.bytes, sized.bytes, "the size measured before is kept");
    assert.deepEqual(quick?.scan.branches, [{ name: "agent/never", exists: false }]);
    assert.deepEqual(problems, []);
    // While another scan runs: `skip` reads nothing, `read` reads without storing.
    const release = store.claimScan(full.scan.id);
    try {
      assert.equal(await refreshScan(store, main, { sizes: false, whenBusy: "skip" }, problems), undefined);
      const read = await refreshScan(store, main, { sizes: false, whenBusy: "read" }, problems);
      assert.equal(read?.stored, false);
    } finally {
      release?.();
    }
  });
});

describe("a session's branches", () => {
  const at = (min: number) => new Date(Date.parse("2026-11-10T10:00:00.000Z") + min * 60_000).toISOString();
  const session: Session = { id: "s1", provider: "Test", project: { name: "shop", dir: "/p/shop" }, state: "working", startedAt: at(0), updatedAt: at(0) };
  const agent = (name: string, more: Partial<Agent>): Agent => ({ sessionId: "s1", name, state: "working", after: [], startedAt: at(1), updatedAt: at(1), ...more });
  const scan: ProjectScan = {
    id: "shop-1",
    name: "shop",
    dir: "/p/shop",
    baseBranch: "main",
    worktrees: [
      { path: "/p/shop", branch: "main", head: "aaa", main: true, dirty: 0, subject: "Base", committedAt: at(-60) },
      { path: "/p/shop/.claude/worktrees/one", branch: "agent/one", head: "bbb", main: false, merged: false, ahead: 2, behind: 1, dirty: 3, subject: "One", committedAt: at(5), busy: ["vitest"] },
      { path: "/p/shop/.claude/worktrees/two", branch: "agent/two", head: "ccc", main: false, merged: true, ahead: 0, behind: 4, dirty: 0, subject: "Two", committedAt: at(-30) },
      { path: "/p/shop-old", branch: "old", head: "ddd", main: false, merged: true, ahead: 0, behind: 9, dirty: 0, subject: "Old", committedAt: at(-900) },
      { path: "/p/shop-open", branch: "open", head: "eee", main: false, merged: false, ahead: 1, behind: 0, dirty: 0, subject: "Open", committedAt: at(-90) },
    ],
    branches: [{ name: "agent/parked", exists: false }],
    totalBytes: 0,
    dayStart: { day: "2026-11-10", bytes: 0 },
    measuredAt: at(10),
    problems: [],
  };

  it("lists the main checkout, each agent's checkout (by its folder, else its branch) or branch, then the other checkouts, counting the merged idle ones", () => {
    const agents = [
      agent("one", { worktree: "/p/shop/.claude/worktrees/one/src", startedAt: at(2) }),
      agent("two", { branch: "agent/two", state: "done", startedAt: at(1) }),
      agent("parked", { branch: "agent/parked", startedAt: at(3) }),
      agent("fresh", { branch: "agent/fresh", startedAt: at(4), updatedAt: at(11) }),
      agent("plain", { startedAt: at(5) }),
      { ...agent("other", { branch: "agent/one" }), sessionId: "s2" },
    ];
    const b = sessionBranches(session, agents, scan);
    assert.ok(b);
    assert.deepEqual(
      b.rows.map((r) => [r.agent?.name ?? "-", r.branch, r.status]),
      [["-", "main", "found"], ["two", "agent/two", "found"], ["one", "agent/one", "found"], ["parked", "agent/parked", "missing"], ["fresh", "agent/fresh", "unread"], ["-", "open", "found"]],
    );
    assert.equal(b.rows[0]?.session, true, "the session works in the main checkout");
    assert.equal(b.hidden, 1, "the old merged, clean, idle checkout is counted, not shown");
    assert.equal(b.checkedAt, scan.measuredAt);
    assert.equal(sessionBranches(session, agents, undefined), undefined);
  });

  it("words them for the session, cut to a bound at a line's end", () => {
    const now = new Date(at(15));
    const b = sessionBranches(session, [agent("one", { worktree: "/p/shop/.claude/worktrees/one", goal: "First" })], scan);
    const lines = statusLines({ session, branches: b, agents: [agent("one", { goal: "First", state: "blocked" })], questions: [], services: [], reviews: [], now });
    assert.equal(lines[0], "Branches (git read 5 min ago; compared with main):");
    assert.equal(lines[2], "- agent one (working) · agent/one · .claude/worktrees/one · 2 ahead, 1 behind · 3 changed files · last «One» 10 min ago · in use: vitest");
    assert.ok(lines.includes("Agents not finished:"));
    const many = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(50)}`);
    const cut = fitText(many, 1000, "… (cut)");
    assert.ok(cut.length <= 1000);
    assert.ok(cut.endsWith("\n… (cut)"));
    assert.equal(fitText(["short"], 1000, "… (cut)"), "short");
  });
});

/** The fields a test compares, without times and heads. */
function pick(w: ProjectScan["worktrees"][number] | undefined) {
  if (!w) return undefined;
  const { path: _p, head: _h, committedAt: _c, bytes: _b, sizedAt: _s, busy: _busy, ...rest } = w;
  return rest;
}
