// The page in a real headless Chrome, over the demo store: the desk: questions, agents, branches, strip.
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { Browser, type Page } from "./browser.ts";
import { Store } from "../src/store/store.ts";
import { arrived, base, browser, cardOf, fetchNow, open, pages, setupPage, SKIP, STILL, store, worktrees } from "./page-harness.ts";
import { gitIn, landedRepo, runScript, serve, tempHome, waitingScript } from "./helpers.ts";
import { procInfo } from "../src/core/proc.ts";
import { projectId, scanProject } from "../src/project/scan.ts";

describe("page: the desk: questions, agents, branches, strip", SKIP, () => {
  setupPage();

  it("draws the oldest question large and every live session", async () => {
    const page = await open();
    assert.match(await page.eval<string>("document.querySelector('.next').textContent"), /VAT be rounded per line/);
    assert.equal(await page.eval<number>("document.querySelectorAll('.scard').length"), 3);
    assert.equal(await page.eval<string>("document.title").then((t) => t.endsWith("Agent Desk")), true);
  });

  it("shows a session at work even when all its agents are done", async () => {
    store.upsertSession({ id: "all-done", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "all agents done" });
    store.upsertAgent("all-done", "only", { goal: "One finished job", state: "done" });
    const page = await open();
    const card = cardOf("all agents done");
    await page.waitFor(card);
    assert.equal(await page.eval<boolean>(`!!${card}.querySelector('.s-l1 .live .st-working')`), true, "a working dot for the session");
    assert.match(await page.eval<string>(`${card}.querySelector('.s-l3').textContent`), /^1 done$/);
    store.updateSession("all-done", (s) => ({ ...s, state: "waiting" }));
    await page.waitFor(`!${card}.querySelector('.st-working')`);
  });

  it("shows a closing list of decisions whole, titled by the line that introduces it", async () => {
    const decisions = [
      "Three things are left for you to decide:",
      "1. Shall I push this fix?",
      "2. Shall I log API errors always?",
      "3. Your ~/.bashrc has two problems:",
      "   - Node 20 first.",
      "   - A token in plain text.",
    ].join("\n");
    store.ask({ sessionId: "demo-pagos", kind: "waiting", text: decisions });
    const page = await open();
    await page.click(".qrow", "Three things are left for you to decide");
    await page.waitFor("document.querySelector('.next')?.textContent.includes('Shall I push this fix?')");
    assert.equal(await page.eval<string>("document.querySelector('.next .qtext').textContent"), "Three things are left for you to decide:");
    assert.deepEqual(await page.eval<string[]>("[...document.querySelectorAll('.next ol > li')].map((li) => li.firstChild.textContent)"), ["Shall I push this fix?", "Shall I log API errors always?", "Your ~/.bashrc has two problems:"]);
  });

  it("leaves a report that asks nothing out of Needs you, marked new on its session's card", async () => {
    store.upsertSession({ id: "report-only", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "nightly report", state: "waiting", lastMessage: { text: "Both builds are green; 8 agents still at work.", at: new Date().toISOString() } });
    const page = await open();
    const card = cardOf("nightly report");
    await page.waitFor(card);
    assert.match(await page.eval<string>(`${card}.querySelector('.quiet-line.unread').textContent`), /New message.*Both builds are green/);
    assert.equal(await page.eval<boolean>("document.querySelector('.col-needs').textContent.includes('Both builds are green')"), false);
  });

  it("shows the number of pending items on the app's icon", async () => {
    const page = await browser.newPage(1400, 900);
    pages.push(page);
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.badges = []; navigator.setAppBadge = async (n) => { badges.push(n); }; navigator.clearAppBadge = async () => { badges.push(0); };" });
    await page.goto(base + "/");
    await page.waitFor("document.querySelector('.next')");
    const pending = await page.eval<number>("Number(/^\\((\\d+)\\)/.exec(document.title)?.[1])");
    assert.ok(pending > 0);
    assert.equal(await page.eval<number>("badges.at(-1)"), pending, "the icon counts what the title counts");
  });

  it("warns in amber of an agent quiet for a while, or failing its calls in a row, on its session's card and row", async () => {
    store.upsertSession({ id: "stuck", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "stuck agents", state: "working", activityAt: new Date().toISOString() });
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    store.upsertAgent("stuck", "silent", { goal: "Silent agent", activityAt: ago(8) });
    store.upsertAgent("stuck", "looping", { goal: "Looping agent", activityAt: ago(0), failedAt: [ago(3), ago(2), ago(1)], failedWhat: "Bash: npm test -- --grep checkout" });
    // The adapter ends a streak at each successful call: failures between fixes never add up.
    store.upsertAgent("stuck", "fine", { goal: "Fine agent", activityAt: ago(1), failedAt: [ago(1)], failedWhat: "Bash: grep -rn nothing src" });
    store.upsertAgent("stuck", "on-job", { goal: "Agent on its job", activityAt: ago(12), waitsForJob: true, activity: "Bash: npx playwright test" });
    store.upsertAgent("stuck", "broken", { goal: "Broken agent", state: "failed", activity: "No space left on device" });
    // An older adapter stamps no activity: its agent's last update, long ago, does not make it quiet.
    new Store(store.paths.home, () => new Date(Date.now() - 20 * 60_000)).upsertAgent("stuck", "unstamped", { goal: "Unstamped agent" });
    store.upsertSession({ id: "on-job", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "waiting on its build", state: "working", activityAt: ago(9), waitsForJob: true, activity: "TaskOutput" });
    const page = await open();
    const card = cardOf("stuck agents");
    await page.waitFor(card);
    const lines = await page.eval<{ text: string; color: string; tip: string; code: number }[]>(
      `[...${card}.querySelectorAll('.s-bad')].map((l) => ({ text: l.textContent, color: getComputedStyle(l).color, tip: l.title, code: l.querySelectorAll('code').length }))`,
    );
    assert.deepEqual(
      lines.map((l) => l.text),
      ["Broken agent · No space left on device", "Looping agent · 3 failed calls in a row", "Silent agent · no activity for 8 min"],
      "what matters about the session, one line each, failed agents first",
    );
    const [broken, looping, silent] = lines;
    assert.notEqual(looping?.color, broken?.color, "only a failed agent is red");
    assert.equal(looping?.color, silent?.color, "calls failing in a row warn, as a quiet agent does");
    assert.equal(looping?.code, 0, "the failing call is not printed in the card");
    assert.equal(looping?.tip, "", "not even in a tooltip: the call stays in the session panel");
    const jobCard = cardOf("waiting on its build");
    assert.equal(await page.eval<number>(`${jobCard}.querySelectorAll('.s-bad').length`), 0, "a session waiting on its own job is not quiet");
    assert.equal(await page.eval<string>(`${jobCard}.querySelector('.s-l1 .dot').title`), "Waiting on its job");
    await page.click(".scard", "stuck agents");
    await page.click("#session .agents-fold > summary");
    const row = (goal: string, what = ".astuck") => `[...document.querySelectorAll('#session .arow')].find((r) => r.textContent.includes('${goal}'))?.querySelector('${what}')`;
    const stuck = (goal: string) => page.eval<string>(`${row(goal)}?.textContent ?? ''`);
    assert.equal(await stuck("Silent agent"), "no activity for 8 min");
    assert.equal(await stuck("Looping agent"), "3 failed calls in a row");
    assert.equal(await page.eval<string>(`${row("Looping agent")}.title`), "Last failed: Bash: npm test -- --grep checkout");
    assert.equal(await stuck("Fine agent"), "", "one failure since the last successful call is not a pattern");
    assert.equal(await stuck("Agent on its job"), "", "an agent waiting on its own job is not quiet");
    assert.ok(await page.eval<boolean>(`${row("Agent on its job", ".dot")}.classList.contains('st-waiting')`), "it carries the waiting mark");
    assert.equal(await stuck("Unstamped agent"), "");
    await page.press("Escape");
  });

  it("says when a check sent a session's turn back to work, and names a check still failing in Needs you", async () => {
    const project = { name: "web-shop", dir: "/home/demo/Projects/web-shop" };
    const reason = "verify failed. Fix it before finishing:\n\n[web-shop] typecheck: 1 error";
    store.upsertSession({ id: "checked", provider: "Test", project, title: "reopened by its check", state: "working", activityAt: new Date().toISOString(), checkReopened: { times: 2, reason, at: new Date().toISOString() } });
    store.upsertSession({ id: "gave-up", provider: "Test", project, title: "its check gave up", state: "waiting" });
    const q = store.ask({ sessionId: "gave-up", kind: "waiting", text: "verify keeps failing after 3 attempts", context: reason, checkFailing: true });
    try {
      const page = await open();
      const card = cardOf("reopened by its check");
      await page.waitFor(card);
      const line = await page.eval<{ text: string; tip: string }>(`(() => { const l = ${card}.querySelector('.s-bad'); return { text: l.textContent, tip: l.title }; })()`);
      assert.deepEqual(line, { text: "A check sent it back to work 2 times · verify failed. Fix it before finishing:", tip: reason }, "plain text: the count and the refusal's first line, the rest in its tip");
      const row = "[...document.querySelectorAll('.qrow')].find((r) => r.textContent.includes('verify keeps failing'))";
      await page.waitFor(row);
      assert.equal(await page.eval<string>(`${row}.querySelector('.badge').textContent`), "Check failing");
      // Its next end waits while the checks run on it again, its waiter reading them: the panel still says the turn goes on.
      store.updateSession("checked", (s) => ({ ...s, state: "waiting", turnEndedAt: new Date().toISOString() }));
      const stop = store.listen("checked", process.pid, { checks: true });
      let again: (() => void) | undefined;
      try {
        await page.click(".scard", "reopened by its check");
        await page.waitFor("document.querySelector('#session .working-now')?.textContent.includes('Its checks run again')");
        assert.match(await page.eval<string>("document.querySelector('#session .working-now').textContent"), /Its checks run again.*A check sent it back to work 2 times · verify failed/);
        // Its waiter cannot read them (an unreadable transcript) and listens on for answers: nothing says they run.
        store.checksRead("checked");
        await page.waitFor("!document.querySelector('#session .working-now')");
        // A later end's waiter reads them again.
        again = store.listen("checked", process.pid, { checks: true });
        await page.waitFor("document.querySelector('#session .working-now')?.textContent.includes('Its checks run again')");
      } finally {
        again?.();
        stop();
      }
      // No waiter reads them any more (it gave up, or delivered an answer): nothing says they run.
      await page.waitFor("!document.querySelector('#session .working-now')");
      await page.press("Escape");
    } finally {
      store.dismiss(q.id);
      for (const id of ["checked", "gave-up"]) {
        store.updateSession(id, (s) => ({ ...s, state: "ended" }));
        store.forgetSession(id);
      }
    }
  });

  it("warns of the machine's load, memory and heat in the strip, and shows an agent at the load gate waiting for the machine, not stuck", async () => {
    const sick = tempHome();
    fs.writeFileSync(path.join(sick, "loadavg"), "21.37 9.00 4.00 9/900 1234\n");
    fs.writeFileSync(path.join(sick, "meminfo"), "MemTotal:       32000000 kB\nMemAvailable:    1953125 kB\n");
    fs.mkdirSync(path.join(sick, "class", "thermal", "thermal_zone0"), { recursive: true });
    fs.writeFileSync(path.join(sick, "class", "thermal", "thermal_zone0", "temp"), "97000\n");
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const dir = path.join(tempHome(), "gated-shop");
    const worktree = path.join(dir, ".claude", "worktrees", "tests");
    fs.mkdirSync(worktree, { recursive: true });
    // This test's process stands for the session: the gate it starts through a shell is its agent's.
    store.upsertSession({ id: "gated", provider: "Test", project: { name: "gated-shop", dir }, title: "agents at the gate", state: "working", activityAt: ago(9), process: { pid: process.pid, start: procInfo(process.pid)?.start ?? "", ancestors: [] } });
    store.upsertAgent("gated", "tests", { goal: "Test agent", activity: "Bash: npm test", activityIsCall: true, activityAt: ago(12), worktree });
    store.putProjectScan({ id: projectId(dir), name: "gated-shop", dir, worktrees: [{ path: dir, branch: "main", head: "abc1234", main: true }, { path: worktree, branch: "agent/tests", head: "def5678", main: false }], totalBytes: 0, dayStart: { day: "2026-10-28", bytes: 0 }, measuredAt: ago(1), problems: [] });
    const own = await serve(store, undefined, undefined, { proc: sick, sys: sick, cores: 12 });
    const gate = await runScript(waitingScript("load-gate.sh"), worktree);
    // Closed before its desk stops, so that its event stream is not cut under it.
    const page = await browser.newPage(1400, 900);
    try {
      await page.goto(own.base + "/");
      await page.waitFor("document.querySelector('#strip')?.textContent.includes('Load: 21.4')");
      assert.deepEqual(
        await page.eval<string[]>("[...document.querySelectorAll('#strip .chip.warn')].map((c) => c.textContent).filter((t) => /^(Load|Memory|Temperature):/.test(t))"),
        ["Load: 21.4, above its 12 cores", "Memory: 2.0 GB free, under 3.3 GB", "Temperature: 97 °C, at or above 95 °C"],
        "what is high, its reading and its limit, one line each",
      );
      const card = cardOf("agents at the gate");
      await page.waitFor(card);
      assert.equal(await page.eval<number>(`${card}.querySelectorAll('.s-bad').length`), 0, "an agent waiting for the machine is not quiet");
      await page.click(".scard", "agents at the gate");
      await page.click("#session .agents-fold > summary");
      const row = "[...document.querySelectorAll('#session .arow')].find((r) => r.textContent.includes('Test agent'))";
      await page.waitFor(row);
      assert.deepEqual(
        await page.eval(`({ doing: ${row}.querySelector('.adoing').textContent, waiting: ${row}.querySelector('.dot').classList.contains('st-waiting'), stuck: ${row}.querySelector('.astuck') !== null })`),
        { doing: "waits for the machine's load to drop", waiting: true, stuck: false },
      );
      await gate.end();
      await page.waitFor(`${row}?.querySelector('.adoing').textContent === 'now: Bash: npm test'`, 10_000);
      await page.press("Escape");
    } finally {
      await page.close();
      await gate.end();
      await own.close();
      store.updateSession("gated", (s) => ({ ...s, state: "ended" }));
    }
    assert.deepEqual(page.errors, [], "the page reports no errors");
  });

  it("keeps an agent's failure loud only until its session ends a turn after it, then one failed row in its list", async () => {
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const page = await open();
    await page.eval("localStorage.setItem('agent-desk:failures', 'on')");
    const project = { name: "web-shop", dir: "/home/demo/Projects/web-shop" };
    // It failed at the start of an earlier turn; the session has ended turns since, so it has told of it.
    store.upsertSession({ id: "told", provider: "Test", project, title: "told of its failure", state: "waiting", turnEndedAt: ago(30) });
    new Store(store.paths.home, () => new Date(Date.now() - 60 * 60_000)).upsertAgent("told", "profile", { goal: "Profile agent", state: "failed", activity: "Did not start: Permission to use Agent denied" });
    store.upsertAgent("told", "docs", { goal: "Docs agent", activityAt: ago(0) });
    // It failed during the turn now running.
    store.upsertSession({ id: "fresh", provider: "Test", project, title: "failing this turn", state: "working", activityAt: ago(0), turnEndedAt: ago(30) });
    new Store(store.paths.home, () => new Date(Date.now() - 5 * 60_000)).upsertAgent("fresh", "build", { goal: "Build agent", state: "failed", activity: "No space left on device" });
    const told = cardOf("told of its failure");
    const fresh = cardOf("failing this turn");
    await page.waitFor(`${told} && ${fresh}`);
    assert.deepEqual(await page.eval<string[]>(`[...${fresh}.querySelectorAll('.s-bad')].map((l) => l.textContent)`), ["Build agent · No space left on device"], "a failure of the turn at work stays loud");
    assert.equal(await page.eval<number>(`${told}.querySelectorAll('.s-bad').length`), 0, "a failure its session has told of is not");
    assert.ok(await page.eval<boolean>(`(() => { const cards = [...document.querySelectorAll('.scard')]; return cards.indexOf(${fresh}) < cards.indexOf(${told}); })()`), "nor does it raise its session");
    await page.waitFor("[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Build agent'))");
    assert.equal(await page.eval<boolean>("[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Profile agent'))"), false, "and calls for no notice");
    await page.eval("localStorage.removeItem('agent-desk:failures')");
    await page.click(".scard", "told of its failure");
    const chip = await page.eval<{ text: string; bad: boolean; mark: boolean }>(`(() => {
      const chip = [...document.querySelectorAll('#session .pchips > .chip')].find((c) => c.textContent.includes('agents'));
      return { text: chip.textContent, bad: chip.classList.contains('bad'), mark: !!chip.querySelector('.dot') };
    })()`);
    assert.deepEqual([chip.text.replace("▾", ""), chip.bad, chip.mark], ["2 agents · 1 failed", false, false], "its chip counts it, with no red");
    await page.click("#session .pchips button.chip", "agents");
    await page.waitFor("document.querySelector('#session .ppart .arow.failed')");
    assert.match(await page.eval<string>("document.querySelector('#session .ppart .arow.failed').textContent"), /Profile agent.*Did not start: Permission to use Agent denied/, "it stays a failed row in the session's agents");
    await page.press("Escape");
    for (const id of ["told", "fresh"]) store.upsertSession({ id, provider: "Test", project, state: "ended" });
  });

  it("draws each state in a shape of its own, solid only where it needs the developer, 14px on a card and 16px in a row", async () => {
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    store.upsertSession({ id: "marks", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "every state", state: "working" });
    for (const [name, state] of [["w", "working"], ["j", "waiting"], ["b", "blocked"], ["i", "idle"], ["f", "failed"], ["d", "done"]] as const) {
      store.upsertAgent("marks", name, { goal: `Agent ${state}`, state, activity: `${state} now`, startedAt: ago(20), after: name === "b" ? ["w"] : [] });
    }
    store.ask({ sessionId: "marks", kind: "question", text: "Which state is this?" });
    const page = await open();
    const card = cardOf("every state");
    await page.waitFor(`${card}?.querySelector('.s-bad')`);
    const size = (el: string) => `(() => { const r = ${el}.getBoundingClientRect(); return [r.width, r.height]; })()`;
    assert.deepEqual(await page.eval<number[]>(size(`${card}.querySelector('.s-l1 .dot.st-needs')`)), [14, 14], "the session's mark on its card");
    assert.deepEqual(await page.eval<string[]>(`[...${card}.querySelectorAll('.s-bad .dot')].map((d) => d.className)`), ["dot st-failed", "dot st-blocked"]);
    for (const line of await page.eval<number[][]>(`[...${card}.querySelectorAll('.s-bad')].map((l) => { const r = l.querySelector('.dot').getBoundingClientRect(); return [r.width, l.querySelector('span:not(.dot)').getBoundingClientRect().left]; })`)) {
      assert.equal(line[0], 14, "a trouble line's mark is the card's size");
      assert.ok(Math.abs((line[1] ?? 0) - (await page.eval<number>(`${card}.querySelector('.sname').getBoundingClientRect().left`))) <= 1, "its text starts under the session's name");
    }
    // The legend holds all seven: one shape each, filled solid, on a tint or as an outline.
    const legend = await page.eval<{ cls: string; w: number; mask: string; fill: string }[]>(`[...document.querySelectorAll('.legend .dot')].map((d) => ({
      cls: d.className, w: d.getBoundingClientRect().width, mask: getComputedStyle(d, '::before').maskImage, fill: getComputedStyle(d).backgroundColor }))`);
    assert.deepEqual(legend.map((d) => d.cls.replace("dot st-", "")), ["needs", "working", "waiting", "blocked", "idle", "failed", "done"]);
    assert.ok(legend.every((d) => d.w === 14), "one size in the legend");
    assert.equal(new Set(legend.map((d) => d.mask)).size, 7, "no two states share a shape");
    const tinted = legend.filter((d) => !/rgba\(0, 0, 0, 0\)|transparent/.test(d.fill)).map((d) => d.cls.replace("dot st-", ""));
    assert.deepEqual(tinted, ["working", "waiting", "blocked", "done"], "work in progress sits on a soft disc; needs you and failed are solid, idle an outline");
    await page.click(".scard", "every state");
    await page.click("#session .pchips button.chip", "agents");
    await page.waitFor("document.querySelectorAll('#session .ppart .arow .dot').length === 6");
    assert.deepEqual(
      await page.eval<string[]>("[...document.querySelectorAll('#session .ppart .arow .dot')].map((d) => `${d.className.replace('dot st-', '')} ${d.getBoundingClientRect().width}`)"),
      ["failed 16", "blocked 16", "idle 16", "working 16", "waiting 16", "done 16"],
    );
    const turning = "getComputedStyle(document.querySelector('#session .arow .live > .st-working'), '::before').animationName";
    assert.equal(await page.eval<string>(turning), "mark-turn", "an agent at work turns");
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    assert.equal(await page.eval<string>(turning), "none", "and stays still when the system asks for less motion");
    assert.equal(await page.eval<string>("getComputedStyle(document.querySelector('.legend .st-working'), '::before').animationName"), "none", "the legend's never turns");
    await page.press("Escape");
  });

  it("lays a session's agents on one time axis, with the progress their activity states and none it does not", async () => {
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    store.upsertSession({ id: "timeline", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "agents on a timeline", state: "working" });
    const agents = [
      ["audit", "Running axe on 14 pages (9/14)", 30],
      ["tests", "npm test -- invoices 212/340", 50],
      ["pages", "Checked 9 of 14 pages", 10],
      ["edit", "Editing src/checkout/OrderSummary.tsx", 40],
      ["deps", "Upgrading the API to v2/3 and the 2026/11/10 release", 20],
    ] as const;
    for (const [name, activity, min] of agents) store.upsertAgent("timeline", name, { goal: `Goal ${name}`, activity, startedAt: ago(min) });
    const page = await open();
    await page.click(".scard", "agents on a timeline");
    await page.click("#session .pchips button.chip", "agents");
    await page.waitFor("document.querySelectorAll('#session .atimeline .abar').length === 5");
    const progress = await page.eval<Record<string, string | null>>(
      "Object.fromEntries([...document.querySelectorAll('#session .atimeline .atrack[data-key]')].map((t) => [t.dataset.key, t.querySelector('.aprog')?.textContent ?? null]))",
    );
    assert.deepEqual(progress, { "bar-tests": "212/340", "bar-edit": null, "bar-audit": "9/14", "bar-deps": null, "bar-pages": "9/14" });
    // Every bar on the same axis: tracks one width and place, an open bar ending at now, the earliest starting first.
    const tracks = await page.eval<{ key: string; left: number; width: number; start: number; end: number }[]>(`[...document.querySelectorAll('#session .atimeline .atrack')].map((t) => {
      const r = t.getBoundingClientRect(); const b = t.querySelector('.abar')?.getBoundingClientRect();
      return { key: t.dataset.key ?? 'axis', left: Math.round(r.left), width: Math.round(r.width), start: b ? Math.round(b.left) : 0, end: b ? Math.round(b.right) : 0 };
    })`);
    assert.equal(new Set(tracks.map((t) => `${t.left} ${t.width}`)).size, 1, "the axis and every bar share one track");
    const bars = tracks.filter((t) => t.key !== "axis");
    const right = (tracks[0]?.left ?? 0) + (tracks[0]?.width ?? 0);
    assert.ok(bars.every((t) => Math.abs(t.end - right) <= 1), "an agent at work runs to now, the axis' end");
    assert.equal(bars.toSorted((a, b) => a.start - b.start)[0]?.key, "bar-tests", "the agent started first starts furthest left");
    // A live update keeps the bar's element and changes only what changed.
    await page.eval("window.keptBar = document.querySelector('#session .atrack[data-key=\"bar-audit\"] .abar')");
    store.upsertAgent("timeline", "audit", { activity: "Running axe on 14 pages (10/14)" });
    await page.waitFor("document.querySelector('#session .atrack[data-key=\"bar-audit\"] .aprog')?.textContent === '10/14'");
    assert.equal(await page.eval<boolean>("window.keptBar === document.querySelector('#session .atrack[data-key=\"bar-audit\"] .abar')"), true, "the same bar, updated in place");
    await page.press("Escape");
  });

  it("on a phone, keeps a session's agents and their bars inside the screen", async () => {
    const page = await open(390, 844);
    await page.click(".tabbar button", "Sessions");
    await page.click(".scard", "checkout redesign");
    await page.click("#session .pchips button.chip", "agents");
    await page.waitFor("document.querySelectorAll('#session .atimeline .abar').length");
    const [scroll, client, widest, bars] = await page.eval<[number, number, number, number]>(`(() => {
      const body = document.querySelector('#session .session-body');
      const edge = body.getBoundingClientRect().right;
      const rows = [...document.querySelectorAll('#session .atimeline > .arow')];
      return [body.scrollWidth, body.clientWidth, Math.max(...rows.map((r) => r.getBoundingClientRect().right - edge)), document.querySelectorAll('#session .atimeline .abar').length];
    })()`);
    assert.equal(scroll, client, "nothing scrolls sideways");
    assert.ok(widest <= 0, `every row ends inside the panel: ${widest}`);
    assert.equal(bars, 5);
    const { track, gap } = await page.eval<{ track: number; gap: number }>(`(() => {
      const row = [...document.querySelectorAll('#session .atimeline > .arow[data-key^="agent-"]')][0];
      const t = row.querySelector('.atrack').getBoundingClientRect();
      return { track: Math.round(t.width), gap: Math.round(t.top - row.querySelector('.awhat').getBoundingClientRect().bottom) };
    })()`);
    assert.ok(track >= 200, `a bar's track keeps room to read on a phone: ${track}px`);
    assert.ok(gap >= 0, "the bar sits under its agent's goal, not beside it");
    await page.press("Escape");
  });

  it("shows where the session's branches stand under its agents, with how old the reading is", async () => {
    const page = await open();
    await page.click(".scard", "checkout redesign");
    await page.click("#session .pchips button.chip", "agents");
    await page.waitFor("document.querySelectorAll('#session .branches-sec .brow').length === 4");
    const rows = await page.eval<string[]>("[...document.querySelectorAll('#session .branches-sec .brow')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())");
    assert.match(rows[0] ?? "", /^main clean vite main checkout · this session · «Merge the cart redesign» · 1 h 3\d min ago$/);
    assert.match(rows[2] ?? "", /^agent\/summary 3 changed files vitest Order summary beside the cart · «Order summary beside the cart on desktop» · \d+ min ago \+4 −0$/);
    assert.match(rows[3] ?? "", /^agent\/cart-rebase branch not found Rebase the cart on the new summary/);
    assert.match(await page.eval<string>("document.querySelector('#session .branches-sec .bage').textContent"), /^read from git [23] min ago$/);
    assert.equal(await page.eval<string>("document.querySelector('#session .bhidden').textContent"), "1 more checkout merged, clean and idle");
    // An old reading says so: rows that may no longer hold are never shown as current.
    const scan = store.listProjectScans().find((p) => p.name === "web-shop");
    assert.ok(scan);
    try {
      store.putProjectScan({ ...scan, measuredAt: new Date(Date.now() - 40 * 60_000).toISOString() });
      await fetchNow(page);
      await page.waitFor("document.querySelector('#session .branches-sec .bage.stale')?.textContent === 'read from git 40 min ago · may have changed since'");
    } finally {
      store.putProjectScan(scan);
    }
    await page.press("Escape");
  });

  it("counts finished agents whose branch is gone in one quiet line, and says branch not found only of an agent still open", async () => {
    store.upsertSession({ id: "integrated", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "integrated work", state: "waiting" });
    for (const [name, state] of [["merged-one", "done"], ["merged-two", "done"], ["dropped", "failed"], ["stuck", "blocked"]] as const) store.upsertAgent("integrated", name, { goal: `Goal ${name}`, branch: `agent/${name}`, state });
    const scan = store.listProjectScans().find((p) => p.name === "web-shop");
    assert.ok(scan);
    store.putProjectScan({ ...scan, measuredAt: new Date(Date.now() + 1000).toISOString() });
    try {
      const page = await open();
      await page.click(".scard", "integrated work");
      await page.click("#session .pchips button.chip", "agents");
      await page.waitFor("document.querySelector('#session .branches-sec .bgone')");
      assert.equal(await page.eval<string>("document.querySelector('#session .bgone').textContent"), "3 finished agents: branch already gone, integrated or deleted");
      const missing = await page.eval<string[]>("[...document.querySelectorAll('#session .brow')].filter((r) => r.textContent.includes('branch not found')).map((r) => r.querySelector('.bname').textContent)");
      assert.deepEqual(missing, ["agent/stuck"]);
      await page.press("Escape");
    } finally {
      store.putProjectScan(scan);
      store.updateSession("integrated", (x) => ({ ...x, state: "ended" }));
      store.forgetSession("integrated");
    }
  });

  it("says which branches landed by cherry-pick and what is not pushed, and copies commands that remove only what landed", async () => {
    const { root, main, wt } = landedRepo();
    const detached = path.join(root, "shop-detached");
    gitIn(main, "worktree", "add", "-q", "--detach", detached, "agent/merged");
    // A folder whose name holds what dash's echo reads as an escape (\c ends its output).
    const escaped = path.join(root, "shop-\\c-escaped");
    gitIn(main, "worktree", "add", "-q", "--detach", escaped, "agent/merged");
    // Merged and left alone since the scan: removed, the branch with branch -d. And one on a branch
    // that stays put while its checkout leaves it for commits of its own.
    const quiet = path.join(root, "shop-quiet");
    const still = path.join(root, "shop-still");
    const switched = path.join(root, "shop-switched");
    gitIn(main, "worktree", "add", "-q", "-b", "agent/quiet", quiet, "agent/merged");
    gitIn(main, "worktree", "add", "-q", "--detach", still, "agent/merged");
    gitIn(main, "worktree", "add", "-q", "-b", "agent/switched", switched, "agent/merged");
    const scan = await scanProject(main, undefined, new Date(), { sizes: false });
    const demo = store.listProjectScans().find((p) => p.name === "web-shop");
    assert.ok(demo);
    store.putProjectScan({ ...scan, id: demo.id });
    store.upsertSession({ id: "landed", provider: "Test", project: { name: "shop", dir: main }, title: "landed work", state: "waiting" });
    store.upsertAgent("landed", "picker", { goal: "Pick me", worktree: wt.picked, state: "done" });
    // Checkouts move after the scan: the copied commands must remove nothing they did not check.
    for (const moved of [wt.moved, wt.merged, detached, escaped]) gitIn(moved, "commit", "-q", "--allow-empty", "-m", "after the scan");
    gitIn(switched, "switch", "-q", "--detach");
    gitIn(switched, "commit", "-q", "--allow-empty", "-m", "after the scan, on no branch");
    try {
      await browser.send("Browser.grantPermissions", { origin: base, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
      const page = await open();
      await page.click(".scard", "landed work");
      await page.click("#session .pchips button.chip", "1 agent");
      const tags = (branch: string) => `[...document.querySelectorAll('#session .brow')].find((r) => r.querySelector('.bname').textContent === ${JSON.stringify(branch)})?.querySelectorAll('.btag')`;
      await page.waitFor(`${tags("agent/picked")}?.length`);
      assert.deepEqual(await page.eval<string[]>(`[...${tags("agent/picked")}].map((t) => t.textContent)`), ["clean", "landed by cherry-pick"]);
      assert.deepEqual(await page.eval<string[]>(`[...${tags("main")}].map((t) => t.textContent)`), ["clean", "no upstream"]);
      store.putProjectScan({ ...scan, id: demo.id, worktrees: scan.worktrees.map(({ noUpstream: _n, ...w }) => (w.main ? { ...w, upstream: "origin/main", unpushed: 3 } : w)) });
      await fetchNow(page);
      await page.waitFor(`[...${tags("main")}].some((t) => t.textContent === '↑3 not pushed' && t.title === '3 commits not pushed to origin/main')`);
      store.putProjectScan({ ...scan, id: demo.id });
      await fetchNow(page);

      await page.click("#session .pchips .chip", "More");
      await page.click("#session .linkish", "already merged");
      await page.waitFor("document.querySelector('#session .wt-actions button')");
      assert.match(await page.eval<string>("[...document.querySelectorAll('#session .wt-list .arow')].find((r) => r.textContent.startsWith('agent/picked')).textContent"), /picked · landed by cherry-pick/);
      await page.click("#session .wt-actions button");
      const commands = (await page.eval<string>("navigator.clipboard.readText()")).split("\n");
      assert.equal(commands.length, 9, "merged, picked, dirty, moved, detached, escaped, quiet, still and switched; not the one partly picked");
      const kept: string[] = [];
      for (const c of commands) {
        try {
          execFileSync("sh", ["-c", c], { stdio: "pipe" });
        } catch (error) {
          // Expected for the dirty checkout and the five that moved: each line fails, saying which it kept.
          kept.push(String((error as { stderr?: Buffer }).stderr));
        }
      }
      assert.equal(kept.length, 6, kept.join("\n"));
      for (const moved of [wt.moved, wt.merged, detached, escaped, switched]) assert.ok(kept.some((e) => e.includes(`kept ${moved}: its HEAD or branch is no longer at`)), `${moved} said kept, its path whole`);
      assert.ok(kept.some((e) => e.includes(wt.dirty) && /modified or untracked/.test(e)), "git says why the dirty one stays");
      assert.deepEqual(gitIn(main, "branch", "--format=%(refname:short)").trim().split("\n").sort(), ["agent/dirty", "agent/merged", "agent/moved", "agent/partly", "agent/switched", "main"]);
      assert.deepEqual(
        gitIn(main, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)).sort(),
        [main, wt.dirty, wt.partly, wt.moved, wt.merged, detached, escaped, switched].sort(),
        "the picked, quiet and still checkouts go: the dirty one is kept, and so are those that moved since the scan, with their branches",
      );
      await page.press("Escape");
    } finally {
      store.putProjectScan(demo);
      store.updateSession("landed", (x) => ({ ...x, state: "ended" }));
      store.forgetSession("landed");
    }
  });

  it("shows a question's past decisions quietly, and answers with one, verbatim, only when it is clicked", async () => {
    store.upsertSession({ id: "deciding", provider: "Test", project: { name: "billing", dir: "/home/demo/Projects/billing" }, title: "past decisions", state: "waiting" });
    store.ask({ sessionId: "deciding", kind: "question", text: "Bill new customers monthly or yearly by default?" });
    store.closeOpen("deciding", { answer: "Monthly, with a yearly plan two months cheaper" });
    const q = store.ask({ sessionId: "deciding", kind: "question", text: "Default billing period for new customers: monthly or yearly?", options: ["Monthly", "Yearly"] });
    assert.equal(q.past?.length, 1);
    const stop = store.listen("deciding");
    try {
      const page = await open();
      await page.click(".scard", "past decisions");
      await page.waitFor("document.querySelector('#session .panel-question .past-row')");
      assert.equal(await page.eval<string>("document.querySelector('#session .past-head').textContent"), "Decided before");
      assert.match(await page.eval<string>("document.querySelector('#session .past-row').innerText.replace(/\\s+/g, ' ')"), /^Monthly, with a yearly plan two months cheaper \d+ \w+ · Bill new customers monthly or yearly by default\?/);
      assert.equal(store.getQuestion(q.id)?.status, "open", "nothing is answered by itself");
      await page.click("#session .past-row");
      for (let i = 0; i < 100 && store.getQuestion(q.id)?.status === "open"; i++) await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(store.takeInbox("deciding").map((e) => e.answer), ["Monthly, with a yearly plan two months cheaper"], "sent as it was answered then");
      await page.press("Escape");
    } finally {
      stop();
      store.updateSession("deciding", (x) => ({ ...x, state: "ended" }));
      store.forgetSession("deciding");
    }
  });

  it("brings an unanswered question up once more after 15 minutes", async () => {
    const page = await browser.newPage(1400, 900);
    pages.push(page);
    // The page's 30 s tick runs every 200 ms here.
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "const tick = window.setInterval; window.setInterval = (f, ms, ...a) => tick(f, ms === 30000 ? 200 : ms, ...a);" });
    await page.goto(base + "/");
    await page.waitFor("document.querySelector('.next')");
    const earlier = new Store(store.paths.home, () => new Date(Date.now() - 20 * 60_000));
    earlier.ask({ sessionId: "demo-pagos", kind: "question", text: "Still there?" });
    await page.waitFor("[...document.querySelectorAll('.toast')].some((t) => t.textContent.startsWith('Still waiting for you'))");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await page.eval<number>("[...document.querySelectorAll('.toast')].filter((t) => t.textContent.startsWith('Still waiting for you')).length"), 1, "once, not at every tick");
  });

  it("tells of a new failure only when failures are switched on", async () => {
    const page = await open();
    const failedToast = "[...document.querySelectorAll('.toast')].some((t) => t.textContent.startsWith('Failed in'))";
    store.upsertAgent("demo-pagos", "quiet-failure", { goal: "First failure", state: "failed" });
    await page.waitFor("[...document.querySelectorAll('.scard')].some((c) => c.textContent.includes('failed'))");
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(await page.eval<boolean>(failedToast), false, "off by default");
    await page.eval("localStorage.setItem('agent-desk:failures', 'on')");
    store.upsertAgent("demo-pagos", "loud-failure", { goal: "Second failure", state: "failed" });
    await page.waitFor("[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Second failure'))");
    await page.eval("localStorage.removeItem('agent-desk:failures')");
  });

  it("plays a new question's entrance once, not at every redraw", async () => {
    const page = await open();
    // An entrance is an animation that starts the row from transparent.
    await page.eval(`(() => {
      window.entrances = 0;
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (frames, options) {
        if (Array.isArray(frames) && frames[0]?.opacity === 0 && this.textContent.includes('Which rounding mode?')) entrances++;
        return animate.call(this, frames, options);
      };
    })()`);
    const q = store.ask({ sessionId: "demo-iva", kind: "question", text: "Which rounding mode?" });
    await page.waitFor("[...document.querySelectorAll('.qrow, .next')].some((e) => e.textContent.includes('Which rounding mode?'))");
    // Changes that make the page redraw while the arrival is still fresh.
    for (const title of ["VAT rounding a", "VAT rounding b", "VAT rounding c"]) {
      store.updateSession("demo-iva", (s) => ({ ...s, title }));
      await page.waitFor(`document.body.textContent.includes(${JSON.stringify(title)})`);
    }
    assert.equal(await page.eval<number>("entrances"), 1, "the entrance is drawn once");
    store.dismiss(q.id);
  });

  it("numbers a list shown from its third item from 3", async () => {
    store.ask({ sessionId: "demo-pagos", kind: "waiting", text: "3. Shall I rotate the token?\n4. Shall I remove line 119?" });
    const page = await open();
    await page.click(".qrow", "Shall I rotate the token?");
    await page.waitFor("document.querySelector('.next ol')");
    assert.equal(await page.eval<string>("document.querySelector('.next ol').getAttribute('start')"), "3");
  });

  it("copies a command of the session's text with a click", async () => {
    const asked = store.ask({ sessionId: "demo-pagos", kind: "waiting", text: "Shall I free the disk?" });
    store.addContext(asked.id, "Run this, then `git worktree prune`:\n\n```\n! rm -rf build\n```");
    await browser.send("Browser.grantPermissions", { origin: base, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
    const page = await open();
    await page.click(".qrow", "Shall I free the disk?");
    await page.waitFor(STILL); // the card grows out of its row: its code is clicked once in view
    await page.click(".next pre[data-copy]");
    await page.waitFor("document.querySelector('.toast')?.textContent.startsWith('Copied: ! rm -rf build')");
    assert.equal(await page.eval<string>("navigator.clipboard.readText()"), "! rm -rf build");
    await page.click(".next code[data-copy]", "git worktree prune");
    await page.waitFor("[...document.querySelectorAll('.toast')].some((t) => t.textContent === 'Copied: git worktree prune')");
    assert.equal(await page.eval<string>("navigator.clipboard.readText()"), "git worktree prune");
  });

  it("offers a project's pending handoffs from the strip, each with its age and its command copied with a click, and hides one past its end", async () => {
    const hour = 3600_000;
    const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
    const resumes = { id: "web-shop-0badc0de", name: "web-shop", dir: "/home/demo/Projects/web-shop", source: "test-notes", at: iso(0), notes: [
      { title: "Finish the pay page <b>now</b>", writtenAt: iso(-3 * hour), expiresAt: iso(45 * hour), command: "/load 1" },
      { writtenAt: iso(-5 * hour), expiresAt: iso(43 * hour), command: "/load 2" },
      { title: "Expired since", writtenAt: iso(-49 * hour), expiresAt: iso(-hour), command: "/load 3" },
    ] };
    store.putResumes(resumes);
    try {
      await browser.send("Browser.grantPermissions", { origin: base, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
      const page = await open();
      await page.click("#strip .resume-chip", "web-shop: 2 handoffs to resume");
      await page.waitFor(arrived("session"));
      const rows = await page.eval<string[]>("[...document.querySelectorAll('#session .resume')].map((r) => r.textContent)");
      assert.equal(rows.length, 2, "the expired one is not offered");
      assert.match(rows[0] ?? "", /^Finish the pay page <b>now<\/b>written 3 h ago · offered until \w{3} \d\d:\d\d\/load 1$/, "its objective as plain text, and until when its note says it is offered");
      assert.equal(await page.eval<string>("document.querySelector('#session .status').textContent"), "Paste the command in a new conversation of web-shop: it loads that handoff.", "no adapter's own policy in the page's words");
      assert.match(rows[1] ?? "", /^A handoff with no objective/);
      assert.equal(await page.eval<number>("document.querySelectorAll('#session .resume b').length"), 0);
      await page.click("#session .resume button", "/load 1");
      await page.waitFor("[...document.querySelectorAll('.toast')].some((t) => t.textContent === 'Copied: /load 1')");
      assert.equal(await page.eval<string>("navigator.clipboard.readText()"), "/load 1");
    } finally {
      store.putResumes({ ...resumes, notes: [] });
    }
  });

  it("shows under a project's filter the handoffs its sessions file under, named after another folder", async () => {
    const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
    // A session in the repository's subfolder: its filter says "shop-ui", its handoffs are the repository's.
    const resumes = { id: "shop-0badc0de", name: "shop", dir: "/home/demo/Projects/shop", source: "test-notes", at: iso(0), notes: [{ title: "Wire the cart", writtenAt: iso(-3600_000), expiresAt: iso(40 * 3600_000), command: "/load" }] };
    store.putResumes(resumes);
    store.upsertSession({ id: "in-subfolder", provider: "Test", project: { name: "shop-ui", dir: "/home/demo/Projects/shop/shop-ui" }, resumesId: resumes.id, title: "subfolder work", state: "waiting" });
    try {
      const page = await open();
      await page.click("#projects button", "shop-ui");
      await page.waitFor("[...document.querySelectorAll('#strip .resume-chip')].map((c) => c.textContent).join() === 'shop: 1 handoff to resume'");
      await page.click("#projects button", "invoices-api");
      await page.waitFor("document.querySelectorAll('#strip .resume-chip').length === 0");
      await page.click("#projects button", "All");
    } finally {
      store.putResumes({ ...resumes, notes: [] });
      store.updateSession("in-subfolder", (x) => ({ ...x, state: "ended" }));
      store.forgetSession("in-subfolder");
    }
  });

});
