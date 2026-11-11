// The service worker in a real headless Chrome: what a device shows when the computer stops answering.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as vm from "node:vm";
import { reviewCsp, reviewHeaders } from "../src/server/security.ts";
import { reviewDocument } from "../src/server/server.ts";
import { Browser, findChrome } from "./browser.ts";

const chrome = findChrome();
const SW = fs.readFileSync(path.join(import.meta.dirname, "../src/web/sw.js"));
const PAGE = `<!doctype html><title>desk</title><script>navigator.serviceWorker.register("/sw.js");</script>`;

type Shown = { body: string; close: () => void };

/** The worker on a device that, like iOS (WebKit bug 258922), stacks notifications whatever their tag. */
function workerOnIos(getNotifications?: () => Promise<Shown[]>, deleteCache?: (name: string) => Promise<boolean>) {
  const screen: Shown[] = [];
  const deleted: string[] = [];
  const caches = { delete: deleteCache ?? (async (name: string) => (deleted.push(name), true)) };
  const listeners = new Map<string, (e: unknown) => void>();
  const registration = {
    getNotifications: getNotifications ?? (async () => [...screen]),
    showNotification: async (_title: string, options: { body: string }) => {
      const shown: Shown = { body: options.body, close: () => void screen.splice(screen.indexOf(shown), 1) };
      screen.push(shown);
    },
  };
  const self = { addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn), registration, navigator: {} };
  const logged: unknown[][] = [];
  vm.runInNewContext(SW.toString(), { self, caches, console: { error: (...args: unknown[]) => logged.push(args) } });
  const push = async (message: object) => {
    const waits: Promise<unknown>[] = [];
    listeners.get("push")?.({ data: { json: () => message }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  return { push, logged, deleted, bodies: () => screen.map((n) => n.body) };
}

describe("service worker notifications", () => {
  it("keeps one notification on the screen, with the latest count", async () => {
    const { push, bodies } = workerOnIos();
    await push({ count: 2 });
    await push({ count: 3 });
    await push({ count: 4 });
    assert.deepEqual(bodies(), ["4 need you"]);
  });

  it("replaces the count with the notice that the PIN ended, and deletes the desk the device kept", async () => {
    const { push, bodies, deleted } = workerOnIos();
    await push({ count: 2 });
    assert.deepEqual(deleted, [], "a count leaves the saved desk alone");
    await push({ pinEnded: true });
    assert.deepEqual(bodies(), ["Enter the PIN to keep getting notifications"]);
    assert.equal(deleted.length, 1, "the PIN ended: the saved desk is deleted");
  });

  it("still shows the notice that the PIN ended when the saved desk cannot be deleted, and says why", async () => {
    const { push, bodies, logged } = workerOnIos(undefined, () => Promise.reject(new Error("no cache storage")));
    await push({ pinEnded: true });
    assert.deepEqual(bodies(), ["Enter the PIN to keep getting notifications"]);
    assert.match(String(logged[0]), /no cache storage/);
  });

  it("still shows the notification when the old ones cannot be listed, since iOS requires one for every push", async () => {
    const { push, bodies, logged } = workerOnIos(() => Promise.reject(new Error("no list")));
    await push({ count: 2 });
    assert.deepEqual(bodies(), ["2 need you"]);
    assert.match(String(logged[0]), /no list/);
  });
});

describe("service worker requests", () => {
  it("leaves the event stream to the network, never answering it from the device", () => {
    const listeners = new Map<string, (e: unknown) => void>();
    const origin = "http://127.0.0.1:7420";
    vm.runInNewContext(SW.toString(), { self: { addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn), location: { origin } }, URL });
    const answered = (path: string) => {
      let taken = false;
      const respondWith = (p: Promise<unknown>) => {
        taken = true;
        p.catch(() => {}); // the cache this sandbox lacks makes the answer fail; only whether the worker took the request matters
      };
      listeners.get("fetch")?.({ request: { method: "GET", url: origin + path }, respondWith });
      return taken;
    };
    assert.equal(answered("/api/events"), false);
    assert.equal(answered("/api/state"), true, "while the state is kept");
  });
});

describe("service worker reviews", () => {
  /** The worker's own top-level names, as it runs. */
  const worker = () => {
    const context = vm.createContext({ self: { addEventListener: () => {} }, URL });
    vm.runInContext(SW.toString(), context);
    return (name: string) => vm.runInContext(name, context) as unknown;
  };

  it("serves a review offline with every header the desk serves it with, the sandbox above all", () => {
    const headers = worker()("reviewHeaders") as (origin: string) => Record<string, string>;
    for (const origin of ["http://127.0.0.1:7420", "https://desk.tailnet-name.ts.net"]) assert.deepEqual({ ...headers(origin) }, reviewHeaders(origin), origin); // spread: the worker runs in another realm, with its own Object
  });

  it("builds a review's page offline byte for byte as the desk does", () => {
    const inject = worker()("injectReview") as (html: string, state: unknown, shim: string) => string;
    const state = { data: { "a</script><script>alert(1)": "<b>x</b>" }, summary: "ok", rev: 3 };
    for (const html of ["<!doctype html><html><head><title>t</title></head><body>x</body></html>", '<HEAD lang="en"><meta charset="utf-8">', "<header>no head</header>", "<head/><p>"]) {
      assert.equal(inject(html, state, "/*shim*/"), reviewDocument(html, state, "/*shim*/"), html);
    }
  });
});

describe("service worker", { skip: chrome ? false : "no Chrome found (set AGENT_DESK_CHROME)" }, () => {
  let browser: Browser;
  let server: http.Server;
  let base: string;
  let mode: "up" | "hung" | "gateway" | "dropped" | "locked" = "up";
  /** Set, the desk answers as to a device that entered the PIN: with when its unlock ends. Unset, as to this computer. */
  let unlockEnds: number | undefined;
  const SAVED_TEXT = "the desk";
  const REVIEW = "rv-offline";
  const REVIEW_HTML = "<!doctype html><html><head><title>cards</title></head><body>cards</body></html>";
  const REVIEW_SHIM = "/* the shim */";
  let reviewSaved: { data: Record<string, string>; rev: number } = { data: {}, rev: 0 };

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/sw.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(SW);
      if (req.url?.startsWith("/review") || req.url?.startsWith("/api/reviews/")) {
        if (mode === "dropped") return req.socket.destroy();
        const unlock = unlockEnds === undefined ? {} : { "X-Agent-Desk-Unlock-Ends": String(unlockEnds) };
        if (req.url === "/review-shim.js") return res.writeHead(200, { "Content-Type": "text/javascript", ...unlock }).end(REVIEW_SHIM);
        if (req.url === `/review/${REVIEW}/raw`) return res.writeHead(200, { ...reviewHeaders(base), ...unlock }).end(REVIEW_HTML);
        if (req.url === `/review/${REVIEW}`) return res.writeHead(200, { ...reviewHeaders(base), ...unlock }).end(reviewDocument(REVIEW_HTML, reviewSaved, REVIEW_SHIM));
        if (req.url === `/api/reviews/${REVIEW}/state` && req.method === "GET") return res.writeHead(200, { "Content-Type": "application/json", ...unlock }).end(JSON.stringify(reviewSaved));
        if (req.url === `/api/reviews/${REVIEW}/state` && req.method === "POST") {
          let body = "";
          req.on("data", (c: Buffer) => (body += c.toString()));
          req.on("end", () => {
            const { ops } = JSON.parse(body) as { ops: { op: string; key: string; value: string }[] };
            for (const o of ops) if (o.op === "set") reviewSaved.data[o.key] = o.value;
            reviewSaved.rev++;
            res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ rev: reviewSaved.rev }));
          });
          return;
        }
        return res.writeHead(404).end();
      }
      if (req.url === "/" || req.url === "/api/state") {
        if (mode === "hung") return; // never answered: a computer asleep
        if (mode === "gateway") return res.writeHead(502).end("Bad Gateway");
        if (mode === "dropped") return req.socket.destroy(); // no network at all
        const unlock = unlockEnds === undefined ? {} : { "X-Agent-Desk-Unlock-Ends": String(unlockEnds) };
        if (req.url === "/api/state") {
          if (mode === "locked") return res.writeHead(401, { "Content-Type": "application/json", "X-Agent-Desk-Locked": "1" }).end('{"error":"locked: enter the PIN"}');
          return res.writeHead(200, { "Content-Type": "application/json", ...unlock }).end('{"desk":true}');
        }
        if (mode === "locked") return res.writeHead(200, { "Content-Type": "text/html", "X-Agent-Desk-Locked": "1" }).end("<!doctype html><title>pin</title>Enter your PIN");
        return res.writeHead(200, { "Content-Type": "text/html", ...unlock }).end(`${PAGE}${SAVED_TEXT}`);
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

  /** A tab on the desk, starting with nothing saved, whose requests go through the worker. */
  async function openDesk() {
    mode = "up";
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
    await page.eval("caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n))))");
    await load(); // this load goes through the worker, which saves it
    /** What the worker answers for `route` now: the page's title, the state's text, or "failed". */
    const fetched = (route: string) => page.eval<string>(`fetch(${JSON.stringify(route)}).then((r) => r.text()).then((t) => /<title>(.*?)<\\/title>/.exec(t)?.[1] ?? t, () => "failed")`);
    const savedCount = () => page.eval<number>("caches.keys().then((names) => Promise.all(names.map((n) => caches.open(n).then((c) => c.keys())))).then((all) => all.flat().length)");
    return { page, load, fetched, savedCount };
  }

  it("shows the saved desk when the computer hangs or the desk is down, and on this computer keeps it", async () => {
    unlockEnds = undefined;
    const { page, load } = await openDesk();
    assert.equal(await page.eval<boolean>(`caches.match("/").then(Boolean)`), true, "saved");

    mode = "gateway";
    assert.equal(await load(), "desk", "a 502 from the gateway shows the saved desk");
    assert.ok((await page.eval<string>("document.body.textContent")).includes(SAVED_TEXT));

    mode = "hung";
    assert.equal(await load(), "desk", "no answer at all shows the saved desk once the wait ends");
  });

  it("deletes a device's saved desk once the desk answers it is locked, and never saves the PIN page", async () => {
    unlockEnds = Date.now() + 3600_000;
    const { load, fetched, savedCount } = await openDesk();
    assert.equal(await fetched("/api/state"), '{"desk":true}');
    assert.equal(await savedCount(), 2, "the page and the state are saved while the unlock lasts");
    mode = "gateway";
    assert.equal(await load(), "desk", "while the unlock lasts the device shows the saved desk");

    mode = "locked";
    assert.match(await fetched("/api/state"), /locked/, "the state answers 401 locked");
    assert.equal(await savedCount(), 0, "a locked answer to the state deletes every saved copy");
    mode = "up";
    await load();
    mode = "locked";
    assert.equal(await load(), "pin", "a locked device sees the PIN page, not the saved desk");
    assert.equal(await savedCount(), 0, "the PIN page deletes the saved desk, and is not saved in its place");

    mode = "gateway";
    assert.notEqual(await load(), "desk", "the desk down, nothing saved is shown");
    mode = "dropped";
    assert.equal(await fetched("/"), "failed", "nor with no network at all");
  });

  it("never shows a device's saved desk once its unlock has ended, even offline, and deletes it", async () => {
    unlockEnds = Date.now() + 3600_000;
    const { page, fetched, savedCount } = await openDesk();
    assert.equal(await fetched("/api/state"), '{"desk":true}');
    assert.equal(await savedCount(), 2);
    // The device's clock passes the end while the computer does not answer: the page's copy now says its unlock ended.
    await page.eval(`caches.keys().then(async ([name]) => {
      const cache = await caches.open(name);
      const saved = await cache.match("/");
      const headers = new Headers(saved.headers);
      headers.set("X-Agent-Desk-Unlock-Ends", String(Date.now() - 1));
      await cache.put("/", new Response(await saved.blob(), { headers }));
    })`);
    mode = "dropped";
    assert.equal(await fetched("/"), "failed", "no network: the ended copy is not shown");
    assert.equal(await savedCount(), 0, "and every saved copy is deleted, the state's too");

    unlockEnds = Date.now() - 1000;
    mode = "up";
    assert.equal(await fetched("/"), "desk", "an answer under an unlock already ended by this device's clock is shown");
    assert.equal(await savedCount(), 0, "but not saved");
  });

  it("opens a review offline from what the device kept, with the changes made since, under the review's sandbox", async () => {
    unlockEnds = Date.now() + 3600_000;
    reviewSaved = { data: { a: "1" }, rev: 1 };
    const { page, savedCount } = await openDesk();
    /** What the worker answers for a review route: its status, headers and text, or "failed". */
    const get = (route: string, init = "{}") =>
      page.eval<{ status: number; headers: Record<string, string>; text: string } | "failed">(`fetch(${JSON.stringify(route)}, ${init}).then(async (r) => ({ status: r.status, headers: Object.fromEntries(r.headers), text: await r.text() }), () => "failed")`);
    const save = (key: string, value: string) => get(`/api/reviews/${REVIEW}/state`, `{ method: "POST", headers: { "Content-Type": "application/json" }, body: ${JSON.stringify(JSON.stringify({ ops: [{ op: "set", key, value }] }))} }`);
    // What the desk page fetches when it opens a review on a device with a worker (src/web/review.js).
    for (const route of [`/review/${REVIEW}/raw`, "/review-shim.js", `/api/reviews/${REVIEW}/state`]) assert.notEqual(await get(route), "failed");
    await save("b", "2");
    mode = "dropped";
    assert.equal(await save("c", "3"), "failed", "offline, the change does not reach the desk");
    const offline = await get(`/review/${REVIEW}`);
    assert.notEqual(offline, "failed");
    if (offline === "failed") return;
    assert.equal(offline.headers["content-security-policy"], reviewCsp(base), "the sandbox, offline as online: never the desk's origin");
    const expected = Object.fromEntries(Object.entries(reviewHeaders(base)).map(([k, v]) => [k.toLowerCase(), v]));
    for (const [k, v] of Object.entries(expected)) assert.equal(offline.headers[k], v, k);
    // Its saved page too, as the desk sent it.
    const raw = await get(`/review/${REVIEW}/raw`);
    assert.ok(raw !== "failed" && raw.headers["content-security-policy"] === reviewCsp(base));
    assert.equal(offline.text, reviewDocument(REVIEW_HTML, { data: { a: "1", b: "2", c: "3" }, rev: 2 }, REVIEW_SHIM), "the page with every change kept, sent or not");

    mode = "locked";
    assert.match(await page.eval<string>("fetch('/api/state').then((r) => r.text())"), /locked/);
    assert.equal(await savedCount(), 0, "the PIN ended: the review's copies go with the rest");
    mode = "dropped";
    assert.equal(await get(`/review/${REVIEW}`), "failed");
  });
});
