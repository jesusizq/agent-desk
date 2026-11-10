// The page in a real headless Chrome, over the demo store: what it draws, its windows and its layout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { procInfo } from "../src/core/proc.ts";
import { Store } from "../src/store/store.ts";
import { Browser, findChrome, type Page } from "./browser.ts";
import { PNG, serve, tempHome } from "./helpers.ts";

const chrome = findChrome();
/** Nothing on the page moving any more, but for the marks of work in progress, which turn for as long as the work goes on. */
/** The session card whose text holds `text`, as an expression for page.eval. */
const cardOf = (text: string) => `[...document.querySelectorAll('.scard')].find((c) => c.textContent.includes(${JSON.stringify(text)}))`;
const STILL = "document.getAnimations().every((a) => a.effect?.getComputedTiming().iterations === Infinity)";
if (!chrome && process.env.CI) throw new Error("no Chrome found: install one or set AGENT_DESK_CHROME");

describe("page", { skip: chrome ? false : "no Chrome found (set AGENT_DESK_CHROME)" }, () => {
  let browser: Browser;
  let store: Store;
  let base: string;
  let close: () => Promise<void>;
  const pages: Page[] = [];

  before(async () => {
    const home = path.join(tempHome(), "store");
    execFileSync(process.execPath, [path.join(import.meta.dirname, "../scripts/demo.ts"), home]);
    store = new Store(home);
    ({ base, close } = await serve(store));
    browser = await Browser.launch(chrome ?? "");
  });
  // A test's pages close with it: left open, every one would chime at each new question, and past a
  // few dozen at once the browser has no audio stream left for them.
  afterEach(async () => {
    const done = pages.splice(0);
    await Promise.all(done.map((page) => page.close()));
    for (const page of done) assert.deepEqual(page.errors, [], "the page reports no errors");
  });
  after(async () => {
    try {
      await browser?.close();
    } finally {
      await close?.();
    }
  });

  /** The desk loaded at a window size, its data drawn. */
  async function open(width = 1400, height = 900): Promise<Page> {
    const page = await browser.newPage(width, height);
    pages.push(page);
    await page.goto(base + "/");
    await page.waitFor("document.querySelector('.next') && document.querySelectorAll('.scard').length");
    return page;
  }
  /**
   * As iOS: the layout keeps its height with the keyboard open, while the visual viewport and
   * innerHeight, which follows it there, shrink. The page gets `setKeyboard(px)`.
   */
  const coveringKeyboard = (height: number) => `(() => {
    const vv = new EventTarget();
    window.covered = 0;
    Object.defineProperties(vv, { height: { get: () => ${height} - covered }, width: { get: () => document.documentElement.clientWidth }, offsetTop: { value: 0 }, scale: { value: 1 } });
    Object.defineProperty(window, "visualViewport", { value: vv });
    Object.defineProperty(window, "innerHeight", { get: () => vv.height, configurable: true });
    window.setKeyboard = (px) => { covered = px; vv.dispatchEvent(new Event("resize")); };
  })()`;
  /** A dialog open and done moving in (on a phone it slides in from the side). */
  const arrived = (id: string) => `document.getElementById('${id}').open && !document.getElementById('${id}').getAnimations().length`;
  const openDialogs = (page: Page) => page.eval<string[]>("[...document.querySelectorAll('dialog[open]')].map((d) => d.id)");
  /** The state fetched now: as at the stream's next change or its slow poll, which a stubbed fetch would wait for. */
  const fetchNow = (page: Page) => page.eval("dispatchEvent(new Event('online'))");

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
    assert.equal(looping?.tip, "Last failed: Bash: npm test -- --grep checkout", "it waits in the tooltip");
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

  it("opens a session from its card, shows the turn at work, and closes with Escape", async () => {
    const page = await open();
    await page.click(".scard", "checkout redesign");
    await page.waitFor("document.getElementById('session').open");
    await page.waitFor("document.querySelector('#session .working-now')?.textContent.includes('Edit: src/checkout/OrderSummary.tsx')");
    assert.match(await page.eval<string>("document.querySelector('#session .working-now').textContent"), /^\s*Working/);
    const agents = await page.eval<string[]>("[...document.querySelectorAll('#session .working-now .agoal')].map((g) => g.textContent)");
    assert.ok(agents.includes("Order summary beside the cart"), "its agents at work are listed under it");
    assert.ok(!agents.includes("Three pay button variants"), "finished ones are not");
    // The conversation arrives after the panel opens and moves everything: a click before it lands elsewhere.
    await page.waitFor("document.querySelector('#session .session-body')?.dataset.fetched === 'yes'");
    const fold = "document.querySelector('#session .working-now .agents-fold')";
    assert.equal(await page.eval<boolean>(`${fold}.open`), false, "the agents are folded under one line");
    assert.match(await page.eval<string>(`${fold}.querySelector('summary').textContent`), /^\d+ still running( · \d+ failed)?$/);
    await page.click("#session .working-now .agents-fold > summary");
    await page.waitFor(`${fold}.open`);
    store.upsertAgent("demo-checkout", "summary", { activity: "Editing src/checkout/Totals.tsx" });
    await page.waitFor("document.querySelector('#session .working-now')?.textContent.includes('Totals.tsx')");
    assert.equal(await page.eval<boolean>(`${fold}.open`), true, "unfolded, they stay so across redraws");
    await page.press("Escape");
    await page.waitFor("!document.getElementById('session').open");
  });

  it("writes to a session while it works, when its adapter delivers mid-turn", async () => {
    store.upsertSession({ id: "mid-turn", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "release notes", takesMessagesWhileWorking: true });
    const page = await open();
    await page.click(".scard", "release notes");
    await page.click("#session .chat-footer textarea");
    assert.equal(await page.eval<string>("document.querySelector('#session .chat-footer textarea').placeholder"), "Write to it while it works…");
    await page.type("and push it when the tests pass");
    // A second click before the answer arrives (a slow phone network) sends nothing more.
    const button = "document.querySelector('#session .chat-footer .send')";
    const box = "document.querySelector('#session .chat-footer textarea')";
    const width = await page.eval<number>(`${box}.getBoundingClientRect().width`);
    const mine = "[...document.querySelectorAll('#session .msg.from-developer')].filter((m) => m.textContent.includes('and push it when the tests pass'))";
    assert.deepEqual(
      await page.eval(`(() => { const b = ${button}; b.click(); b.click(); return [b.getAttribute("aria-busy"), ${box}.readOnly, ${box}.getBoundingClientRect().width, ${box}.value, ${mine}.map((m) => m.querySelector('.msg-meta').textContent)]; })()`),
      ["true", true, width, "", ["You, from the desk · Sending…"]],
      "it says at once, in the conversation, that the message is on its way, without resizing the box",
    );
    await page.waitFor(`${mine}.length === 1 && ${mine}[0].querySelector('.msg-meta .delivered') && !${box}.readOnly && !${button}.hasAttribute("aria-busy")`);
    assert.equal(await page.eval<string>(`${mine}[0].querySelector('.delivered').getAttribute('aria-label')`), "Delivered", "its tick is read out");
    assert.deepEqual(store.takeInbox("mid-turn").map((e) => e.answer), ["and push it when the tests pass"], "sent once");
    await page.waitFor(`${mine}.length === 1 && !${mine}[0].classList.contains('out')`); // the conversation itself now holds it, once
    assert.equal(await page.eval<number>("document.querySelectorAll('.toast').length"), 0, "no toast says it was sent");
  });

  it("opens what came earlier in a session on the turn right before its question", async () => {
    store.upsertSession({ id: "earlier", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "earlier turns", state: "waiting" });
    for (let i = 1; i <= 8; i++) store.addMessage({ sessionId: "earlier", from: "session", text: `Turn ${i}: ${"what the session reported at length. ".repeat(6)}` });
    const asked = store.ask({ sessionId: "earlier", kind: "question", text: "Ship the earlier turns?" });
    try {
      const page = await open();
      await page.click(".qrow", "Ship the earlier turns?");
      await page.click(".next button", "Earlier in this session");
      const block = "document.querySelector('.next .conversation')";
      await page.waitFor(`${block} && ${STILL}`);
      const [top, height, shown] = await page.eval<[number, number, number]>(`[${block}.scrollTop, ${block}.scrollHeight, ${block}.clientHeight]`);
      assert.ok(height > shown, "longer than its box");
      assert.ok(Math.abs(top + shown - height) <= 1, `scrolled to its newest end: ${top} + ${shown} of ${height}`);
    } finally {
      store.dismiss(asked.id);
    }
  });

  it("titles a turn that ends asking with its question, what the paragraph says around it right under it, and leaves that turn out of the earlier ones", async () => {
    store.upsertSession({ id: "pin-copy", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "pin copy", state: "waiting" });
    store.addMessage({ sessionId: "pin-copy", from: "session", text: "Turn 1: the offline banner is in." });
    // As the Claude Code adapter records a turn that ends asking in plain text.
    store.addMessage({ sessionId: "pin-copy", from: "session", text: "Los tests pasan.\n\nSi el PIN caduca, la copia guardada sigue en el móvil. ¿Lo dejo así, o la borro? Yo recomiendo borrarla." });
    const asked = store.ask({ sessionId: "pin-copy", kind: "waiting", text: "¿Lo dejo así, o la borro?", context: "Si el PIN caduca, la copia guardada sigue en el móvil. Yo recomiendo borrarla.\n\nLos tests pasan." });
    try {
      const page = await open();
      await page.click(".qrow", "¿Lo dejo así, o la borro?");
      assert.equal(await page.eval<string>("document.querySelector('.next .qtext').textContent"), "¿Lo dejo así, o la borro?");
      assert.ok((await page.eval<string>("document.querySelector('.next .qctx').textContent")).startsWith("Si el PIN caduca"), "the rest of its paragraph comes first");
      await page.click(".next button", "Earlier in this session");
      await page.waitFor("document.querySelector('.next .conversation')");
      const earlier = await page.eval<string>("document.querySelector('.next .conversation').textContent");
      assert.ok(earlier.includes("Turn 1: the offline banner is in."));
      assert.ok(!earlier.includes("Yo recomiendo borrarla"), "the asking turn is on the card already");
    } finally {
      store.dismiss(asked.id);
    }
  });

  it("shows in an open session what it writes and what is typed to it while it works, without reopening", async () => {
    store.upsertSession({ id: "live-steps", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "live steps", state: "working" });
    store.addMessage({ sessionId: "live-steps", from: "developer", text: "migrate the schema", via: "terminal" });
    const page = await open();
    await page.click(".scard", "live steps");
    await page.waitFor("document.querySelector('#session .session-body')?.dataset.fetched === 'yes' && document.querySelector('#session').textContent.includes('migrate the schema')");
    // Mid-turn, neither its state nor its last message changes: only the conversation grows.
    store.addMessage({ sessionId: "live-steps", from: "session", text: "Generated the migration for the orders table.", step: true });
    await page.waitFor("document.querySelector('#session').textContent.includes('Generated the migration for the orders table.')");
    store.addMessage({ sessionId: "live-steps", from: "developer", text: "and keep the old column for a week", via: "terminal" });
    await page.waitFor("document.querySelector('#session').textContent.includes('and keep the old column for a week')");
    await page.press("Escape");
  });

  it("asks for the PIN again when the unlock ends, and drops what was being written", async () => {
    store.upsertSession({ id: "pin-ended", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "pin ended", takesMessagesWhileWorking: true });
    const page = await open();
    await page.click(".scard", "pin ended");
    await page.click("#session .chat-footer textarea");
    await page.type("half a thought");
    await page.waitFor("(localStorage.getItem('agent-desk:drafts') ?? '').includes('half a thought')");
    // What the server answers a device whose 24 hours ended; a reload loads the page's real fetch again.
    await page.eval(`(() => {
      window.beforeReload = true;
      const real = window.fetch;
      window.fetch = (url, init) => String(url) === "/api/state" ? Promise.resolve(new Response("{}", { status: 401, headers: { "X-Agent-Desk-Locked": "1" } })) : real(url, init);
    })()`);
    await fetchNow(page);
    await page.waitFor("window.beforeReload === undefined && document.querySelector('.scard')");
    assert.equal(await page.eval<string | null>("localStorage.getItem('agent-desk:drafts')"), null, "nothing written outlives the unlock");
    await page.click(".scard", "pin ended");
    await page.waitFor("document.querySelector('#session .chat-footer textarea')");
    assert.equal(await page.eval<string>("document.querySelector('#session .chat-footer textarea').value"), "");
  });

  it("keeps what was being written when the app closes while the desk is unlocked", async () => {
    store.upsertSession({ id: "app-closed", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "app closed", takesMessagesWhileWorking: true });
    const page = await open();
    await page.click(".scard", "app closed");
    await page.click("#session .chat-footer textarea");
    await page.type("half a thought");
    // As iOS closing the app: nothing warned the page, the draft is already on the device.
    await page.goto(base + "/");
    await page.waitFor("document.querySelector('.scard')");
    await page.click(".scard", "app closed");
    await page.waitFor("document.querySelector('#session .chat-footer textarea')?.value === 'half a thought'");
    await page.click("#session .chat-footer .primary");
    await page.waitFor("localStorage.getItem('agent-desk:drafts') === null");
    assert.deepEqual(store.takeInbox("app-closed").map((e) => e.answer), ["half a thought"], "sent, and no longer kept");
  });

  it("reloads when the unlock the desk named ends, so a device offline then shows nothing it saved", async () => {
    const page = await open();
    // What the server tells a device that entered the PIN: when its unlock ends, here in a moment.
    await page.eval(`(() => {
      window.beforeReload = true;
      const real = window.fetch;
      const ends = String(Date.now() + 800);
      window.fetch = (url, init) => String(url) === "/api/state" ? real(url).then(async (r) => new Response(await r.text(), { headers: { "Content-Type": "application/json", "X-Agent-Desk-Unlock-Ends": ends } })) : real(url, init);
    })()`);
    await page.eval(`localStorage.setItem("agent-desk:drafts", JSON.stringify({ drafts: [["message-demo-pagos", "unsent idea"]], images: [] }))`);
    await fetchNow(page);
    assert.equal(await page.eval<boolean>("window.beforeReload"), true, "not before the end");
    await page.waitFor("window.beforeReload === undefined && document.querySelector('.scard')", 5000);
    assert.equal(await page.eval<string | null>("localStorage.getItem('agent-desk:drafts')"), null, "its drafts went with the unlock");
  });

  it("drops a saved draft whose question closed or whose session is gone", async () => {
    const page = await open();
    await page.eval(`localStorage.setItem("agent-desk:drafts", JSON.stringify({ drafts: [["answer-closed", "too late"], ["message-gone", "nobody"]], images: [] }))`);
    await page.goto(base + "/");
    await page.waitFor("document.querySelector('.scard') && localStorage.getItem('agent-desk:drafts') === null");
  });

  it("says when the device is not allowed, and how old the saved desk is", async () => {
    const page = await open();
    await page.eval(`(() => {
      window.realFetch = window.fetch;
      window.fetch = (url, init) => String(url) === "/api/state" ? Promise.resolve(new Response("{}", { status: 421 })) : window.realFetch(url, init);
    })()`);
    await fetchNow(page);
    await page.waitFor("document.querySelector('#strip .offline')?.textContent.includes('not allowed')");
    const yesterday = new Date(Date.now() - 864e5).toISOString();
    await page.eval(`(() => {
      window.fetch = async (url, init) => {
        if (String(url) !== "/api/state") return window.realFetch(url, init);
        const headers = new Headers({ "X-Agent-Desk-Saved-At": ${JSON.stringify(yesterday)} });
        return new Response(await (await window.realFetch(url)).blob(), { headers });
      };
    })()`);
    await page.waitFor("document.querySelector('#strip .offline')?.textContent.includes('Offline · last update Yesterday')");
    await page.eval("window.fetch = window.realFetch");
    await page.waitFor("!document.querySelector('#strip .offline')");
  });

  it("a hidden page notifies on the computer, and on a phone leaves it to the push, which carries no text", async () => {
    // Forwards to the desk under the Host it accepts, so the page runs at an address that is not this machine's.
    const target = new URL(base);
    const proxy = http.createServer((req, res) => {
      const out = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      out.on("error", (error) => res.writeHead(502).end(error.message));
      req.pipe(out);
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const remote = `http://desk.localhost:${(proxy.address() as AddressInfo).port}/`;
    /** The titles of the page's own notifications when a question opens while it is hidden. @param url where the page runs */
    const notified = async (url: string, text: string) => {
      const page = await browser.newPage(390, 800);
      pages.push(page);
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `Object.defineProperty(document, "hidden", { get: () => true });
          window.raised = [];
          window.Notification = class { static permission = "granted"; constructor(title) { raised.push(title); } };`,
      });
      await page.goto(url);
      await page.waitFor("document.title.endsWith('Agent Desk') && document.querySelector('.next')");
      const q = store.ask({ sessionId: "demo-iva", kind: "question", text });
      await page.waitFor(`document.body.textContent.includes(${JSON.stringify(text)})`);
      store.dismiss(q.id);
      return page.eval<string[]>("raised");
    };
    try {
      assert.match((await notified(base + "/", "Asked on the computer?")).join(), /New question/);
      assert.deepEqual(await notified(remote, "Asked on the phone?"), []);
    } finally {
      // Its pages close before the proxy: cut under an open page, the event stream reads as a load error.
      const opened = pages.splice(0);
      await Promise.all(opened.map((page) => page.close()));
      proxy.closeAllConnections();
      await new Promise((r) => proxy.close(r));
      for (const page of opened) assert.deepEqual(page.errors, [], "the page reports no errors");
    }
  });

  it("a tapped notification shows what needs the developer, whatever was open", async () => {
    const page = await open(390, 800);
    const on = (tab: string) => `document.querySelector('.tabbar button[aria-pressed="true"]')?.textContent.includes(${JSON.stringify(tab)})`;
    await page.click(".tabbar button", "History");
    await page.waitFor(on("History"));
    await page.eval(`navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { show: "needs" } }))`);
    await page.waitFor(on("Needs you"));
    await page.click(".tabbar button", "History");
    await page.waitFor(on("History"));
    await page.eval(`location.hash = "#needs"`);
    await page.waitFor(on("Needs you"));
    await page.eval(`location.hash = ""`);
  });

  it("says the connection is lost when requests hang, also inside a session, and recovers", async () => {
    store.upsertSession({ id: "hung", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "hung line", takesMessagesWhileWorking: true });
    const page = await open();
    await page.click(".scard", "hung line");
    await page.waitFor("document.querySelector('#session .chat-footer textarea')");
    // A computer asleep: no answer and no failure, only the page's own limit ends the wait (shortened here).
    await page.eval(`(() => {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = () => timeout(300);
      window.realFetch = window.fetch;
      window.fetch = (url, init) => String(url) === "/api/state" ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))) : window.realFetch(url, init);
    })()`);
    await fetchNow(page);
    await page.waitFor("document.querySelector('#strip .offline')?.textContent.includes('agent-desk serve')");
    await page.waitFor("document.querySelector('#session .offline-line')?.textContent.includes('agent-desk serve')");
    await page.eval("window.fetch = window.realFetch");
    await page.waitFor("!document.querySelector('#strip .offline') && !document.querySelector('#session .offline-line')");
  });

  it("shows a question as soon as it is asked, told by the desk's event stream, with no poll at all", async () => {
    const page = await browser.newPage(1400, 900);
    pages.push(page);
    // The poll's tick (live.js) taken away: only the event stream can bring the question.
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "const every = window.setInterval; window.setInterval = (fn, ms, ...rest) => (ms === 1500 ? 0 : every(fn, ms, ...rest));" });
    await page.goto(base + "/");
    await page.waitFor("document.querySelector('.next') && document.documentElement.dataset.live === 'stream'");
    const q = store.ask({ sessionId: "demo-iva", kind: "question", text: "Told by the stream?" });
    try {
      await page.waitFor("document.querySelector('.col-needs')?.textContent.includes('Told by the stream?')");
    } finally {
      store.dismiss(q.id);
    }
    await page.waitFor("!document.querySelector('.col-needs')?.textContent.includes('Told by the stream?')");
  });

  it("shares one event stream among the tabs of a browser, handed to another tab when its tab closes", async () => {
    const noPoll = "const every = window.setInterval; window.setInterval = (fn, ms, ...rest) => (ms === 1500 ? 0 : every(fn, ms, ...rest));";
    const tab = async () => {
      const page = await browser.newPage(1400, 900);
      pages.push(page);
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: noPoll });
      await page.goto(base + "/");
      await page.waitFor("document.querySelector('.next') && document.documentElement.dataset.live === 'stream'");
      return page;
    };
    const first = await tab();
    const second = await tab();
    const streams = (page: Page) => page.eval<number[]>("navigator.locks.query().then((s) => [s.held.length, s.pending.length])");
    assert.deepEqual(await streams(second), [1, 1], "one tab holds the stream, the other waits to take it over");
    const shows =(text: string) => `document.querySelector('.col-needs')?.textContent.includes(${JSON.stringify(text)})`;
    const q1 = store.ask({ sessionId: "demo-iva", kind: "question", text: "Heard in both tabs?" });
    try {
      await first.waitFor(shows("Heard in both tabs?"));
      await second.waitFor(shows("Heard in both tabs?"));
    } finally {
      store.dismiss(q1.id);
    }
    await first.close();
    pages.splice(pages.indexOf(first), 1);
    const q2 = store.ask({ sessionId: "demo-iva", kind: "question", text: "Heard once the first tab closed?" });
    try {
      await second.waitFor(shows("Heard once the first tab closed?"));
    } finally {
      store.dismiss(q2.id);
    }
    assert.deepEqual(first.errors, [], "the closed tab reported no errors");
  });

  it("when the desk stops, keeps its last state marked offline, with answering off and the draft kept, and comes back by itself", async () => {
    store.upsertSession({ id: "stopping", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "desk stopping", takesMessagesWhileWorking: true });
    // A desk of its own, to stop and start again on the same port.
    const own = await serve(store);
    const { createDeskServer } = await import("../src/server/server.ts");
    let back: http.Server | undefined;
    try {
      const page = await browser.newPage(1400, 900);
      pages.push(page);
      await page.goto(own.base + "/");
      await page.waitFor("document.querySelector('.scard') && document.documentElement.dataset.live === 'stream'");
      await page.click(".scard", "desk stopping");
      await page.click("#session .chat-footer textarea");
      await page.type("half a thought");
      const box = "document.querySelector('#session .chat-footer textarea')";

      await own.close();
      await page.waitFor("document.querySelector('#strip .offline')?.textContent.includes('Offline · last update')");
      assert.match(await page.eval<string>("document.querySelector('#strip .offline').textContent"), /agent-desk serve/, "and why");
      assert.equal(await page.eval<string>("document.documentElement.dataset.live"), "poll", "polled while the stream is away");
      await page.waitFor(`${box}?.readOnly`);
      assert.deepEqual(
        await page.eval(`[${box}.value, ${box}.placeholder, ${box}.getAttribute("aria-disabled"), document.querySelector('#session .chat-footer .send').disabled, document.querySelector('#session .send-hint').textContent]`),
        ["half a thought", "Offline", "true", true, "Offline: it can be sent once the desk answers again."],
        "the draft stays, nothing can be sent, and the box says why",
      );
      assert.ok(await page.eval<boolean>("document.querySelector('#session').textContent.includes('desk stopping') && !!document.querySelector('#session .offline-line')"), "the last state stays in view, marked");

      back = createDeskServer(store, own.port);
      await new Promise<void>((r) => back?.listen(own.port, "127.0.0.1", r));
      await page.waitFor(`!document.querySelector('#strip .offline') && !${box}.readOnly && document.documentElement.dataset.live === 'stream'`, 10_000);
      assert.equal(await page.eval<string>(`${box}.value`), "half a thought");
      await page.press("Escape");
      // The browser logs each request the stopped desk could not answer; nothing else may have gone wrong.
      const unanswered = (e: string) => /^Failed to load resource: net::ERR_\w+ /.test(e) && e.includes(`${own.base}/api/`);
      page.errors.splice(0, page.errors.length, ...page.errors.filter((e) => !unanswered(e)));
    } finally {
      back?.closeAllConnections();
      await new Promise((r) => (back ? back.close(r) : r(undefined)));
    }
  });

  it("shows a question asked during a turn only when the turn has finished writing it", async () => {
    store.upsertSession({ id: "still-writing", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "still writing" });
    store.updateSession("still-writing", (s) => ({ ...s, state: "working" }));
    const q = store.ask({ sessionId: "still-writing", kind: "question", text: "Half-written question?", writing: true });
    const page = await open();
    const seen = "document.body.textContent.includes('Half-written question?')";
    await page.waitFor("document.querySelector('.scard')");
    await new Promise((r) => setTimeout(r, 1800)); // more than a poll
    assert.equal(await page.eval<boolean>(seen), false, "held while its turn runs");
    store.addContext(q.id, "The whole explanation.");
    store.releaseQuestions("still-writing");
    await page.waitFor(seen);
    store.dismiss(q.id);
  });

  it("marks a session unread back to the list, and opening it reads it again", async () => {
    store.upsertSession({ id: "come-back", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "come back later" });
    store.updateSession("come-back", (s) => ({ ...s, state: "waiting", lastMessage: { text: "Here is the long report", at: new Date().toISOString() } }));
    const page = await open();
    const card = cardOf("come back later");
    await page.waitFor(`${card}?.textContent.includes('New message')`);
    await page.click(".scard", "come back later");
    await page.waitFor(`document.querySelector('#session .dhead')?.textContent.includes('Mark unread')`);
    await page.waitFor(`${card}?.textContent.includes('Seen')`);
    assert.ok(store.getSession("come-back")?.readAt, "opened: read");
    await page.click("#session .dhead button", "Mark unread");
    await page.waitFor(`!document.getElementById('session').open && ${card}?.textContent.includes('New message')`);
    assert.equal(store.getSession("come-back")?.readAt, undefined);
    await page.click(".scard", "come back later");
    await page.waitFor(`${card}?.textContent.includes('Seen')`);
    await page.press("Escape");
  });

  it("fits Mark unread in a session's header on a phone, as an icon large enough to tap", async () => {
    store.upsertSession({ id: "phone-head", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "a long session title that needs two lines on a phone" });
    store.updateSession("phone-head", (s) => ({ ...s, state: "waiting", lastMessage: { text: "Report", at: new Date().toISOString() } }));
    const page = await open(390, 800);
    await page.click(".tabbar button", "Sessions");
    await page.click(".scard", "a long session title");
    const button = "[...document.querySelectorAll('#session .dhead button')].find((b) => b.getAttribute('aria-label') === 'Mark unread')";
    await page.waitFor(`${button} && ${arrived("session")}`); // measured at rest: mid-slide its width is off by a float's error
    const size = await page.eval<{ w: number; h: number; inner: number; label: number }>(`(() => { const b = ${button}; const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, inner: b.scrollWidth, label: b.querySelector('.lbl').getClientRects().length }; })()`);
    assert.equal(size.label, 0, "only its icon: the words do not fit");
    assert.ok(size.w >= 44 && size.h >= 30 && size.inner <= size.w, JSON.stringify(size));
    await page.press("Escape");
  });

  it("keeps in view a session that ended asking, until it is opened", async () => {
    store.upsertSession({ id: "ended-asking", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "gone mid question" });
    store.updateSession("ended-asking", (s) => ({ ...s, state: "ended", endedAsking: true, lastMessage: { text: "Should I delete it?", at: new Date().toISOString() } }));
    const page = await open();
    const card = cardOf("gone mid question");
    await page.waitFor(`${card}?.textContent.includes('It ended while asking')`);
    await page.click(".scard", "gone mid question");
    await page.waitFor(`document.getElementById('session').open`);
    await page.waitFor(`document.querySelector('#session .dhead')?.textContent.includes('Mark unread')`);
    await page.press("Escape");
    await page.waitFor(`!${card}`);
    // Started again, it is an ordinary live session even if an old mark is left on it.
    store.updateSession("ended-asking", (s) => ({ ...s, state: "waiting", readAt: undefined as never, lastMessage: { text: "Should I delete it?", at: new Date().toISOString() } }));
    await page.waitFor(`${card}?.textContent.includes('New message')`);
    assert.ok(!(await page.eval<string>(`${card}.textContent`)).includes("It ended while asking"));
  });

  it("warns only when a plan window fills before it resets", async () => {
    const page = await open();
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const resetsAt = new Date(Date.now() + 3 * 3600_000).toISOString();
    store.recordPlan([{ label: "5 h", percent: 50, resetsAt }], at(40));
    store.recordPlan([{ label: "5 h", percent: 70, resetsAt }], at(1));
    await page.waitFor(`document.querySelector('#strip')?.textContent.includes('5 h limit: at this pace, out around')`);
    fs.rmSync(store.paths.plan);
    await page.waitFor(`!document.querySelector('#strip')?.textContent.includes('5 h limit')`);
  });

  it("sends an image pasted into the box with the message", async () => {
    store.upsertSession({ id: "with-image", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "hero picture", takesMessagesWhileWorking: true });
    const page = await open();
    await page.click(".scard", "hero picture");
    await page.click("#session .chat-footer textarea");
    await page.type("like this one");
    await page.eval(`(() => {
      const png = Uint8Array.from(atob(${JSON.stringify(PNG.toString("base64"))}), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([png], "shot.png", { type: "image/png" }));
      document.querySelector("#session .chat-footer textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    })()`);
    await page.waitFor("document.querySelector('#session .attached img')?.complete");
    assert.equal(await page.eval<string>("document.querySelector('#session .chat-footer textarea').value"), "like this one", "the text typed stays as it was");
    await page.click("#session .chat-footer .primary");
    await page.waitFor("[...document.querySelectorAll('#session .msg.from-developer')].some((m) => m.textContent.includes('like this one') && m.querySelector('.msg-imgs img') && m.querySelector('.delivered'))");
    const [entry] = store.takeInbox("with-image");
    assert.equal(entry?.answer, "like this one");
    assert.equal(entry?.images?.length, 1);
    assert.ok(store.imageFile(entry?.images?.[0] ?? ""), "the image is in the store");
  });

  it("on a phone, shows the project's name whole and keeps a long draft where it is written", async () => {
    store.upsertSession({ id: "long-draft", provider: "Test", project: { name: "invoices-api", dir: "/home/demo/Projects/invoices-api" }, title: "a session whose title is far too long for a phone", takesMessagesWhileWorking: true });
    const page = await open(390, 844);
    await page.click(".tabbar button", "Sessions");
    const proj = `${cardOf("far too long")}.querySelector('.sproj')`;
    await page.waitFor(proj);
    assert.equal(await page.eval<boolean>(`${proj}.scrollWidth <= ${proj}.clientWidth`), true, "the project's name is not cut");
    await page.click(".scard", "far too long");
    await page.click("#session .chat-footer textarea");
    const box = "document.querySelector('#session .chat-footer textarea')";
    const before = await page.eval<number>(`${box}.clientHeight`);
    await page.type(Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
    assert.ok((await page.eval<number>(`${box}.clientHeight`)) > before, "the box grows with the draft");
    const top = await page.eval<number>(`${box}.scrollTop`);
    assert.ok(top > 0, "a draft taller than the box is scrolled to where it is written");
    store.upsertAgent("long-draft", "helper", { goal: "Redraw the panel" });
    await page.waitFor(`document.querySelector('#session').textContent.includes('Redraw the panel')`);
    assert.equal(await page.eval<number>(`${box}.scrollTop`), top, "a redraw keeps the draft's scroll");
    assert.equal(await page.eval<boolean>(`document.activeElement === ${box}`), true);
  });

  describe("the box being typed in stays the same element while the desk changes around it", () => {
    /** Watches the box: iOS drops its autocorrect and its paste menu when the element leaves the page or the focus. */
    const watch = (page: Page, box: string) =>
      page.eval(`(() => {
        window.kept = ${box};
        window.blurs = 0;
        kept.addEventListener("blur", () => blurs++);
        window.drops = 0;
        new MutationObserver((changes) => {
          for (const c of changes) for (const n of c.removedNodes) if (n === kept || n.contains(kept)) drops++;
        }).observe(document, { childList: true, subtree: true });
      })()`);
    const untouched = async (page: Page, box: string) => {
      assert.deepEqual(
        await page.eval(`({ same: ${box} === kept, focused: document.activeElement === kept, blurs, drops })`),
        { same: true, focused: true, blurs: 0, drops: 0 },
      );
    };

    it("in a session's chat, and what is sent is what it holds", async () => {
      store.upsertSession({ id: "writing", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "writing on a phone", takesMessagesWhileWorking: true });
      const page = await open(390, 844);
      await page.click(".tabbar button", "Sessions");
      await page.click(".scard", "writing on a phone");
      await page.click("#session .chat-footer textarea");
      await page.type("half a thought");
      const box = "document.querySelector('#session .chat-footer textarea')";
      await watch(page, box);
      await page.eval("kept.setSelectionRange(4, 4)");

      store.upsertAgent("writing", "helper", { goal: "Redraw around the box" });
      await page.waitFor("document.querySelector('#session').textContent.includes('Redraw around the box')");
      await untouched(page, box);
      assert.deepEqual(await page.eval("[kept.value, kept.selectionStart, kept.selectionEnd]"), ["half a thought", 4, 4]);

      // The buttons drawn around it act on the box that stayed.
      await page.type(" more");
      await page.eval("document.querySelector('#session .chat-footer .primary').click()"); // a tap on iOS leaves the focus in the box
      await page.waitFor(`[...document.querySelectorAll('#session .msg.from-developer')].some((m) => m.textContent.includes('half more a thought') && m.querySelector('.delivered')) && ${box}?.value === ''`);
      assert.deepEqual(store.takeInbox("writing").map((e) => e.answer), ["half more a thought"]);
      assert.equal(await page.eval<boolean>(`${box} === kept`), true, "the box empties, it is not replaced");
    });

    it("on the inbox's large card, whose options answer at once", async () => {
      store.upsertSession({ id: "answering", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "answering a question", state: "waiting" });
      const stop = store.listen("answering");
      const asked = store.ask({ sessionId: "answering", kind: "question", text: "Which colour for the button?", options: ["Green", "Blue"] });
      try {
        const page = await open();
        await page.click(".qrow", "Which colour for the button?");
        await page.waitFor("document.querySelector('.next')?.textContent.includes('Which colour for the button?')");
        const box = "document.querySelector('.next textarea')";
        await page.waitFor(STILL); // a card still moving in takes the click elsewhere
        await page.click(".next textarea");
        await page.waitFor(`document.activeElement === ${box}`);
        await page.type("my own answer");
        await watch(page, box);

        const other = store.ask({ sessionId: "demo-pagos", kind: "question", text: "Asked while the other was being answered?" });
        await page.waitFor("document.body.textContent.includes('Asked while the other was being answered?')");
        await untouched(page, box);
        assert.equal(await page.eval<string>("kept.value"), "my own answer");
        store.dismiss(other.id);

        // An option clicked is the answer, sent at once, whatever the box held.
        await page.click(".next .opts button", "Blue");
        await page.waitFor("document.querySelector('.next.resolved')?.textContent.includes('Blue')");
        assert.deepEqual(store.takeInbox("answering").map((e) => e.answer), ["Blue"]);
      } finally {
        store.dismiss(asked.id);
        stop();
      }
    });

    it("turns inert when what it answers stops taking messages, in place, saying where to answer", async () => {
      store.upsertSession({ id: "closing", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "closing under the box", takesMessagesWhileWorking: true });
      const page = await open();
      await page.click(".scard", "closing under the box");
      await page.click("#session .chat-footer textarea");
      await page.type("half a thought");
      const box = "document.querySelector('#session .chat-footer textarea')";
      await watch(page, box);
      store.updateSession("closing", (s) => ({ ...s, state: "waiting" }));
      await page.waitFor(`${box}.readOnly`);
      await untouched(page, box);
      assert.deepEqual(
        await page.eval(`[kept.value, kept.placeholder, kept.getAttribute("aria-disabled"), document.querySelector('#session .chat-footer .send').disabled]`),
        ["half a thought", "Answer in its terminal", "true", true],
        "the draft stays, nothing can be sent, and the box says why",
      );
      await page.press("Escape");
    });
  });

  it("on a phone, keeps the box being typed in above a keyboard that covers the page, as iOS's does", async () => {
    store.upsertSession({ id: "covered", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "covered by the keyboard", state: "waiting" });
    const stop = store.listen("covered");
    const asked = store.ask({ sessionId: "covered", kind: "question", text: "Is the box still in view?", options: ["Yes", "No"] });
    store.upsertSession({ id: "covered-chat", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "chat under the keyboard", takesMessagesWhileWorking: true });
    try {
      const page = await browser.newPage(390, 844);
      pages.push(page);
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: coveringKeyboard(844) });
      await page.goto(base + "/");
      await page.waitFor("document.querySelector('.next')");
      const inView = (box: string) => page.eval<boolean>(`(() => { const r = ${box}.getBoundingClientRect(); return r.top >= 0 && r.bottom <= visualViewport.height; })()`);

      await page.click(".qrow", "Is the box still in view?");
      await page.waitFor("document.querySelector('.next')?.textContent.includes('Is the box still in view?')");
      await page.waitFor(STILL); // the card grows out of its row: measured once it has
      const onCard = "document.querySelector('.next textarea')";
      // Covers the box's last 20 px, whatever its place on the page.
      await page.eval(`(() => { ${onCard}.focus(); window.scrollTo(0, 0); setKeyboard(innerHeight - ${onCard}.getBoundingClientRect().bottom + 20); })()`);
      assert.equal(await inView(onCard), true, "on the inbox's card");
      await page.eval(`(() => { setKeyboard(0); ${onCard}.blur(); })()`);

      await page.click(".tabbar button", "Sessions");
      await page.click(".scard", "chat under the keyboard");
      const inChat = "document.querySelector('#session .chat-footer textarea')";
      await page.waitFor(inChat);
      await page.eval(`(() => { ${inChat}.focus(); setKeyboard(340); })()`);
      assert.equal(await inView(inChat), true, "in a session's chat");
      // Waited for: the window slides in as it opens.
      await page.waitFor("document.querySelector('#session').getBoundingClientRect().bottom <= visualViewport.height");
      await page.eval("setKeyboard(0)");
      await page.waitFor("document.querySelector('#session').getBoundingClientRect().height === 844");
      await page.press("Escape");
    } finally {
      store.dismiss(asked.id);
      stop();
    }
  });

  it("on a phone, the connection's error wraps inside the screen", async () => {
    const page = await open(390, 844);
    await page.eval(`(() => {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = () => timeout(200);
      window.realFetch = window.fetch;
      window.fetch = (url, init) => String(url) === "/api/state" ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))) : window.realFetch(url, init);
    })()`);
    await fetchNow(page);
    await page.waitFor("document.querySelector('#strip .offline')");
    assert.ok(await page.eval<boolean>("document.querySelector('#strip .offline').getBoundingClientRect().right <= innerWidth"), "the whole text is in view, with no sideways scroll");
    assert.ok(await page.eval<boolean>("document.querySelector('#strip .offline').getBoundingClientRect().height > 20"), "on several lines");
    await page.eval("window.fetch = window.realFetch");
    await page.waitFor("!document.querySelector('#strip .offline')");
  });

  it("gives a table's long columns room to read, scrolling sideways when they do not fit", async () => {
    const long = "A long explanation that a narrow column would break into a very tall tower of a few words on each line";
    store.upsertSession({ id: "tables", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "a wide table", state: "waiting" });
    store.addMessage({ sessionId: "tables", from: "session", text: `Summary:\n\n| # | What | Why | Next |\n|---|---|---|---|\n| 1 | ${long} | ${long} | ${long} |` });
    const page = await open(390, 844);
    await page.click(".tabbar button", "Sessions");
    await page.click(".scard", "a wide table");
    await page.waitFor("document.querySelector('#session .md-table td')");
    await page.waitFor(arrived("session"));
    const widths = await page.eval<number[]>("[...document.querySelectorAll('#session .md-table td')].map((c) => c.getBoundingClientRect().width)");
    assert.ok((widths[0] ?? 999) < 60, `a short column stays short: ${widths}`);
    for (const w of widths.slice(1)) assert.ok(w >= 220, `a long column has room: ${widths}`);
    assert.ok(await page.eval<boolean>("(() => { const t = document.querySelector('#session .md-table'); return t.scrollWidth > t.clientWidth && t.getBoundingClientRect().right <= innerWidth; })()"), "the table scrolls inside the screen");
    assert.equal(await page.eval<boolean>("document.querySelector('#session .session-body').scrollWidth <= document.querySelector('#session .session-body').clientWidth"), true, "the conversation does not");
    await page.press("Escape");
  });

  it("folds what a session wrote between its tool calls once something followed it", async () => {
    store.upsertSession({ id: "steps", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "steps folded", state: "working" });
    store.addMessage({ sessionId: "steps", from: "developer", text: "fix the build", via: "terminal" });
    store.addMessage({ sessionId: "steps", from: "session", text: "Looking at the logs first.", step: true });
    store.addMessage({ sessionId: "steps", from: "session", text: "Found it: a missing import.", step: true });
    store.addMessage({ sessionId: "steps", from: "session", text: "Fixed and tested." });
    store.addMessage({ sessionId: "steps", from: "session", text: "Now running the e2e suite.", step: true });
    const page = await open();
    await page.click(".scard", "steps folded");
    await page.waitFor("document.querySelector('#session .steps-fold')");
    const texts = () => page.eval<string[]>("[...document.querySelectorAll('#session .msg:not(.working-now) .md')].map((m) => m.textContent)");
    assert.deepEqual(await texts(), ["fix the build", "Fixed and tested.", "Now running the e2e suite."], "the latest run, still being written, stays open");
    assert.match(await page.eval<string>("document.querySelector('#session .steps-fold').textContent"), /2 messages while it worked/);
    await page.click("#session .steps-fold");
    await page.waitFor("document.querySelectorAll('#session .msg.step').length === 3");
    assert.deepEqual((await texts()).slice(1, 3), ["Looking at the logs first.", "Found it: a missing import."]);
    await page.press("Escape");
  });

  it("keeps the line breaks of what the developer pasted, and joins the session's wrapped lines", async () => {
    store.upsertSession({ id: "pasted", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "pasted output" });
    store.addMessage({ sessionId: "pasted", from: "developer", text: "$ git push\nfatal: 403", via: "terminal" });
    store.addMessage({ sessionId: "pasted", from: "session", text: "The push was\nrefused." });
    const page = await open();
    await page.click(".scard", "pasted output");
    await page.waitFor("document.querySelector('#session .msg.from-developer')");
    const shown = (who: string) => page.eval<string>(`document.querySelector('#session .msg.from-${who} .md p').innerText`);
    assert.equal(await shown("developer"), "$ git push\nfatal: 403");
    assert.equal(await shown("session"), "The push was refused.");
    await page.press("Escape");
  });

  it("sets the theme and the text size from the display menu, kept for the next visit", async () => {
    const page = await open();
    const rootSize = "getComputedStyle(document.documentElement).fontSize";
    assert.equal(await page.eval<string>(rootSize), "16px");
    await page.click("#theme");
    await page.click("#display-menu .sizes button:last-child");
    await page.waitFor(`${rootSize} === "20px"`);
    assert.equal(await page.eval<boolean>("!document.querySelector('#display-menu').hidden"), true, "a choice leaves the menu open");
    await page.click("#display-menu button", "Dark");
    await page.waitFor("document.documentElement.dataset.theme === 'dark'");
    await page.goto(base + "/");
    await page.waitFor(`document.querySelector('.scard') && ${rootSize} === "20px" && document.documentElement.dataset.theme === 'dark'`);
    await page.eval("localStorage.clear()");
  });

  describe("on a phone, the answer box works as a chat app's", () => {
    /** The desk as a phone shows it: a finger, no hover, the page's own viewport. */
    async function phone(width = 390, height = 844, setup = ""): Promise<Page> {
      const page = await browser.newPage(width, height);
      pages.push(page);
      await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true });
      await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });
      if (setup) await page.send("Page.addScriptToEvaluateOnNewDocument", { source: setup });
      await page.goto(base + "/");
      await page.waitFor("document.querySelector('.next') && document.querySelectorAll('.scard').length");
      return page;
    }
    /** A session waiting on a question with options, its listener running until `stop`. */
    function asking(id: string, title: string) {
      store.upsertSession({ id, provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title, state: "waiting" });
      const stop = store.listen(id);
      const q = store.ask({ sessionId: id, kind: "question", text: `Which colour, ${title}?`, options: ["Green", "Blue"] });
      return () => (store.dismiss(q.id), stop());
    }
    const openPanel = async (page: Page, title: string) => {
      await page.click(".tabbar button", "Sessions");
      await page.click(".scard", title);
      await page.waitFor(`document.querySelector('#session .chat-footer textarea') && ${STILL}`);
    };

    it("one line when empty, round buttons, clear of the home indicator, with the conversation resting on it", async () => {
      store.upsertSession({ id: "composer", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "a phone's composer", takesMessagesWhileWorking: true });
      const page = await phone();
      await openPanel(page, "a phone's composer");
      const shape = await page.eval<Record<string, unknown>>(`(() => {
        const box = document.querySelector('#session .chat-footer textarea'), send = document.querySelector('#session .chat-footer .send');
        const foot = document.querySelector('#session .chat-footer'), chat = document.querySelector('#session .conversation');
        return { rows: box.rows, oneLine: box.getBoundingClientRect().height <= 46, resize: getComputedStyle(box).resize,
          send: [send.offsetWidth, send.offsetHeight], name: send.getAttribute('aria-label'), footPad: getComputedStyle(foot).paddingBottom,
          resting: foot.getBoundingClientRect().top - chat.getBoundingClientRect().bottom <= 12 };
      })()`);
      assert.deepEqual(shape, { rows: 1, oneLine: true, resize: "none", send: [44, 44], name: "Send to the session", footPad: "12px", resting: true });
      await page.press("Escape");
    });

    it("a tapped option is sent at once without raising the keyboard; a tap on the box does", async () => {
      const done = asking("picking", "picking on a phone");
      try {
        const page = await phone();
        await openPanel(page, "picking on a phone");
        await page.tap("#session .opts button", "Blue");
        const box = "document.querySelector('#session .chat-footer textarea')";
        await page.waitFor("[...document.querySelectorAll('#session .msg.from-developer')].some((m) => m.textContent.includes('Blue') && m.querySelector('.delivered'))");
        assert.deepEqual(store.takeInbox("picking").map((e) => e.answer), ["Blue"], "sent as tapped, once");
        assert.equal(await page.eval<boolean>(`document.activeElement === ${box}`), false, "the box is not focused, so no keyboard rose");
        await page.tap("#session .chat-footer textarea");
        await page.waitFor(`document.activeElement === ${box}`);
        await page.press("Escape");
      } finally {
        done();
      }
    });

    it("keeps the box focused after Send, so the keyboard stays up for the next message", async () => {
      store.upsertSession({ id: "chatting", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "chatting on a phone", takesMessagesWhileWorking: true });
      const page = await phone();
      await openPanel(page, "chatting on a phone");
      const box = "document.querySelector('#session .chat-footer textarea')";
      await page.tap("#session .chat-footer textarea");
      await page.waitFor(`document.activeElement === ${box}`);
      await page.type("first of two");
      await page.tap("#session .chat-footer .send");
      await page.waitFor(`[...document.querySelectorAll('#session .msg.from-developer')].some((m) => m.textContent.includes('first of two') && m.querySelector('.delivered')) && ${box}.value === ''`);
      assert.equal(await page.eval<boolean>(`document.activeElement === ${box}`), true);
      assert.deepEqual(store.takeInbox("chatting").map((e) => e.answer), ["first of two"]);
      await page.press("Escape");
    });

    it("slides the tab bar away only once a keyboard is up, with nothing moving under the finger", async () => {
      const done = asking("kbd-room", "room for the keyboard");
      try {
        const page = await phone();
        await page.click(".qrow", "room for the keyboard");
        const box = "document.querySelector('.next textarea')";
        await page.waitFor(`${box} && ${STILL}`);
        const where = `[Math.round(scrollY), Math.round(${box}.getBoundingClientRect().top), document.documentElement.scrollHeight]`;
        await page.eval("window.scrollTo(0, document.documentElement.scrollHeight)");
        const before = await page.eval<number[]>(where);
        await page.eval(`${box}.focus({ preventScroll: true })`);
        await page.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        assert.deepEqual(await page.eval<number[]>(where), before, "focus alone moves nothing: the keyboard may not even come");
        const bar = "getComputedStyle(document.querySelector('.tabbar')).visibility";
        assert.equal(await page.eval<string>(bar), "visible");
        // As Android with interactive-widget=resizes-content: the whole viewport shrinks for the keyboard.
        await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 508, deviceScaleFactor: 1, mobile: true });
        await page.waitFor(`document.documentElement.hasAttribute('data-keyboard') && ${bar} === "hidden"`);
        assert.ok(await page.eval<boolean>("document.querySelector('.tabbar').getBoundingClientRect().top >= innerHeight"), "slid below the screen");
        await page.eval(`${box}.blur()`);
        await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await page.waitFor(`!document.documentElement.hasAttribute('data-keyboard') && ${bar} === "visible"`);
      } finally {
        done();
      }
    });

    it("under a keyboard that covers the page, as iOS's, turns compact, sits on the keyboard, and toasts come from the top", async () => {
      const done = asking("compact", "compact under the keyboard");
      store.upsertSession({ id: "compact-other", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "another session", state: "working" });
      try {
        const page = await phone(390, 844, coveringKeyboard(844));
        await openPanel(page, "compact under the keyboard");
        const box = "document.querySelector('#session .chat-footer textarea')";
        await page.tap("#session .chat-footer textarea");
        await page.eval("setKeyboard(336)");
        await page.waitFor("document.documentElement.hasAttribute('data-compact')");
        const fit = await page.eval<Record<string, unknown>>(`(() => {
          const foot = document.querySelector('#session .chat-footer');
          return { chips: getComputedStyle(document.querySelector('#session .pchips')).display, kind: getComputedStyle(document.querySelector('#session .panel-question > .meta')).display,
            onKeyboard: 508 - ${box}.getBoundingClientRect().bottom, roomLeft: foot.getBoundingClientRect().height < 508 * 0.45 };
        })()`);
        assert.deepEqual(fit, { chips: "none", kind: "none", onKeyboard: 8, roomLeft: true });
        await page.tap("#session .opts button", "Green");
        await page.waitFor("[...document.querySelectorAll('#session .msg.from-developer')].some((m) => m.textContent.includes('Green') && m.querySelector('.delivered'))");
        store.updateSession("compact-other", (s) => ({ ...s, state: "waiting", lastMessage: { text: "Done elsewhere.", at: new Date().toISOString() } }));
        await page.waitFor("document.querySelector('.toast')?.textContent.includes('another session')");
        assert.deepEqual(
          await page.eval("(() => { const t = document.querySelector('.toast').getBoundingClientRect(); return [t.top >= document.querySelector('#session .dhead').getBoundingClientRect().bottom, t.bottom < 508 / 2]; })()"),
          [true, true],
          "under the window's head, so its title, Go and Close stay in sight, and far from the box",
        );
        await page.press("Escape");
      } finally {
        done();
      }
    });

    it("on a short phone, a long draft under the keyboard keeps the question, the box's end and Send above the keyboard", async () => {
      const done = asking("short", "a long draft on a short phone");
      try {
        const page = await phone(375, 667, coveringKeyboard(667));
        await openPanel(page, "a long draft on a short phone");
        await page.tap("#session .chat-footer textarea");
        await page.eval("setKeyboard(260)");
        await page.waitFor("document.documentElement.hasAttribute('data-compact')");
        for (let i = 0; i < 9; i++) await page.type(`Line ${i} of a long draft\n`);
        const fit = await page.eval<Record<string, unknown>>(`(() => {
          const foot = document.querySelector('#session .chat-footer'), box = foot.querySelector('textarea'), send = foot.querySelector('.send');
          return { footScrolls: foot.scrollHeight - foot.clientHeight, question: foot.querySelector('.qtext').getBoundingClientRect().top >= foot.getBoundingClientRect().top,
            boxOnKeyboard: 407 - Math.round(box.getBoundingClientRect().bottom), sendOnKeyboard: 407 - Math.round(send.getBoundingClientRect().bottom), boxScrolls: box.scrollHeight > box.clientHeight };
        })()`);
        assert.deepEqual(fit, { footScrolls: 0, question: true, boxOnKeyboard: 8, sendOnKeyboard: 8, boxScrolls: true });
        await page.press("Escape");
      } finally {
        done();
      }
    });

    it("under a keyboard that covers the page, a box on the inbox's card growing line by line keeps its end and Send above the keyboard", async () => {
      const done = asking("growing", "a growing answer");
      try {
        const page = await phone(390, 844, coveringKeyboard(844));
        await page.click(".qrow", "a growing answer");
        const box = "document.querySelector('.next textarea')";
        await page.waitFor(`${box} && document.querySelector('.next').textContent.includes('a growing answer') && ${STILL}`);
        // The keyboard leaves 20 px under the box: no scroll is needed until it grows.
        await page.eval(`(() => { ${box}.focus(); setKeyboard(innerHeight - ${box}.getBoundingClientRect().bottom - 20); })()`);
        await page.waitFor("document.documentElement.hasAttribute('data-keyboard')");
        for (let i = 0; i < 4; i++) await page.type(`Line ${i} of a longer answer\n`);
        const room = await page.eval<number[]>(`(() => {
          const send = document.querySelector('.next .send');
          return [${box}, send].map((el) => Math.round(visualViewport.height - el.getBoundingClientRect().bottom));
        })()`);
        assert.ok(room.every((px) => px >= 16), `the box's end and Send stay 16 px above the keyboard: ${room}`);
      } finally {
        done();
      }
    });

    it("keeps a toast where it came in when the window it came over closes", async () => {
      store.upsertSession({ id: "toast-edge", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "a toast's edge", takesMessagesWhileWorking: true });
      store.upsertSession({ id: "toast-edge-other", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "finishing elsewhere", state: "working" });
      const page = await phone();
      await openPanel(page, "a toast's edge");
      store.updateSession("toast-edge-other", (s) => ({ ...s, state: "waiting", lastMessage: { text: "Finished over there.", at: new Date().toISOString() } }));
      const toast = "[...document.querySelectorAll('.toast')].find((t) => t.textContent.includes('finishing elsewhere'))";
      await page.waitFor(`${toast} && !${toast}.getAnimations().length`);
      const top = await page.eval<number>(`${toast}.getBoundingClientRect().top`);
      assert.ok(top < 844 / 2, "over the window, it comes from the top");
      await page.press("Escape");
      await page.waitFor("!document.getElementById('session').open");
      assert.equal(await page.eval<number>(`${toast}.getBoundingClientRect().top`), top, "the window gone, it stays there until it leaves");
    });
  });

  it("keeps the large card's shape when its session starts or stops listening", async () => {
    store.upsertSession({ id: "flipping", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "listening on and off", state: "waiting" });
    const asked = store.ask({ sessionId: "flipping", kind: "question", text: "Does the card hold still?", options: ["Yes", "No"] });
    try {
      const page = await open();
      await page.click(".qrow", "Does the card hold still?");
      const card = "document.querySelector('.next')";
      await page.waitFor(`${card}?.textContent.includes('Does the card hold still?') && ${STILL}`);
      const height = () => page.eval<number>(`${card}.getBoundingClientRect().height`);
      const off = await height();
      assert.equal(await page.eval<string>(`${card}.querySelector('textarea').placeholder`), "Answer in its terminal");
      const stop = store.listen("flipping");
      await page.waitFor(`!${card}.querySelector('.answer.off')`);
      assert.equal(await height(), off, "the box, the options and the link stay where they were");
      stop();
      await page.waitFor(`${card}.querySelector('.answer.off')`);
      assert.equal(await height(), off);
    } finally {
      store.dismiss(asked.id);
    }
  });

  it("closes only the zoom with Escape, then the result", async () => {
    const page = await open();
    await page.click(".rtile", "Three pay button variants");
    await page.waitFor("document.getElementById('result').open");
    await page.click("#result .vimgs img");
    await page.waitFor("document.getElementById('zoom').open");
    await page.press("Escape");
    await page.waitFor("!document.getElementById('zoom').open");
    assert.deepEqual(await openDialogs(page), ["result"], "the result stays open under the zoom");
    await page.press("Escape");
    await page.waitFor("!document.getElementById('result').open");
  });

  it("keeps the inbox beside the sessions down to tablet widths, and shows tabs on a phone", async () => {
    const page = await open();
    const visible = () => page.eval<string[]>("[...document.querySelectorAll('.board > .col')].filter((c) => c.getClientRects().length).map((c) => c.className.match(/col-(\\w+)/)[1])");
    const beside = () => page.eval<boolean>("document.querySelector('.col-needs').getBoundingClientRect().right <= document.querySelector('.col-sessions').getBoundingClientRect().left");
    for (const width of [1400, 1000, 760]) {
      await page.resize(width, 900);
      assert.equal(await beside(), true, `two columns at ${width} px`);
      assert.equal(await page.eval<number>("document.documentElement.scrollWidth"), width, `nothing overflows sideways at ${width} px`);
    }
    await page.resize(390, 800);
    assert.deepEqual(await visible(), ["needs"], "one part at a time on a phone");
    assert.equal(await page.eval<boolean>("!!document.querySelector('.tabbar').getClientRects().length"), true);
  });

  describe("the desk when nothing needs the developer", () => {
    let quiet: Store;
    let quietBase: string;
    let closeQuiet: () => Promise<void>;
    before(async () => {
      const home = path.join(tempHome(), "store");
      execFileSync(process.execPath, [path.join(import.meta.dirname, "../scripts/demo.ts"), home]);
      quiet = new Store(home);
      for (const q of quiet.listQuestions()) if (q.status === "open") quiet.dismiss(q.id);
      for (const r of quiet.listResults()) if (!r.seenAt) quiet.markResultSeen(r.id);
      ({ base: quietBase, close: closeQuiet } = await serve(quiet));
    });
    after(() => closeQuiet?.());
    afterEach(() => {
      for (const q of quiet.listQuestions()) if (q.status === "open") quiet.dismiss(q.id);
    });
    async function openQuiet(width = 1440, height = 900): Promise<Page> {
      const page = await browser.newPage(width, height);
      pages.push(page);
      await page.goto(quietBase + "/");
      await page.waitFor("document.querySelectorAll('.scard').length === 3");
      return page;
    }
    const box = (page: Page, sel: string) => page.eval<{ top: number; bottom: number; left: number; right: number; height: number }>(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; })()`);
    const checkout = cardOf("checkout redesign");
    // The rich cards' agent marks: their sizes, goals that start where the session's name does, marks centred on the goal's line.
    const agentMarks = (page: Page) =>
      page.eval<{ sizes: number[]; left: boolean; centred: boolean }>(`(() => {
        const rows = [...document.querySelectorAll('.scard.rich .s-agent')];
        const near = (a, b) => Math.abs(a - b) < 1;
        return {
          sizes: [...new Set(rows.map((r) => r.querySelector('.dot').getBoundingClientRect().width))],
          left: rows.every((r) => near(r.querySelector('.s-agent-t').getBoundingClientRect().left, r.closest('.scard').querySelector('.sname').getBoundingClientRect().left)),
          centred: rows.every((r) => { const d = r.querySelector('.dot').getBoundingClientRect(); const g = r.querySelector('b').getBoundingClientRect(); return near(d.top + d.height / 2, g.top + g.height / 2); }),
        };
      })()`);

    it("shrinks Needs you to one line and gives the centre to the sessions, with what each does now, its agents and what it runs on", async () => {
      const page = await openQuiet();
      assert.equal(await page.eval<boolean>("document.querySelector('.board').classList.contains('quiet')"), true);
      assert.equal(await page.eval<boolean>("!document.querySelector('.col-needs .col-head') && !!document.querySelector('.col-needs .all-clear')"), true, "Needs you is the one line");
      assert.match(await page.eval<string>("document.querySelector('.all-clear').textContent"), /^All clear.*nothing needs you, nothing new to review.*last answer \d\d:\d\d · “?Yes, one series per year/);
      const line = await box(page, ".all-clear");
      assert.ok(line.height < 50, `one line (${line.height} px)`);
      const sessions = await box(page, ".col-sessions");
      const split = await box(page, ".split");
      assert.ok(sessions.right <= split.left && sessions.top >= line.bottom, "the sessions sit under the line, left of the splitter");
      const review = await box(page, ".col-review");
      assert.ok(review.left >= split.right && review.top < line.bottom, "To review keeps the right column whole");
      assert.equal(await page.eval<number>("document.querySelectorAll('.scard.rich').length"), 3, "every card is the rich one");
      assert.equal(await page.eval<number>("new Set([...document.querySelectorAll('.scard')].map((c) => Math.round(c.getBoundingClientRect().top))).size < 3"), true, "cards side by side");
      assert.equal(await page.eval<boolean>(`!${checkout}.querySelector('.quiet-line')`), true, "its tool call stays in the session panel");
      assert.deepEqual(
        await page.eval<string[][]>(`[...${checkout}.querySelectorAll('.s-agent')].map((r) => [r.querySelector('b').textContent, r.querySelector('small').textContent])`),
        [
          ["Checkout e2e suite", "No space left on device while writing traces"],
          ["Rebase the cart on the new summary", "waits for Order summary beside the cart"],
          ["Order summary beside the cart", "Editing src/checkout/OrderSummary.tsx"],
          ["Accessibility audit", "Running axe on 14 pages (9/14)"],
        ],
        "each agent at work or in trouble with what it was said to do, or why it stopped, trouble first",
      );
      assert.deepEqual(await page.eval<string[]>(`[...${checkout}.querySelectorAll('.s-agent-at')].map((t) => t.textContent.replace(/\\d+/g, "N"))`), ["took N h N min", "N min", "N min", "N min"]);
      assert.equal(await page.eval<string>(`${checkout}.querySelector('.s-agents > .s-more').textContent`), "1 done", "finished agents are counted, not listed");
      assert.equal(await page.eval<number>(`${checkout}.querySelectorAll('.s-bad').length`), 0, "a failed or blocked agent says why on its own row, not twice");
      assert.equal(await page.eval<boolean>(`${checkout}.querySelector('.s-agent').classList.contains('failed')`), true);
      assert.deepEqual(await agentMarks(page), { sizes: [14], left: true, centred: true }, "each agent's mark at the card's size, its goal under the session's name");
      const work = await page.eval<string>(`${checkout}.querySelector('.s-work').textContent`);
      assert.match(work, /Context 71%.*vite dev :5173.*storybook :6006.*feat\/checkout-mobile$/);
      assert.doesNotMatch(work, /Opus/, "the model is in the session panel");
      assert.equal(await page.eval<boolean>("[...document.querySelectorAll('.scard .s-work')].some((w) => w.textContent.includes('limit'))"), false, "no card repeats the plan windows");
      assert.match(
        await page.eval<string>("[...document.querySelectorAll('.col-sessions .col-head .s-gauge')].map((g) => (g.querySelector('.mini') ? '[bar] ' : '') + g.textContent).join(' | ')"),
        /^\[bar\] 5 h limit 42% · resets \d\d:\d\d$/,
        "the account's plan windows, once in the Sessions head, each with its bar",
      );
      assert.equal(await page.eval<string>(`${checkout}.querySelector('.s-live a').getAttribute('href')`), "http://localhost:5173");
      // A preview opens in its own tab: a click beside its link does not open the session.
      await page.eval(`${checkout}.querySelector('.s-live').click()`);
      assert.deepEqual(await openDialogs(page), []);
      const vat = cardOf("VAT rounding");
      assert.match(await page.eval<string>(`${vat}.querySelector('.s-work .chip').textContent`), /^Context 86% · \/compact$/, "the command its context calls for stands for its context");
      assert.match(await page.eval<string>("document.querySelector('.col-sessions .col-head').textContent"), /Sessions3.*2 working · 4 agents at work/);
      assert.deepEqual(await page.eval<string[]>("[...document.querySelectorAll('.rearlier .rrow .rt')].map((t) => t.textContent)"), ["Migration 0041 applied locally", "Checkout e2e: failed, disk full", "Three pay button variants", "Checkout: before and after"], "the results already seen, newest first");
      assert.match(await page.eval<string>("document.querySelector('.col-review .col-head').textContent"), /nothing new · seen earlier/);
      await page.click(".last-answer");
      await page.waitFor("document.body.dataset.view === 'history'");
    });

    it("leaves off a rich card what does not help at a glance: finished agents, tool calls, the project's own branch", async () => {
      const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
      quiet.upsertSession({ id: "noisy", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "busy session", state: "working", activity: "Bash: python3 - <<'EOF' import pathlib", activityIsCall: true, activityAt: ago(0) });
      quiet.mergeMetrics({ sessionId: "noisy", model: "Opus 5.5", effort: "high", branch: "main", contextPercent: 40 });
      for (let i = 0; i < 6; i++) quiet.upsertAgent("noisy", `done-${i}`, { goal: `Finished task ${i}`, state: "done", activity: "Bash: pgrep -af node", activityIsCall: true });
      quiet.upsertAgent("noisy", "looping", { goal: "Looping agent", activity: "Bash: npm test", activityIsCall: true, activityAt: ago(0), failedAt: [ago(3), ago(2), ago(1)], failedWhat: "Bash: npm test", startedAt: ago(31) });
      quiet.upsertAgent("noisy", "reader", { goal: "Reads the tests", activity: "Bash: sed -n 100,200p test/page.test.ts", activityIsCall: true, activityAt: ago(0), startedAt: ago(30) });
      quiet.upsertAgent("noisy", "suite", { goal: "Runs the suite", activity: "Bash: npm test -- invoices (212/340)", activityIsCall: true, activityAt: ago(0), startedAt: ago(29) });
      for (const n of [1, 2, 3]) quiet.upsertAgent("noisy", `busy-${n}`, { goal: `Busy agent ${n}`, activity: "StructuredOutput", activityIsCall: true, activityAt: ago(0), startedAt: ago(29 - n) });
      quiet.markSessionRead("demo-pagos");
      try {
        const page = await browser.newPage(1440, 900);
        pages.push(page);
        await page.goto(quietBase + "/");
        const card = cardOf("busy session");
        await page.waitFor(`${card}?.querySelector('.s-agents')`);
        assert.deepEqual(
          await page.eval<string[][]>(`[...${card}.querySelectorAll('.s-agent')].map((r) => [...r.querySelectorAll('b, small')].map((x) => x.textContent))`),
          [["Looping agent", "3 failed calls in a row"], ["Reads the tests"], ["Runs the suite", "212/340"], ["Busy agent 1"]],
          "at most four, the stuck one first, each with no tool call: only how far a call has got",
        );
        assert.equal(await page.eval<string>(`${card}.querySelector('.s-agents > .s-more').textContent`), "+2 more at work · 6 done");
        assert.equal(await page.eval<number>(`${card}.querySelectorAll('.s-bad').length`), 0, "the stuck agent is said once, on its own row");
        const said = await page.eval<string>(`${card}.textContent + [...${card}.querySelectorAll('[title]')].map((e) => e.title).join(' ')`);
        assert.doesNotMatch(said, /Bash|sed -n|pgrep|python3|StructuredOutput/, "no tool call on the card, not even in a tooltip");
        assert.doesNotMatch(await page.eval<string>(`${card}.querySelector('.s-work').textContent`), /main|Opus/, "the project's own branch and the model are left to the panel");
        const pagos = cardOf("payment webhooks");
        assert.match(await page.eval<string>(`${pagos}.querySelector('.quiet-line').textContent`), /^Waiting for you · 3 min$/, "a session read and waiting says so in a few words");
      } finally {
        quiet.upsertSession({ id: "noisy", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, state: "ended" });
        quiet.markSessionUnread("demo-pagos");
      }
    });

    it("gives the top back to Needs you when a question arrives, the sessions landing in the right column", async () => {
      const page = await openQuiet();
      // What moves is read the moment the board changes shape, right after its redraw.
      await page.eval(`(() => {
        const board = document.querySelector('.board');
        new MutationObserver((_, mo) => {
          if (board.classList.contains('quiet')) return;
          mo.disconnect();
          window.moved = {
            cards: [...document.querySelectorAll('.scard')].map((c) => c.getAnimations().some((a) => a.effect.getKeyframes().some((k) => k.opacity === '0' || k.opacity === 0))),
            head: document.querySelector('.col-needs .col-head').getAnimations().length > 0,
            line: !!document.querySelector('.all-clear[data-leaving]'),
          };
        }).observe(board, { attributes: true, attributeFilter: ['class'] });
      })()`);
      quiet.ask({ sessionId: "demo-pagos", kind: "question", text: "Shall I start stripe listen again?", options: ["Yes", "No"] });
      await page.waitFor("window.moved && document.querySelector('.next')");
      assert.deepEqual(await page.eval("window.moved"), { cards: [true, true, true], head: true, line: true }, "the cards land in their new column, Needs you's head fades in, the line folds away");
      const needs = await box(page, ".col-needs");
      const sessions = await box(page, ".col-sessions");
      assert.ok(needs.right <= sessions.left && needs.top < sessions.top + 1, "Needs you takes the left column again, the sessions the right");
      assert.equal(await page.eval<number>("document.querySelectorAll('.scard.rich').length"), 0, "the cards are the short ones again");
      assert.equal(await page.eval<boolean>("document.querySelector('.scard.needs')?.textContent.includes('payment webhooks')"), true);
      for (const q of quiet.listQuestions()) if (q.status === "open") quiet.dismiss(q.id);
      await page.waitFor("document.querySelector('.board.quiet .all-clear')");
    });

    it("moves nothing for a developer who prefers reduced motion", async () => {
      const page = await browser.newPage(1440, 900);
      pages.push(page);
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await page.goto(quietBase + "/");
      await page.waitFor("document.querySelector('.board.quiet')");
      quiet.ask({ sessionId: "demo-pagos", kind: "question", text: "Shall I start stripe listen again?", options: ["Yes", "No"] });
      await page.waitFor("document.querySelector('.next')");
      assert.equal(await page.eval<number>("document.getAnimations().filter((a) => a.id === 'motion').length"), 0);
    });

    it("on a phone, keeps its tabs and the centred All clear, and gives the Sessions tab the rich cards under the plan windows", async () => {
      const page = await openQuiet(390, 800);
      assert.equal(await page.eval<boolean>("document.querySelector('.board').classList.contains('quiet')"), false, "the board keeps its tabs");
      assert.equal(await page.eval<string>("document.querySelector('.col-needs .empty').textContent"), "All clear: nothing needs you, nothing new to review.");
      await page.click(".tabbar button", "Sessions");
      await page.waitFor("document.querySelector('.col-sessions').getClientRects().length");
      assert.equal(await page.eval<number>("document.querySelectorAll('.scard.rich').length"), 3);
      assert.equal(await page.eval<number>(`${checkout}.querySelectorAll('.s-agent').length`), 4);
      assert.deepEqual(await agentMarks(page), { sizes: [14], left: true, centred: true }, "on its own line, the goal keeps its mark centred on it");
      assert.equal(await page.eval<number>("document.documentElement.scrollWidth"), 390, "nothing overflows sideways");
      assert.equal(await page.eval<boolean>("[...document.querySelectorAll('.scard .s-work')].some((w) => w.textContent.includes('limit'))"), false, "no card repeats the plan windows");
      assert.match(await page.eval<string>("document.querySelector('.col-sessions .col-head .head-aside').textContent"), /^5 h limit 42% · resets \d\d:\d\d$/, "they stand once over the cards, as on the quiet desk");
      await page.click(".tabbar button", "To review");
      assert.equal(await page.eval<boolean>("!document.querySelector('.rearlier') && !!document.querySelector('.col-review .empty')"), true, "To review as before: nothing new, and the way to earlier results");
      await page.resize(1440, 900);
      await page.waitFor("document.querySelector('.board.quiet')");
    });

    // Last of these: a dismissal is for good.
    it("lets a result already seen be dismissed from To review on every device, and keeps it in History", async () => {
      const page = await openQuiet();
      const row = (title: string) => `[...document.querySelectorAll('.rearlier-wrap')].find((w) => w.textContent.includes(${JSON.stringify(title)}))`;
      const migration = row("Migration 0041 applied locally");
      await page.waitFor(migration);
      assert.equal(
        await page.eval<string>(`getComputedStyle(${migration}.querySelector('.rdismiss')).opacity`),
        await page.eval<string>("matchMedia('(hover: hover)').matches ? '0' : '1'"),
        "the × waits for a pointer, and is always there without one",
      );
      const [x, y] = await page.eval<[number, number]>(`(() => { const r = ${migration}.querySelector('.rdismiss').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      await page.waitFor(`!${migration} && !!${row("Three pay button variants")}`);
      assert.deepEqual(await openDialogs(page), [], "the × does not open the result");
      assert.ok(quiet.listResults().find((r) => r.title === "Migration 0041 applied locally")?.dismissedAt, "kept in the store, not in this browser");
      const other = await openQuiet();
      await other.waitFor(`!!${row("Three pay button variants")}`);
      assert.equal(await other.eval<boolean>(`!${migration}`), true, "gone from the list on another device too");
      // The page opened last is the one in front, where animation frames run.
      for (const r of quiet.listResults()) quiet.dismissResult(r.id);
      await other.waitFor("!document.querySelector('.rearlier') && !!document.querySelector('.col-review .empty')");
      assert.equal(await other.eval<string>("document.querySelector('.col-review .empty').textContent"), "Nothing new to review.All results", "calm, with the way to every result");
      await other.click(".col-review .empty button", "All results");
      await other.waitFor("document.body.dataset.view === 'history' && document.querySelector('#view').textContent.includes('Migration 0041 applied locally')");
    });
  });

  describe("redraws change only what changed, and lists move on their own cards", () => {
    it("keeps the focused card, the selected text and every node through new data and the 30 s tick", async () => {
      const page = await browser.newPage(1400, 900);
      pages.push(page);
      // The page's 30 s tick runs every 200 ms here.
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "const tick = window.setInterval; window.setInterval = (f, ms, ...a) => tick(f, ms === 30000 ? 200 : ms, ...a);" });
      await page.goto(base + "/");
      await page.waitFor("document.querySelector('.next') && document.querySelectorAll('.scard').length");
      await page.eval(`(() => {
        window.removed = 0;
        new MutationObserver((ms) => { for (const m of ms) removed += m.removedNodes.length; }).observe(document.getElementById('view'), { childList: true, subtree: true });
        const text = document.querySelector('.next .qtext').firstChild;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 12);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        window.card = [...document.querySelectorAll('.scard')].find((c) => c.textContent.includes('payment webhooks'));
        card.focus();
        window.selected = getSelection().toString();
      })()`);
      await new Promise((r) => setTimeout(r, 600)); // three ticks
      store.mergeMetrics({ sessionId: "demo-pagos", contextPercent: 47 });
      await page.waitFor("window.card.textContent.includes('47%')");
      assert.deepEqual(
        await page.eval("({ same: card === [...document.querySelectorAll('.scard')].find((c) => c.textContent.includes('payment webhooks')), focused: document.activeElement === card, selection: getSelection().toString() === selected, removed })"),
        { same: true, focused: true, selection: true, removed: 0 },
      );
    });

    it("animates a question arriving on its row, inside its column, and a click meanwhile still lands", async () => {
      const page = await open();
      await page.send("Animation.enable");
      await page.send("Animation.setPlaybackRate", { playbackRate: 0.05 }); // the motion lasts seconds: the click falls inside it
      const asked = store.ask({ sessionId: "demo-pagos", kind: "question", text: "Arriving while you click?" });
      try {
        const row = "[...document.querySelectorAll('.qrow')].find((r) => r.textContent.includes('Arriving while you click?'))";
        await page.waitFor(`${row}?.getAnimations().some((a) => a.id === 'motion')`);
        assert.equal(await page.eval<boolean>("!!document.activeViewTransition"), false, "no picture of the page is taken");
        assert.equal(await page.eval<boolean>(`${row}.closest('.col-body') !== null`), true);
        assert.equal(await page.eval<boolean>("document.getElementById('needs-pill').getAnimations().some((a) => a.id === 'bump')"), true, "the pill bumps");
        await page.click(".scard", "checkout redesign");
        await page.waitFor("document.getElementById('session').open");
        await page.press("Escape");
      } finally {
        await page.send("Animation.setPlaybackRate", { playbackRate: 1 });
        store.dismiss(asked.id);
      }
    });

    it("shows an answer sent from the desk on its card, then brings the next question up in its place", async () => {
      store.upsertSession({ id: "resolving", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "resolving a question", state: "waiting" });
      const stop = store.listen("resolving");
      store.ask({ sessionId: "resolving", kind: "question", text: "Answered from the desk?", options: ["Yes", "No"] });
      try {
        const page = await open();
        await page.click(".qrow", "Answered from the desk?");
        await page.waitFor(`document.querySelector('.next textarea') && ${STILL}`);
        await page.eval("window.left = 0; new MutationObserver((ms) => { for (const m of ms) if (m.attributeName === 'data-leaving') left++; }).observe(document.getElementById('view'), { attributes: true, subtree: true })");
        await page.click(".next .opts button", "Yes");
        await page.waitFor("document.querySelector('.next.resolved')?.textContent.includes('Answered')");
        assert.match(await page.eval<string>("document.querySelector('.next.resolved .resolved-line').textContent"), /Answered\s*Yes/);
        await page.waitFor("!document.querySelector('.next.resolved') && !document.querySelector('[data-leaving]')", 5000);
        assert.ok((await page.eval<number>("left")) >= 1, "the answered card folded away");
        assert.doesNotMatch(await page.eval<string>("document.querySelector('.next').textContent"), /Answered from the desk/);
      } finally {
        stop();
      }
    });

    it("swaps the large card for a picked question: the old card folds away, never a row painted over the new one", async () => {
      const page = await open();
      await page.waitFor(STILL);
      // Frozen mid-way: the old question's row opens at a row's height below the new card, which nothing covers.
      const midway = (pick: string) =>
        page.eval<Record<string, boolean>>(`(() => {
          const old = document.querySelector('.next').dataset.flip;
          const ends = (a) => a.effect?.getComputedTiming().iterations !== Infinity;
          ${pick};
          for (const a of document.getAnimations().filter(ends)) (a.pause(), (a.currentTime = 140));
          const next = document.querySelector('.next:not([data-leaving])').getBoundingClientRect();
          const back = document.querySelector('.qrow[data-flip="' + old + '"]');
          const row = back.getBoundingClientRect();
          const hit = document.elementFromPoint(next.left + next.width / 2, next.top + 12);
          for (const a of document.getAnimations().filter(ends)) a.finish();
          return { rowSized: row.height <= back.getBoundingClientRect().height + 0.5, below: row.top >= next.bottom - 1, newOnTop: !!hit?.closest('.next:not([data-leaving])') };
        })()`);
      const clean = { rowSized: true, below: true, newOnTop: true };
      assert.deepEqual(await midway("document.querySelector('.qrow[data-flip]').click()"), clean, "picked with a click");
      assert.deepEqual(await midway("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }))"), clean, "picked with a key");
      assert.deepEqual(await midway("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))"), clean, "and back");
    });

    it("answered with Ctrl+Enter, the next question's box takes the next key once its card is up", async () => {
      store.upsertSession({ id: "keys", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "answering with the keys", state: "waiting" });
      store.ask({ sessionId: "keys", kind: "question", text: "Answered with the keys?", options: ["Yes", "No"] });
      // Every waiting session listens, so whichever question comes next has a box that takes text.
      const stops = [...new Set(store.openQuestions().map((q) => q.sessionId))].map((id) => store.listen(id));
      try {
        const page = await open();
        await page.click(".qrow", "Answered with the keys?");
        await page.waitFor(`document.querySelector('.next textarea:not([readonly])') && ${STILL}`);
        await page.click(".next textarea");
        await page.type("Yes, with the keys");
        for (const type of ["rawKeyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 2 });
        await page.waitFor("document.querySelector('.next.resolved')");
        await page.waitFor("!document.querySelector('.next.resolved') && document.activeElement?.matches('.next:not([data-leaving]) textarea')", 5000);
        await page.type("x");
        const box = "document.querySelector('.next:not([data-leaving]) textarea')";
        assert.equal(await page.eval<string>(`${box}.value`), "x", "the key landed in the next question's box");
        await page.eval(`(() => { const b = ${box}; b.value = ''; b.dispatchEvent(new Event('input', { bubbles: true })); })()`); // no draft left for the other tests
      } finally {
        for (const stop of stops) stop();
      }
    });

    it("chimes for a new question once a click unlocked the sound, which sleeps between chimes", async () => {
      const page = await browser.newPage(1400, 900);
      pages.push(page);
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: "window.contexts = []; window.notes = 0; const A = AudioContext; window.AudioContext = class extends A { constructor() { super(); contexts.push(this); } createOscillator() { notes++; return super.createOscillator(); } };",
      });
      await page.goto(base + "/");
      await page.waitFor("document.querySelector('.next')");
      const sound = "contexts[0]";
      await page.click(".col-head");
      await page.waitFor(`contexts.length === 1 && ${sound}.state === 'suspended'`); // made running by the click, then asleep
      await page.click(".col-head");
      const before = await page.eval<number>(`${sound}.currentTime`);
      const asked = store.ask({ sessionId: "demo-pagos", kind: "question", text: "Does the chime sound?" });
      try {
        await page.waitFor(`notes === 2 && ${sound}.state === 'running'`, 5000);
        await page.waitFor(`${sound}.state === 'suspended'`, 5000);
        assert.equal(await page.eval<number>("contexts.length"), 1, "one context for the page");
        assert.ok((await page.eval<number>(`${sound}.currentTime`)) > before + 0.3, "it played the two notes, then went back to sleep");
      } finally {
        store.dismiss(asked.id);
      }
    });

    it("slides a toast up when another arrives below it", async () => {
      for (const n of [1, 2]) store.upsertSession({ id: `toasting-${n}`, provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: `toast ${n}`, state: "working" });
      const finish = (n: number) => store.updateSession(`toasting-${n}`, (s) => ({ ...s, state: "waiting", lastMessage: { text: `Finished ${n}.`, at: new Date().toISOString() } }));
      const page = await open();
      finish(1);
      await page.waitFor(`document.querySelectorAll('.toast').length === 1 && ${STILL}`);
      await page.eval("window.tops = []; (function f() { const t = document.querySelector('.toast'); if (t) tops.push(Math.round(t.getBoundingClientRect().top)); if (tops.length < 120) requestAnimationFrame(f); })()");
      finish(2);
      try {
        await page.waitFor(`document.querySelectorAll('.toast').length === 2 && ${STILL}`);
        const tops = await page.eval<number[]>("tops");
        const start = tops[0] ?? 0;
        const end = tops.at(-1) ?? 0;
        assert.ok(end < start - 20, `the first toast went up: ${start} → ${end}`);
        assert.ok(new Set(tops.filter((t) => t < start && t > end)).size >= 2, `through the places between: ${tops.join(" ")}`);
      } finally {
        for (const n of [1, 2]) store.updateSession(`toasting-${n}`, (s) => ({ ...s, state: "ended" }));
      }
    });

    it("slides the context bar to its new width, and keeps a control's confirmation through a redraw", async () => {
      // This test's own process stands for the session's: the End button is clicked once only, so it never ends it.
      const own = procInfo(process.pid);
      assert.ok(own?.start);
      store.upsertSession({ id: "confirming", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "confirming a control", process: { pid: process.pid, start: own.start, ancestors: [] } });
      store.mergeMetrics({ sessionId: "confirming", contextPercent: 30 });
      try {
        const page = await open();
        await page.click(".scard", "confirming a control");
        await page.waitFor("document.querySelector('#session .mini i')");
        await page.eval("window.bar = document.querySelector('#session .mini i')");
        store.mergeMetrics({ sessionId: "confirming", contextPercent: 85 });
        await page.waitFor("document.querySelector('#session .mini.warn')");
        assert.equal(await page.eval<boolean>("bar === document.querySelector('#session .mini i')"), true, "the same bar");
        assert.equal(await page.eval<boolean>("bar.getAnimations().some((a) => a.transitionProperty === 'width')"), true, "its width slides");
        await page.click("#session .pchips .chip", "More");
        await page.click("#session .danger");
        const armed = await page.eval<string>("document.querySelector('#session .danger').innerText");
        assert.notEqual(armed, "End session", "the first click asks for a second");
        store.mergeMetrics({ sessionId: "confirming", contextPercent: 60 });
        await page.waitFor("!document.querySelector('#session .mini.warn')");
        assert.equal(await page.eval<string>("document.querySelector('#session .danger').innerText"), armed, "still asking after the redraw");
        await page.press("Escape");
      } finally {
        store.updateSession("confirming", (s) => ({ ...s, state: "ended" }));
      }
    });

    it("shows placeholders while the first data arrives, not an all-clear", async () => {
      const page = await browser.newPage(1400, 900);
      pages.push(page);
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "const f = window.fetch; window.fetch = (u, i) => String(u) === '/api/state' && !window.go ? new Promise((r) => (window.release = () => r(f(u, i)))) : f(u, i);" });
      await page.goto(base + "/");
      await page.waitFor("window.release && document.querySelector('.board[aria-busy]')");
      assert.deepEqual(
        await page.eval("({ pill: document.getElementById('needs-pill').textContent, loading: document.getElementById('needs-pill').classList.contains('loading'), strip: document.getElementById('strip').textContent })"),
        { pill: "", loading: true, strip: "" },
      );
      await page.eval("(window.go = true, release())");
      await page.waitFor("document.querySelector('.next')");
      assert.match(await page.eval<string>("document.getElementById('needs-pill').textContent"), /need/);
    });

    it("opens a session's panel on its latest message while the conversation is on its way", async () => {
      const page = await open();
      await page.eval("const f = window.fetch; window.fetch = (u, i) => String(u).endsWith('/messages') ? new Promise((r) => (window.release = () => r(f(u, i)))) : f(u, i)");
      await page.click(".scard", "payment webhooks");
      await page.waitFor("window.release && document.getElementById('session').open");
      assert.equal(await page.eval<number>("document.querySelectorAll('#session .skel-msg').length"), 2, "the shape of what came before");
      assert.match(await page.eval<string>("document.querySelector('#session .msg').textContent"), /Both agents stopped/, "its latest message, already known");
      await page.eval("release()");
      await page.waitFor("!document.querySelector('#session .skel-msg')");
      await page.press("Escape");
    });

    it("resizes the columns from the keyboard on the line between them", async () => {
      const page = await open();
      const width = () => page.eval<number>("document.querySelector('.col-sessions').getBoundingClientRect().width");
      assert.equal(await page.eval<string>("document.querySelector('.split').getAttribute('role')"), "separator");
      const before = await width();
      await page.eval("document.querySelector('.split').focus()");
      await page.press("ArrowLeft");
      assert.equal(await width(), before + 16);
      await page.eval("document.querySelector('.split').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
      assert.equal(await width(), before);
    });
  });

  /** A result opened by its link, which leaves it unseen for the other tests. */
  async function openResultOf(page: Page, title: string): Promise<void> {
    const r = store.listResults().find((x) => x.title === title);
    assert.ok(r, `the demo has a result "${title}"`);
    await page.eval(`location.hash = "#r=${r.id}"`);
    await page.waitFor(arrived("result"));
  }
  /** A phone with a touch screen. */
  async function openPhone(): Promise<Page> {
    const page = await open(390, 844);
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    return page;
  }
  const touch = (page: Page, type: string, points: [number, number][]) =>
    page.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });

  it("opens and closes a header menu from its button or Escape, keeping the focus on each choice", async () => {
    const page = await open();
    await page.click("#theme");
    assert.equal(await page.eval<string>("document.getElementById('theme').getAttribute('aria-expanded')"), "true", "the button shows its menu open");
    await page.eval("document.querySelector('#display-menu button[data-value=dark]').focus()");
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await page.waitFor("document.documentElement.dataset.theme === 'dark'");
    assert.equal(await page.eval<string>("document.activeElement.dataset.value"), "dark", "the focus stays on the choice made");
    assert.equal(await page.eval<string>("document.querySelector('#display-menu button[data-value=dark]').getAttribute('aria-pressed')"), "true");
    await page.press("Escape");
    await page.waitFor("document.getElementById('display-menu').hidden && getComputedStyle(document.getElementById('display-menu')).display === 'none'");
    assert.equal(await page.eval<string>("document.activeElement.id"), "theme", "Escape gives the focus back to the button");
    assert.equal(await page.eval<string>("document.getElementById('theme').getAttribute('aria-expanded')"), "false");

    await page.click("#alerts");
    await page.eval("document.querySelectorAll('#alerts-menu input')[2].focus()");
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    await page.waitFor("localStorage.getItem('agent-desk:failures') === 'on'");
    assert.equal(await page.eval<boolean>("document.activeElement === document.querySelectorAll('#alerts-menu input')[2] && document.activeElement.checked"), true, "a switch keeps the focus");
    await page.click(".col-head", "Needs you");
    await page.waitFor("document.getElementById('alerts-menu').hidden");
    await page.eval("localStorage.clear()");
  });

  it("switches the theme in one frame, its native controls and accent included", async () => {
    const page = await open();
    const scheme = "getComputedStyle(document.documentElement).colorScheme";
    assert.equal(await page.eval<string>(scheme), "light");
    assert.equal(await page.eval<string>("getComputedStyle(document.querySelector('#alerts-menu')).accentColor"), "rgb(81, 70, 220)", "checkboxes take the desk's accent");
    await page.click("#theme");
    await page.waitFor(STILL);
    await page.click("#display-menu button", "Dark");
    assert.deepEqual(await page.eval<string[]>("document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.transitionProperty)"), [], "no control fades on its own from the old colours");
    assert.equal(await page.eval<string>(scheme), "dark", "scrollbars and checkboxes follow the theme chosen, not the system's");
    await page.eval("localStorage.clear()");
  });

  it("keeps a dialog open when text selected in it is released over the backdrop", async () => {
    const page = await open();
    await page.click(".scard", "checkout redesign");
    await page.waitFor(`${arrived("session")} && document.querySelector('#session .msg.from-session')`);
    const [x, y] = await page.eval<[number, number]>("(() => { const r = document.querySelector('#session .msg.from-session').getBoundingClientRect(); return [r.x + 5, r.y + 8]; })()");
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    for (let at = x; at > 20; at -= 40) await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at, y: y + 20, button: "left", buttons: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 20, y: y + 20, button: "left", clickCount: 1 });
    assert.ok((await page.eval<string>("String(getSelection())")).length > 0, "the text is selected");
    assert.deepEqual(await openDialogs(page), ["session"], "the selection does not close the panel");
    for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: 20, y: y + 20, button: "left", clickCount: 1 });
    await page.waitFor("!document.getElementById('session').open");
  });

  it("zooms either side of a before and after, and moves its divider by a drag on the picture or its handle", async () => {
    const page = await open();
    await openResultOf(page, "Checkout: before and after");
    const box = await page.eval<{ x: number; y: number; w: number; h: number }>("(() => { const r = document.querySelector('#result .compare').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()");
    const y = box.y + box.h * 0.75;
    const divider = "Number(document.querySelector('#result .compare .handle').getAttribute('aria-valuenow'))";
    for (const [at, side] of [[0.8, "After"], [0.2, "Before"]] as const) {
      const x = box.x + box.w * at;
      for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      await page.waitFor("document.getElementById('zoom').open");
      assert.match(await page.eval<string>("document.querySelector('#zoom .zcaption').textContent"), new RegExp(`· ${side}$`), `a click on the ${side} side zooms it`);
      await page.press("Escape");
      await page.waitFor("!document.getElementById('zoom').open");
    }
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x + box.w * 0.5, y, button: "left", clickCount: 1 });
    for (let i = 10; i >= 5; i--) await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + (box.w * i) / 20, y, button: "left", buttons: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + box.w * 0.25, y, button: "left", clickCount: 1 });
    assert.ok(Math.abs((await page.eval<number>(divider)) - 25) <= 2, "a drag on the picture moves the divider");
    assert.equal(await page.eval<boolean>("document.getElementById('zoom').open"), false, "and does not zoom");
    await page.eval("document.querySelector('#result .compare .handle').focus()");
    await page.press("ArrowRight");
    assert.ok(Math.abs((await page.eval<number>(divider)) - 27) <= 2, "the handle moves with the arrow keys");
    await page.press("Escape");
    await page.waitFor("!document.getElementById('result').open");
  });

  it("opens a small picture at its own size, zooms in on a double click and slides to the next one", async () => {
    const page = await open();
    await openResultOf(page, "Three pay button variants");
    await page.click("#result .vimgs img");
    await page.waitFor(`${arrived("zoom")} && document.querySelector('#zoom img.cur').complete`);
    const pct = "document.querySelector('#zoom .zbar .num.zfine').textContent";
    await page.waitFor(`${pct} === "100 %"`);
    const cur = "document.querySelector('#zoom img.cur')";
    const centre = await page.eval<[number, number]>(`(() => { const r = ${cur}.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    for (let i = 0; i < 2; i++) for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: centre[0], y: centre[1], button: "left", clickCount: 1 });
    await page.waitFor(`${pct} === "250 %"`);
    await page.press("ArrowRight");
    await page.waitFor("document.querySelector('#zoom .zcount').textContent === '2 / 3'");
    await page.waitFor(`${pct} === "100 %" && ${cur}.getBoundingClientRect().x > 0`);
    assert.match(await page.eval<string>(`${cur}.alt`), / · B$/, "the next picture is the one shown");
    await page.press("Escape");
    await page.press("Escape");
    await page.waitFor("!document.querySelector('dialog[open]')");
  });

  it("on a phone, pinching a picture out of its fit size springs it back", async () => {
    const page = await openPhone();
    await openResultOf(page, "Checkout: before and after");
    await page.eval("document.querySelector('#result .seg button:last-child').click()");
    await page.eval("document.querySelector('#result .vimgs img').click()");
    await page.waitFor(`${arrived("zoom")} && document.querySelector('#zoom img.cur').complete`);
    const width = "Math.round(document.querySelector('#zoom img.cur').getBoundingClientRect().width)";
    const fit = await page.eval<number>(width);
    assert.ok(fit <= 390, "it opens inside the screen");
    await touch(page, "touchStart", [[95, 420], [295, 420]]);
    for (let s = 100; s >= 20; s -= 20) await touch(page, "touchMove", [[195 - s, 420], [195 + s, 420]]);
    assert.ok((await page.eval<number>(width)) < fit, "the fingers shrink it");
    await touch(page, "touchEnd", []);
    await page.waitFor(`${width} === ${fit}`);
    await page.press("Escape");
    await page.press("Escape");
  });

  it("on a phone, slides a session in from the right, opaque, and takes it back with a swipe from the left edge", async () => {
    const page = await openPhone();
    await page.click(".tabbar button", "Sessions");
    await page.eval(`(() => {
      window.frames = [];
      const d = document.getElementById("session");
      const tick = () => { frames.push([d.getBoundingClientRect().x, Number(getComputedStyle(d).opacity)]); if (frames.length < 30) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      [...document.querySelectorAll(".scard")].find((c) => c.textContent.includes("checkout redesign")).click();
    })()`);
    await page.waitFor(`${arrived("session")} && window.frames.length >= 30`);
    const frames = await page.eval<[number, number][]>("window.frames");
    assert.ok(frames.some(([x]) => x > 50), "it moves in from the side");
    assert.ok(frames.every(([, o]) => o === 1), "never see-through over the list");
    await touch(page, "touchStart", [[6, 500]]);
    for (let x = 6; x <= 70; x += 16) await touch(page, "touchMove", [[x, 502]]);
    assert.ok((await page.eval<number>("document.getElementById('session').getBoundingClientRect().x")) > 30, "it follows the finger");
    await touch(page, "touchEnd", []);
    await page.waitFor(`${arrived("session")} && document.getElementById('session').getBoundingClientRect().x === 0`);
    await touch(page, "touchStart", [[6, 500]]);
    for (let x = 6; x <= 246; x += 30) await touch(page, "touchMove", [[x, 502]]);
    await touch(page, "touchEnd", []);
    await page.waitFor("!document.getElementById('session').open");
  });

  it("keeps a session's and a result's window whole while it slides or fades out", async () => {
    /** Closes a window and measures it in the first frame of its way out: its body as wide as it is, under its head. */
    const closing = (page: Page, id: string) =>
      page.eval<Record<string, boolean>>(`(async () => {
        const d = document.getElementById('${id}');
        d.close();
        await new Promise(requestAnimationFrame);
        // Layout sizes, which its transform on the way out does not scale.
        const [head, body] = [d.querySelector('.dhead'), d.querySelector('.dbody')];
        return { leaving: getComputedStyle(d).display !== 'none', bodyFull: Math.abs(body.offsetWidth - d.clientWidth) <= 1, bodyUnderHead: body.offsetTop >= head.offsetTop + head.offsetHeight - 1, headOnTop: head.offsetTop <= 1 };
      })()`);
    const whole = { leaving: true, bodyFull: true, bodyUnderHead: true, headOnTop: true };
    for (const [width, height] of [[1400, 900], [390, 844]] as const) {
      const page = await open(width, height);
      if (width < 700) await page.click(".tabbar button", "Sessions");
      await page.click(".scard", "checkout redesign");
      await page.waitFor(arrived("session"));
      assert.deepEqual(await closing(page, "session"), whole, `the session's window at ${width} px`);
      await page.waitFor(`!document.querySelector('dialog[open]') && ${STILL}`);
      await openResultOf(page, "Checkout: before and after");
      assert.deepEqual(await closing(page, "result"), whole, `the result's window at ${width} px`);
      await page.waitFor("!document.querySelector('dialog[open]')");
    }
  });

  it("on a phone, shows no header search before the desk's first data", async () => {
    const page = await browser.newPage(390, 844);
    pages.push(page);
    // The first state waits for the test, as over a slow network.
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const realFetch = window.fetch;
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        window.releaseState = () => release();
        window.fetch = (url, init) => String(url) === "/api/state" ? gate.then(() => realFetch(url, init)) : realFetch(url, init);
      })()`,
    });
    await page.goto(base + "/");
    await page.waitFor("document.querySelector('.board[aria-busy]')");
    assert.equal(await page.eval<string>("getComputedStyle(document.querySelector('header .search')).display"), "none", "nothing to search yet, and the projects' place stays free");
    await page.eval("releaseState()");
    await page.waitFor("document.querySelector('.next') && !document.getElementById('projects').hidden");
    assert.equal(await page.eval<string>("getComputedStyle(document.querySelector('header .search')).display"), "none", "the projects take the row");
  });

  it("keeps a result's window and the button under the pointer still when its comparison changes mode", async () => {
    const page = await open(1400, 900);
    await openResultOf(page, "Checkout: before and after");
    await page.waitFor("[...document.querySelectorAll('#result img')].every((i) => i.complete)");
    const place = () => page.eval<number[]>("[document.getElementById('result'), document.querySelector('#result .seg')].map((el) => Math.round(el.getBoundingClientRect().top))");
    const height = () => page.eval<number>("Math.round(document.getElementById('result').getBoundingClientRect().height)");
    const first = await place();
    const tall = await height();
    for (const mode of ["Side by side", "Slider"]) {
      await page.click("#result .seg button", mode);
      await page.waitFor(`document.querySelector('#result .seg button[aria-pressed=true]')?.textContent.includes(${JSON.stringify(mode)}) && [...document.querySelectorAll('#result img')].every((i) => i.complete)`);
      if (mode === "Side by side") assert.notEqual(await height(), tall, "the comparison changes the window's height");
      assert.deepEqual(await place(), first, `in ${mode}, the window's top and its buttons stay where they were`);
    }
    await page.press("Escape");
  });

  it("on a phone, each tab keeps its scroll, and a tap on the tab shown goes back to its top", async () => {
    const page = await open(390, 600);
    await page.click(".tabbar button", "Sessions");
    const room = await page.eval<number>("document.documentElement.scrollHeight - innerHeight");
    assert.ok(room > 120, `the sessions scroll (${room} px)`);
    await page.eval("window.scrollTo(0, 120)");
    await page.eval(`[...document.querySelectorAll(".tabbar button")].find((b) => b.textContent.includes("Needs you")).click()`);
    await page.eval(`[...document.querySelectorAll(".tabbar button")].find((b) => b.textContent.includes("Sessions")).click()`);
    assert.equal(await page.eval<number>("Math.round(scrollY)"), 120, "back on Sessions, where it was left");
    await page.eval(`[...document.querySelectorAll(".tabbar button")].find((b) => b.textContent.includes("Sessions")).click()`);
    await page.waitFor("scrollY === 0");
  });

  it("shows keyboard focus on a session card and the search box, and no grey flash on a tap", async () => {
    const page = await open();
    await page.eval("document.querySelector('.scard').focus({ focusVisible: true })");
    assert.equal(await page.eval<string>("getComputedStyle(document.querySelector('.scard')).outlineOffset"), "-2px", "a ring inside the card, which the list's rounded box would clip");
    await page.eval("document.getElementById('q').focus()");
    assert.notEqual(await page.eval<string>("getComputedStyle(document.querySelector('header .search')).boxShadow"), "none", "the search box shows it has the focus");
    assert.equal(await page.eval<string>("getComputedStyle(document.querySelector('.scard')).webkitTapHighlightColor"), "rgba(0, 0, 0, 0)");
  });

  describe("on a desktop window", () => {
    const LONG = "The current session cookies are stored in Redis with a 30 day expiry, and the refresh logic lives in three different services that each re-implement the same validation; moving to short-lived JWT means we need a token service with rotation and a revocation list so that a user can revoke a single device from the account page. Which storage should the token service use for the revocation list, Postgres or Redis?";
    let long: string;
    before(() => {
      store.upsertSession({ id: "far-project", provider: "Test", project: { name: "customer-portal-monorepo-infrastructure", dir: "/home/demo/Projects/customer-portal-monorepo-infrastructure" }, title: "Migrate the authentication flow from session cookies to short-lived JWT access tokens", state: "waiting" });
      long = store.ask({ sessionId: "far-project", kind: "question", text: LONG, options: ["Postgres, with a nightly cleanup job", "Redis, with the same TTL as the refresh token"] }).id;
    });
    after(() => {
      store.dismiss(long);
      store.updateSession("far-project", (s) => ({ ...s, state: "ended" }));
    });
    const rect = (sel: string) => `JSON.parse(JSON.stringify(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect()))`;

    it("keeps every header control on screen with three projects, from 900 to 1450 px", async () => {
      const page = await open(1024, 768);
      await page.waitFor("document.querySelectorAll('#projects button').length === 4");
      for (const width of [900, 1024, 1180, 1280, 1450]) {
        await page.resize(width, 768);
        const m = await page.eval<{ over: number; right: number; search: number; pill: boolean }>(`(() => {
          const hd = document.querySelector('header.top'), pill = document.getElementById('needs-pill');
          return { over: hd.scrollWidth - hd.clientWidth, right: document.getElementById('theme').getBoundingClientRect().right, search: document.querySelector('header .search').getBoundingClientRect().width, pill: pill.scrollWidth <= pill.clientWidth };
        })()`);
        assert.equal(m.over, 0, `the header does not overflow at ${width} px`);
        assert.ok(m.right <= width, `Display stays on screen at ${width} px`);
        assert.ok(m.search >= 150, `the search keeps a usable width at ${width} px (${m.search})`);
        assert.ok(m.pill, `the needs pill is whole at ${width} px`);
        if (width === 1024) assert.ok(await page.eval<boolean>("document.getElementById('projects').scrollWidth > document.getElementById('projects').clientWidth"), "the projects scroll instead");
      }
    });

    it("keeps the header's controls in place when a view or project is picked", async () => {
      const page = await open(1440, 900);
      const at = () => page.eval<number[]>("['#alerts', '#needs-pill', '#projects button:last-child'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().right))");
      const before = await at();
      await page.click("#projects button", "invoices-api");
      await page.click("#views button", "History");
      await page.waitFor("document.querySelector('.wrap')");
      const [alerts, , lastProject] = await at();
      assert.deepEqual([alerts, lastProject], [before[0], before[2]], "nothing moves sideways");
      assert.equal(Math.round(await page.eval<number>(`${rect("#needs-pill")}.right`)), before[1], "the needs pill stays where it was");
      await page.click("#views button", "Desk");
      await page.click("#projects button", "All");
    });

    it("cuts a long session name before the age in the large card", async () => {
      const page = await open(1024, 768);
      await page.click(".qrow", "token service");
      await page.waitFor("document.querySelector('.next')?.textContent.includes('Postgres or Redis?')");
      const m = await page.eval<{ where: number; age: number; card: number }>(`(() => {
        const meta = document.querySelector('.next .meta');
        return { where: meta.querySelector('.where').getBoundingClientRect().right, age: meta.querySelector('.age').getBoundingClientRect().left, card: document.querySelector('.next').getBoundingClientRect().right };
      })()`);
      assert.ok(m.where <= m.age, "the session's name ends before the age");
      assert.ok(m.age < m.card, "the age stays inside the card");
    });

    it("shows a long question whole in its session's panel", async () => {
      const page = await open(1280, 800);
      await page.click(".scard", "Migrate the authentication");
      await page.waitFor(arrived("session"));
      assert.match(await page.eval<string>("document.querySelector('#session .panel-question').textContent"), /Postgres or Redis\?/);
      await page.press("Escape");
    });

    it("lines up the inbox rows' times whatever the kind of row", async () => {
      const page = await open(1280, 800);
      const rows = await page.eval<{ time: number; text: number }[]>("[...document.querySelectorAll('.qrow')].map((r) => ({ time: Math.round(r.querySelector('.qwhen').getBoundingClientRect().right), text: Math.round(r.querySelector('.qbody').getBoundingClientRect().left) }))");
      assert.ok(rows.length >= 3, "questions and a failure in the list");
      assert.equal(new Set(rows.map((r) => r.time)).size, 1, `one column of times: ${JSON.stringify(rows)}`);
      assert.equal(new Set(rows.map((r) => r.text)).size, 1, "one left edge for the text");
    });

    it("grows the right column with the window, keeps a dragged width, and caps the inbox", async () => {
      const page = await open(1920, 1080);
      const side = () => page.eval<number>(`Math.round(${rect(".col-sessions")}.width)`);
      assert.equal(await side(), 560, "a wide window gives the sessions more room");
      assert.ok((await page.eval<number>(`${rect(".next")}.width`)) <= 880, "the inbox keeps a reading width");
      await page.resize(1280, 800);
      assert.equal(await side(), 384);
      await page.eval("document.querySelector('.split').focus()");
      await page.press("ArrowLeft");
      assert.equal(await side(), 400, "the splitter still sets the width");
      await page.resize(1920, 1080);
      assert.equal(await side(), 400, "and a set width stays set");
      await page.eval("document.querySelector('.split').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
      assert.equal(await side(), 560, "a double click goes back to the window's width");
    });

    it("fades a list where its scroll area cuts it, and only there", async () => {
      const page = await open(1280, 600);
      const cut = () => page.eval<string | null>("document.querySelector('.col-sessions .col-body').dataset.cut ?? null");
      assert.equal(await cut(), "end", "cut at the bottom only");
      await page.eval("(() => { const b = document.querySelector('.col-sessions .col-body'); b.scrollTop = b.scrollHeight; })()");
      await page.waitFor("document.querySelector('.col-sessions .col-body').dataset.cut === 'start'");
      assert.notEqual(await page.eval<string>("getComputedStyle(document.querySelector('.col-sessions .col-body')).maskImage"), "none");
    });
  });

  it("on a phone, sets the tab bar on the bottom edge, over the home indicator, and the credit in the display menu", async () => {
    const page = await open(390, 844);
    await page.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
    const bar = "document.querySelector('.tabbar')";
    await page.waitFor(`getComputedStyle(${bar}).paddingBottom === "34px"`);
    assert.equal(await page.eval<number>(`Math.round(${bar}.getBoundingClientRect().bottom)`), 844, "the tab bar reaches the bottom edge");
    assert.equal(await page.eval<number>("document.querySelector('.credits').getClientRects().length"), 0, "no credits band under it");
    assert.equal(await page.eval<number>("document.getElementById('needs-pill').getClientRects().length"), 0, "the Inbox tab counts the questions, not a header pill");
    await page.click("#theme");
    const link = "document.querySelector('#display-menu .menu-credit a')";
    await page.waitFor(`${link}?.getClientRects().length && ${STILL}`); // measured once the menu has opened
    assert.equal(await page.eval<string>(`${link}.href`), "https://github.com/jesusizq");
    assert.match(await page.eval<string>(`${link}.textContent`), /© 2026 Jesús Izquierdo/);
    assert.ok((await page.eval<number>(`${link}.getBoundingClientRect().height`)) >= 44, "a finger's target");
    await page.press("Escape");
  });

  it("keeps the credit in the footer beside the columns, not in the display menu", async () => {
    const page = await open();
    assert.equal(await page.eval<number>("document.querySelector('.credits a').getClientRects().length"), 1);
    await page.click("#theme");
    await page.waitFor("!document.getElementById('display-menu').hidden");
    assert.equal(await page.eval<number>("document.querySelector('#display-menu .menu-credit').getClientRects().length"), 0);
    await page.press("Escape");
  });

  it("on a portrait phone, puts the projects on the first header row when they fit there whole", async () => {
    const page = await open(520, 900);
    const up = "(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const p = document.getElementById('projects'); return r('#projects').top < r('#theme').bottom && p.scrollWidth <= p.clientWidth; })()";
    await page.waitFor(up);
    await page.resize(390, 844);
    await page.waitFor(`!${up}`);
    assert.ok(await page.eval<boolean>("document.getElementById('projects').getBoundingClientRect().top >= document.getElementById('theme').getBoundingClientRect().bottom"), "too wide: a row of their own");
  });

  it("on a phone, keeps a table's words whole", async () => {
    const page = await open(390, 844);
    const split = await page.eval<string[]>(`(() => {
      const md = document.createElement('div');
      md.className = 'md';
      md.innerHTML = '<div class="md-table"><table><tr><th>Agente</th><th>Qué hace</th><th>Toca</th></tr>'
        + '<tr><td>feat:calm-arrivals</td><td>Globo de pregunta nueva, una marca en la burbuja al enviar, imágenes una debajo de otra en el móvil</td><td>la página</td></tr>'
        + '<tr><td>fix:agent-lifecycle</td><td>Que los agentes de workflow tomen su nombre real y no se queden trabajando para siempre</td><td>el adaptador</td></tr></table></div>';
      document.getElementById('view').prepend(md);
      const split = [];
      for (const cell of md.querySelectorAll('th, td')) {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          for (const m of n.data.matchAll(/[^\\s:-]+/g)) {
            const r = document.createRange();
            r.setStart(n, m.index);
            r.setEnd(n, m.index + m[0].length);
            if (new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size > 1) split.push(m[0]);
          }
        }
      }
      md.remove();
      return split;
    })()`);
    assert.deepEqual(split, [], "no word is split across lines");
  });

  /** A phone held by a finger, the checkout session's panel open on its latest message. */
  async function touchPanel(): Promise<Page> {
    const page = await open(390, 640);
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });
    await page.click(".tabbar button", "Sessions");
    await page.click(".scard", "checkout redesign");
    await page.waitFor(`document.querySelector('#session .pchips button.chip') && document.querySelector('#session .session-body').scrollTop > 0 && ${STILL}`);
    return page;
  }

  it("on a touch phone, keeps the session panel's chips one height, each button a finger's reach", async () => {
    const page = await touchPanel();
    const heights = await page.eval<number[]>("[...document.querySelectorAll('#session .pchips > .chip')].map((c) => Math.round(c.getBoundingClientRect().height))");
    assert.equal(new Set(heights).size, 1, `one height: ${heights}`);
    // The chips scroll sideways: the first button may start past the screen's edge, behind the metrics.
    await page.eval("document.querySelector('#session .pchips button.chip').scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })");
    assert.ok(
      await page.eval<boolean>("(() => { const b = document.querySelector('#session .pchips button.chip'); const r = b.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.top - 5)?.closest('button.chip') === b; })()"),
      "a button chip still takes a tap just outside its pill",
    );
    await page.press("Escape");
  });

  it("on a phone, shows a session's failed agents first among its chips, in view without scrolling", async () => {
    const page = await touchPanel();
    const [first, right, edge] = await page.eval<[string, number, number]>(`(() => {
      const chip = document.querySelector('#session .pchips > .chip');
      return [chip.textContent, chip.getBoundingClientRect().right, document.querySelector('#session .pchips').getBoundingClientRect().right];
    })()`);
    assert.match(first, /failed/);
    assert.ok(right <= edge, `the failed agents chip ends inside the row: ${right} <= ${edge}`);
    await page.press("Escape");
  });

  it("on a touch phone, opens a part of the session panel from its top, right under the way back", async () => {
    const page = await touchPanel();
    await page.click("#session .pchips button.chip", "agents");
    await page.waitFor("document.querySelector('#session .ppart .alist')");
    const [above, below] = await page.eval<[number, number]>(`(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#session .ppart .back'));
      const back = range.getBoundingClientRect();
      const first = Math.min(...[...document.querySelectorAll('#session .ppart > .rsec')].map((s) => s.getBoundingClientRect().top));
      return [back.top - document.querySelector('#session .pchips').getBoundingClientRect().bottom, first - back.bottom];
    })()`);
    assert.ok(above > 0, `the way back is in view, under the chips: ${above}`);
    assert.ok(Math.abs(above - below) <= 4, `as much room under the way back as above it: ${above} above, ${below} below`);
    await page.press("Escape");
  });

  describe("answering what a session asks", () => {
    /** A session waiting on the desk, its answers taken from its inbox; ended afterwards. */
    function asking(id: string, title: string) {
      store.upsertSession({ id, provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title, state: "waiting" });
      const stop = store.listen(id);
      return () => {
        stop();
        for (const q of store.openQuestions(id)) store.dismiss(q.id);
        store.updateSession(id, (s) => ({ ...s, state: "ended" }));
      };
    }
    const answers = async (id: string, n: number) => {
      const end = Date.now() + 5000;
      const got: string[] = [];
      while (got.length < n && Date.now() < end) {
        got.push(...store.takeInbox(id).map((e) => e.answer));
        await new Promise((r) => setTimeout(r, 50));
      }
      return got;
    };

    it("ticks each option of a question that takes several on and off, in their order", async () => {
      const done = asking("picking", "picking sections");
      try {
        store.ask({ sessionId: "picking", kind: "question", text: "Which sections go in the index?", options: ["Guides", "API reference", "Changelog"], several: true, dialog: true });
        const page = await open();
        await page.click(".qrow", "Which sections go in the index?");
        await page.waitFor("document.querySelector('.next')?.textContent.includes('Which sections go in the index?')");
        await page.waitFor("!document.querySelector('.next').getAnimations({ subtree: true }).length");
        assert.match(await page.eval<string>("document.querySelector('.next .opts-note').textContent"), /Pick one or more/);
        const box = "document.querySelector('.next textarea').value";
        const pressed = "[...document.querySelectorAll('.next .opts button[aria-pressed=\"true\"]')].map((b) => b.textContent.replace(/^\\d/, ''))";
        await page.click(".next .opts button", "Changelog");
        await page.click(".next .opts button", "Guides");
        assert.equal(await page.eval<string>(box), "Guides, Changelog", "picked in the options' order, not the clicks'");
        assert.deepEqual(await page.eval<string[]>(pressed), ["Guides", "Changelog"]);
        await page.click(".next .opts button", "Guides");
        assert.equal(await page.eval<string>(box), "Changelog", "a second click takes it out");
        await page.click(".next .opts button", "API reference");
        await page.click(".next .send");
        assert.deepEqual(await answers("picking", 1), ["API reference, Changelog"]);
      } finally {
        done();
      }
    });

    it("allows a permission prompt with one click, and denies it with the reason written, if any", async () => {
      const done = asking("permitting", "permission prompts");
      try {
        const prompt = (text: string) => store.ask({ sessionId: "permitting", kind: "permission", text, options: ["Allow", "Deny"] });
        prompt("Bash: rm -rf build");
        const page = await open();
        await page.click(".qrow", "Bash: rm -rf build");
        await page.waitFor("document.querySelector('.next')?.textContent.includes('rm -rf build') && !document.querySelector('.next').getAnimations({ subtree: true }).length");
        assert.equal(await page.eval<boolean>("!!document.querySelector('.next .opts')"), false, "no options to pick: two buttons that decide");
        assert.equal(await page.eval<string>("document.querySelector('.next textarea').placeholder"), "Reason for denying (optional)");
        assert.equal(await page.eval<boolean>("document.querySelector('.next .send-hint').textContent.includes('exactly as written')"), false);
        await page.click(".next .allow");
        await page.waitFor("document.querySelector('.next.resolved .resolved-line')?.textContent.includes('Allowed')");
        assert.equal(await page.eval<number>("document.querySelectorAll('.toast').length"), 0, "the card says it, no toast");
        assert.deepEqual(await answers("permitting", 1), ["Allow"]);

        prompt("Bash: make deploy");
        const row = "[...document.querySelectorAll('.qrow')].find((r) => r.textContent.includes('make deploy'))";
        await page.waitFor(row);
        assert.equal(await page.eval<string>(`${row}.querySelector('.qs').textContent`), "web-shop › permission prompts", "a permission row counts no options");
        await page.click(".qrow", "make deploy");
        await page.waitFor("document.querySelector('.next')?.textContent.includes('make deploy') && !document.querySelector('.next').getAnimations({ subtree: true }).length");
        await page.click(".next textarea");
        await page.type("not on main");
        await page.click(".next .deny");
        assert.deepEqual(await answers("permitting", 1), ["not on main"], "the reason goes with Deny, as written");

        prompt("Bash: npm publish");
        await page.click(".qrow", "npm publish");
        await page.waitFor("document.querySelector('.next')?.textContent.includes('npm publish') && !document.querySelector('.next').getAnimations({ subtree: true }).length");
        await page.click(".next textarea");
        await page.type("Allow");
        await page.click(".next .deny");
        assert.deepEqual(await answers("permitting", 1), ["Deny"], "a reason that reads as the allowing answer never allows");
      } finally {
        done();
      }
    });

    it("shows questions asked together as one item that says the terminal waits for all of them", async () => {
      const done = asking("grouped", "questions asked together");
      try {
        const group = (index: number) => ({ id: "dialog-grouped", index, size: 2 });
        store.ask({ sessionId: "grouped", kind: "question", dialog: true, group: group(0), text: "Which engine should search use?", options: ["Pagefind", "Lunr"] });
        store.ask({ sessionId: "grouped", kind: "question", dialog: true, group: group(1), text: "Which theme should it ship with?", options: ["Light", "Dark"] });
        const page = await open();
        const rows = "[...document.querySelectorAll('.qrow')].filter((r) => r.textContent.includes('Which engine should search use?'))";
        await page.waitFor(`${rows}.length === 1`);
        assert.match(await page.eval<string>(`${rows}[0].textContent`), /Which theme should it ship with\?.*2 questions asked together/, "one row names both");
        await page.click(".qrow", "Which engine should search use?");
        await page.waitFor("document.querySelectorAll('.next .qpart').length === 2 && !document.querySelector('.next').getAnimations({ subtree: true }).length");
        assert.match(await page.eval<string>("document.querySelector('.next .group-note').textContent"), /waits for all 2 answers/);
        assert.deepEqual(await page.eval<string[]>("[...document.querySelectorAll('.next .qpart-n')].map((n) => n.textContent)"), ["Question 1 of 2", "Question 2 of 2"]);

        await page.click(".next .qpart .opts button", "Lunr");
        await page.eval("document.querySelector('.next .qpart .send').click()");
        assert.deepEqual(await answers("grouped", 1), ["Lunr"]);
        await page.waitFor("document.querySelector('.next .group-note')?.textContent.includes('1 of 2 answered')");
        assert.match(await page.eval<string>("document.querySelector('.next .qpart.done').textContent"), /Which engine should search use\?.*Answered.*Lunr/, "the answered part stays, with its answer");
        assert.equal(await page.eval<number>("document.querySelectorAll('.next .qpart:not(.done) .opts button').length"), 2, "the other part is still to answer");

        await page.click(".next .qpart:not(.done) .opts button", "Dark");
        await page.eval("document.querySelector('.next .qpart:not(.done) .send').click()");
        assert.deepEqual(await answers("grouped", 1), ["Dark"]);
        await page.waitFor("document.querySelector('.next.resolved .group-note')");
        assert.equal(await page.eval<string>("document.querySelector('.next.resolved .group-note').textContent"), "All 2 answered.", "the answered card says all are answered");
      } finally {
        done();
      }
    });

    it("answered with Ctrl+Enter, questions asked together hand the keys to the part still open, then to the next question", async () => {
      const done = asking("grouped-keys", "questions answered with the keys");
      // Every waiting session listens, so whichever question comes next has a box that takes text.
      const stops = [...new Set(store.openQuestions().map((q) => q.sessionId))].filter((id) => id !== "grouped-keys").map((id) => store.listen(id));
      try {
        const group = (index: number) => ({ id: "dialog-grouped-keys", index, size: 2 });
        store.ask({ sessionId: "grouped-keys", kind: "question", dialog: true, group: group(0), text: "Which port should the preview use?", options: ["5173", "8080"] });
        store.ask({ sessionId: "grouped-keys", kind: "question", dialog: true, group: group(1), text: "Which browser should it open?", options: ["Chrome", "Firefox"] });
        const page = await open();
        const ctrlEnter = async () => {
          for (const type of ["rawKeyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 2 });
        };
        await page.click(".qrow", "Which port should the preview use?");
        await page.waitFor(`document.querySelectorAll('.next .qpart').length === 2 && ${STILL}`);
        await page.click(".next .qpart textarea");
        await page.type("5173");
        await ctrlEnter();
        assert.deepEqual(await answers("grouped-keys", 1), ["5173"]);
        await page.waitFor("document.querySelector('.next .qpart.done') && document.activeElement?.matches('.next .qpart:not(.done) textarea')", 5000);
        await page.type("Chrome");
        await ctrlEnter();
        assert.deepEqual(await answers("grouped-keys", 1), ["Chrome"]);
        await page.waitFor("document.querySelector('.next.resolved')");
        await page.waitFor("!document.querySelector('.next.resolved') && document.activeElement?.matches('.next:not([data-leaving]) textarea')", 5000);
        await page.type("x");
        const box = "document.querySelector('.next:not([data-leaving]) textarea')";
        assert.equal(await page.eval<string>(`${box}.value`), "x", "the key landed in the next question's box");
        await page.eval(`(() => { const b = ${box}; b.value = ''; b.dispatchEvent(new Event('input', { bubbles: true })); })()`); // no draft left for the other tests
      } finally {
        for (const stop of stops) stop();
        done();
      }
    });

    for (const phone of [false, true]) {
      it(`${phone ? "on a phone, " : ""}answers or dismisses a large card scrolled past its top from what shows, nothing below jumping`, async () => {
        const id = phone ? "scrolled-phone" : "scrolled";
        const done = asking(id, "scrolled past the top");
        const context = Array.from({ length: 16 }, (_, i) => `Line ${i + 1}: what the session found before asking.`).join("\n");
        store.ask({ sessionId: id, kind: "question", text: "Answered while scrolled?", context, options: ["Yes", "No"] });
        store.ask({ sessionId: id, kind: "question", text: "Dismissed while scrolled?", context, options: ["Yes", "No"] });
        try {
          const page = await (phone ? open(390, 700) : open(1400, 640));
          const acts = {
            answer: "[...card.querySelectorAll('.opts button')].find((b) => b.textContent.includes('Yes')).click()",
            dismiss: "[...card.querySelectorAll('.actions button')].find((b) => b.textContent.includes('Dismiss')).click()",
          };
          for (const [text, act] of [["Answered while scrolled?", acts.answer], ["Dismissed while scrolled?", acts.dismiss]] as const) {
            await page.click(".qrow", text);
            await page.waitFor(`document.querySelector('.next:not([data-leaving])')?.textContent.includes(${JSON.stringify(text)}) && ${STILL}`);
            // Every frame from the click until the card is gone: the scroll, the card's top against the scroll
            // area's, the top of the box it held (where its content showed) and of the last row below it.
            type Frame = { scroll: number; card: number | null; box: number | null; row: number | null; resolved: boolean; leaving: boolean };
            const frames = await page.eval<Frame[]>(`new Promise((done) => {
              const scroller = ${phone ? "document.scrollingElement" : "document.querySelector('.col-needs .col-body')"};
              const edge = () => ${phone ? "0" : "scroller.getBoundingClientRect().top + scroller.clientTop"};
              const card = document.querySelector('.next');
              const box = card.querySelector('.answer textarea');
              const row = [...document.querySelectorAll('.col-needs .qrow')].at(-1);
              scroller.scrollTop += card.getBoundingClientRect().top - edge() + 120;
              const frames = [];
              const sample = () => frames.push({ scroll: scroller.scrollTop, card: card.isConnected ? card.getBoundingClientRect().top - edge() : null, box: box.isConnected ? box.getBoundingClientRect().top : null, row: row.isConnected ? row.getBoundingClientRect().top : null, resolved: card.classList.contains('resolved'), leaving: card.hasAttribute('data-leaving') });
              sample();
              ${act};
              const end = performance.now() + 4000;
              const tick = () => {
                sample();
                if ((!card.isConnected && !document.getAnimations().some((a) => a.id === 'motion')) || performance.now() > end) done(frames);
                else requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
            })`);
            const [first] = frames;
            const log = JSON.stringify(frames);
            assert.ok(first && first.card !== null && first.card < -100, `the card's top starts out of sight: ${log}`);
            assert.equal(frames.at(-1)?.card, null, `the card went: ${log}`);
            // Where what is left is shorter than the window, the scroll follows the content down, never back up.
            assert.ok(frames.every((f, i) => i === 0 || f.scroll <= frames[i - 1]!.scroll + 0.5), `the scroll never goes back up: ${log}`);
            const staying = frames.filter((f) => !f.leaving && f.row !== null).map((f) => f.row!);
            assert.ok(staying.every((top, i) => i === 0 || top <= staying[i - 1]! + 0.5), `the rows below the answered card only rise: ${log}`);
            for (const f of frames.filter((f) => f.resolved && f.card !== null)) assert.ok(f.card! >= -1, `the answered card shows from its top: ${log}`);
            const shown = frames.filter((f) => f.box !== null).map((f) => f.box!);
            assert.ok(Math.max(...shown) - Math.min(...shown) <= 20, `what showed of the card stays in place as it goes, but for its padding folding: ${log}`);
          }
        } finally {
          done();
        }
      });
    }
  });

  it("dates a result from an earlier day in its tile and its window, and gives today's its time only", async () => {
    const weeksAgo = new Store(store.paths.home, () => new Date(Date.now() - 21 * 86400_000));
    const old = weeksAgo.addResult({ sessionId: "demo-iva", title: "Rounding report from weeks ago", summary: "Old run.", url: "http://127.0.0.1:5173/" });
    try {
      const page = await open();
      const tile = (title: string) => `[...document.querySelectorAll('.rtile')].find((t) => t.textContent.includes(${JSON.stringify(title)}))`;
      await page.waitFor(tile("Rounding report from weeks ago"));
      const day = new Date(old.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      assert.equal(await page.eval<string>(`${tile("Rounding report from weeks ago")}.querySelector('.rm .num').textContent`), `${day} ${new Date(old.at).toTimeString().slice(0, 5)}`);
      assert.match(await page.eval<string>("[...document.querySelectorAll('.rtile .rm .num')].map((m) => m.textContent).find((t) => /^\\d\\d:\\d\\d$/.test(t)) ?? ''"), /^\d\d:\d\d$/, "a result from today shows its time alone");
      await page.click(".rtile", "Rounding report from weeks ago");
      await page.waitFor(arrived("result"));
      assert.match(await page.eval<string>("document.querySelector('#result .dhead .meta').textContent"), new RegExp(`·\\s*${day} `));
      await page.press("Escape");
    } finally {
      store.markResultSeen(old.id);
    }
  });

  describe("a question that arrives tells of itself without interrupting", () => {
    /** A waiting session listening on the desk; ended afterwards, its questions dismissed. */
    function listening(id: string, title: string) {
      store.upsertSession({ id, provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title, state: "waiting" });
      const stop = store.listen(id);
      return () => {
        stop();
        for (const q of store.openQuestions(id)) store.dismiss(q.id);
        store.updateSession(id, (s) => ({ ...s, state: "ended" }));
      };
    }
    const bubble = "document.getElementById('arrival')";
    const bubbleUp = `${bubble}.matches(':popover-open') && !${bubble}.inert`;
    /** The bubble's 8 s before it goes back into Needs you take 400 ms here. */
    const quickRetreat = "const later = window.setTimeout; window.setTimeout = (f, ms, ...a) => later(f, ms === 8000 ? 400 : ms, ...a);";
    async function openWith(source: string, width = 1400, height = 900): Promise<Page> {
      const page = await browser.newPage(width, height);
      pages.push(page);
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source });
      await page.goto(base + "/");
      await page.waitFor("document.querySelector('.next') && document.querySelectorAll('.scard').length");
      return page;
    }

    it("in the asking session's open panel, comes into its conversation: no bubble, no toast, the focus left where it was", async () => {
      const done = listening("arrive-panel", "asks in its panel");
      try {
        const page = await open();
        await page.click(".scard", "asks in its panel");
        await page.waitFor(`${arrived("session")} && document.querySelector('#session .session-body')?.dataset.fetched === 'yes'`);
        await page.eval("document.querySelector('#session .dhead .icon-btn').focus()");
        await page.eval("window.rose = 0; const a = Element.prototype.animate; Element.prototype.animate = function (f, o) { if (this.matches('.panel-question') && f[0]?.opacity === 0) rose++; return a.call(this, f, o); }");
        store.ask({ sessionId: "arrive-panel", kind: "question", text: "Asked while its panel is open?", options: ["Yes", "No"] });
        await page.waitFor("document.querySelector('#session .panel-question')?.textContent.includes('Asked while its panel is open?')");
        assert.equal(await page.eval<number>("rose"), 1, "it comes into the panel's foot with a motion");
        await new Promise((r) => setTimeout(r, 400));
        assert.deepEqual(
          await page.eval(`[${bubble}.matches(':popover-open'), document.querySelectorAll('.toast').length, document.activeElement === document.querySelector('#session .dhead .icon-btn')]`),
          [false, 0, true],
        );
        await page.press("Escape");
      } finally {
        done();
      }
    });

    it("in sight on the board, arrives on its row only", async () => {
      const page = await open();
      const asked = store.ask({ sessionId: "demo-pagos", kind: "question", text: "Arriving in plain sight?" });
      try {
        await page.waitFor("[...document.querySelectorAll('.qrow')].some((r) => r.textContent.includes('Arriving in plain sight?'))");
        await new Promise((r) => setTimeout(r, 400));
        assert.deepEqual(await page.eval(`[${bubble}.matches(':popover-open'), document.querySelectorAll('.toast').length]`), [false, 0]);
      } finally {
        store.dismiss(asked.id);
      }
    });

    it("out of sight, a bubble over the window says where and what, answered whole in place, and leaves once answered", async () => {
      const done = listening("arrive-out", "asks out of sight");
      try {
        const page = await open();
        await openResultOf(page, "Three pay button variants");
        store.ask({ sessionId: "arrive-out", kind: "question", text: "Which pay button ships?", context: "Variant B tested best on phones.", options: ["A", "B", "C"] });
        await page.waitFor(`${bubbleUp} && !${bubble}.getAnimations().length`); // come to rest
        assert.deepEqual(
          await page.eval(`[${bubble}.parentElement.id, ${bubble}.getAttribute('aria-label'), [...${bubble}.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent)]`),
          ["result", "New question", ["Hide this notice: the question stays in Needs you", "Expand", "Go"]],
          "inside the window on top, so it can be clicked; every button named",
        );
        assert.match(await page.eval<string>(`${bubble}.querySelector('[role=status]').textContent`), /^web-shop›.*asks out of sightWhich pay button ships\?$/, "it says where and what, read out politely");
        const head = await page.eval<number>("document.querySelector('#result .dhead').getBoundingClientRect().bottom");
        assert.ok((await page.eval<number>(`${bubble}.getBoundingClientRect().top`)) >= head, "under the window's head");
        assert.equal(await page.eval<number>("document.querySelectorAll('.toast').length"), 0, "no toast");
        await page.click("#arrival .arr-expand");
        await page.waitFor("document.querySelector('#arrival .arr-body textarea')");
        assert.match(await page.eval<string>("document.querySelector('#arrival .arr-body').textContent"), /Which pay button ships\?.*Variant B tested best on phones\./, "the whole question, with what was said around it");
        await page.eval("document.querySelector('#arrival textarea').focus()");
        await page.press("Escape");
        assert.deepEqual(await page.eval("[!!document.querySelector('#arrival .arr-body'), document.getElementById('result').open]"), [false, true], "Escape folds the bubble, not the window under it");
        await page.click("#arrival .arr-expand");
        await page.waitFor("document.querySelector('#arrival .arr-body textarea')");
        await page.click("#arrival .opts button", "B");
        await page.waitFor("document.querySelector('#arrival .resolved-line')?.textContent.includes('Answered')");
        assert.deepEqual(store.takeInbox("arrive-out").map((e) => e.answer), ["B"], "delivered as picked, to the session that asked");
        await page.waitFor(`!${bubble}.matches(':popover-open')`);
        assert.deepEqual(await page.eval(`[document.getElementById('result').open, document.querySelectorAll('.toast').length]`), [true, 0], "the window stays; no toast");
        await page.press("Escape");
      } finally {
        done();
      }
    });

    it("Go selects it in Needs you, with the window over the desk closed; one bubble counts the others", async () => {
      const page = await open();
      await page.click("#views button", "History");
      const first = store.ask({ sessionId: "demo-pagos", kind: "question", text: "First while in History?" });
      await page.waitFor(`${bubbleUp} && ${bubble}.textContent.includes('First while in History?')`);
      const second = store.ask({ sessionId: "demo-iva", kind: "question", text: "Second while in History?" });
      try {
        await page.waitFor(`${bubble}.textContent.includes('Second while in History?')`);
        assert.match(await page.eval<string>(`${bubble}.querySelector('.arr-more').textContent`), /^\+1 more$/);
        assert.equal(await page.eval<number>("document.querySelectorAll('#arrival').length"), 1, "one bubble, never a wall");
        await page.click("#arrival .arr-go");
        await page.waitFor(`!${bubble}.matches(':popover-open') && document.querySelector('.next:not([data-leaving])')?.textContent.includes('Second while in History?')`);
        assert.equal(await page.eval<boolean>("document.querySelector('#views button[aria-pressed=true]').textContent.includes('Desk')"), true);
      } finally {
        store.dismiss(first.id);
        store.dismiss(second.id);
      }
    });

    it("goes back into the needs pill by itself, never while expanded or under the pointer; Escape folds it, then hides it", async () => {
      const page = await openWith(quickRetreat);
      await page.click("#views button", "History");
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 400 });
      const first = store.ask({ sessionId: "demo-pagos", kind: "question", text: "Left alone, where does it go?" });
      try {
        await page.waitFor(bubbleUp);
        await page.eval("window.bumped = 0; const a = Element.prototype.animate; Element.prototype.animate = function (f, o) { if (this.id === 'needs-pill' && o?.id === 'bump') bumped++; return a.call(this, f, o); }");
        await page.waitFor(`!${bubble}.matches(':popover-open')`, 3000);
        assert.equal(await page.eval<number>("bumped"), 1, "the pill it went into says so");
        assert.ok(store.openQuestions("demo-pagos").some((q) => q.id === first.id), "the question still waits in Needs you");

        const second = store.ask({ sessionId: "demo-pagos", kind: "question", text: "Expanded, does it stay?" });
        try {
          await page.waitFor(`${bubbleUp} && !${bubble}.getAnimations().length`);
          assert.equal(await page.eval<string>(`getComputedStyle(${bubble}).opacity`), "1", "back after a retreat, it shows whole");
          await page.click("#arrival .arr-expand");
          await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 400 });
          await page.eval("document.activeElement.blur()");
          await new Promise((r) => setTimeout(r, 1200));
          assert.equal(await page.eval<boolean>(bubbleUp), true, "expanded, it stays");
          await page.eval("document.querySelector('#arrival textarea').focus()");
          await page.press("Escape");
          assert.equal(await page.eval<boolean>("!document.querySelector('#arrival .arr-body') && document.activeElement.matches('#arrival .arr-expand')"), true, "Escape folds it");
          await page.press("Escape");
          await page.waitFor(`!${bubble}.matches(':popover-open')`);
          assert.equal(await page.eval<string>("document.querySelector('#views button[aria-pressed=true]').textContent"), "History", "and then hides it, nothing else");
        } finally {
          store.dismiss(second.id);
        }
      } finally {
        store.dismiss(first.id);
      }
    });

    it("leaves when its question is answered elsewhere", async () => {
      const page = await open();
      await page.click("#views button", "History");
      const asked = store.ask({ sessionId: "demo-pagos", kind: "question", text: "Answered in the terminal instead?" });
      await page.waitFor(bubbleUp);
      store.dismiss(asked.id);
      await page.waitFor(`!${bubble}.matches(':popover-open')`);
    });

    it("on a phone, sits above the tab bar, inside the screen, while another tab is shown", async () => {
      const page = await open(390, 844);
      await page.click(".tabbar button", "Sessions");
      const asked = store.ask({ sessionId: "demo-pagos", kind: "question", text: "Seen from the Sessions tab?" });
      try {
        await page.waitFor(`${bubbleUp} && !${bubble}.getAnimations().length`); // come to rest
        const [left, right, bottom, bar] = await page.eval<[number, number, number, number]>(`(() => { const r = ${bubble}.getBoundingClientRect(); return [r.left, r.right, r.bottom, document.querySelector('.tabbar').getBoundingClientRect().top]; })()`);
        assert.ok(left >= 8 && right <= 382 && bottom <= bar, `inside the screen, above the tab bar: ${left} ${right} ${bottom} ${bar}`);
        await page.click(".tabbar button", "Needs you");
        await page.waitFor(`!${bubble}.matches(':popover-open')`); // now in sight
      } finally {
        store.dismiss(asked.id);
      }
    });
  });

  it("a message that cannot be sent stays in the conversation with why and Retry, kept on the device, and Retry sends it once", async () => {
    store.upsertSession({ id: "unsent", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "a message that fails", takesMessagesWhileWorking: true });
    const page = await open();
    await page.click(".scard", "a message that fails");
    await page.click("#session .chat-footer textarea");
    await page.type("deploy after lunch");
    await page.eval(`(() => {
      const real = window.fetch;
      window.fetch = (url, init) => init?.method === "POST" && String(url).endsWith("/message") ? (window.fetch = real, Promise.resolve(new Response(JSON.stringify({ error: "the desk is busy" }), { status: 503 }))) : real(url, init);
    })()`);
    await page.click("#session .chat-footer .send");
    const failed = "document.querySelector('#session .msg.out.failed')";
    await page.waitFor(failed);
    assert.deepEqual(
      await page.eval(`[${failed}.querySelector('.md').textContent, ${failed}.querySelector('.unsent-why').textContent, document.querySelector('#session .chat-footer textarea').value, document.querySelectorAll('.toast').length]`),
      ["deploy after lunch", "Not sent: the desk is busy", "", 0],
      "the message stays where it was sent, saying why, with no toast; the box is free",
    );
    assert.equal(store.takeInbox("unsent").length, 0);
    // Never lost: a reload shows it again, not sent.
    await page.goto(base + "/");
    await page.waitFor("document.querySelector('.scard')");
    await page.click(".scard", "a message that fails");
    await page.waitFor(failed);
    await page.click("#session .msg.out.failed button", "Retry");
    await page.waitFor("[...document.querySelectorAll('#session .msg.from-developer')].some((m) => m.textContent.includes('deploy after lunch') && m.querySelector('.delivered')) && !document.querySelector('#session .msg.out.failed')");
    assert.deepEqual(store.takeInbox("unsent").map((e) => e.answer), ["deploy after lunch"], "sent once, as written");
    await page.waitFor("localStorage.getItem('agent-desk:drafts') === null");
    await page.press("Escape");
  });

  it("on a phone, a result's pictures read one under the other, each with its caption, and a tap opens it in the viewer", async () => {
    const page = await open(390, 844);
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await openResultOf(page, "Three pay button variants");
    const figures = await page.eval<{ top: number; bottom: number; width: number; caption: string }[]>(
      "[...document.querySelectorAll('#result .vimgs figure')].map((f) => { const r = f.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width, caption: f.querySelector('figcaption').textContent }; })",
    );
    const column = await page.eval<number>("document.querySelector('#result .vimgs').clientWidth");
    assert.deepEqual(figures.map((f) => f.caption), ["A", "B", "C"]);
    figures.forEach((f, i) => {
      assert.ok(Math.abs(f.width - column) < 1, `picture ${f.caption} takes the width: ${f.width} of ${column}`);
      if (i) assert.ok(f.top >= figures[i - 1]!.bottom, `picture ${f.caption} sits under the one before`);
    });
    await page.eval("document.querySelectorAll('#result .vimgs img')[1].click()");
    await page.waitFor(arrived("zoom"));
    assert.match(await page.eval<string>("document.querySelector('#zoom .zcount')?.textContent ?? ''"), /^2/, "the viewer opens on the picture tapped");
    await page.press("Escape");
    await page.waitFor("!document.getElementById('zoom').open");
    await page.press("Escape");
    await openResultOf(page, "Checkout: before and after");
    assert.equal(await page.eval<boolean>("!!document.querySelector('#result .compare')"), true, "a before and after keeps its slider");
    await page.press("Escape");
  });

  describe("while you were away", () => {
    /** The desk as this device saw it last `minutes` ago. */
    async function openAway(minutes: number, width = 1400, height = 900, phone = false): Promise<Page> {
      const page = await browser.newPage(width, height);
      pages.push(page);
      if (phone) {
        await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 3, mobile: true });
        await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      }
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("agent-desk:last-looked", String(Date.now() - ${minutes} * 60000));` });
      await page.goto(base + "/");
      await page.waitFor("document.querySelector('.next')");
      return page;
    }
    const lines = (page: Page, group: string) => page.eval<string[]>(`[...document.querySelectorAll('.away [data-key="${group}"] .away-line')].map((l) => l.textContent)`);

    it("sums up what finished, failed, waits and was answered in the terminal, each line opening it, until dismissed", async () => {
      const done = store.addResult({ sessionId: "demo-iva", title: "Finished while away", url: "http://localhost:5173/away" });
      store.addResult({ sessionId: "demo-iva", title: "Failed while away", status: "failed" });
      const q = store.ask({ sessionId: "demo-pagos", kind: "question", text: "Answered in the terminal while away?" });
      store.closeOpen("demo-pagos", { answer: "Yes, from the terminal", which: (x) => x.id === q.id });
      const page = await openAway(120);
      await page.waitFor("document.querySelector('#strip .away')");
      assert.match(await page.eval<string>("document.querySelector('.away-head').textContent"), /^While you were away\s*since \d\d:\d\d · .*finished.*answered in the terminal/);
      assert.ok((await lines(page, "finished")).some((l) => l.includes("Finished while away")));
      assert.ok((await lines(page, "failed")).some((l) => l.includes("Failed while away")));
      assert.ok((await lines(page, "answered")).some((l) => l.includes("Answered in the terminal while away?") && l.includes("Yes, from the terminal")));
      assert.ok((await lines(page, "waits")).length > 0, "what waits, oldest first");
      assert.equal(await page.eval<boolean>("document.querySelector('#strip > .muted') === null"), true, "it takes the place of the line on what is new");
      // A line opens what it names; the summary stays for the next one.
      await page.click(".away .away-line", "Finished while away");
      await page.waitFor(`${arrived("result")} && document.querySelector('#result h3').textContent === 'Finished while away'`);
      await page.press("Escape");
      await page.waitFor("!document.getElementById('result').open");
      await page.click(".away .away-line", "Answered in the terminal while away?");
      await page.waitFor(arrived("session"));
      assert.match(await page.eval<string>("document.querySelector('#session h3').textContent"), /./);
      await page.press("Escape");
      await page.waitFor("!document.getElementById('session').open");
      // Answering stays where it was: the large card answers as without the summary.
      assert.ok(await page.eval<boolean>("!!document.querySelector('.next .answer')"));
      await page.click(".away-close");
      await page.waitFor("!document.querySelector('.away') && document.querySelector('#strip > .muted')");
      store.markResultSeen(done.id);
    });

    it("says nothing after a short absence, and sums up on coming back to a page left hidden for a while", async () => {
      const page = await openAway(5);
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(await page.eval<boolean>("!!document.querySelector('.away')"), false, "5 minutes away is not away");
      // Hidden for an hour: the device noted when it stopped looking, and something finished meanwhile.
      await page.eval(`(() => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => window.fakeHidden });
        window.fakeHidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
        localStorage.setItem("agent-desk:last-looked", String(Date.now() - 60 * 60000));
      })()`);
      const r = store.addResult({ sessionId: "demo-iva", title: "Finished behind a hidden page", url: "http://localhost:5173/hidden" });
      await page.eval(`(() => { window.fakeHidden = false; document.dispatchEvent(new Event("visibilitychange")); })()`);
      await page.waitFor("[...document.querySelectorAll('.away .away-line')].some((l) => l.textContent.includes('Finished behind a hidden page'))");
      // Not in History: it belongs to the desk.
      await page.click("#views button", "History");
      await page.waitFor("!document.querySelector('.away')");
      await page.click("#views button", "Desk");
      await page.waitFor("!!document.querySelector('.away')");
      store.markResultSeen(r.id);
    });

    it("on a phone, sits above Needs you one line per group, on every tab of the desk", async () => {
      const r = store.addResult({ sessionId: "demo-iva", title: "Finished while the phone slept", url: "http://localhost:5173/phone" });
      const page = await openAway(90, 390, 844, true);
      await page.waitFor("document.querySelector('#strip .away')?.getBoundingClientRect().height > 0");
      const away = await page.eval<{ bottom: number; needsTop: number; width: number; groups: number[] }>(`(() => ({
        bottom: document.querySelector('.away').getBoundingClientRect().bottom,
        needsTop: document.querySelector('.col-needs').getBoundingClientRect().top,
        width: document.querySelector('.away').getBoundingClientRect().right,
        groups: [...document.querySelectorAll('.away-group')].map((g) => g.querySelectorAll('.away-line').length),
      }))()`);
      assert.ok(away.bottom <= away.needsTop, "above Needs you, covering nothing");
      assert.ok(away.width <= 390, "inside the screen");
      assert.ok(away.groups.every((n) => n === 1), `one line per group: ${away.groups}`);
      await page.tap(".tabbar button", "Sessions");
      await page.waitFor("document.querySelector('.away')?.getBoundingClientRect().height > 0");
      await page.tap(".away-close");
      await page.waitFor("!document.querySelector('.away')");
      store.markResultSeen(r.id);
    });
  });

  describe("forgetting a session", () => {
    it("offers Forget only on a session that is not running, acts on the second click, and takes it off the desk", async () => {
      const at = new Date(Date.now() - 30 * 60000).toISOString();
      store.upsertSession({ id: "to-forget", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "ended and forgotten", state: "ended", endedAt: at, endedAsking: true, lastMessage: { text: "Shall I go on?", at } });
      const result = store.addResult({ sessionId: "to-forget", title: "Left behind by the ended session", url: "http://localhost:5173/left" });
      const page = await open();
      const card = cardOf("ended and forgotten");
      await page.waitFor(card);
      assert.equal(await page.eval<number>("[...document.querySelectorAll('.scard')].filter((c) => c.querySelector('[data-key=forget]')).length"), 1, "only the session that ended offers it");
      await page.click(".scard [data-key=forget]");
      assert.equal(await page.eval<string>(`${card}.querySelector('[data-key=forget]').getAttribute('aria-label')`), "Forget it?");
      assert.equal(await page.eval<boolean>("document.getElementById('session').open"), false, "the click is the button's, not the card's");
      assert.equal(store.getSession("to-forget")?.endedAsking, true, "one click does nothing yet");
      // Its 3 s countdown runs as a transform, which page.click waits out: the second click comes at once, as a person's does.
      await page.eval("document.querySelector('.scard [data-key=forget]').click()");
      await page.waitFor(`!${card}`);
      await page.waitFor("[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Forgot web-shop › ended and forgotten'))");
      assert.ok(store.listResults().find((r) => r.id === result.id)?.seenAt, "its result went to History");
      assert.equal(await page.eval<boolean>("[...document.querySelectorAll('.rtile')].some((t) => t.textContent.includes('Left behind'))"), false);
      await page.click("#views button", "History");
      await page.waitFor("[...document.querySelectorAll('.hitem')].some((h) => h.textContent.includes('Left behind by the ended session') && h.textContent.includes('ended and forgotten'))");
      await page.click("#views button", "Desk");
    });

    it("keeps a session whose process is gone on the desk while it asks, and forgets it from its panel", async () => {
      store.upsertSession({ id: "gone-asking", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "gone while asking", state: "waiting", process: { pid: 2 ** 31 - 3, ancestors: [] } });
      const q = store.ask({ sessionId: "gone-asking", kind: "question", text: "Asked before its process went away?" });
      const page = await open();
      await page.click(".scard", "gone while asking");
      await page.waitFor(arrived("session"));
      assert.match(await page.eval<string>("document.querySelector('#session .pchips').textContent"), /its process is gone\s*Forget/);
      await page.click("#session .pchips [data-key=forget]");
      await page.eval("document.querySelector('#session .pchips [data-key=forget]').click()");
      await page.waitFor("!document.getElementById('session').open");
      await page.waitFor("![...document.querySelectorAll('.scard, .qrow, .next')].some((c) => c.textContent.includes('gone while asking') || c.textContent.includes('Asked before its process'))");
      assert.equal(store.getQuestion(q.id)?.status, "dismissed");
      assert.equal(store.getSession("gone-asking")?.state, "ended");
    });
  });

  it("asks before leaving only while an image or an answer is on its way", async () => {
    store.upsertSession({ id: "leaving", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "leaving mid-upload", takesMessagesWhileWorking: true });
    const page = await browser.newPage(1400, 900);
    pages.push(page);
    // The image never reaches the store: it stays on its way.
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "const real = window.fetch; window.fetch = (url, init) => (String(url).includes('/api/images') ? new Promise(() => {}) : real(url, init));" });
    await page.goto(base + "/");
    await page.waitFor("document.querySelector('.scard')");
    const asks = "(() => { const e = new Event('beforeunload', { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; })()";
    assert.equal(await page.eval<boolean>(asks), false, "nothing on its way: leaving is free");
    await page.click(".scard", "leaving mid-upload");
    await page.eval(`(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(8)], "shot.png", { type: "image/png" }));
      document.querySelector("#session .chat-footer textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    })()`);
    await page.waitFor("document.querySelector('#session .attached')?.textContent.includes('Attaching')");
    assert.equal(await page.eval<boolean>(asks), true, "an image on its way: the browser asks first");
  });

  describe("a window's first focus", () => {
    const focus = (page: Page) => page.eval<{ active: string; ring: boolean }>("({ active: document.activeElement?.tagName + ' ' + (document.activeElement?.textContent ?? ''), ring: document.activeElement?.matches(':focus-visible') ?? false })");

    it("is its title: no ring after a click or a tap, one for the keyboard", async () => {
      const titles = ["Focus by click", "Focus by key", "Focus by tap"];
      for (const title of titles) store.addResult({ sessionId: "demo-iva", title, url: "http://localhost:5173/focus" });
      const page = await open();
      await page.click(".rtile", "Focus by click");
      await page.waitFor(arrived("result"));
      assert.deepEqual(await focus(page), { active: "H3 Focus by click", ring: false }, "not Open live, and no ring");
      await page.press("Escape");
      await page.waitFor("!document.getElementById('result').open");
      await page.eval("[...document.querySelectorAll('.rtile')].find((t) => t.textContent.includes('Focus by key')).focus()");
      // A button acts on the Enter that types (its "char"), not on the bare key press.
      for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: type === "keyDown" ? "\r" : undefined });
      await page.waitFor(arrived("result"));
      assert.deepEqual(await focus(page), { active: "H3 Focus by key", ring: true }, "the keyboard sees where it is");
      await page.press("Escape");
      const phone = await openPhone();
      await phone.tap(".tabbar button", "To review");
      await phone.tap(".rtile", "Focus by tap");
      await phone.waitFor(arrived("result"));
      assert.deepEqual(await focus(phone), { active: "H3 Focus by tap", ring: false });
      assert.equal(await phone.eval<boolean>("!!document.querySelector('#result :focus-visible')"), false);
      await phone.press("Escape");
    });
  });

  it("knows every window of the page by one list", async () => {
    const page = await open();
    assert.deepEqual(await page.eval<string[]>("import('/dom.js').then((m) => [...m.WINDOWS])"), await page.eval<string[]>("[...document.querySelectorAll('dialog')].map((d) => d.id)"));
  });

  describe("a question's card", () => {
    it("reads the whole message first, then the options, then the box, wherever it shows", async () => {
      store.upsertSession({ id: "reading", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "read then choose", state: "waiting" });
      const context = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of what the session said.`).join("\n");
      const q = store.ask({ sessionId: "reading", kind: "question", text: "Which way after reading?", context, options: ["This way", "That way"] });
      const huge = store.ask({ sessionId: "reading", kind: "question", text: "Which way after a huge message?", context: Array.from({ length: 90 }, (_, i) => `Huge line ${i + 1}.`).join("\n"), options: ["Up", "Down"] });
      try {
        const page = await open();
        await page.click(".qrow", "Which way after reading?");
        await page.waitFor(`document.querySelector('.next')?.textContent.includes('Which way after reading?') && ${STILL}`);
        const order = (scope: string) =>
          page.eval<string[]>(`[...document.querySelectorAll('${scope} :is(.qtext, .qctx, .opts, textarea)')].map((el) => el.matches('.qtext') ? 'title' : el.matches('.qctx') ? 'context' : el.matches('.opts') ? 'options' : 'box')`);
        assert.deepEqual(await order(".next"), ["title", "context", "options", "box"]);
        assert.equal(await page.eval<boolean>("document.querySelector('.next .qctx').classList.contains('folded')"), false, "30 lines read whole");
        assert.ok(await page.eval<boolean>("(() => { const c = document.querySelector('.next .qctx'); return c.scrollHeight <= c.clientHeight + 1 && c.textContent.includes('Line 30 of'); })()"));
        // In its session's panel, the same order.
        await page.click(".scard", "read then choose");
        await page.waitFor(arrived("session"));
        assert.deepEqual(await order("#session .panel-question"), ["title", "context", "options", "box"]);
        await page.press("Escape");
        await page.waitFor("!document.getElementById('session').open");
        // Only a huge message folds, from its end: its start reads as written.
        await page.click(".qrow", "Which way after a huge message?");
        await page.waitFor(`document.querySelector('.next')?.textContent.includes('after a huge message') && ${STILL}`);
        assert.equal(await page.eval<boolean>("document.querySelector('.next .qctx').classList.contains('folded')"), true);
        assert.match(await page.eval<string>("document.querySelector('.next .qctx').firstElementChild.textContent"), /^Huge line 1\./);
        assert.equal(await page.eval<number>("document.querySelector('.next .qctx').scrollTop"), 0);
        await page.click(".next .linkish", "Show the whole message");
        await page.waitFor("!document.querySelector('.next .qctx').classList.contains('folded')");
      } finally {
        store.dismiss(q.id);
        store.dismiss(huge.id);
      }
    });

    it("sends a single choice with one click, as Send does, and the next card takes the keys", async () => {
      store.upsertSession({ id: "one-click", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "one click answers", state: "waiting" });
      store.ask({ sessionId: "one-click", kind: "question", text: "Answered with one click?", options: ["Yes, at once", "No"] });
      const stops = [...new Set(store.openQuestions().map((x) => x.sessionId))].map((id) => store.listen(id));
      try {
        const page = await open();
        await page.click(".qrow", "Answered with one click?");
        await page.waitFor(`document.querySelector('.next')?.textContent.includes('Answered with one click?') && document.querySelector('.next .opts button:not([disabled])') && ${STILL}`);
        assert.deepEqual(await page.eval<string[]>("[...document.querySelectorAll('.next .opts button')].map((b) => b.getAttribute('aria-label'))"), ["Answer: Yes, at once", "Answer: No"]);
        await page.click(".next .opts button", "Yes, at once");
        await page.waitFor("document.querySelector('.next.resolved')?.textContent.includes('Yes, at once')");
        assert.deepEqual(store.takeInbox("one-click").map((e) => e.answer), ["Yes, at once"], "sent once, verbatim");
        await page.waitFor("!document.querySelector('.next.resolved') && document.activeElement?.matches('.next:not([data-leaving]) textarea')", 5000);
      } finally {
        for (const stop of stops) stop();
      }
    });

    it("picks an option with a digit without sending it, and Enter sends it", async () => {
      store.upsertSession({ id: "digits", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "digits pick", state: "waiting" });
      const q = store.ask({ sessionId: "digits", kind: "question", text: "Picked with a digit?", options: ["First", "Second"] });
      const stop = store.listen("digits");
      try {
        const page = await open();
        await page.click(".qrow", "Picked with a digit?");
        await page.waitFor(`document.querySelector('.next')?.textContent.includes('Picked with a digit?') && document.querySelector('.next textarea:not([readonly])') && ${STILL}`);
        await page.eval("document.activeElement.blur()");
        for (const type of ["rawKeyDown", "char", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "2", code: "Digit2", text: type === "char" ? "2" : undefined, windowsVirtualKeyCode: 50 });
        await page.waitFor("document.querySelector('.next textarea').value === 'Second' && document.activeElement === document.querySelector('.next textarea')");
        assert.equal(await page.eval<string>("[...document.querySelectorAll('.next .opts button')].find((b) => b.textContent.includes('Second')).getAttribute('aria-pressed')"), "true");
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(store.getQuestion(q.id)?.status, "open", "a digit alone never sends");
        await page.press("Enter");
        await page.waitFor("document.querySelector('.next.resolved')?.textContent.includes('Second')");
        assert.deepEqual(store.takeInbox("digits").map((e) => e.answer), ["Second"]);
      } finally {
        stop();
      }
    });

    it("on a phone, a tapped option sends at once without raising the keyboard", async () => {
      store.upsertSession({ id: "tap-sends", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "a tap answers", state: "waiting" });
      store.ask({ sessionId: "tap-sends", kind: "question", text: "Answered with a tap?", options: ["Tapped", "Not tapped"] });
      const stops = [...new Set(store.openQuestions().map((x) => x.sessionId))].map((id) => store.listen(id));
      try {
        const page = await openPhone();
        await page.click(".qrow", "Answered with a tap?");
        await page.waitFor(`document.querySelector('.next')?.textContent.includes('Answered with a tap?') && document.querySelector('.next .opts button:not([disabled])') && ${STILL}`);
        await page.eval("document.querySelector('.next').scrollIntoView()");
        await page.tap(".next .opts button", "Tapped");
        await page.waitFor("document.querySelector('.next.resolved')?.textContent.includes('Tapped')");
        assert.deepEqual(store.takeInbox("tap-sends").map((e) => e.answer), ["Tapped"]);
        await new Promise((r) => setTimeout(r, 1500));
        assert.equal(await page.eval<string>("document.activeElement?.tagName"), "BODY", "no box took the focus: no keyboard");
      } finally {
        for (const stop of stops) stop();
      }
    });
  });
});
