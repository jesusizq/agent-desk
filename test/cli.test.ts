import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { procInfo } from "../src/core/proc.ts";
import { Store } from "../src/store/store.ts";
import { PNG, tempHome } from "./helpers.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "main.ts");
const exec = promisify(execFile);

async function cli(home: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], { env: { ...process.env, AGENT_DESK_HOME: home, AGENT_DESK_SESSION: "" } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

/** A session whose process is this test runner, so CLI children find it as their ancestor. */
function sessionOfThisProcess(): Store {
  const store = new Store(tempHome());
  const own = procInfo(process.pid);
  store.upsertSession({ id: "me", provider: "Test", project: { name: "shop", dir: "/work/shop" }, process: { pid: process.pid, ...(own ? { start: own.start } : {}), ancestors: [] } });
  return store;
}

describe("cli", () => {
  it("finds the calling session from its process ancestry", async () => {
    const store = sessionOfThisProcess();
    const out = await cli(store.paths.home, "ask", "Bars or line?", "--option", "Bars", "--option", "Line");
    assert.equal(out.code, 0, out.stderr);
    const [q] = store.openQuestions("me");
    assert.deepEqual([q?.text, q?.options], ["Bars or line?", ["Bars", "Line"]]);
  });

  it("posts a result with images, comparison and checks", async () => {
    const store = sessionOfThisProcess();
    const img = path.join(tempHome(), "a.png");
    fs.writeFileSync(img, PNG);
    const out = await cli(store.paths.home, "result", "Checkout on mobile", "--summary", "Fixed bar", "--image", `${img}::Before`, "--image", `${img}::After`, "--compare", "0,1", "--url", "http://localhost:5173/x", "--check", "Pay button visible => screenshot at 390 px");
    assert.equal(out.code, 0, out.stderr);
    const [r] = store.listResults();
    assert.deepEqual(r?.images.map((i) => i.caption), ["Before", "After"]);
    assert.deepEqual(r?.checks, [{ criterion: "Pay button visible", verification: "screenshot at 390 px" }]);
    assert.ok(r?.compare);
  });

  it("names agents like the hooks do, so the session can add what only it knows", async () => {
    const store = sessionOfThisProcess();
    const out = await cli(store.paths.home, "agent", "Fix pay button", "--after", "Summary bar", "--branch", "agent/pay", "--state", "blocked");
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(store.listAgents("me").map((a) => [a.name, a.after, a.branch, a.state]), [["fix-pay-button", ["summary-bar"], "agent/pay", "blocked"]]);
  });

  it("posts a result that has something to see or try, or that failed", async () => {
    const store = sessionOfThisProcess();
    for (const args of [["--url", "http://localhost:5173/x"], ["--failed", "--summary", "The build broke"]]) {
      const out = await cli(store.paths.home, "result", "Worth a look", ...args);
      assert.equal(out.code, 0, out.stderr);
    }
    assert.equal(store.listResults().length, 2);
  });

  it("explains what is wrong with its input and exits 2", async () => {
    const store = sessionOfThisProcess();
    const cases: [string[], RegExp][] = [
      [["result", "x", "--url", "https://example.com"], /only local URLs/],
      [["agent", "x", "--state", "sleeping"], /--state: expected one of/],
      [["ask", "a", "b"], /unexpected argument "b"; quote text/],
      [["ask", "x", "--bogus"], /bogus/],
      [["ask", "x", "--session", "../etc"], /--session/],
      [["result", "x", "--check", "no arrow"], /--check: expected/],
      [["result", "A definition written to a file", "--summary", "Closed"], /nothing to see or try/],
      [["toString"], /unknown command/],
    ];
    for (const [args, message] of cases) {
      const out = await cli(store.paths.home, ...args);
      assert.equal(out.code, 2, args.join(" "));
      assert.match(out.stderr, message, args.join(" "));
    }
  });

  it("refuses to post outside a registered session", async () => {
    const out = await cli(tempHome(), "ask", "Anyone?");
    assert.equal(out.code, 2);
    assert.match(out.stderr, /does not run inside a registered session/);
  });
});

describe("cli decisions", () => {
  const decide = (store: Store, text: string, answer: string, options: string[] = []) => {
    const q = store.ask({ sessionId: "me", kind: "question", text, options });
    store.closeOpen("me", { answer, which: (x) => x.id === q.id });
  };

  it("lists what the calling session's project decided, newest first, each answer verbatim", async () => {
    const store = sessionOfThisProcess();
    store.upsertSession({ id: "other", provider: "Test", project: { name: "blog", dir: "/work/blog" } });
    store.ask({ sessionId: "other", kind: "question", text: "Another project?" });
    store.closeOpen("other", { answer: "not shown" });
    decide(store, "Bars or line?\nThe chart has 12 points.", "Bars,\n  in indigo", ["Bars", "Line"]);
    store.interpret("me", "Bar chart, brand indigo");
    store.addResult({ sessionId: "me", title: "Chart", url: "http://localhost:5173", decisions: ["Labels inside the bars"] });
    const out = await cli(store.paths.home, "decisions");
    assert.equal(out.code, 0, out.stderr);
    const [head, result, question, ...rest] = out.stdout.trimEnd().split("\n\n");
    assert.equal(head, "Decisions in shop (/work/shop), newest first: 2 of 2.");
    assert.match(result ?? "", /^\d{4}-\d\d-\d\d \d\d:\d\dZ · session me · decided by the session, reported with its result "Chart"\n {2}- Labels inside the bars$/);
    assert.match(question ?? "", /· session me\n {2}Asked: Bars or line\?\n {2}Options: Bars \| Line\n {2}Answer: Bars,\n {6}in indigo\n {2}Understood as: Bar chart, brand indigo$/);
    assert.deepEqual(rest, []);
    assert.doesNotMatch(out.stdout, /Another project/);
  });

  it("says how many are left out past the limit, finds the words searched for, and gives the records whole in JSON", async () => {
    const store = sessionOfThisProcess();
    for (let i = 0; i < 5; i++) decide(store, `Choice ${i}?`, `Answer ${i}`);
    decide(store, "Long one?", "x".repeat(1500));
    const limited = await cli(store.paths.home, "decisions", "--limit", "2");
    assert.equal(limited.code, 0, limited.stderr);
    assert.match(limited.stdout, /newest first: 2 of 6\./);
    assert.match(limited.stdout, /Answer: x{1000}… \(500 more characters; --json shows it whole\)/);
    assert.match(limited.stdout, /4 older not shown; narrow with --search or raise --limit \(now 2\)\.\n$/);
    const searched = await cli(store.paths.home, "decisions", "--search", "CHOICE 3");
    assert.match(searched.stdout, /matching "CHOICE 3", newest first: 1 of 1\.[\s\S]*Answer: Answer 3/);
    const none = await cli(store.paths.home, "decisions", "--search", "nothing like it");
    assert.equal(none.stdout, 'No decisions recorded in shop (/work/shop) matching "nothing like it".\n');
    const json = await cli(store.paths.home, "decisions", "--json", "--limit", "1");
    const parsed = JSON.parse(json.stdout) as { total: number; decisions: { source: string; question: { answer: { text: string } } }[]; problems: string[] };
    assert.equal(parsed.total, 6);
    assert.equal(parsed.decisions[0]?.question.answer.text, "x".repeat(1500));
    assert.deepEqual(parsed.problems, []);
  });

  it("outside a session, lists the project of the current folder, or the one named, and reports unreadable records", async () => {
    const home = tempHome();
    const store = new Store(home);
    const project = fs.realpathSync(tempHome());
    fs.mkdirSync(path.join(project, "src"));
    store.upsertSession({ id: "s1", provider: "Test", project: { name: "notes", dir: project } });
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Markdown or HTML?" });
    store.closeOpen("s1", { answer: "Markdown", which: (x) => x.id === q.id });
    fs.writeFileSync(path.join(store.paths.questionDir("closed"), "q-broken.json"), "{");
    const env = { ...process.env, AGENT_DESK_HOME: home, AGENT_DESK_SESSION: "" };
    const { stdout, stderr } = await exec(process.execPath, [CLI, "decisions"], { cwd: path.join(project, "src"), env });
    assert.ok(stdout.startsWith(`Decisions in notes (${project}), newest first: 1 of 1.`), stdout);
    assert.match(stdout, /Answer: Markdown/);
    assert.match(stderr, /skipped an unreadable record: .*q-broken\.json: not valid JSON/);
    const named = await cli(home, "decisions", "--project", "notes");
    assert.match(named.stdout, /Answer: Markdown/);
  });

  it("explains what is wrong with its arguments and exits 2", async () => {
    const store = sessionOfThisProcess();
    const cases: [string[], RegExp][] = [
      [["decisions", "--limit", "0"], /--limit: expected an integer between 1 and 500, got 0/],
      [["decisions", "--limit", "ten"], /--limit: expected an integer between 1 and 500, got "ten"/],
      [["decisions", "--search", " "], /--search: must not be empty/],
      [["decisions", "--project", "nope"], /no project named "nope" in the store \(known: shop\)/],
      [["decisions", "--project", "/nowhere/at/all"], /no session in the store ran in \/nowhere\/at\/all/],
      [["decisions", "topic"], /unexpected argument "topic"/],
    ];
    for (const [args, message] of cases) {
      const out = await cli(store.paths.home, ...args);
      assert.equal(out.code, 2, args.join(" "));
      assert.match(out.stderr, message, args.join(" "));
    }
    const outside = await cli(tempHome(), "decisions");
    assert.equal(outside.code, 2);
    assert.match(outside.stderr, /does not run inside a registered session, and no session in the store ran in .*; pass --project/);
  });
});
