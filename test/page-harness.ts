// The page tests' shared harness: a demo desk, its server and a headless Chrome per test file, and the helpers the files share.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { renderOptionsPage } from "../src/cli/review-options.ts";
import { procInfo } from "../src/core/proc.ts";
import { Store } from "../src/store/store.ts";
import { Browser, findChrome, type Page } from "./browser.ts";
import { projectId, scanProject } from "../src/project/scan.ts";
import { gitIn, landedRepo, PNG, runScript, serve, tempHome, waitingScript } from "./helpers.ts";

export const chrome = findChrome();
/** Nothing on the page moving any more, but for the marks of work in progress, which turn for as long as the work goes on. */
/** The session card whose text holds `text`, as an expression for page.eval. */
export const cardOf = (text: string) => `[...document.querySelectorAll('.scard')].find((c) => c.textContent.includes(${JSON.stringify(text)}))`;
export const STILL = "document.getAnimations().every((a) => a.effect?.getComputedTiming().iterations === Infinity)";
/**
 * Fails when `part` jumps between two frames. Every motion of a redraw runs style.css's --dur-3 (280 ms) on
 * its --ease-out, cubic-bezier(.2, .8, .2, 1), whose steepest slope is 4.06: in dt ms nothing moving with
 * it goes farther than 4.1 × travel × dt / 280, travel being all it moves over the frames (moved in one go,
 * it goes all of it at once); 2 px more for the scroll, kept in whole pixels.
 */
export function smooth<K extends string>(frames: ({ t: number } & Record<K, number | null>)[], part: K, log: string) {
  const seen = frames.filter((f) => f[part] !== null) as ({ t: number } & Record<K, number>)[];
  assert.ok(seen.length >= 2, `the ${part} shows in at least two frames, to compare: ${log}`);
  const travel = Math.max(...seen.map((f) => f[part])) - Math.min(...seen.map((f) => f[part]));
  seen.forEach((f, i) => {
    const prev = seen[i - 1];
    if (!prev) return;
    const step = Math.abs(f[part] - prev[part]);
    assert.ok(step <= (4.1 * travel * (f.t - prev.t)) / 280 + 2, `the ${part} moves ${step.toFixed(1)} px in ${(f.t - prev.t).toFixed(1)} ms, of ${travel.toFixed(1)} in all: ${log}`);
  });
}

/** A file of page tests: skipped without Chrome. */
export const SKIP = { skip: chrome ? false : "no Chrome found (set AGENT_DESK_CHROME)" } as const;
export let browser: Browser;
export let store: Store;
export let base: string;
let close: () => Promise<void>;
export const pages: Page[] = [];

/** Each file's own demo desk and browser, set up before its tests and closed after them; a test's pages close with it. */
export function setupPage(): void {
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
}

/** The desk's first data drawn: its board, no longer the placeholder, and the sessions on it. */
export const DRAWN = "document.querySelector('.board:not([aria-busy])') && document.querySelectorAll('.scard').length";

/** The desk loaded at a window size, its data drawn. */
export async function open(width = 1400, height = 900): Promise<Page> {
  const page = await browser.newPage(width, height);
  pages.push(page);
  await page.goto(base + "/");
  await page.waitFor(DRAWN);
  return page;
}
/**
 * As iOS: the layout keeps its height with the keyboard open, while the visual viewport and
 * innerHeight, which follows it there, shrink. The page gets `setKeyboard(px)`.
 */
export const coveringKeyboard = (height: number) => `(() => {
  const vv = new EventTarget();
  window.covered = 0;
  Object.defineProperties(vv, { height: { get: () => ${height} - covered }, width: { get: () => document.documentElement.clientWidth }, offsetTop: { value: 0 }, scale: { value: 1 } });
  Object.defineProperty(window, "visualViewport", { value: vv });
  Object.defineProperty(window, "innerHeight", { get: () => vv.height, configurable: true });
  window.setKeyboard = (px) => { covered = px; vv.dispatchEvent(new Event("resize")); };
})()`;
/** A dialog open and done moving in (on a phone it slides in from the side). */
export const arrived = (id: string) => `document.getElementById('${id}').open && !document.getElementById('${id}').getAnimations().length`;
export const openDialogs = (page: Page) => page.eval<string[]>("[...document.querySelectorAll('dialog[open]')].map((d) => d.id)");
/** The state fetched now: as at the stream's next change or its slow poll, which a stubbed fetch would wait for. */
export const fetchNow = (page: Page) => page.eval("dispatchEvent(new Event('online'))");

/**
 * The desk at an address that is not this machine's, as a phone reaches it: forwarded under the Host
 * and Origin the desk accepts, with a review's frame ancestor named as the address reached, as the desk
 * names its tailnet host. Its pages close before it does: cut under an open page, the event stream reads
 * as a load error.
 */
export async function elsewhere(): Promise<{ url: string; close: () => Promise<void> }> {
  const target = new URL(base);
  let url = "";
  const proxy = http.createServer((req, res) => {
    const headers = { ...req.headers, host: target.host, ...(req.headers.origin ? { origin: target.origin } : {}) };
    const out = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers }, (up) => {
      const csp = up.headers["content-security-policy"];
      res.writeHead(up.statusCode ?? 502, { ...up.headers, ...(typeof csp === "string" ? { "content-security-policy": csp.replace(`frame-ancestors ${target.origin}`, `frame-ancestors ${new URL(url).origin}`) } : {}) });
      up.pipe(res);
    });
    out.on("error", (error) => res.writeHead(502).end(error.message));
    req.pipe(out);
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  url = `http://desk.localhost:${(proxy.address() as AddressInfo).port}/`;
  return {
    url,
    close: async () => {
      proxy.closeAllConnections();
      await new Promise((r) => proxy.close(r));
    },
  };
}

/** A result opened by its link, which leaves it unseen for the other tests. */
export async function openResultOf(page: Page, title: string): Promise<void> {
  const r = store.listResults().find((x) => x.title === title);
  assert.ok(r, `the demo has a result "${title}"`);
  await page.eval(`location.hash = "#r=${r.id}"`);
  await page.waitFor(arrived("result"));
}
/** A phone with a touch screen. */
export async function openPhone(): Promise<Page> {
  const page = await open(390, 844);
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  return page;
}
export const touch = (page: Page, type: string, points: [number, number][]) =>
  page.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });

/**
 * A page on a demo desk of its own, for a test that changes what every other test reads (results
 * marked seen), needs a machine of its own, or must not see what earlier tests left on the shared
 * desk; the page closes before its desk. A phone is 390 × 844 with a touch screen, else a 1400 × 900 window.
 */
export async function ownDesk(test: (page: Page, own: Store) => Promise<void>, prepare: (own: Store) => void = () => {}, { machine, phone = false, speech }: { machine?: Parameters<typeof serve>[3]; phone?: boolean; speech?: Parameters<typeof serve>[4] } = {}): Promise<void> {
  const home = path.join(tempHome(), "store");
  execFileSync(process.execPath, [path.join(import.meta.dirname, "../scripts/demo.ts"), home]);
  const own = new Store(home);
  prepare(own);
  const desk = await serve(own, undefined, undefined, machine, speech);
  const page = phone ? await browser.newPage(390, 844) : await browser.newPage(1400, 900);
  try {
    if (phone) await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await page.goto(desk.base + "/");
    await page.waitFor(DRAWN);
    await test(page, own);
  } finally {
    await page.close();
    await desk.close();
  }
  assert.deepEqual(page.errors, [], "the page reports no errors");
}
export const ownPhone = (test: (page: Page, own: Store) => Promise<void>, prepare?: (own: Store) => void, machine?: Parameters<typeof serve>[3]) => ownDesk(test, prepare, { machine, phone: true });
/** Whether a finger lands on the element at its centre, or at the height `y` gives from its box `r`: in the viewport, and nothing else on top. */
export const underFinger = (el: string, y = "r.y + r.height / 2") =>
  `(() => { const el = ${el}; const r = el.getBoundingClientRect(); const x = r.x + r.width / 2, y = ${y}; const top = x >= 0 && x < innerWidth && y >= 0 && y < innerHeight ? document.elementFromPoint(x, y) : null; return !!top && el.contains(top); })()`;
/** A machine past its cores' load and short of memory: two warnings, its files the test may change. */
export function sickMachine(): { proc: string; sys: string; cores: number } {
  const sick = tempHome();
  fs.writeFileSync(path.join(sick, "loadavg"), "21.37 9.00 4.00 9/900 1234\n");
  fs.writeFileSync(path.join(sick, "meminfo"), "MemTotal:       32000000 kB\nMemAvailable:    1953125 kB\n");
  return { proc: sick, sys: sick, cores: 12 };
}
export const LONG_PROJECT = "/home/demo/Projects/a-checkout-project-with-a-long-name";
/** A project with a long name whose merged worktrees hold 8 GB (a warning), or none any more. */
export function worktrees(own: Store, merged = true): void {
  const dir = LONG_PROJECT;
  const worktree = (n: number) => ({ path: `${dir}/.claude/worktrees/w${n}`, branch: `agent/w${n}`, head: `abc123${n}`, main: false, merged: true, bytes: 4e9 });
  const main = { path: dir, branch: "main", head: "abc1234", main: true, bytes: 1e9 };
  const total = merged ? 9e9 : 1e9;
  own.putProjectScan({ id: projectId(dir), name: path.basename(dir), dir, worktrees: merged ? [main, worktree(1), worktree(2)] : [main], totalBytes: total, dayStart: { day: "2026-10-28", bytes: total }, measuredAt: new Date().toISOString(), problems: [] });
}
/** Plan windows: the 5 h one runs out before it resets (a warning); the 7 d one gets to about 90% by its reset, which only informs. */
export function planWindows(own: Store): void {
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const hour = 3600_000;
  own.recordPlan([{ label: "5 h", percent: 50, resetsAt: at(3 * hour) }], at(-40 * 60_000));
  own.recordPlan([{ label: "5 h", percent: 70, resetsAt: at(3 * hour) }], at(-60_000));
  own.recordPlan([{ label: "7 d", percent: 10, resetsAt: at(120 * hour) }], at(-72 * hour));
  own.recordPlan([{ label: "7 d", percent: 40, resetsAt: at(120 * hour) }], at(-60_000));
}
/** The page's state with web-shop's disk short of space, which the test machine's own disk may not be; fetched in full, never as not modified. */
export const LOW_DISK = `(() => { const real = window.fetch.bind(window); window.fetch = async (url, init) => {
  if (String(url) !== "/api/state") return real(url, init);
  const body = await (await real(url, { ...init, headers: {} })).json();
  body.disk = [{ dir: "/home/demo/Projects/web-shop", projects: ["web-shop"], freeBytes: 12e9, totalBytes: 500e9 }];
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}; })()`;

/** A phone held by a finger, the checkout session's panel open on its latest message. */
export async function touchPanel(): Promise<Page> {
  const page = await open(390, 640);
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });
  await page.click(".tabbar button", "Sessions");
  await page.click(".scard", "checkout redesign");
  await page.waitFor(`document.querySelector('#session .pchips button.chip') && document.querySelector('#session .session-body').scrollTop > 0 && ${STILL}`);
  return page;
}
