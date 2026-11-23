// The page in a real headless Chrome, over the demo store: a quiet desk and its redraws.
import * as http from "node:http";
import * as path from "node:path";
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store/store.ts";
import { base, browser, cardOf, DRAWN, open, openDialogs, ownDesk, pages, setupPage, SKIP, STILL, store } from "./page-harness.ts";
import { procInfo } from "../src/core/proc.ts";
import { serve, tempHome } from "./helpers.ts";
import { type Page } from "./browser.ts";

describe("page: a quiet desk and its redraws", SKIP, () => {
  setupPage();

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
      for (const r of quiet.listReviews()) if (!r.closedAt) quiet.closeReview(r.id);
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
      assert.equal(await page.eval<string>("document.querySelector('.all-clear').textContent"), "All clearnothing needs you, nothing new to review", "only what is clear: no last answer to mistake for something waiting");
      for (const width of [1440, 1024, 800]) {
        await page.resize(width, 900);
        await page.waitFor("document.querySelector('.board.quiet .all-clear')");
        const rest = await page.eval<{ cut: boolean; height: number }>("(() => { const r = document.querySelector('.all-clear .clear-rest'); return { cut: r.scrollWidth > r.clientWidth, height: document.querySelector('.all-clear').getBoundingClientRect().height }; })()");
        assert.equal(rest.cut, false, `never cut at ${width} px`);
        assert.ok(rest.height < 50, `one line at ${width} px (${rest.height} px)`);
      }
      await page.resize(1440, 900);
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
      assert.equal(await page.eval<string>("document.querySelector('.col-review .col-body').textContent"), "Nothing new to review.Earlier results", "To review keeps only what is new: the results already seen are in History");
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

    it("counts on a rich card, among the finished, a failure its session has told of since", async () => {
      const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
      const project = { name: "web-shop", dir: "/home/demo/Projects/web-shop" };
      quiet.upsertSession({ id: "told-rich", provider: "Test", project, title: "told on a rich card", state: "waiting", turnEndedAt: ago(30) });
      new Store(quiet.paths.home, () => new Date(Date.now() - 60 * 60_000)).upsertAgent("told-rich", "profile", { goal: "Profile agent", state: "failed", activity: "Did not start: Permission to use Agent denied" });
      quiet.upsertAgent("told-rich", "docs", { goal: "Docs agent", activity: "Writing the guide", activityAt: ago(0) });
      quiet.upsertAgent("told-rich", "lint", { goal: "Lint agent", state: "done" });
      try {
        const page = await browser.newPage(1440, 900);
        pages.push(page);
        await page.goto(quietBase + "/");
        const card = cardOf("told on a rich card");
        await page.waitFor(`${card}?.querySelector('.s-agents')`);
        assert.deepEqual(await page.eval<string[]>(`[...${card}.querySelectorAll('.s-agent b')].map((b) => b.textContent)`), ["Docs agent"], "no red row for it");
        assert.equal(await page.eval<string>(`${card}.querySelector('.s-agents > .s-more').textContent`), "1 done · 1 failed");
      } finally {
        quiet.upsertSession({ id: "told-rich", provider: "Test", project, state: "ended" });
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
      assert.equal(await page.eval<string>("document.querySelector('.col-review .col-body').textContent"), "Nothing new to review.Earlier results", "To review as on the quiet desk: nothing new, and the way to earlier results");
      await page.resize(1440, 900);
      await page.waitFor("document.querySelector('.board.quiet')");
    });

    it("opens the results already seen in History from To review's calm empty state", async () => {
      const page = await openQuiet();
      assert.equal(await page.eval<number>("document.querySelectorAll('.col-review .rtile, .col-review .rrow').length"), 0, "no result already seen in To review");
      await page.click(".col-review .empty button", "Earlier results");
      await page.waitFor("document.body.dataset.view === 'history' && document.querySelector('#view').textContent.includes('Migration 0041 applied locally')");
    });
  });

  describe("redraws change only what changed, and lists move on their own cards", () => {
    it("keeps the focused card, the selected text and every node through new data and the 30 s tick", async () => {
      const page = await browser.newPage(1400, 900);
      pages.push(page);
      // The page's 30 s tick runs every 200 ms here.
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "const tick = window.setInterval; window.setInterval = (f, ms, ...a) => tick(f, ms === 30000 ? 200 : ms, ...a);" });
      await page.goto(base + "/");
      await page.waitFor(DRAWN);
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
      // A desk of its own with a third question: on the demo's two, the key has nothing past the picked one to go
      // to, and what earlier tests leave open on the shared desk would decide whether it does.
      const third = (own: Store) => own.ask({ sessionId: "demo-pagos", kind: "question", text: "Retry failed webhooks for a day or a week?", options: ["A day", "A week"] });
      await ownDesk(async (page) => {
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
      }, third);
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

    it("makes the code block holding the shell command a waiting session asks for a two-tap button that runs it, and only that block", async () => {
      const own = procInfo(process.pid);
      assert.ok(own?.start);
      const run = "! python3 /tmp/rules.py";
      const at = new Date().toISOString();
      store.upsertSession({ id: "asks-run", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "asks to run a command", state: "waiting", lastMessage: { text: `Run:\n\n\`\`\`\n! ls\n\`\`\`\n\nthen:\n\n\`\`\`\n${run}\n\`\`\``, at }, process: { pid: process.pid, start: own.start, ancestors: [] }, tmux: { socket: "/tmp/tmux-1000/default", pane: "%1", clients: [] } });
      try {
        const page = await open();
        await page.click(".scard", "asks to run a command");
        await page.waitFor("document.querySelectorAll('#session .conversation pre[data-copy]').length === 2");
        assert.equal(await page.eval<number>("document.querySelectorAll('#session [data-key=shell]').length"), 0, "none stored: both blocks only copy");

        store.updateSession("asks-run", (s) => ({ ...s, shellSuggestion: { text: run, at } }));
        const button = "document.querySelector('#session .conversation [data-key=shell]')";
        await page.waitFor(button);
        assert.equal(await page.eval<string>(`${button}.innerText.trim()`), run, "the block itself, its command shown");
        assert.deepEqual(await page.eval<string[]>("[...document.querySelectorAll('#session .conversation pre[data-copy]')].map((b) => b.textContent)"), ["! ls"], "the other block still copies");
        await page.eval(`(() => { window.sentKeys = []; const real = window.fetch; window.fetch = (route, init) => String(route).endsWith('/keys') ? (window.sentKeys.push(JSON.parse(init.body)), Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))) : real(route, init); })()`);
        const centred = (state: string) => page.eval<number>(`(() => { const b = ${button}.getBoundingClientRect(); const r = document.createRange(); r.selectNodeContents(${button}.querySelector('${state}')); const l = r.getBoundingClientRect(); return Math.abs((l.top + l.bottom) / 2 - (b.top + b.bottom) / 2); })()`);
        await page.click("#session .conversation [data-key=shell]");
        assert.equal(await page.eval<string>(`${button}.getAttribute('aria-label')`), "Run it? Read it first", "the first tap asks for a second");
        assert.ok((await centred(".arm-ask")) <= 1, "its question centred top to bottom");
        assert.deepEqual(await page.eval<unknown[]>("window.sentKeys"), []);
        // Within the 3 s it asks: page.click would first wait for its countdown bar to stop moving.
        await page.eval(`${button}.click()`);
        await page.waitFor("window.sentKeys.length === 1");
        assert.deepEqual(await page.eval<unknown[]>("window.sentKeys"), [{ action: "shell", command: run }]);
        store.updateSession("asks-run", ({ shellSuggestion: _sent, ...s }) => s); // as the server does once it typed it
        await page.waitFor(`${button}?.classList.contains('sent')`);
        assert.equal(await page.eval<string>(`${button}.getAttribute('aria-label')`), "Sent", "it shows it was sent after the command was dropped");
        assert.ok((await centred(".arm-done")) <= 1, "its outcome centred top to bottom");
        await page.waitFor("document.querySelectorAll('#session .conversation pre[data-copy]').length === 2", 6000);

        store.updateSession("asks-run", (s) => ({ ...s, state: "working", shellSuggestion: { text: run, at } }));
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(await page.eval<number>("document.querySelectorAll('#session [data-key=shell]').length"), 0, "never while the session works");
        await page.press("Escape");
      } finally {
        store.updateSession("asks-run", (s) => ({ ...s, state: "ended" }));
      }
    });

    it("shows on the /compact button the start of the instructions the session suggested, as plain text, and disarms it when they change", async () => {
      const own = procInfo(process.pid);
      assert.ok(own?.start);
      const at = new Date().toISOString();
      const long = `keep the plan, <b>the decisions</b> and the next steps ${"and every reason behind them ".repeat(20)}`.trim();
      store.upsertSession({ id: "suggests", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "suggests a compaction", process: { pid: process.pid, start: own.start, ancestors: [] }, tmux: { socket: "/tmp/tmux-1000/default", pane: "%1", clients: [] } });
      try {
        const page = await open();
        await page.click(".scard", "suggests a compaction");
        await page.click("#session .pchips .chip", "More");
        const button = "document.querySelector('#session [data-key=compact]')";
        await page.waitFor(button);
        assert.equal(await page.eval<string>(`${button}.innerText`), "/compact", "no suggestion: /compact alone");

        store.updateSession("suggests", (s) => ({ ...s, compactInstructions: { text: long, at } }));
        await page.waitFor(`${button}.querySelector('.compact-preview')`);
        assert.equal(await page.eval<string>(`${button}.querySelector('.compact-preview').textContent`), long, "as text, its markup shown, never drawn");
        assert.equal(await page.eval<number>(`${button}.querySelectorAll('b').length`), 0);
        assert.equal(await page.eval<string>(`${button}.title`), `/compact ${long}`, "all of it on hover");
        const clipped = await page.eval<{ shown: number; whole: number; width: number }>(`(() => { const p = ${button}.querySelector('.compact-preview'); return { shown: p.clientWidth, whole: p.scrollWidth, width: ${button}.getBoundingClientRect().width }; })()`);
        assert.ok(clipped.whole > clipped.shown && clipped.width < 400, `only its start, in a button of ${clipped.width}px`);

        // What the second click sends, kept here: this session's pane is no real one.
        await page.eval(`(() => { window.sentKeys = []; const real = window.fetch; window.fetch = (route, init) => String(route).endsWith('/keys') ? (window.sentKeys.push(JSON.parse(init.body)), Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))) : real(route, init); })()`);
        await page.click("#session [data-key=compact]");
        const armedAt = Date.now();
        assert.equal(await page.eval<string>(`${button}.getAttribute('aria-label')`), "Send /compact?", "the first click asks for a second");
        store.updateSession("suggests", (s) => ({ ...s, compactInstructions: { text: "keep only the next steps", at: new Date(Date.parse(at) + 1000).toISOString() } }));
        await page.waitFor(`${button}.querySelector('.compact-preview')?.textContent === 'keep only the next steps'`);
        assert.equal(await page.eval<boolean>(`${button}.classList.contains('armed')`), false, "new instructions need their own two clicks");
        assert.ok(Date.now() - armedAt < 3000, "disarmed by the change, before its 3 s ran out");

        await page.click("#session [data-key=compact]");
        // Within the 3 s it asks: page.click would first wait for its countdown bar to stop moving.
        await page.eval(`${button}.click()`);
        await page.waitFor("window.sentKeys.length > 0");
        assert.deepEqual(await page.eval<unknown>("window.sentKeys"), [{ action: "compact", instructions: "keep only the next steps" }], "the instructions it showed, for the server to check");

        // What its adapter says starts it afresh gets a button of its own, unless that is /compact itself.
        const fresh = "document.querySelector('#session [data-key=fresh]')";
        store.mergeMetrics({ sessionId: "suggests", coldResume: { command: "/compact" } });
        await page.waitFor(`${button}.isConnected && !${fresh}`);
        store.mergeMetrics({ sessionId: "suggests", coldResume: { command: "/ahorro:handoff" } });
        await page.waitFor(fresh);
        assert.equal(await page.eval<string>(`${fresh}.innerText`), "/ahorro:handoff");
        await page.click("#session [data-key=fresh]");
        assert.equal(await page.eval<string>(`${fresh}.getAttribute('aria-label')`), "Send /ahorro:handoff?", "the first click asks for a second");
        await page.eval(`${fresh}.click()`);
        await page.waitFor("window.sentKeys.length > 1");
        assert.deepEqual(await page.eval<unknown>("window.sentKeys.at(-1)"), { action: "fresh", command: "/ahorro:handoff" }, "the command it showed, for the server to check");
        // Each tap shows on the button: armed, then sent, then back to itself.
        await page.waitFor(`${fresh}.classList.contains('sent')`);
        assert.equal(await page.eval<string>(`${fresh}.getAttribute('aria-label')`), "Sent");
        await page.waitFor(`${fresh}.getAttribute('aria-label') === '/ahorro:handoff' && !${fresh}.classList.contains('fired')`);
        // A refused send says so on the button too, why in a toast.
        await page.eval(`(() => { const stub = window.fetch; window.fetch = (route, init) => String(route).endsWith('/keys') ? Promise.resolve(new Response(JSON.stringify({ error: 'the pane is gone' }), { status: 400, headers: { 'Content-Type': 'application/json' } })) : stub(route, init); })()`);
        await page.click("#session [data-key=fresh]");
        await page.eval(`${fresh}.click()`);
        await page.waitFor(`${fresh}.classList.contains('failed')`);
        assert.equal(await page.eval<string>(`${fresh}.innerText`), "Not sent");
        await page.waitFor("[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('the pane is gone'))");
        await page.press("Escape");
      } finally {
        store.updateSession("suggests", (s) => ({ ...s, state: "ended" }));
      }
    });

    it("shows each agent's cost beside its tokens and their sum on the agents chip, and over a large context's cold cache what resuming costs, with the command that starts afresh", async () => {
      const project = { name: "web-shop", dir: "/home/demo/Projects/web-shop" };
      store.upsertSession({ id: "cold", provider: "Test", project, title: "cold cache session", state: "waiting" });
      store.upsertAgent("cold", "pay", { goal: "Fix pay", state: "done", tokens: 1_200_000, costUsd: 1.5 });
      store.upsertAgent("cold", "cart", { goal: "Fix cart", state: "done", tokens: 40_000, costUsd: 0.25 });
      store.upsertAgent("cold", "copy", { goal: "Fix copy", state: "done", tokens: 900, costUsd: 0.002 });
      store.mergeMetrics({ sessionId: "cold", contextTokens: 180_000, contextPercent: 18, cacheExpiresAt: new Date(Date.now() - 60_000).toISOString(), coldResume: { command: "/ahorro:handoff", costUsd: 1.44 } });
      try {
        const page = await open();
        const card = cardOf("cold cache session");
        await page.waitFor(`${card}?.querySelector('.chip.warn')`);
        const chip = await page.eval<{ text: string; title: string }>(`(() => { const c = ${card}.querySelector('.chip.warn'); return { text: c.textContent, title: c.title }; })()`);
        assert.equal(chip.text, "Cold cache ≈ $1.44 · /ahorro:handoff");
        assert.match(chip.title, /prompt cache has expired.*≈ \$1\.44/);
        await page.click(".scard", "cold cache session");
        await page.waitFor("document.querySelector('#session .pchips .chip.warn')");
        assert.equal(await page.eval<string>("document.querySelector('#session .pchips .chip.warn').textContent"), "/ahorro:handoff");
        const agents = await page.eval<string>("[...document.querySelectorAll('#session .pchips > .chip')].find((c) => c.textContent.includes('agents')).textContent");
        assert.equal(agents.replace("▾", ""), "3 agents · $1.75");
        await page.click("#session .pchips button.chip", "agents");
        await page.waitFor("document.querySelectorAll('#session .ppart .arow[data-key^=agent-]').length === 3");
        assert.deepEqual((await page.eval<string[]>("[...document.querySelectorAll('#session .ppart .arow[data-key^=agent-]')].map((r) => r.title)")).sort(), ["1.2M tokens · $1.50", "40k tokens · $0.25", "900 tokens · <$0.01"], "a cheap agent never reads as free");
        await page.click("#session .pchips .chip", "More");
        await page.waitFor("[...document.querySelectorAll('#session .faint')].some((d) => d.textContent.includes('cache expired'))");
        assert.match(await page.eval<string>("[...document.querySelectorAll('#session .faint')].find((d) => d.textContent.includes('cache expired')).textContent"), /cache expired, resuming ≈ \$1\.44/);
        // A small context resumes cheaply: nothing to suggest.
        store.mergeMetrics({ sessionId: "cold", contextTokens: 40_000, contextPercent: 4 });
        await page.waitFor("!document.querySelector('#session .pchips .chip.warn')");
        await page.press("Escape");
        // Ended (kept on the desk by the question it ended on), nothing can run the command: its card suggests none.
        store.mergeMetrics({ sessionId: "cold", contextTokens: 180_000, contextPercent: 18 });
        await page.waitFor(`${card}?.querySelector('.chip.warn')`);
        store.updateSession("cold", (s) => ({ ...s, state: "ended", endedAsking: true, lastMessage: { text: "Shall I go on?", at: new Date().toISOString() } }));
        await page.waitFor(`${card}?.querySelector('.s-actions') && !${card}.querySelector('.chip.warn')`);
        // Nor does its panel.
        await page.click(".scard", "cold cache session");
        await page.waitFor("document.getElementById('session').open && document.querySelector('#session .pchips')?.textContent.includes('agents')");
        assert.equal(await page.eval<number>("document.querySelectorAll('#session .pchips .chip.warn').length"), 0);
        await page.press("Escape");
      } finally {
        store.updateSession("cold", (s) => ({ ...s, state: "ended" }));
        store.forgetSession("cold");
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
