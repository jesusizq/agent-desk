// The page in a real headless Chrome, over the demo store: what it draws, its windows and its layout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { Store } from "../src/store/store.ts";
import { Browser, findChrome, type Page } from "./browser.ts";
import { serve, tempHome } from "./helpers.ts";

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

  it("opens a session from its card and closes it with Escape", async () => {
    const page = await open();
    await page.click(".scard");
    await page.waitFor("document.getElementById('session').open");
    await page.press("Escape");
    await page.waitFor("!document.getElementById('session').open");
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
