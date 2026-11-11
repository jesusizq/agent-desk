// Pages a session opens in the developer's browser are published as reviews by its adapter.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { handleHook, type HookContext, readHookInput } from "../adapters/claude-code/hooks.ts";
import { notPublished, openedPages } from "../adapters/claude-code/pages.ts";
import type { Store } from "../src/store/store.ts";
import { PNG, tempHome, testStore } from "./helpers.ts";

const PAGE = '<!doctype html><html><head><title>Propuestas &amp; variantes\n  del checkout</title></head><body><img src="shot.png"><p>3 options</p></body></html>';

/** A project folder holding a page and the image it shows, its real path. */
function project() {
  const dir = path.join(fs.realpathSync(tempHome()), "shop");
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  const page = path.join(dir, "docs", "proposals.html");
  fs.writeFileSync(page, PAGE);
  fs.writeFileSync(path.join(dir, "docs", "shot.png"), PNG);
  return { dir, page };
}
function ctx(store: Store, dir: string): HookContext {
  return { store, env: { TERM_PROGRAM: "vscode", CLAUDE_PROJECT_DIR: dir, HOME: "/home/dev" }, sessionProcess: () => ({ pid: process.pid, ancestors: [] }) };
}
const event = (cwd: string, hook_event_name: string, extra: Record<string, unknown> = {}) => readHookInput(JSON.stringify({ session_id: "cc-1", cwd, hook_event_name, ...extra }));
const bash = (cwd: string, command: string) => event(cwd, "PostToolUse", { tool_name: "Bash", tool_input: { command }, tool_response: { stdout: "" } });

describe("pages opened in the browser", () => {
  it("finds the local HTML files a command opens in a browser, through quotes, cd, wrappers and file: URLs", () => {
    const cases: [string, string[][]][] = [
      ["xdg-open /tmp/out/review.html", [["/tmp/out/review.html"]]],
      ["cd docs && xdg-open proposals.html", [["/work/shop/docs/proposals.html", "/work/shop/proposals.html"]]],
      ['open "Mis propuestas.html"', [["/work/shop/Mis propuestas.html"]]],
      ["python3 -m webbrowser -t file:///tmp/a%20b.html", [["/tmp/a b.html"]]],
      ["firefox --new-tab ~/notes/plan.htm", [["/home/dev/notes/plan.htm"]]],
      ["nohup google-chrome /tmp/r.html >/dev/null 2>&1 &", [["/tmp/r.html"]]],
      ["(cd /tmp/out && gio open index.html)", [["/tmp/out/index.html", "/work/shop/index.html"]]],
      ["ls *.html && env BROWSER=x sensible-browser 'docs/a.html' docs/b.HTML # both", [["/work/shop/docs/a.html"], ["/work/shop/docs/b.HTML"]]],
      ["xdg-open /tmp/r.html; xdg-open /tmp/r.html", [["/tmp/r.html"]]],
    ];
    for (const [command, expected] of cases) assert.deepEqual(openedPages(command, "/work/shop", "/home/dev"), expected, command);
    const none = [
      "chromium --headless --screenshot=s.png /tmp/r.html", // a browser run for a program
      "google-chrome --print-to-pdf=r.pdf file:///tmp/r.html",
      "xdg-open http://localhost:5173/", // a served page shows as a service
      "xdg-open $OUT/page.html", // known only to the shell
      'xdg-open "$(ls -t *.html | head -1)"',
      "echo xdg-open /tmp/a.html",
      "cat /tmp/a.html | grep title",
      "xdg-open /tmp/report.pdf",
      "npx playwright test --reporter=html",
    ];
    for (const command of none) assert.deepEqual(openedPages(command, "/work/shop", "/home/dev"), [], command);
  });

  it("publishes a page the session opens as a review titled after the page, its images inlined, once a turn", () => {
    const { dir, page } = project();
    const store = testStore();
    const c = ctx(store, dir);
    handleHook(event(dir, "SessionStart", { source: "startup" }), c);
    handleHook(bash(dir, "cd docs && xdg-open proposals.html"), c);
    const [review, ...more] = store.listReviews();
    assert.deepEqual(more, []);
    assert.equal(review?.title, "Propuestas & variantes del checkout", "the page's <title>, as it reads");
    assert.deepEqual(review?.rounds.map((r) => [r.n, r.page, r.sessionId]), [[1, page, "cc-1"]]);
    assert.match(store.reviewPage(review?.id ?? "")?.html ?? "", /<img src="data:image\/png;base64,/, "inlined as agent-desk review --page inlines it");
    // Opened again this turn, changed or not, it is not published again.
    fs.writeFileSync(page, PAGE.replace("3 options", "4 options"));
    handleHook(bash(dir, `xdg-open ${page}`), c);
    assert.equal(store.listReviews()[0]?.rounds.length, 1);
    // In a later turn, unchanged it stays as it is; changed, it is the review's next round.
    handleHook(event(dir, "Stop", { last_assistant_message: "Done." }), c);
    handleHook(event(dir, "UserPromptSubmit", { prompt: "go on" }), c);
    handleHook(bash(dir, `xdg-open file://${page}`), c);
    assert.deepEqual(store.listReviews()[0]?.rounds.map((r) => r.n), [1, 2], "the page changed since round 1");
    handleHook(event(dir, "Stop", { last_assistant_message: "Done." }), c);
    handleHook(bash(dir, `xdg-open ${page}`), c);
    assert.deepEqual(store.listReviews()[0]?.rounds.map((r) => r.n), [1, 2], "unchanged since its latest round: no round that looks new");
  });

  it("leaves a page the session already published with agent-desk review this turn, and one without a title is named after its file", () => {
    const { dir, page } = project();
    const store = testStore();
    const c = ctx(store, dir);
    handleHook(event(dir, "SessionStart", { source: "startup" }), c);
    store.publishReview({ sessionId: "cc-1", title: "Checkout copy", html: PAGE, page });
    handleHook(bash(dir, `open ${page}`), c);
    assert.deepEqual(store.listReviews().map((r) => r.title), ["Checkout copy"]);
    const bare = path.join(dir, "docs", "variants.html");
    fs.writeFileSync(bare, "<p>no title</p>");
    handleHook(bash(dir, `xdg-open ${bare}`), c);
    assert.ok(store.listReviews().some((r) => r.title === "variants.html"));
  });

  it("publishes no page of a tool, of an app's build, from outside the session's places, or made of several files, saying why when it is the page's", () => {
    const { dir } = project();
    const store = testStore();
    const c = ctx(store, dir);
    handleHook(event(dir, "SessionStart", { source: "startup" }), c);
    const write = (relative: string, html = PAGE) => {
      const file = path.join(dir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, html);
      return file;
    };
    for (const relative of ["node_modules/pkg/docs/index.html", "coverage/lcov-report/index.html", "playwright-report/index.html", "dist/index.html", "web/build/index.html"]) {
      const out = handleHook(bash(dir, `xdg-open ${write(relative)}`), c);
      assert.equal(out.stderr, undefined, relative);
    }
    assert.deepEqual(store.listReviews(), []);
    const app = write("mock/app.html", '<html><head><link rel="stylesheet" href="app.css"><link rel="icon" href="i.png"><script src="https://cdn.example/x.js"></script><script src="./app.js"></script></head></html>');
    const out = handleHook(bash(dir, `xdg-open ${app}`), c);
    assert.match(out.stderr ?? "", /mock\/app\.html opened in the browser was not published as a review: it loads app\.css, \.\/app\.js from beside it/);
    assert.deepEqual(store.listReviews(), []);
    const big = write("big.html", `<title>Big</title>${"x".repeat(26 * 1024 * 1024)}`);
    assert.match(handleHook(bash(dir, `xdg-open ${big}`), c).stderr ?? "", /big\.html opened in the browser was not published as a review: --page: .* larger than/);
    assert.deepEqual(store.listReviews(), []);
    handleHook(bash(dir, "xdg-open /tmp/agent-desk-no-such-page.html"), c);
    assert.deepEqual(store.listReviews(), [], "a page that does not exist");
  });

  it("takes pages in the project, its linked worktrees and the temporary folder only", () => {
    const root = fs.realpathSync(tempHome());
    const repo = path.join(root, "shop");
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "first");
    const elsewhere = path.join(root, "shop-feature");
    git("worktree", "add", "-q", "-b", "feature", elsewhere);
    const session = { project: { name: "shop", dir: repo } };
    assert.equal(notPublished(path.join(repo, "docs", "a.html"), session, []), undefined);
    assert.equal(notPublished(path.join(elsewhere, "docs", "a.html"), session, []), undefined, "a linked worktree outside the main checkout");
    assert.match(notPublished(path.join(elsewhere, "dist", "a.html"), session, []) ?? "", /under dist\//);
    assert.match(notPublished(path.join(root, "other", "a.html"), session, []) ?? "", /outside the session's project/);
    assert.equal(notPublished(path.join(root, "other", "a.html"), session, [root]), undefined, "the temporary folder");
    assert.match(notPublished(path.join(root, "other", "node_modules", "a.html"), session, [root]) ?? "", /under node_modules\//);
  });
});
