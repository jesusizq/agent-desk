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

  it("marks an answer that was only what the developer typed next, in the text and in JSON", async () => {
    const store = sessionOfThisProcess();
    decide(store, "Keep the old table?", "Keep it");
    const q = store.ask({ sessionId: "me", kind: "waiting", text: "¿Añado esa línea?" });
    store.closeOpen("me", { answer: "esas frases en rojo…", probable: true, which: (x) => x.id === q.id });
    const out = await cli(store.paths.home, "decisions");
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /Asked: ¿Añado esa línea\?\n {2}Answer \(next message in the terminal\): esas frases en rojo…/);
    assert.match(out.stdout, /Asked: Keep the old table\?\n {2}Answer: Keep it/, "a certain answer is unmarked");
    const json = JSON.parse((await cli(store.paths.home, "decisions", "--json")).stdout) as { decisions: { question: { text: string; answer: { probable?: boolean } } }[] };
    assert.deepEqual(json.decisions.map((d) => [d.question.text, d.question.answer.probable]), [["¿Añado esa línea?", true], ["Keep the old table?", undefined]]);
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

describe("cli unanswered", () => {
  it("opens again the question the developer's reply did not answer, and keeps it out of the decisions", async () => {
    const store = sessionOfThisProcess();
    const q = store.ask({ sessionId: "me", kind: "waiting", text: "¿Añado esa línea?" });
    store.closeOpen("me", { answer: "esas frases en rojo…", probable: true });
    const out = await cli(store.paths.home, "unanswered");
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout, `open again on the desk, its reply set aside: ${q.id} "¿Añado esa línea?"\n`);
    assert.deepEqual(store.openQuestions("me").map((x) => x.id), [q.id]);
    assert.match((await cli(store.paths.home, "decisions")).stdout, /^No decisions recorded/);
    const again = await cli(store.paths.home, "unanswered");
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.stdout, `already open on the desk: ${q.id} "¿Añado esa línea?"\n`);
  });

  it("refuses to set aside an answer given on the desk unless the question is named, and explains bad input", async () => {
    const store = sessionOfThisProcess();
    const q = store.ask({ sessionId: "me", kind: "question", text: "Keep the table?" });
    const stop = store.listen("me");
    store.answerFromDesk(q.id, "yes");
    stop();
    const refused = await cli(store.paths.home, "unanswered");
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, new RegExp(`given to that very question on the desk, so it stays; .*--question ${q.id}`));
    assert.equal(store.getQuestion(q.id)?.status, "answered");
    const named = await cli(store.paths.home, "unanswered", "--question", q.id);
    assert.equal(named.code, 0, named.stderr);
    assert.equal(store.getQuestion(q.id)?.status, "open");
    const cases: [string[], RegExp][] = [
      [["unanswered", "--question", "../q"], /--question: expected an id/],
      [["unanswered", "--question", "q-none"], /no question q-none of session me/],
      [["unanswered", "now"], /unexpected argument "now"/],
    ];
    for (const [args, message] of cases) {
      const out = await cli(store.paths.home, ...args);
      assert.equal(out.code, 2, args.join(" "));
      assert.match(out.stderr, message, args.join(" "));
    }
  });

  it("records an interpretation only for an answer of the turn now running", async () => {
    const store = sessionOfThisProcess();
    const q = store.ask({ sessionId: "me", kind: "waiting", text: "Ship it?" });
    store.closeOpen("me", { answer: "yes", probable: true });
    store.updateSession("me", (s) => ({ ...s, turnEndedAt: new Date(Date.now() + 1000).toISOString() }));
    const out = await cli(store.paths.home, "interpret", "Ship today");
    assert.equal(out.code, 2);
    assert.match(out.stderr, /agent-desk interpret: no question was answered this turn: the latest answer, to "Ship it\?", was given before this turn began/);
    assert.equal(store.getQuestion(q.id)?.interpretation, undefined);
  });
});

describe("cli reviews", () => {
  /** A folder holding a page, images beside it and one outside it, and a symlink inside leading out. */
  function pageFolder(html: string): { page: string; root: string } {
    const root = tempHome();
    const dir = path.join(root, "review");
    fs.mkdirSync(path.join(dir, "img"), { recursive: true });
    fs.writeFileSync(path.join(dir, "img", "a.png"), PNG);
    fs.writeFileSync(path.join(dir, "img", "b c.png"), PNG);
    fs.writeFileSync(path.join(dir, "icon.svg"), '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>');
    fs.writeFileSync(path.join(dir, "fake.png"), "<script>alert(1)</script>");
    fs.writeFileSync(path.join(root, "outside.png"), PNG);
    fs.symlinkSync(path.join(root, "outside.png"), path.join(dir, "link.png"));
    fs.symlinkSync(root, path.join(dir, "up"));
    const page = path.join(dir, "page.html");
    fs.writeFileSync(page, html);
    return { page, root };
  }
  const DATA_PNG = `data:image/png;base64,${PNG.toString("base64")}`;

  it("publishes a page with only the images inside its own folder inlined", async () => {
    const store = sessionOfThisProcess();
    const html = [
      "<!doctype html><html><head><style>.a { background: url('img/a.png') } .b { background: url(../outside.png) }</style></head><body>",
      '<img src="img/a.png" alt="a > b"><img src=\'img/b%20c.png\'><img src="icon.svg"><img src="fake.png">',
      '<img src="../outside.png"><img src="link.png"><img src="up/outside.png"><img src="/etc/hosts"><img src="https://example.com/x.png"><img src="missing.png">',
      '<picture><source srcset="img/a.png 1x, img/a.png?v=2 2x"><img srcset="img/a.png 480w,link.png 800w"></picture>',
      "<div style=\"background-image: url('img/a.png')\"></div><p>img/a.png</p>",
      "<script>const s = \"<img src='img/a.png'>\";</script><!-- <img src=\"img/a.png\"> -->",
      "</body></html>",
    ].join("\n");
    const { page } = pageFolder(html);
    const out = await cli(store.paths.home, "review", "Proposals", "--page", page);
    assert.equal(out.code, 0, out.stderr);
    const [review] = store.listReviews();
    assert.ok(review);
    assert.match(out.stdout, new RegExp(`^review ${review.id} round 1: Proposals\n.*To review.*agent-desk review ${review.id}`));
    const kept = store.reviewPage(review.id)?.html ?? "";
    assert.ok(kept.includes(`.a { background: url(${DATA_PNG}) }`), "CSS url() in <style>");
    assert.ok(kept.includes(`.b { background: url(../outside.png) }`));
    assert.ok(kept.includes(`<img src="${DATA_PNG}" alt="a > b">`), "<img src>, keeping its quotes");
    assert.ok(kept.includes(`<img src='${DATA_PNG}'>`), "a %-escaped name");
    assert.ok(kept.includes('<img src="data:image/svg+xml;base64,'), "an SVG");
    for (const left of ['src="fake.png"', 'src="../outside.png"', 'src="link.png"', 'src="up/outside.png"', 'src="/etc/hosts"', 'src="https://example.com/x.png"', 'src="missing.png"']) {
      assert.ok(kept.includes(left), `${left} is left as is`);
    }
    assert.ok(kept.includes(`<source srcset="${DATA_PNG} 1x, ${DATA_PNG} 2x">`), "srcset with descriptors");
    assert.ok(kept.includes(`<img srcset="${DATA_PNG} 480w,link.png 800w">`), "a symlink out of the folder in a srcset is left");
    assert.ok(kept.includes(`<div style="background-image: url(${DATA_PNG})">`), "style=\"\"");
    assert.ok(kept.includes("<p>img/a.png</p>") && kept.includes("const s = \"<img src='img/a.png'>\";") && kept.includes('<!-- <img src="img/a.png"> -->'), "text, scripts and comments are untouched");
    for (const ref of ["fake.png", "../outside.png", "link.png", "up/outside.png", "/etc/hosts", "https://example.com/x.png", "missing.png"]) {
      assert.match(out.stderr, new RegExp(`left as is, .*: ${ref.replace(/[.?/]/g, "\\$&")}\\n`), ref);
    }
    assert.match(out.stderr, /outside the page's folder \(symlinks resolved\): link\.png/);
  });

  it("publishes the same title as the next round, and a session reads what was sent", async () => {
    const store = sessionOfThisProcess();
    const { page } = pageFolder("<html><head></head><body>1</body></html>");
    assert.equal((await cli(store.paths.home, "review", "Proposals", "--page", page)).code, 0);
    const again = await cli(store.paths.home, "review", "proposals", "--page", page);
    assert.match(again.stdout, /round 2: proposals/);
    const [review] = store.listReviews();
    assert.ok(review);
    store.changeReviewState(review.id, { ops: [{ op: "set", key: "cards", value: '{"1":"yes"}' }], progress: "1/2", summary: "✓ card 1" }, "local");
    store.sendReview(review.id, "other");
    assert.match((await cli(store.paths.home, "reviews")).stdout, new RegExp(`^${review.id}  «proposals»  round 2  1 of 2  sent, not read\n$`));
    const read = await cli(store.paths.home, "review", review.id);
    assert.equal(read.code, 0, read.stderr);
    assert.match(read.stdout, /^Review «proposals» \(rv-[^)]+\), project shop \(\/work\/shop\)\nRound 2, published .* by session me\nProgress: 1 of 2\nSent: .* copied for another conversation \(round 2, 1 of 2\)\nAnswers the page copied:\n✓ card 1\nSaved state \(the page's localStorage\), as JSON:\n\{\n {2}"cards": "\{\\"1\\":\\"yes\\"\}"\n\}\n$/);
    assert.deepEqual(store.getReview(review.id)?.collected && { by: store.getReview(review.id)?.collected?.sessionId, round: store.getReview(review.id)?.collected?.round }, { by: "me", round: 2 });
    assert.match((await cli(store.paths.home, "reviews")).stdout, /  read\n$/);
    const decisions = await cli(store.paths.home, "decisions", "--search", "card 1");
    assert.match(decisions.stdout, /Asked: Review «proposals», round 2\n {2}Answer: ✓ card 1/);
  });

  it("refuses a bad review id, title or page and exits 2", async () => {
    const store = sessionOfThisProcess();
    const { page, root } = pageFolder("<html></html>");
    const cases: [string[], RegExp][] = [
      [["review", "../x"], /expected a review id/],
      [["review", "rv-nothing"], /no review rv-nothing/],
      [["review", "two\nlines", "--page", page], /one line/],
      [["review", "T", "--page", path.join(root, "nope.html")], /--page: cannot read/],
      [["review", "T", "--page", root], /is not a file/],
    ];
    for (const [args, message] of cases) {
      const out = await cli(store.paths.home, ...args);
      assert.equal(out.code, 2, `${args.join(" ")}: ${out.stderr}`);
      assert.match(out.stderr, message);
    }
    assert.deepEqual(store.listReviews(), []);
  });
});
