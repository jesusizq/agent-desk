// What the key screens look like, against baselines drawn on the developer's machine: a change of
// layout or colour fails with a picture of where. `npm run visual:update` accepts an intended change.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { Store } from "../src/store/store.ts";
import { Browser, findChrome, type Page } from "./browser.ts";
import { serve, tempHome } from "./helpers.ts";

/** The demo's now and the page's, frozen: every time the page shows is the same on every run. */
const NOW = "2026-11-10T10:30:00.000Z";
const BASELINES = path.join(import.meta.dirname, "visual", process.platform);
/** The Chrome and the fonts the baselines were drawn with. */
const RENDERER = path.join(BASELINES, "renderer.json");
const OUT = path.join(os.tmpdir(), "agent-desk-visual");
const UPDATE = process.env.UPDATE_VISUAL === "1";
/** A channel off by more than this (of 255) counts its pixel as changed: a colour nudged by 3% already is. */
const CHANNEL_TOLERANCE = 8;
/** Changed pixels a screen may have: the logo's SVG edges rasterize up to 3 differently from run to run; a moved box changes hundreds. */
const ALLOWED_PIXELS = 16;

const chrome = findChrome();
function skipped(): string | false {
  // Fonts, their hinting and Chrome's version are the machine's: CI draws text differently from the baselines.
  if (process.env.CI) return "the baselines are drawn on the developer's machine, whose fonts CI does not have";
  if (!chrome) return "no Chrome found (set AGENT_DESK_CHROME)";
  if (!UPDATE && !fs.existsSync(RENDERER)) return `no baselines for ${process.platform} in ${BASELINES}: \`npm run visual:update\` draws them`;
  return false;
}

type Renderer = { chrome: string; fonts: string[] };
type Device = "desktop" | "phone";
type Theme = "light" | "dark";
type Screen = { name: string; device: Device; theme: Theme; quiet?: boolean; marked?: boolean; show?: (page: Page) => Promise<void> };

const STILL = "document.getAnimations().every((a) => a.effect?.getComputedTiming().iterations === Infinity)";
const arrived = (id: string) => `document.getElementById('${id}').open && !document.getElementById('${id}').getAnimations().length`;
const SIZES: Record<Device, { width: number; height: number; deviceScaleFactor: number; mobile: boolean }> = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  // Twice the pixels, as a phone draws them; three times would only make the files larger.
  phone: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
};

/** Runs before the page's own scripts: a frozen clock and the browser's first visit (Auto theme, nothing kept). */
const FIRST_VISIT = `(() => {
  const now = Date.parse(${JSON.stringify(NOW)});
  const Real = Date;
  window.Date = class extends Real {
    constructor(...args) { if (args.length) super(...args); else super(now); }
    static now() { return now; }
  };
  localStorage.clear();
})()`;

/** Waits for the fonts, the pictures and every finite animation, and holds the endless ones at their start. */
const SETTLE = `(async () => {
  await document.fonts.ready;
  await Promise.all([...document.images].filter((i) => i.src && i.checkVisibility()).map((i) => i.decode()));
  for (;;) {
    const moving = document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity);
    if (!moving.length) break;
    // A redraw cancels an animation, whose finished promise then rejects: either way it no longer moves.
    await Promise.allSettled(moving.map((a) => a.finished));
  }
  for (const a of document.getAnimations()) if (a.effect?.getComputedTiming().iterations === Infinity) (a.pause(), (a.currentTime = 0));
  for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
})()`;

/** A page a session made with its options marked for the desk's controls, in its own plain style. */
const MARKED_PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Empty cart headline</title>
<style>body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 20px; background: #f6f7f9; color: #1d2330 } h1 { font-size: 20px; margin: 0 0 16px }
article { background: #fff; border: 1px solid #dde1e8; border-radius: 12px; padding: 16px; margin: 0 0 12px } article p { margin: 0; font-size: 18px }
@media (prefers-color-scheme: dark) { body { background: #12151b; color: #e4e7ec } article { background: #1a1e26; border-color: #2c323d } }</style></head><body>
<h1>Empty cart headline</h1>
<section data-agent-desk-group="Which headline for the empty cart?">
<article data-agent-desk-option="A"><p>Your cart is empty.</p></article>
<article data-agent-desk-option="B"><p>Nothing here yet. Find something you like.</p></article>
<article data-agent-desk-option="C"><p>Your cart is empty! Start shopping →</p></article>
</section></body></html>`;

const desktop = (name: string, extra: Omit<Screen, "name" | "device" | "theme"> = {}): Screen[] =>
  (["light", "dark"] as const).map((theme) => ({ name: `${name}-${theme}`, device: "desktop", theme, ...extra }));

describe("what the page looks like", { skip: skipped() }, () => {
  let browser: Browser;
  let busy: Store;
  let urls: { busy: string; quiet: string; marked: string };
  let closers: (() => Promise<void>)[] = [];
  /** Compares two PNGs in Chrome itself, which decodes and encodes them without a PNG library. */
  let lab: Page;
  let renderer: Renderer;
  /** Why this machine cannot be compared with the baselines, if it cannot. */
  let mismatch: string | undefined;
  let recorded: Renderer | undefined;
  const pages: Page[] = [];

  /** The demo store at the frozen now, with a clock of its own for what is written later. */
  function demoStore(): Store {
    const home = path.join(tempHome(), "store");
    execFileSync(process.execPath, [path.join(import.meta.dirname, "../scripts/demo.ts"), home, NOW]);
    let t = Date.parse(NOW) + 1000;
    return new Store(home, () => new Date((t += 1)));
  }

  before(async () => {
    busy = demoStore();
    // A session the developer can write to while it works, so its panel shows the composer.
    busy.updateSession("demo-checkout", (s) => ({ ...s, takesMessagesWhileWorking: true }));
    const quiet = demoStore();
    for (const q of quiet.listQuestions()) if (q.status === "open") quiet.dismiss(q.id);
    for (const r of quiet.listResults()) if (!r.seenAt) quiet.markResultSeen(r.id);
    // The busy desk and one more review, whose page marks its options for the desk's controls.
    const marked = demoStore();
    marked.publishReview({ sessionId: "demo-checkout", title: "Empty cart headline", html: MARKED_PAGE });
    const servers = [await serve(busy), await serve(quiet), await serve(marked)];
    closers = servers.map((s) => s.close);
    urls = { busy: servers[0]?.base ?? "", quiet: servers[1]?.base ?? "", marked: servers[2]?.base ?? "" };
    browser = await Browser.launch(chrome ?? "");
    lab = await browser.newPage(64, 64);
    renderer = await measureRenderer();
    if (UPDATE) {
      fs.mkdirSync(BASELINES, { recursive: true });
      fs.writeFileSync(RENDERER, `${JSON.stringify(renderer, null, 2)}\n`);
      return;
    }
    const kept: unknown = JSON.parse(fs.readFileSync(RENDERER, "utf8"));
    const valid = (v: unknown): v is Renderer => typeof v === "object" && v !== null && "chrome" in v && typeof v.chrome === "string" && "fonts" in v && Array.isArray(v.fonts) && v.fonts.every((f) => typeof f === "string");
    if (!valid(kept)) throw new Error(`${RENDERER} is not { chrome, fonts }: draw it again with \`npm run visual:update\``);
    recorded = kept;
    if (recorded.fonts.join() !== renderer.fonts.join()) {
      mismatch = `this machine draws the page with ${renderer.fonts.join(", ")}; the baselines in ${BASELINES} were drawn with ${recorded.fonts.join(", ")}`;
    }
  });
  afterEach(async () => {
    const done = pages.splice(0);
    await Promise.all(done.map((page) => page.close()));
    for (const page of done) assert.deepEqual(page.errors, [], "the page reports no errors");
  });
  after(async () => {
    try {
      await browser?.close();
    } finally {
      await Promise.all(closers.map((close) => close()));
    }
  });

  /** The desk as `device` shows it, in `theme`, drawn and at rest. */
  async function open(device: Device, theme: Theme, quiet = false, marked = false): Promise<Page> {
    const size = SIZES[device];
    const page = await browser.newPage(size.width, size.height);
    pages.push(page);
    await page.send("Emulation.setDeviceMetricsOverride", size);
    const touch = device === "phone";
    if (touch) await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    const pointer = touch ? [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] : [];
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }, ...pointer] });
    await page.send("Emulation.setTimezoneOverride", { timezoneId: "Europe/Madrid" });
    await page.send("Emulation.setLocaleOverride", { locale: "en-GB" });
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: FIRST_VISIT });
    await page.goto((quiet ? urls.quiet : marked ? urls.marked : urls.busy) + "/");
    await page.waitFor(quiet ? "document.querySelector('.board.quiet .all-clear')" : "document.querySelector('.next') && document.querySelectorAll('.scard').length === 3");
    await page.waitFor(`document.documentElement.dataset.theme === '${theme}'`);
    // Inherited by every box: a blinking caret would make two captures differ.
    await page.eval("document.documentElement.style.caretColor = 'transparent'");
    return page;
  }

  /** The platform fonts the busy desk's text is drawn with, and the Chrome drawing it. */
  async function measureRenderer(): Promise<Renderer> {
    const page = await open("desktop", "light");
    const { product } = await browser.send<{ product: string }>("Browser.getVersion");
    await page.send("DOM.enable");
    await page.send("CSS.enable");
    const { root } = await page.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: -1 });
    const { nodeIds } = await page.send<{ nodeIds: number[] }>("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "body *" });
    const fonts = new Set<string>();
    for (const nodeId of nodeIds) {
      const { fonts: used } = await page.send<{ fonts: { postScriptName: string }[] }>("CSS.getPlatformFontsForNode", { nodeId });
      for (const f of used) fonts.add(f.postScriptName);
    }
    await page.close();
    pages.splice(pages.indexOf(page), 1);
    assert.deepEqual(page.errors, [], "the page reports no errors");
    return { chrome: product, fonts: [...fonts].sort() };
  }

  /** The viewport once it no longer changes: two captures in a row alike, the pointer parked on the header's empty middle. */
  async function capture(page: Page, device: Device): Promise<Buffer> {
    await page.send("Page.bringToFront");
    if (device === "desktop") {
      const [x, y] = await page.eval<[number, number]>("(() => { const r = document.querySelector('.top .spacer').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()");
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    }
    let last: Buffer | undefined;
    for (let i = 0; i < 10; i++) {
      await page.eval(SETTLE);
      const shot = await page.screenshot();
      if (last?.equals(shot)) return shot;
      last = shot;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error("the screen kept changing over 10 captures: something on it moves or keeps loading");
  }

  /** How many pixels differ beyond the tolerance, and a picture of them: magenta on a faded baseline. */
  async function compare(baseline: Buffer, actual: Buffer): Promise<{ size?: string; changed: number; diff?: Buffer }> {
    const r = await lab.eval<{ size?: string; changed: number; diff?: string }>(`(async () => {
      const load = async (b64) => createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      const [a, b] = await Promise.all([load(${JSON.stringify(baseline.toString("base64"))}), load(${JSON.stringify(actual.toString("base64"))})]);
      if (a.width !== b.width || a.height !== b.height) return { size: a.width + "x" + a.height + " drawn " + b.width + "x" + b.height, changed: a.width * a.height };
      const pixels = (img) => { const c = new OffscreenCanvas(img.width, img.height).getContext("2d"); c.drawImage(img, 0, 0); return c.getImageData(0, 0, img.width, img.height).data; };
      const [pa, pb] = [pixels(a), pixels(b)];
      const out = new ImageData(a.width, a.height);
      let changed = 0;
      for (let i = 0; i < pa.length; i += 4) {
        const off = Math.abs(pa[i] - pb[i]) > ${CHANNEL_TOLERANCE} || Math.abs(pa[i + 1] - pb[i + 1]) > ${CHANNEL_TOLERANCE} || Math.abs(pa[i + 2] - pb[i + 2]) > ${CHANNEL_TOLERANCE};
        if (off) changed++;
        const grey = 255 - (255 - (pa[i] + pa[i + 1] + pa[i + 2]) / 3) * 0.25;
        out.data.set(off ? [255, 0, 255, 255] : [grey, grey, grey, 255], i);
      }
      if (!changed) return { changed };
      const canvas = new OffscreenCanvas(a.width, a.height);
      canvas.getContext("2d").putImageData(out, 0, 0);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { changed, diff: btoa(s) };
    })()`);
    return { ...(r.size ? { size: r.size } : {}), changed: r.changed, ...(r.diff ? { diff: Buffer.from(r.diff, "base64") } : {}) };
  }

  const screens: Screen[] = [
    ...desktop("desk"),
    ...desktop("desk-quiet", { quiet: true }),
    ...desktop("session-agents", {
      show: async (page) => {
        await page.click(".scard", "checkout redesign");
        await page.waitFor(arrived("session"));
        await page.click("#session .pchips button.chip", "agents");
        await page.waitFor("document.querySelectorAll('#session .atimeline .abar').length === 5");
      },
    }),
    ...desktop("session-branches", {
      show: async (page) => {
        await page.click(".scard", "checkout redesign");
        await page.waitFor(arrived("session"));
        await page.click("#session .pchips button.chip", "agents");
        await page.waitFor("document.querySelectorAll('#session .branches-sec .brow').length === 4");
        await page.eval("document.querySelector('#session .branches-sec').scrollIntoView({ block: 'end' })");
      },
    }),
    ...desktop("result-compare", {
      show: async (page) => {
        const r = busy.listResults().find((x) => x.title === "Checkout: before and after");
        assert.ok(r, "the demo has its before and after");
        await page.eval(`location.hash = "#r=${r.id}"`);
        await page.waitFor(`${arrived("result")} && document.querySelector('#result .compare img')?.complete`);
      },
    }),
    ...desktop("history-search", {
      show: async (page) => {
        await page.click("#views button", "History");
        await page.click('[data-key="history-search"]');
        await page.type("VAT");
        await page.waitFor("document.querySelectorAll('.hlist mark').length");
      },
    }),
    { name: "phone-needs-you", device: "phone", theme: "light" },
    {
      name: "phone-sessions",
      device: "phone",
      theme: "light",
      show: async (page) => {
        await page.tap(".tabbar button", "Sessions");
        await page.waitFor(`document.querySelector('.tabbar button[aria-pressed="true"]')?.textContent.includes('Sessions') && ${STILL}`);
      },
    },
    {
      name: "phone-session-branches",
      device: "phone",
      theme: "light",
      show: async (page) => {
        await page.tap(".tabbar button", "Sessions");
        await page.waitFor(STILL);
        await page.tap(".scard", "checkout redesign");
        await page.waitFor(arrived("session"));
        await page.tap("#session .pchips button.chip", "agents");
        await page.waitFor("document.querySelectorAll('#session .branches-sec .brow').length === 4");
        await page.eval("document.querySelector('#session .branches-sec').scrollIntoView({ block: 'end' })");
      },
    },
    {
      name: "phone-session-composer",
      device: "phone",
      theme: "light",
      show: async (page) => {
        await page.tap(".tabbar button", "Sessions");
        await page.waitFor(STILL);
        await page.tap(".scard", "checkout redesign");
        await page.waitFor(`${arrived("session")} && document.querySelector('#session .chat-footer textarea')`);
      },
    },
    ...desktop("review-open", { show: (page) => openReview(page, "Checkout copy proposals") }),
    ...desktop("review-send", {
      show: async (page) => {
        await openReview(page, "Checkout copy proposals");
        await page.click(".rv-send");
        await page.waitFor(`${arrived("review-send")} && document.querySelector('.rv-answers pre')`);
        // The developer's note, shown after the line exactly as it goes.
        await page.eval("(() => { const t = document.querySelector('.rv-note textarea'); t.value = 'Drop 2 and 5. Iterate 3: keep it under six words.'; t.dispatchEvent(new Event('input')); })()");
        await page.waitFor("document.querySelector('#review-send .rv-line-text').textContent.endsWith('under six words.')");
        await sameId(page);
      },
    }),
    {
      name: "phone-review-tab",
      device: "phone",
      theme: "light",
      show: async (page) => {
        await page.tap(".tabbar button", "To review");
        await page.waitFor(`document.querySelector('.tabbar button[aria-pressed="true"]')?.textContent.includes('To review') && ${STILL}`);
      },
    },
    { name: "phone-review-open", device: "phone", theme: "light", show: (page) => openReview(page, "Checkout copy proposals", true) },
    {
      name: "phone-review-send",
      device: "phone",
      theme: "dark",
      show: async (page) => {
        await openReview(page, "Landing hero headlines", true);
        await page.tap(".rv-send");
        await page.waitFor(`${arrived("review-send")} && document.querySelector('#review-send input[value=other]').checked`);
        await sameId(page);
      },
    },
    ...desktop("review-options", { marked: true, show: (page) => markOptions(page, false) }),
    { name: "phone-review-options", device: "phone", theme: "light", marked: true, show: (page) => markOptions(page, true) },
    {
      name: "phone-display-menu",
      device: "phone",
      theme: "light",
      show: async (page) => {
        await page.tap("#theme");
        await page.waitFor("!document.querySelector('#display-menu').hidden");
      },
    },
  ];

  /** The review's id in the line shown is drawn at random by each demo store: one fixed id in its place keeps the screen the same. */
  const sameId = (page: Page) => page.eval("(() => { const line = document.querySelector('#review-send .rv-line-text'); line.textContent = line.textContent.replace(/agent-desk review rv-[\\w-]+/, 'agent-desk review rv-demo'); })()");

  /** The review whose page marks its options, open, with one chosen and one to iterate. */
  async function markOptions(page: Page, touch: boolean): Promise<void> {
    await openReview(page, "Empty cart headline", touch);
    const root = (label: string) => `document.querySelector('[data-agent-desk-option="${label}"] agent-desk-control').shadowRoot`;
    await page.inFrame("/review/", `new Promise((r) => { const ready = () => (document.querySelectorAll('agent-desk-control').length === 4 ? r(true) : setTimeout(ready, 50)); ready(); })`);
    // Every screen opens the same store: a pick already made by the screen before is left as it is.
    const press = (label: string, pick: string) => `(${root(label)}.querySelector('button.${pick}').getAttribute('aria-pressed') === 'true' || ${root(label)}.querySelector('button.${pick}').click())`;
    await page.inFrame("/review/", `(${press("B", "choose")}, ${press("C", "iterate")}, true)`);
    await page.inFrame("/review/", `(() => { const t = ${root("C")}.querySelector('textarea'); t.value = 'Keep the link, lose the exclamation mark'; t.dispatchEvent(new Event('input', { bubbles: true, composed: true })); return true; })()`);
    await page.waitFor("document.querySelector('.rv-count')?.textContent === '1 of 1' && document.querySelector('.rv-saved')?.textContent.startsWith('Saved')");
  }

  /** A demo review open, its page drawn in its frame. */
  async function openReview(page: Page, title: string, touch = false): Promise<void> {
    if (touch) {
      await page.tap(".tabbar button", "To review");
      await page.waitFor(STILL);
      await page.tap(".rv-tile", title);
    } else await page.click(".rv-tile", title);
    await page.waitFor(`${arrived("review")} && document.querySelector('#review iframe') && document.querySelector('.rv-saved')`);
    await page.inFrame("/review/", "document.fonts.ready.then(() => true)");
  }

  for (const screen of screens) {
    it(screen.name, async (t) => {
      if (mismatch) return t.skip(mismatch);
      const page = await open(screen.device, screen.theme, screen.quiet, screen.marked);
      await screen.show?.(page);
      const actual = await capture(page, screen.device);
      const file = path.join(BASELINES, `${screen.name}.png`);
      const outActual = path.join(OUT, `${screen.name}.png`);
      const outDiff = path.join(OUT, `${screen.name}.diff.png`);
      fs.rmSync(outActual, { force: true });
      fs.rmSync(outDiff, { force: true });
      if (UPDATE) return fs.writeFileSync(file, actual);
      assert.ok(fs.existsSync(file), `no baseline ${file}: \`npm run visual:update\` draws it`);
      const result = await compare(fs.readFileSync(file), actual);
      if (result.size === undefined && result.changed <= ALLOWED_PIXELS) {
        if (result.changed) t.diagnostic(`${result.changed} pixels changed, within the ${ALLOWED_PIXELS} allowed`);
        return;
      }
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(outActual, actual);
      if (result.diff) fs.writeFileSync(outDiff, result.diff);
      const chromeNote = recorded && recorded.chrome !== renderer.chrome ? ` The baselines were drawn by ${recorded.chrome}, this is ${renderer.chrome}.` : "";
      assert.fail(
        `${screen.name} looks different from ${file}: ${result.size ?? `${result.changed} pixels changed (${ALLOWED_PIXELS} allowed)`}.\n` +
          `  drawn now: ${outActual}\n` +
          (result.diff ? `  changes in magenta: ${outDiff}\n` : "") +
          `  If the change is intended, accept it with \`npm run visual:update\`.${chromeNote}`,
      );
    });
  }
});
