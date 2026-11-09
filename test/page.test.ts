// The page in a real headless Chrome, over the demo store: what it draws, its windows and its layout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
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
  after(async () => {
    try {
      await browser?.close();
    } finally {
      await close?.();
    }
    for (const page of pages) assert.deepEqual(page.errors, [], "the page reports no errors");
  });

  /** The desk loaded at a window size, its data drawn. */
  async function open(width = 1400, height = 900): Promise<Page> {
    const page = await browser.newPage(width, height);
    pages.push(page);
    await page.goto(base + "/");
    await page.waitFor("document.querySelector('.next') && document.querySelectorAll('.scard').length");
    return page;
  }
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
    await page.waitFor(button);
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
      // As iOS: the layout keeps its height with the keyboard open, while the visual viewport and
      // innerHeight, which follows it there, shrink.
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `(() => {
          const vv = new EventTarget();
          window.covered = 0;
          Object.defineProperties(vv, { height: { get: () => 844 - covered }, offsetTop: { value: 0 }, scale: { value: 1 } });
          Object.defineProperty(window, "visualViewport", { value: vv });
          Object.defineProperty(window, "innerHeight", { get: () => vv.height, configurable: true });
          window.setKeyboard = (px) => { covered = px; vv.dispatchEvent(new Event("resize")); };
        })()`,
      });
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

  it("on a phone, gives the keyboard the room of the tab bar while writing", async () => {
    store.upsertSession({ id: "typing", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "typing on a phone", takesMessagesWhileWorking: true });
    const page = await open(390, 844);
    await page.click(".tabbar button", "Sessions");
    await page.click(".scard", "typing on a phone");
    const tabbar = "getComputedStyle(document.querySelector('.tabbar')).display";
    assert.notEqual(await page.eval<string>(tabbar), "none");
    await page.click("#session .chat-footer textarea");
    await page.waitFor(`${tabbar} === "none" && getComputedStyle(document.querySelector('.credits')).display === "none"`);
    await page.press("Escape");
    await page.waitFor(`${tabbar} !== "none"`);
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
        const armed = await page.eval<string>("document.querySelector('#session .danger').textContent");
        assert.notEqual(armed, "End session", "the first click asks for a second");
        store.mergeMetrics({ sessionId: "confirming", contextPercent: 60 });
        await page.waitFor("!document.querySelector('#session .mini.warn')");
        assert.equal(await page.eval<string>("document.querySelector('#session .danger').textContent"), armed, "still asking after the redraw");
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
});
