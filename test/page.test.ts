// The page in a real headless Chrome, over the demo store: what it draws, its windows and its layout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
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
    assert.equal(await page.eval<boolean>(`!!${card}.querySelector('.adots .live .st-working')`), true, "a working dot for the session");
    assert.match(await page.eval<string>(`${card}.querySelector('.adots').textContent`), /1 done/);
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
    // Opening the question runs a view transition, which takes the clicks until it ends.
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await page.click(".qrow", "Shall I free the disk?");
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
    await page.click("#session .chat-footer .primary");
    await page.waitFor("document.querySelector('#toasts')?.textContent.includes('release notes')");
    assert.deepEqual(store.takeInbox("mid-turn").map((e) => e.answer), ["and push it when the tests pass"]);
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
});
