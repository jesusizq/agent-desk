import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { locateProject } from "../src/project/locate.ts";
import { parseWorktreeList, projectId, scanProject } from "../src/project/scan.ts";
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
    assert.equal(scan.totalBytes, scan.worktrees.reduce((n, w) => n + (w.bytes ?? 0), 0));
    assert.deepEqual(scan.dayStart, { day: "2026-10-28", bytes: scan.totalBytes });

    fs.writeFileSync(path.join(root, "shop-wip", "big.bin"), Buffer.alloc(100_000));
    const later = await scanProject(repo, scan, new Date("2026-10-28T10:20:00.000Z"));
    assert.equal(later.totalBytes, scan.totalBytes, "sizes are reused within the hour");
    const hourLater = await scanProject(repo, later, new Date("2026-10-28T11:30:00.000Z"));
    assert.ok(hourLater.totalBytes >= scan.totalBytes + 100_000, "and measured again after it");
    assert.deepEqual(hourLater.dayStart, scan.dayStart, "the day's starting total is kept");
  });
});

describe("project of a folder", () => {
  /** A repository with one commit, in a fresh temp folder (real path, so comparisons hold). */
  const repoIn = (name: string) => {
    const root = fs.realpathSync(tempHome());
    const repo = path.join(root, name);
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "src", "a.txt"), "a");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "first");
    return { root, repo };
  };

  it("is the folder itself in a plain checkout, at its root or below, with the path as given", () => {
    const { repo } = repoIn("shop");
    assert.deepEqual(locateProject(repo), { name: "shop", dir: repo });
    assert.deepEqual(locateProject(path.join(repo, "src")), { name: "src", dir: path.join(repo, "src") });
    assert.deepEqual(locateProject(`${repo}/`), { name: "shop", dir: `${repo}/` }, "the project id stays the one it had");
    const outside = fs.realpathSync(tempHome());
    assert.deepEqual(locateProject(outside), { name: path.basename(outside), dir: outside });
  });

  it("groups a linked worktree, nested or beside it, under the main checkout, keeping where the session works", () => {
    const { root, repo } = repoIn("shop");
    const nested = path.join(repo, ".claude", "worktrees", "agent-1");
    const beside = path.join(root, "shop-wt-feature");
    git(repo, "worktree", "add", "-q", "-b", "agent-1", nested);
    git(repo, "worktree", "add", "-q", "-b", "feature", beside);
    for (const wt of [nested, beside]) {
      assert.deepEqual(locateProject(wt), { name: "shop", dir: repo, worktree: wt });
      assert.equal(projectId(locateProject(wt).dir), projectId(repo), "the same project, under the id it already had");
      assert.deepEqual(locateProject(path.join(wt, "src")), { name: "src", dir: path.join(repo, "src"), worktree: path.join(wt, "src") });
    }
    // Reached through a symlink, it is the same worktree.
    const link = path.join(root, "link-to-feature");
    fs.symlinkSync(beside, link);
    assert.deepEqual(locateProject(link), { name: "shop", dir: repo, worktree: link });
  });

  it("keeps a submodule its own project, apart from its superproject", () => {
    const { repo: lib } = repoIn("lib");
    const { repo: app } = repoIn("app");
    git(app, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib");
    const sub = path.join(app, "vendor", "lib");
    assert.ok(fs.statSync(path.join(sub, ".git")).isFile(), "a submodule's .git is a file, as a worktree's is");
    assert.deepEqual(locateProject(sub), { name: "lib", dir: sub });
  });

  it("keeps each worktree of a bare repository its own project: there is no main checkout", () => {
    const { root, repo } = repoIn("shop");
    const bare = path.join(root, "shop.git");
    git(root, "clone", "-q", "--bare", repo, bare);
    const wt = path.join(root, "shop-main");
    git(bare, "worktree", "add", "-q", wt, "main");
    assert.deepEqual(locateProject(wt), { name: "shop-main", dir: wt });
  });

  it("falls back to the folder itself when git's files are missing, corrupt or point elsewhere", () => {
    const { root, repo } = repoIn("shop");
    const wt = path.join(root, "shop-wt");
    git(repo, "worktree", "add", "-q", "-b", "wt", wt);
    const dotGit = path.join(wt, ".git");
    const good = fs.readFileSync(dotGit, "utf8");
    const gitdir = good.replace(/^gitdir: /, "").trim();
    const cases: [string, () => void, () => void][] = [
      ["garbage instead of a gitdir line", () => fs.writeFileSync(dotGit, "\0\0 not git"), () => fs.writeFileSync(dotGit, good)],
      ["a gitdir that does not exist", () => fs.writeFileSync(dotGit, "gitdir: /nowhere/.git/worktrees/x\n"), () => fs.writeFileSync(dotGit, good)],
      ["no commondir", () => fs.renameSync(path.join(gitdir, "commondir"), path.join(gitdir, "commondir.off")), () => fs.renameSync(path.join(gitdir, "commondir.off"), path.join(gitdir, "commondir"))],
      ["a back-link to another worktree", () => fs.writeFileSync(path.join(gitdir, "gitdir"), `${path.join(root, "other", ".git")}\n`), () => fs.writeFileSync(path.join(gitdir, "gitdir"), `${dotGit}\n`)],
      ["a commondir that is not the main checkout's .git", () => fs.writeFileSync(path.join(gitdir, "commondir"), `${root}\n`), () => fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n")],
    ];
    for (const [what, breakIt, repair] of cases) {
      breakIt();
      assert.deepEqual(locateProject(wt), { name: "shop-wt", dir: wt }, what);
      repair();
      assert.equal(locateProject(wt).dir, repo, `${what}, repaired`);
    }
  });
});
