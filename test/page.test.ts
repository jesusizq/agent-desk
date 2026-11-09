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
    const card = `[...document.querySelectorAll('.scard')].find((c) => c.textContent.includes('all agents done'))`;
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
    const card = `[...document.querySelectorAll('.scard')].find((c) => c.textContent.includes('nightly report'))`;
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

  it("marks an agent quiet for a while, or failing its calls, on its session's card and row", async () => {
    store.upsertSession({ id: "stuck", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "stuck agents", state: "working", activityAt: new Date().toISOString() });
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    store.upsertAgent("stuck", "silent", { goal: "Silent agent", activityAt: ago(8) });
    store.upsertAgent("stuck", "looping", { goal: "Looping agent", activityAt: ago(0), failedAt: [ago(3), ago(2), ago(1)] });
    store.upsertAgent("stuck", "fine", { goal: "Fine agent", activityAt: ago(1), failedAt: [ago(30), ago(1)] });
    // An older adapter stamps no activity: its agent's last update, long ago, does not make it quiet.
    new Store(store.paths.home, () => new Date(Date.now() - 20 * 60_000)).upsertAgent("stuck", "unstamped", { goal: "Unstamped agent" });
    const page = await open();
    const card = `[...document.querySelectorAll('.scard')].find((c) => c.textContent.includes('stuck agents'))`;
    await page.waitFor(card);
    assert.deepEqual(
      await page.eval<string[]>(`[...${card}.querySelectorAll('.s-bad')].map((l) => l.textContent)`),
      ["Looping agent · 3 failed calls in 10 min", "Silent agent · no activity for 8 min"],
      "what matters about the session, one line each, failures first",
    );
    await page.click(".scard", "stuck agents");
    await page.click("#session .agents-fold > summary");
    const row = (goal: string) => page.eval<string>(`[...document.querySelectorAll('#session .arow')].find((r) => r.textContent.includes('${goal}'))?.querySelector('.astuck')?.textContent ?? ''`);
    assert.equal(await row("Silent agent"), "no activity for 8 min");
    assert.equal(await row("Looping agent"), "3 failed calls in 10 min");
    assert.equal(await row("Fine agent"), "", "one old failure and one retry are not a pattern");
    assert.equal(await row("Unstamped agent"), "");
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
    await page.waitFor("document.getAnimations().length === 0"); // the card grows out of its row: its code is clicked once in view
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
    assert.match(await page.eval<string>(`${fold}.querySelector('summary').textContent`), /^\d+ agents/);
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
    assert.deepEqual(
      await page.eval(`(() => { const b = ${button}; b.click(); b.click(); return [b.getAttribute("aria-busy"), ${box}.readOnly, ${box}.getBoundingClientRect().width]; })()`),
      ["true", true, width],
      "it says at once that the message is on its way, without resizing the box",
    );
    await page.waitFor("document.querySelector('#toasts')?.textContent.includes('Sent to web-shop › release notes.')");
    await page.waitFor(`${box}.value === '' && !${box}.readOnly && !${button}.hasAttribute("aria-busy")`);
    assert.deepEqual(store.takeInbox("mid-turn").map((e) => e.answer), ["and push it when the tests pass"], "sent once");
  });

  it("asks for the PIN again when the unlock ends, with what was being written kept", async () => {
    store.upsertSession({ id: "pin-ended", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "pin ended", takesMessagesWhileWorking: true });
    const page = await open();
    await page.click(".scard", "pin ended");
    await page.click("#session .chat-footer textarea");
    await page.type("half a thought");
    // What the server answers a device whose 24 hours ended; a reload loads the page's real fetch again.
    await page.eval(`(() => {
      window.beforeReload = true;
      const real = window.fetch;
      window.fetch = (url, init) => String(url) === "/api/state" ? Promise.resolve(new Response("{}", { status: 401, headers: { "X-Agent-Desk-Locked": "1" } })) : real(url, init);
    })()`);
    await page.waitFor("window.beforeReload === undefined && document.querySelector('.scard')");
    await page.click(".scard", "pin ended");
    await page.waitFor("document.querySelector('#session .chat-footer textarea')");
    assert.equal(await page.eval<string>("document.querySelector('#session .chat-footer textarea').value"), "half a thought");
    // As iOS closing the app: nothing warned the page, the draft is already on the device.
    await page.goto(base + "/");
    await page.waitFor("document.querySelector('.scard')");
    await page.click(".scard", "pin ended");
    await page.waitFor("document.querySelector('#session .chat-footer textarea')?.value === 'half a thought'");
    await page.click("#session .chat-footer .primary");
    await page.waitFor("localStorage.getItem('agent-desk:drafts') === null");
    assert.deepEqual(store.takeInbox("pin-ended").map((e) => e.answer), ["half a thought"], "sent, and no longer kept");
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
    await page.waitFor("document.querySelector('#strip .err')?.textContent.includes('not allowed')");
    const yesterday = new Date(Date.now() - 864e5).toISOString();
    await page.eval(`(() => {
      window.fetch = async (url, init) => {
        if (String(url) !== "/api/state") return window.realFetch(url, init);
        const headers = new Headers({ "X-Agent-Desk-Saved-At": ${JSON.stringify(yesterday)} });
        return new Response(await (await window.realFetch(url)).blob(), { headers });
      };
    })()`);
    await page.waitFor("document.querySelector('#strip .err')?.textContent.includes('Last saved: Yesterday')");
    await page.eval("window.fetch = window.realFetch");
    await page.waitFor("!document.querySelector('#strip .err')");
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
      proxy.closeAllConnections();
      await new Promise((r) => proxy.close(r));
    }
  });

  it("a tapped notification shows what needs the developer, whatever was open", async () => {
    const page = await open(390, 800);
    const on = (tab: string) => `document.querySelector('.tabbar button[aria-pressed="true"]')?.textContent.includes(${JSON.stringify(tab)})`;
    await page.click(".tabbar button", "History");
    await page.waitFor(on("History"));
    await page.eval(`navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { show: "needs" } }))`);
    await page.waitFor(on("Inbox"));
    await page.click(".tabbar button", "History");
    await page.waitFor(on("History"));
    await page.eval(`location.hash = "#needs"`);
    await page.waitFor(on("Inbox"));
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
    await page.waitFor("document.querySelector('#strip .err')?.textContent.includes('agent-desk serve')");
    await page.waitFor("document.querySelector('#session .offline-line')?.textContent.includes('agent-desk serve')");
    await page.eval("window.fetch = window.realFetch");
    await page.waitFor("!document.querySelector('#strip .err') && !document.querySelector('#session .offline-line')");
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
    const card = `[...document.querySelectorAll('.scard')].find((c) => c.textContent.includes('come back later'))`;
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
    const card = `[...document.querySelectorAll('.scard')].find((c) => c.textContent.includes('gone mid question'))`;
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
    await page.waitFor(`document.querySelector('#strip')?.textContent.includes('5 h limit: full in about')`);
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
    await page.waitFor("document.querySelector('#toasts')?.textContent.includes('hero picture')");
    const [entry] = store.takeInbox("with-image");
    assert.equal(entry?.answer, "like this one");
    assert.equal(entry?.images?.length, 1);
    assert.ok(store.imageFile(entry?.images?.[0] ?? ""), "the image is in the store");
  });

  it("on a phone, shows the project's name whole and keeps a long draft where it is written", async () => {
    store.upsertSession({ id: "long-draft", provider: "Test", project: { name: "invoices-api", dir: "/home/demo/Projects/invoices-api" }, title: "a session whose title is far too long for a phone", takesMessagesWhileWorking: true });
    const page = await open(390, 844);
    await page.click(".tabbar button", "Sessions");
    const proj = `[...document.querySelectorAll('.scard')].find((c) => c.textContent.includes('far too long')).querySelector('.sproj')`;
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
      await page.waitFor(`document.querySelector('#toasts')?.textContent.includes('writing on a phone') && ${box}?.value === ''`);
      assert.deepEqual(store.takeInbox("writing").map((e) => e.answer), ["half more a thought"]);
      assert.equal(await page.eval<boolean>(`${box} === kept`), true, "the box empties, it is not replaced");
    });

    it("on the inbox's large card, whose options still fill it", async () => {
      store.upsertSession({ id: "answering", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "answering a question", state: "waiting" });
      const stop = store.listen("answering");
      const asked = store.ask({ sessionId: "answering", kind: "question", text: "Which colour for the button?", options: ["Green", "Blue"] });
      try {
        const page = await open();
        await page.click(".qrow", "Which colour for the button?");
        await page.waitFor("document.querySelector('.next')?.textContent.includes('Which colour for the button?')");
        const box = "document.querySelector('.next textarea')";
        await page.waitFor("document.getAnimations().length === 0"); // a card still moving in takes the click elsewhere
        await page.click(".next textarea");
        await page.waitFor(`document.activeElement === ${box}`);
        await page.type("my own answer");
        await watch(page, box);

        const other = store.ask({ sessionId: "demo-pagos", kind: "question", text: "Asked while the other was being answered?" });
        await page.waitFor("document.body.textContent.includes('Asked while the other was being answered?')");
        await untouched(page, box);
        assert.equal(await page.eval<string>("kept.value"), "my own answer");
        store.dismiss(other.id);

        await page.click(".next .opts button", "Blue");
        assert.equal(await page.eval<string>("kept.value"), "Blue");
        assert.equal(await page.eval<string>(`[...document.querySelectorAll('.next .opts button')].find((b) => b.textContent.includes("Blue")).getAttribute("aria-pressed")`), "true");
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
      await page.waitFor("document.getAnimations().length === 0"); // the card grows out of its row: measured once it has
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
    await page.waitFor("document.querySelector('#strip .err')");
    assert.ok(await page.eval<boolean>("document.querySelector('#strip .err').getBoundingClientRect().right <= innerWidth"), "the whole text is in view, with no sideways scroll");
    assert.ok(await page.eval<boolean>("document.querySelector('#strip .err').getBoundingClientRect().height > 20"), "on several lines");
    await page.eval("window.fetch = window.realFetch");
    await page.waitFor("!document.querySelector('#strip .err')");
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
      await page.waitFor("document.querySelector('#session .chat-footer textarea') && document.getAnimations().length === 0");
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

    it("a tapped option fills the box without raising the keyboard; a tap on the box does", async () => {
      const done = asking("picking", "picking on a phone");
      try {
        const page = await phone();
        await openPanel(page, "picking on a phone");
        await page.tap("#session .opts button", "Blue");
        const box = "document.querySelector('#session .chat-footer textarea')";
        await page.waitFor(`${box}.value === "Blue"`);
        assert.equal(await page.eval<boolean>(`document.activeElement === ${box}`), false, "the box is not focused, so no keyboard covers the options");
        assert.equal(await page.eval<string>(`[...document.querySelectorAll('#session .opts button')].find((b) => b.textContent.includes("Blue")).getAttribute("aria-pressed")`), "true");
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
      await page.waitFor(`document.querySelector('#toasts')?.textContent.includes('Sent to web-shop › chatting on a phone.') && ${box}.value === ''`);
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
        await page.waitFor(`${box} && document.getAnimations().length === 0`);
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
        await page.tap("#session .chat-footer .send");
        await page.waitFor("document.querySelector('.toast')?.textContent.includes('Answer sent')");
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
  });

  it("keeps the large card's shape when its session starts or stops listening", async () => {
    store.upsertSession({ id: "flipping", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "listening on and off", state: "waiting" });
    const asked = store.ask({ sessionId: "flipping", kind: "question", text: "Does the card hold still?", options: ["Yes", "No"] });
    try {
      const page = await open();
      await page.click(".qrow", "Does the card hold still?");
      const card = "document.querySelector('.next')";
      await page.waitFor(`${card}?.textContent.includes('Does the card hold still?') && document.getAnimations().length === 0`);
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
        await page.waitFor("document.querySelector('.next textarea') && document.getAnimations().length === 0");
        await page.eval("window.left = 0; new MutationObserver((ms) => { for (const m of ms) if (m.attributeName === 'data-leaving') left++; }).observe(document.getElementById('view'), { attributes: true, subtree: true })");
        await page.click(".next .opts button", "Yes");
        await page.click(".next .send-col .primary");
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
      await page.waitFor("document.getAnimations().length === 0");
      // Frozen mid-way: the old question's row opens at a row's height below the new card, which nothing covers.
      const midway = (pick: string) =>
        page.eval<Record<string, boolean>>(`(() => {
          const old = document.querySelector('.next').dataset.flip;
          ${pick};
          for (const a of document.getAnimations()) (a.pause(), (a.currentTime = 140));
          const next = document.querySelector('.next:not([data-leaving])').getBoundingClientRect();
          const back = document.querySelector('.qrow[data-flip="' + old + '"]');
          const row = back.getBoundingClientRect();
          const hit = document.elementFromPoint(next.left + next.width / 2, next.top + 12);
          for (const a of document.getAnimations()) a.finish();
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
        await page.waitFor("document.querySelector('.next textarea:not([readonly])') && document.getAnimations().length === 0");
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
      const page = await open();
      const first = store.ask({ sessionId: "demo-pagos", kind: "question", text: "First of two toasts?" });
      await page.waitFor("document.querySelectorAll('.toast').length === 1 && document.getAnimations().length === 0");
      await page.eval("window.tops = []; (function f() { const t = document.querySelector('.toast'); if (t) tops.push(Math.round(t.getBoundingClientRect().top)); if (tops.length < 120) requestAnimationFrame(f); })()");
      const second = store.ask({ sessionId: "demo-pagos", kind: "question", text: "Second of two toasts?" });
      try {
        await page.waitFor("document.querySelectorAll('.toast').length === 2 && document.getAnimations().length === 0");
        const tops = await page.eval<number[]>("tops");
        const start = tops[0] ?? 0;
        const end = tops.at(-1) ?? 0;
        assert.ok(end < start - 20, `the first toast went up: ${start} → ${end}`);
        assert.ok(new Set(tops.filter((t) => t < start && t > end)).size >= 2, `through the places between: ${tops.join(" ")}`);
      } finally {
        store.dismiss(first.id);
        store.dismiss(second.id);
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
    await page.waitFor("!document.getAnimations().length");
    await page.click("#display-menu button", "Dark");
    assert.deepEqual(await page.eval<string[]>("document.getAnimations().map((a) => a.transitionProperty)"), [], "no control fades on its own from the old colours");
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

  it("on a phone, each tab keeps its scroll, and a tap on the tab shown goes back to its top", async () => {
    const page = await open(390, 600);
    await page.click(".tabbar button", "Sessions");
    const room = await page.eval<number>("document.documentElement.scrollHeight - innerHeight");
    assert.ok(room > 120, `the sessions scroll (${room} px)`);
    await page.eval("window.scrollTo(0, 120)");
    await page.eval(`[...document.querySelectorAll(".tabbar button")].find((b) => b.textContent.includes("Inbox")).click()`);
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
    await page.waitFor(`${link}?.getClientRects().length && document.getAnimations().length === 0`); // measured once the menu has opened
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

  /** A phone held by a finger, the checkout session's panel open on its latest message. */
  async function touchPanel(): Promise<Page> {
    const page = await open(390, 640);
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });
    await page.click(".tabbar button", "Sessions");
    await page.click(".scard", "checkout redesign");
    await page.waitFor("document.querySelector('#session .pchips button.chip') && document.querySelector('#session .session-body').scrollTop > 0 && document.getAnimations().length === 0");
    return page;
  }

  it("on a touch phone, keeps the session panel's chips one height, each button a finger's reach", async () => {
    const page = await touchPanel();
    const heights = await page.eval<number[]>("[...document.querySelectorAll('#session .pchips > .chip')].map((c) => Math.round(c.getBoundingClientRect().height))");
    assert.equal(new Set(heights).size, 1, `one height: ${heights}`);
    assert.ok(
      await page.eval<boolean>("(() => { const b = document.querySelector('#session .pchips button.chip'); const r = b.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.top - 5)?.closest('button.chip') === b; })()"),
      "a button chip still takes a tap just outside its pill",
    );
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
});
