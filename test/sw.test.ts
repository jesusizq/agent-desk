// The service worker in a real headless Chrome: what a device shows when the computer stops answering.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { Browser, findChrome } from "./browser.ts";

const chrome = findChrome();
const SW = fs.readFileSync(path.join(import.meta.dirname, "../src/web/sw.js"));
const PAGE = `<!doctype html><title>desk</title><script>navigator.serviceWorker.register("/sw.js");</script>`;

describe("service worker", { skip: chrome ? false : "no Chrome found (set AGENT_DESK_CHROME)" }, () => {
  let browser: Browser;
  let server: http.Server;
  let base: string;
  let mode: "up" | "hung" | "gateway" | "locked" = "up";
  const SAVED_TEXT = "the desk";

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/sw.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(SW);
      if (req.url === "/") {
        if (mode === "hung") return; // never answered: a computer asleep
        if (mode === "gateway") return res.writeHead(502).end("Bad Gateway");
        if (mode === "locked") return res.writeHead(200, { "Content-Type": "text/html", "X-Agent-Desk-Locked": "1" }).end("<!doctype html><title>pin</title>Enter your PIN");
        return res.writeHead(200, { "Content-Type": "text/html" }).end(`${PAGE}${SAVED_TEXT}`);
      }
      return res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await Browser.launch(chrome ?? "");
  });
  after(async () => {
    try {
      await browser?.close();
    } finally {
      server?.closeAllConnections();
      await new Promise((r) => server?.close(r));
    }
  });

  it("shows the saved desk when the computer hangs or the desk is down, and never saves the PIN page", async () => {
    const page = await browser.newPage(800, 600);
    /** Loads the desk again and waits for the new document, not the old one still complete. */
    const load = async () => {
      await page.eval("window.oldDocument = true");
      await page.send("Page.navigate", { url: `${base}/` });
      await page.waitFor("window.oldDocument === undefined && document.readyState === 'complete'", 10_000);
      return page.eval<string>("document.title");
    };
    await page.goto(`${base}/`);
    await page.eval("navigator.serviceWorker.ready");
    await load(); // this load goes through the worker, which saves it
    assert.equal(await page.eval<boolean>(`caches.match("/").then(Boolean)`), true, "saved");

    mode = "gateway";
    assert.equal(await load(), "desk", "a 502 from the gateway shows the saved desk");
    assert.ok((await page.eval<string>("document.body.textContent")).includes(SAVED_TEXT));

    mode = "hung";
    assert.equal(await load(), "desk", "no answer at all shows the saved desk once the wait ends");

    mode = "locked";
    assert.equal(await load(), "pin", "a locked device sees the PIN page, not the saved desk");
    mode = "gateway";
    assert.equal(await load(), "desk", "and the PIN page did not replace the saved desk");
  });
});
