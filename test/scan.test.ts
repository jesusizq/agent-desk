import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseWorktreeList, scanProject } from "../src/project/scan.ts";
import { tempHome } from "./helpers.ts";

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString();

describe("project scan", () => {
  it("reads git's worktree listing, branches and detached heads", () => {
    const listed = parseWorktreeList("worktree /p\nHEAD aaa\nbranch refs/heads/main\n\nworktree /p-qa\nHEAD bbb\ndetached\n\n");
    assert.deepEqual(listed, [{ path: "/p", head: "aaa", branch: "main" }, { path: "/p-qa", head: "bbb" }]);
  });

  it("measures each checkout and tells merged worktrees from the ones with work ahead", async () => {
    const root = tempHome();
    const repo = path.join(root, "shop");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "x".repeat(1000));
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "first");
    git(repo, "worktree", "add", "-q", "-b", "done", path.join(root, "shop-done"));
    git(repo, "worktree", "add", "-q", "-b", "wip", path.join(root, "shop-wip"));
    fs.writeFileSync(path.join(root, "shop-wip", "b.txt"), "y".repeat(5000));
    git(path.join(root, "shop-wip"), "add", ".");
    git(path.join(root, "shop-wip"), "commit", "-qm", "wip");

    const scan = await scanProject(repo, undefined, new Date("2026-10-28T10:00:00.000Z"));
    assert.equal(scan.baseBranch, "main");
    const by = Object.fromEntries(scan.worktrees.map((w) => [w.branch, w]));
    assert.equal(by.main?.main, true);
    assert.deepEqual([by.done?.merged, by.done?.ahead], [true, 0]);
    assert.deepEqual([by.wip?.merged, by.wip?.ahead], [false, 1]);
    assert.ok((by.wip?.bytes ?? 0) >= 6000, "the worktree's files are counted");
    assert.equal(scan.totalBytes, scan.worktrees.reduce((n, w) => n + w.bytes, 0));
    assert.deepEqual(scan.dayStart, { day: "2026-10-28", bytes: scan.totalBytes });

    fs.writeFileSync(path.join(root, "shop-wip", "big.bin"), Buffer.alloc(100_000));
    const later = await scanProject(repo, scan, new Date("2026-10-28T10:20:00.000Z"));
    assert.equal(later.totalBytes, scan.totalBytes, "sizes are reused within the hour");
    const hourLater = await scanProject(repo, later, new Date("2026-10-28T11:30:00.000Z"));
    assert.ok(hourLater.totalBytes >= scan.totalBytes + 100_000, "and measured again after it");
    assert.deepEqual(hourLater.dayStart, scan.dayStart, "the day's starting total is kept");
  });
});
