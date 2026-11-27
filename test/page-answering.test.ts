// The page in a real headless Chrome, over the demo store: answering what a session asks.
import * as http from "node:http";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Store } from "../src/store/store.ts";
import { arrived, browser, cardOf, open, ownDesk, setupPage, SKIP, smooth, STILL, store } from "./page-harness.ts";
import { type Page } from "./browser.ts";

describe("page: answering what a session asks", SKIP, () => {
  setupPage();

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
    /** As a permission or dialog hook does: the session's listener waits for these very questions (`asking`'s end withdraws it). */
    const hookWaits = (id: string, ...questions: { id: string }[]) => store.listen(id, process.pid, { questions: questions.map((q) => q.id) });
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
        hookWaits("picking", store.ask({ sessionId: "picking", kind: "question", text: "Which sections go in the index?", options: ["Guides", "API reference", "Changelog"], several: true, dialog: true }));
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
        // A card on its way out keeps `.next` until it folds away: the one shown is the only one left.
        const atRest = (text: string) => `document.querySelectorAll('.next').length === 1 && document.querySelector('.next').textContent.includes(${JSON.stringify(text)}) && !document.querySelector('.next').getAnimations({ subtree: true }).length`;
        // The answered card stays 650 ms, then leaves and the rows move up: a row aimed at before then is clicked on its neighbour.
        const answeredGone = (text: string) => `![...document.querySelectorAll('.next')].some((c) => c.textContent.includes(${JSON.stringify(text)})) && !document.querySelector('[data-leaving]')`;
        const prompt = (text: string) => hookWaits("permitting", store.ask({ sessionId: "permitting", kind: "permission", text, options: ["Allow", "Deny"] }));
        prompt("Bash: rm -rf build");
        const page = await open();
        await page.click(".qrow", "Bash: rm -rf build");
        await page.waitFor(atRest("rm -rf build"));
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
        await page.waitFor(answeredGone("rm -rf build"));
        await page.click(".qrow", "make deploy");
        await page.waitFor(atRest("make deploy"));
        await page.click(".next textarea");
        await page.type("not on main");
        await page.click(".next .deny");
        assert.deepEqual(await answers("permitting", 1), ["not on main"], "the reason goes with Deny, as written");

        prompt("Bash: npm publish");
        await page.waitFor(answeredGone("make deploy"));
        await page.click(".qrow", "npm publish");
        await page.waitFor(atRest("npm publish"));
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
        hookWaits(
          "grouped",
          store.ask({ sessionId: "grouped", kind: "question", dialog: true, group: group(0), text: "Which engine should search use?", options: ["Pagefind", "Lunr"] }),
          store.ask({ sessionId: "grouped", kind: "question", dialog: true, group: group(1), text: "Which theme should it ship with?", options: ["Light", "Dark"] }),
        );
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
        hookWaits(
          "grouped-keys",
          store.ask({ sessionId: "grouped-keys", kind: "question", dialog: true, group: group(0), text: "Which port should the preview use?", options: ["5173", "8080"] }),
          store.ask({ sessionId: "grouped-keys", kind: "question", dialog: true, group: group(1), text: "Which browser should it open?", options: ["Chrome", "Firefox"] }),
        );
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

    /** What the frames below see of the large card, its scroll area and the last row below it. */
    type Frame = { t: number; redraw: boolean; scroll: number; card: number | null; box: number | null; row: number | null; resolved: boolean; leaving: boolean; heights: number };
    const DISMISS = "[...card.querySelectorAll('.actions button')].find((b) => b.textContent.includes('Dismiss')).click()";
    /**
     * Scrolls the large card 120 px past its scroll area's top, runs `act` on it (`card` in the page), and
     * records every frame, at its time, until it is gone and nothing moves: the scroll, the card's top against
     * the scroll area's, the top of the box it held (where its content showed) and of the last row below it,
     * and whether a redraw started moving the page since the frame before. `then` runs on the card that took its
     * place (`card` again), 4 frames after the card started leaving, while it still folds; `heights` counts
     * the animations of that card's height once it leaves too.
     */
    const recordFrames = (page: Page, phone: boolean, act: string, then?: string) =>
      page.eval<Frame[]>(`new Promise((done) => {
        const scroller = ${phone ? "document.scrollingElement" : "document.querySelector('.col-needs .col-body')"};
        const edge = () => ${phone ? "0" : "scroller.getBoundingClientRect().top + scroller.clientTop"};
        const card = document.querySelector('.next');
        const box = card.querySelector('.answer textarea');
        const row = [...document.querySelectorAll('.col-needs .qrow')].at(-1);
        scroller.scrollTop += card.getBoundingClientRect().top - edge() + 120;
        const frames = [];
        let next = null;
        const known = new WeakSet();
        const started = () => document.getAnimations().filter((a) => a.id === 'motion' && !known.has(a) && known.add(a)).length > 0;
        started();
        const sample = (t) => frames.push({ t, redraw: started(), scroll: scroller.scrollTop, card: card.isConnected ? card.getBoundingClientRect().top - edge() : null, box: box.isConnected ? box.getBoundingClientRect().top : null, row: row?.isConnected ? row.getBoundingClientRect().top : null, resolved: card.classList.contains('resolved'), leaving: card.hasAttribute('data-leaving'), heights: next?.hasAttribute('data-leaving') ? next.getAnimations().filter((a) => a.effect.getKeyframes().some((k) => 'height' in k)).length : 0 });
        sample(document.timeline.currentTime);
        ${act};
        const end = performance.now() + 4000;
        const tick = (t) => {
          sample(t);
          ${then ? `if (!next && frames.filter((f) => f.leaving).length === 4) {
            next = document.querySelector('.next:not([data-leaving])');
            ((card) => { ${then}; })(next);
          }` : ""}
          if ((!card.isConnected && !next?.isConnected && !document.getAnimations().some((a) => a.id === 'motion')) || performance.now() > end) done(frames);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })`);
    /** What holds however a scrolled card goes: nothing jumps, the scroll included, nor any of `parts`. */
    function nothingJumps(frames: Frame[], parts: ("box" | "row")[] = ["box", "row"]) {
      const [first] = frames;
      const log = JSON.stringify(frames);
      assert.ok(first && first.card !== null && first.card < -100, `the card's top starts out of sight: ${log}`);
      assert.equal(frames.at(-1)?.card, null, `the card went: ${log}`);
      // Where what is left is shorter than the window, the scroll follows the content down, never back up.
      assert.ok(frames.every((f, i) => i === 0 || f.scroll <= frames[i - 1]!.scroll + 0.5), `the scroll never goes back up: ${log}`);
      // It moves only as a redraw starts: pulled down mid-way, in whole pixels while the cards shrink by fractions, it would shake all below.
      assert.ok(frames.every((f, i) => i === 0 || f.redraw || f.scroll === frames[i - 1]!.scroll), `the scroll goes where it ends at once: ${log}`);
      // Each part is followed across the motion, from the frame before it starts: seen only before, it could not jump.
      const start = frames.findIndex((f) => f.redraw);
      assert.ok(start > 0, `a redraw started moving the page: ${log}`);
      for (const part of parts) {
        assert.ok(frames[start - 1]![part] !== null && frames.slice(start).filter((f) => f[part] !== null).length >= 2, `the ${part} shows as the page moves: ${log}`);
        smooth(frames, part, log);
      }
      return log;
    }

    // A phone 1000 px tall has little left below the card: the scroll must come down as it goes, and nothing may jump with it.
    for (const [phone, width, height] of [[false, 1400, 640], [true, 390, 700], [true, 390, 1000]] as const) {
      const below = height === 1000 ? " with little below it," : "";
      it(`${phone ? "on a phone, " : ""}answers or dismisses a large card scrolled past its top from what shows,${below} nothing below jumping`, async () => {
        const id = `scrolled-${width}x${height}`;
        const done = asking(id, "scrolled past the top");
        const context = Array.from({ length: 16 }, (_, i) => `Line ${i + 1}: what the session found before asking.`).join("\n");
        store.ask({ sessionId: id, kind: "question", text: "Answered while scrolled?", context, options: ["Yes", "No"] });
        store.ask({ sessionId: id, kind: "question", text: "Dismissed while scrolled?", context, options: ["Yes", "No"] });
        // Enough rows below for what is left to fill the window, whatever else the desk shows: the scroll can stay.
        if (!below) for (let i = 1; i <= 10; i++) store.ask({ sessionId: id, kind: "question", text: `Waiting below, ${i}?`, options: ["Yes", "No"] });
        try {
          const page = await open(width, height);
          const answer = "[...card.querySelectorAll('.opts button')].find((b) => b.textContent.includes('Yes')).click()";
          // Answered, the card shows its answer at once where its box was: only the rows below are followed.
          const acts = [["Answered while scrolled?", answer, ["row"]], ["Dismissed while scrolled?", DISMISS, ["box", "row"]]] as const;
          for (const [text, act, parts] of acts) {
            await page.click(".qrow", text);
            await page.waitFor(`document.querySelector('.next:not([data-leaving])')?.textContent.includes(${JSON.stringify(text)}) && ${STILL}`);
            const frames = await recordFrames(page, phone, act);
            const log = nothingJumps(frames, [...parts]);
            const staying = frames.filter((f) => !f.leaving && f.row !== null).map((f) => f.row!);
            assert.ok(staying.every((top, i) => i === 0 || top <= staying[i - 1]! + 0.5), `the rows below the answered card only rise: ${log}`);
            for (const f of frames.filter((f) => f.resolved && f.card !== null)) assert.ok(f.card! >= -1, `the answered card shows from its top: ${log}`);
            const shown = frames.filter((f) => f.box !== null).map((f) => f.box!);
            const followed: readonly string[] = parts;
            if (!below && followed.includes("box")) assert.ok(Math.max(...shown) - Math.min(...shown) <= 20, `what showed of the card stays in place as it goes, but for its padding folding: ${log}`);
          }
        } finally {
          done();
        }
      });
    }

    it("dismisses a large card scrolled past its top with little below it, on a desktop, nothing below jumping", async () => {
      const id = "scrolled-short-desk";
      const done = asking(id, "little below on a desktop");
      // A project of its own, shown alone: what earlier tests left on the desk would fill the column below the card.
      store.upsertSession({ id, provider: "Test", project: { name: "short-desk", dir: "/home/demo/Projects/short-desk" }, title: "little below on a desktop", state: "waiting" });
      // One paragraph a line: a desktop's wide card would run them together into a few lines, too short to scroll.
      const context = Array.from({ length: 28 }, (_, i) => `Line ${i + 1}: what the session found before asking.`).join("\n\n");
      store.ask({ sessionId: id, kind: "question", text: "Dismissed with little below?", context, options: ["Yes", "No"] });
      // Two rows below: the first becomes the large card, the second stays a row to follow.
      store.ask({ sessionId: id, kind: "question", text: "Waiting below the dismissed one?", options: ["Yes", "No"] });
      store.ask({ sessionId: id, kind: "question", text: "Last row below the dismissed one?", options: ["Yes", "No"] });
      try {
        const page = await open(1400, 900);
        await page.click("#projects button", "short-desk");
        await page.waitFor(`document.querySelector('.next:not([data-leaving])')?.textContent.includes('Dismissed with little below?') && document.querySelectorAll('.col-needs .qrow').length === 2 && ${STILL}`);
        const frames = await recordFrames(page, false, DISMISS);
        const log = nothingJumps(frames);
        assert.ok(frames.at(-1)!.scroll < frames[0]!.scroll - 50, `what is left ends above the column's bottom, so the scroll comes down: ${log}`);
      } finally {
        done();
      }
    });

    // On a desk of its own: with what earlier tests leave in Needs you, the row asked here may be the one that
    // overflows its column, which then scrolls its rows on its own, out of the document's scroll the redraw measures.
    it("measures how far the board scrolls only for a redraw that changes a column", async () => {
      const id = "measured-redraw";
      const prepare = (own: Store) => {
        own.upsertSession({ id, provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "measured only on a change", state: "waiting" });
      };
      await ownDesk(async (page, own) => {
        await page.waitFor(STILL);
        // Each measure takes the board's motions off their elements: a motion of a row counts the measures.
        await page.eval(`(() => {
          const row = document.querySelector('.col-needs .qrow');
          window.boardMotion = row.animate([{ opacity: 1 }, { opacity: 1 }], { id: 'motion', duration: 60000 });
          const effect = boardMotion.effect;
          const target = Object.getOwnPropertyDescriptor(KeyframeEffect.prototype, 'target');
          window.measures = 0;
          Object.defineProperty(effect, 'target', { get: () => target.get.call(effect), set: (el) => { if (el === null) measures++; target.set.call(effect, el); } });
          // Listing the page's animations forces a style pass too.
          const list = document.getAnimations.bind(document);
          window.listings = 0;
          document.getAnimations = () => (listings++, list());
        })()`);
        // Needs you scrolls with the document before and after the row, so the measure of the document takes its motions off.
        const ownScroll = "(() => { const e = document.querySelector('.col-needs .col-body'); return e.scrollHeight > e.clientHeight; })()";
        await page.eval("import('/state.js').then((m) => m.page.renderView())");
        assert.deepEqual(await page.eval(`({ measures, listings, ownScroll: ${ownScroll} })`), { measures: 0, listings: 0, ownScroll: false }, "a redraw that changes no list forces no layout to measure, nor lists the page's animations");
        own.ask({ sessionId: id, kind: "question", text: "Asked to change a column?", options: ["Yes", "No"] });
        await page.waitFor("[...document.querySelectorAll('.col-needs .qrow')].some((r) => r.textContent.includes('Asked to change a column?'))");
        assert.deepEqual(await page.eval(`({ measures, listings, ownScroll: ${ownScroll} })`), { measures: 1, listings: 1, ownScroll: false }, "a row added to Needs you is measured, once");
        await page.eval("boardMotion.cancel(); delete document.getAnimations");
      }, prepare);
    });

    // Needs you not overflowing scrolls with the document, which holds every column: one with a scroll of its
    // own carries its motions, which a redraw of Needs you neither takes off to measure nor starts again.
    it("on a desktop, a redraw of a column the document scrolls leaves alone the motions of a column scrolling on its own", async () => {
      const id = "own-scroll";
      const done = asking(id, "a column of its own scroll");
      store.upsertSession({ id, provider: "Test", project: { name: "scrolled-results", dir: "/home/demo/Projects/scrolled-results" }, title: "a column of its own scroll", state: "waiting" });
      const results = Array.from({ length: 24 }, (_, i) => store.addResult({ sessionId: id, title: `Result ${i + 1} filling its column` }));
      // Already asking: the next question only adds a row, and the board keeps its shape.
      store.ask({ sessionId: id, kind: "question", text: "Asked first beside a scrolled column?", options: ["Yes", "No"] });
      try {
        const page = await open(1400, 900);
        await page.click("#projects button", "scrolled-results");
        await page.waitFor(`document.querySelector('.col-review [data-key^="r-"]') && document.querySelector('.col-needs .next')?.textContent.includes('Asked first beside') && ${STILL}`);
        const scrolling = await page.eval<{ needs: boolean; review: boolean }>(`(() => {
          const scrolls = (sel) => { const e = document.querySelector(sel); return e.scrollHeight > e.clientHeight; };
          return { needs: scrolls('.col-needs .col-body'), review: scrolls('.col-review .col-body') };
        })()`);
        assert.deepEqual(scrolling, { needs: false, review: true }, "Needs you scrolls with the document, the results column on its own");
        // A change of height of the desk's in the results column, which counts each time it is taken off its element.
        await page.eval(`(() => {
          const tile = document.querySelector('.col-review [data-list] > [data-key]');
          window.ownMotion = tile.animate([{ height: tile.getBoundingClientRect().height + 'px' }, { height: tile.getBoundingClientRect().height + 'px' }], { id: 'motion', duration: 60000 });
          const effect = ownMotion.effect;
          const target = Object.getOwnPropertyDescriptor(KeyframeEffect.prototype, 'target');
          window.takenOff = 0;
          Object.defineProperty(effect, 'target', { get: () => target.get.call(effect), set: (el) => { if (el === null) takenOff++; target.set.call(effect, el); } });
        })()`);
        store.ask({ sessionId: id, kind: "question", text: "Asked beside a scrolled column?", options: ["Yes", "No"] });
        await page.waitFor("[...document.querySelectorAll('.col-needs .qrow')].some((r) => r.textContent.includes('Asked beside a scrolled column?'))");
        assert.deepEqual(await page.eval("({ takenOff, state: ownMotion.playState })"), { takenOff: 0, state: "running" }, "the results column's motion is neither measured nor started again");
        await page.eval("ownMotion.cancel()");
      } finally {
        for (const r of results) store.markResultSeen(r.id);
        done();
      }
    });

    it("puts back the motions and the leaving cards it set aside to measure the board, also when the measure fails", async () => {
      const id = "measure-fails";
      const done = asking(id, "measure fails");
      // A project of its own, shown alone: the cards dismissed are this test's.
      store.upsertSession({ id, provider: "Test", project: { name: "failing-shop", dir: "/home/demo/Projects/failing-shop" }, title: "measure fails", state: "waiting" });
      store.ask({ sessionId: id, kind: "question", text: "Dismissed first?", options: ["Yes", "No"] });
      store.ask({ sessionId: id, kind: "question", text: "Dismissed while the first folds?", options: ["Yes", "No"] });
      try {
        const page = await open(1400, 900);
        await page.click("#projects button", "failing-shop");
        await page.waitFor(`document.querySelector('.next:not([data-leaving])')?.textContent.includes('Dismissed first?') && ${STILL}`);
        // The second card goes while the first still folds, held mid-way, and reading how far the board scrolls throws.
        const seen = await page.eval<{ display: string; motions: number } | null>(`new Promise((done) => {
          const first = document.querySelector('.next');
          const read = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
          // Every failure shows a toast, through the action's promise or, uncaught, by the page's own handler.
          window.measureFailures = { thrown: 0, toasts: [] };
          new MutationObserver((records) => {
            for (const r of records) for (const n of r.addedNodes) if (n.textContent.includes('measure failed')) measureFailures.toasts.push(n.textContent);
          }).observe(document.getElementById('toasts'), { childList: true });
          const thrown = () => measureFailures.thrown > 0;
          ((card) => { ${DISMISS}; })(first);
          const end = performance.now() + 5000;
          let armed = false;
          // Checked at the frame after the failed redraw; how the page reports it may come later.
          const tick = () => {
            if (thrown() || performance.now() > end) {
              Object.defineProperty(Element.prototype, 'scrollHeight', read);
              const motions = first.getAnimations().filter((a) => a.id === 'motion');
              for (const a of motions) a.play();
              return done(thrown() ? { display: first.style.display, motions: motions.length } : null);
            }
            if (!armed && first.hasAttribute('data-leaving')) {
              armed = true;
              for (const a of first.getAnimations()) a.pause();
              const measuring = () => [...document.querySelectorAll('[data-leaving]')].some((el) => el.style.display === 'none');
              Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get() { if (measuring()) { measureFailures.thrown++; throw new Error('measure failed'); } return read.get.call(this); } });
              ((card) => { ${DISMISS}; })(document.querySelector('.next:not([data-leaving])'));
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        })`);
        assert.ok(seen, "the second card's redraw measured the board while the first card folded");
        assert.deepEqual({ display: seen.display, moving: seen.motions > 0 }, { display: "", moving: true }, "the folding card shows and goes on folding");
        // A redraw from the event stream fails as an uncaught rejection, reported in a task after that frame.
        await page.waitFor("measureFailures.toasts.length === measureFailures.thrown");
        const toasts = await page.eval<string[]>("measureFailures.toasts");
        // Uncaught, it is also an error of the page's, which reaches the test once the browser sends it: only then is it set aside.
        const uncaught = toasts.filter((t) => t.startsWith("Page error:")).length;
        const reported = () => page.errors.filter((e) => e.includes("measure failed"));
        for (const end = Date.now() + 5000; reported().length < uncaught && Date.now() < end; ) await page.eval("new Promise((r) => setTimeout(r, 50))");
        assert.equal(reported().length, uncaught, `each failure the page did not catch is reported, once: ${JSON.stringify({ toasts, errors: page.errors })}`);
        page.errors.splice(0, page.errors.length, ...page.errors.filter((e) => !e.includes("measure failed")));
      } finally {
        done();
      }
    });

    // A motion of the desk in the panel (a question rising into it) is not the desk's behind it: a redraw there
    // that took it off to measure the board would restore the panel's scroll, which ends a smooth scroll mid-way.
    for (const [phone, width, height] of [[false, 1400, 900], [true, 390, 844]] as const) {
      it(`${phone ? "on a phone, " : ""}a redraw of the desk behind the session panel leaves the developer's scroll of the panel going`, async () => {
        const id = `behind-panel-${width}`;
        const done = asking(id, "asks behind the panel");
        const text = `Asked behind the panel at ${width}`;
        try {
          const page = await open(width, height);
          await page.eval("location.hash = '#s=demo-checkout'");
          await page.waitFor(`${arrived("session")} && document.querySelector('#session .msg.from-session') && ${STILL}`);
          const scrolled = page.eval<{ at: number | null; target: number; end: number; turns: number; redraws: number }>(`new Promise((done) => {
            const body = document.querySelector('#session .session-body');
            // Taller while it runs, so the measure would also clamp the panel's scroll.
            const motion = body.firstElementChild.animate([{ marginBottom: '4000px' }, { marginBottom: '4000px' }], { id: 'motion', duration: 60000 });
            const ends = [0, body.scrollHeight - body.clientHeight];
            let target = 0, at = null, turns = 0, still = 0, last = -1;
            // The developer scrolls the panel down and up, smoothly, until the desk behind it redraws, then lets the scroll end.
            const go = () => { target = ends[++turns % 2]; body.scrollTo({ top: target, behavior: 'smooth' }); };
            window.panelRedraws = 0;
            window.panelAt = null;
            new MutationObserver((_, observer) => {
              const rows = [...document.querySelectorAll('#view .qrow')].filter((r) => r.textContent.includes(${JSON.stringify(text)})).length;
              if (rows <= panelRedraws) return;
              panelRedraws = rows;
              // Landed in the frame a leg of the scroll ended in, before the next began, it could not end one: the next question's is awaited.
              if (Math.abs(body.scrollTop - target) < 1) return;
              observer.disconnect();
              at = panelAt = body.scrollTop;
            }).observe(document.getElementById('view'), { childList: true, subtree: true });
            go();
            const tick = () => {
              const top = body.scrollTop;
              if (at === null && Math.abs(top - target) < 1) go();
              still = top === last ? still + 1 : 0;
              last = top;
              if ((at !== null && still >= 10) || window.panelGiveUp) {
                motion.cancel();
                done({ at, target, end: top, turns, redraws: panelRedraws });
              } else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          })`);
          for (let i = 1; i <= 5; i++) {
            store.ask({ sessionId: id, kind: "question", text: `${text}, ${i}?`, options: ["Yes", "No"] });
            await page.waitFor(`panelRedraws >= ${i}`);
            if ((await page.eval<number | null>("panelAt")) !== null) break;
          }
          await page.eval("window.panelGiveUp = panelAt === null");
          const seen = await scrolled;
          assert.ok(seen.at !== null && Math.abs(seen.at - seen.target) >= 1, `the desk redrew while the panel scrolled: ${JSON.stringify(seen)}`);
          assert.ok(Math.abs(seen.end - seen.target) < 1, `the panel's scroll went on to its end: ${JSON.stringify(seen)}`);
        } finally {
          done();
        }
      });
    }

    // A loaded machine draws few frames: the second card may go as the first ends its fold, and the card growing
    // in their place must not let the content dip below the scroll mid-way; rows below keep the scroll off the top.
    for (const slow of [false, true]) {
      const how = slow ? ", with rows below and a slow renderer," : "";
      it(`on a phone, dismisses a scrolled large card and the next one while the first still folds${how} nothing jumping`, async () => {
        const id = `scrolled-twice${slow ? "-slow" : ""}`;
        const done = asking(id, "dismissed in a row");
        const context = Array.from({ length: 16 }, (_, i) => `Line ${i + 1}: what the session found before asking.`).join("\n");
        store.ask({ sessionId: id, kind: "question", text: "First of two in a row?", context, options: ["Yes", "No"] });
        store.ask({ sessionId: id, kind: "question", text: "Second of two in a row?", context, options: ["Yes", "No"] });
        if (slow) for (let i = 1; i <= 4; i++) store.ask({ sessionId: id, kind: "question", text: `Below the two in a row, ${i}?`, options: ["Yes", "No"] });
        try {
          const page = await open(390, 1000);
          await page.click(".qrow", "First of two in a row?");
          await page.waitFor(`document.querySelector('.next:not([data-leaving])')?.textContent.includes('First of two in a row?') && ${STILL}`);
          // 20 ms of work in every frame, as on a machine busy with other work.
          if (slow) await page.eval("(() => { const busy = () => { const end = performance.now() + 20; while (performance.now() < end); if (!window.rested) requestAnimationFrame(busy); }; requestAnimationFrame(busy); })()");
          const frames = await recordFrames(page, true, DISMISS, DISMISS);
          await page.eval("window.rested = true");
          // The rows below change pace there, as the card growing above them stops to fold: only the first card's content keeps one.
          const log = nothingJumps(frames, ["box"]);
          assert.ok(frames.some((f) => f.heights), `the second card left while the first still folded: ${log}`);
          // Out of the page for a moment as the redraw drops it, it must still lose the growth it had, and fold from where it shows.
          assert.ok(frames.every((f) => f.heights <= 1), `the second card only folds once it leaves: ${log}`);
        } finally {
          done();
        }
      });
    }

    // Each redraw that moves a column starts again the folds still running there: a burst of them (the event
    // stream's) must not hold a card on its way out for longer than two lengths from its first start.
    it("a burst of redraws restarting a card's fold lets it leave within two lengths of its start", async () => {
      const id = "fold-burst";
      const done = asking(id, "folds through a burst");
      // A project of its own, shown alone, one question staying open: the board keeps its shape.
      store.upsertSession({ id, provider: "Test", project: { name: "burst-shop", dir: "/home/demo/Projects/burst-shop" }, title: "folds through a burst", state: "waiting" });
      store.ask({ sessionId: id, kind: "question", text: "Folds during a burst?", options: ["Yes", "No"] });
      store.ask({ sessionId: id, kind: "question", text: "Stays open during the burst?", options: ["Yes", "No"] });
      try {
        const page = await open(1400, 900);
        await page.click("#projects button", "burst-shop");
        await page.waitFor(`document.querySelector('.next:not([data-leaving])')?.textContent.includes('Folds during a burst?') && ${STILL}`);
        // Every change of height the card runs, when it started and ends on the document's timeline, and the
        // last frame it was seen running in.
        const seen = page.eval<{ move: number; folds: { start: number; end: number; last: number }[]; gone: boolean }>(`new Promise((done) => {
          const card = document.querySelector('.next');
          const css = getComputedStyle(document.documentElement).getPropertyValue('--dur-3').trim();
          const move = css.endsWith('ms') ? parseFloat(css) : parseFloat(css) * 1000;
          const folds = [];
          const known = new Map();
          const until = performance.now() + 5000;
          ${DISMISS};
          const tick = (now) => {
            for (const a of card.getAnimations()) {
              if (a.id !== 'motion' || a.playState !== 'running' || a.currentTime === null || !a.effect.getKeyframes().some((k) => 'height' in k)) continue;
              if (!known.has(a)) folds.push(known.set(a, {}).get(a));
              const start = now - a.currentTime;
              Object.assign(known.get(a), { start, end: start + a.effect.getComputedTiming().endTime, last: now });
            }
            if (!card.isConnected || performance.now() > until) done({ move, folds, gone: !card.isConnected });
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        })`);
        // A row a redraw every 70 ms, for longer than the fold could be held.
        for (let i = 1; i <= 20; i++) {
          store.ask({ sessionId: id, kind: "question", text: `Asked in the burst, ${i}?`, options: ["Yes", "No"] });
          await new Promise((r) => setTimeout(r, 70));
        }
        const { move, folds, gone } = await seen;
        const log = JSON.stringify({ move, folds });
        assert.ok(gone, `the card left: ${log}`);
        const [first] = folds;
        assert.ok(first && move > 0, `the card folded: ${log}`);
        assert.ok(folds.some((f) => f.start > first.start + move), `a redraw started its fold again past one length, where a whole length more would hold it: ${log}`);
        // Started again from where it was in the redraw's frame, each fold waits for the next frame to start, as the redraw's own do.
        assert.ok(folds.every((f, i) => i === 0 || f.end <= first.start + 2 * move + Math.max(0, f.start - folds[i - 1]!.last) + 1), `it never folds past two lengths from its start: ${log}`);
      } finally {
        done();
      }
    });

    // A row picked up grows into the large card over the rows it crosses: its height changes with a hold of its
    // stacking, and it slides up with another hold, which ends with the slide. A redraw of another column of the
    // same scroll starts the first two again, paused as they were, and leaves the slide's alone.
    it("a redraw that starts again a paused change of height leaves it paused, with what holds its stacking, and a slide's stacking ends with its slide", async () => {
      const id = "fold-paused";
      const other = "fold-paused-other";
      const done = asking(id, "a paused fold");
      store.upsertSession({ id, provider: "Test", project: { name: "paused-shop", dir: "/home/demo/Projects/paused-shop" }, title: "a paused fold", state: "waiting" });
      store.ask({ sessionId: id, kind: "question", text: "Folds and is paused?", options: ["Yes", "No"] });
      store.ask({ sessionId: id, kind: "question", text: "Waits between while it is paused?", options: ["Yes", "No"] });
      store.ask({ sessionId: id, kind: "question", text: "Picked up and paused?", options: ["Yes", "No"] });
      try {
        const page = await open(1400, 900);
        await page.click("#projects button", "paused-shop");
        await page.waitFor(`document.querySelector('.next:not([data-leaving])')?.textContent.includes('Folds and is paused?') && document.querySelectorAll('.col-needs .qrow').length === 2 && ${STILL}`);
        // Some way into the growth of the row picked up, every motion of the page is held.
        const scrolling = await page.eval<{ needs: boolean; sessions: boolean }>(`new Promise((done, fail) => {
          const card = document.querySelector('.next');
          window.pausedCard = card;
          [...document.querySelectorAll('.col-needs .qrow')].find((r) => r.textContent.includes('Picked up and paused?')).click();
          const end = performance.now() + 5000;
          const tick = () => {
            window.grownCard = document.querySelector('.next:not([data-leaving])');
            const growth = grownCard?.getAnimations().find((a) => a.id === 'motion' && 'height' in a.effect.getKeyframes().at(-1));
            if (performance.now() > end) return fail(new Error('the row picked up never grew 40 ms in: a frame took longer than its whole growth'));
            if (!card.hasAttribute('data-leaving') || !(growth?.currentTime >= 40)) return requestAnimationFrame(tick);
            for (const a of document.getAnimations()) if (a.id === 'motion') a.pause();
            window.slideHold = grownCard.getAnimations().find((a) => a.effect.getKeyframes().some((k) => k.zIndex === '1'));
            const scrolls = (sel) => { const e = document.querySelector(sel); return e.scrollHeight > e.clientHeight; };
            done({ needs: scrolls('.col-needs .col-body'), sessions: scrolls('.col-sessions .col-body') });
          };
          requestAnimationFrame(tick);
        })`);
        assert.deepEqual(scrolling, { needs: false, sessions: false }, "Needs you and the sessions scroll with the document");
        type Motion = { kind: string; state: string; left: number };
        const motions = (card: string) =>
          page.eval<Motion[]>(`${card}.getAnimations().filter((a) => a.id === 'motion').map((a) => {
            const end = a.effect.getKeyframes().at(-1);
            return { kind: 'height' in end ? 'height' : 'zIndex' in end ? 'zIndex ' + end.zIndex : 'transform' in end ? 'transform' : 'other', state: a.playState, left: Math.round(a.effect.getComputedTiming().endTime - a.currentTime) };
          }).filter((m) => m.kind !== 'other')`);
        const of = (ms: Motion[], kind: string) => ms.filter((m) => m.kind === kind);
        const grownBefore = await motions("grownCard");
        assert.deepEqual(grownBefore.map((m) => m.kind).sort(), ["height", "transform", "zIndex 1", "zIndex 2"], `the card picked up grows over the rows it crosses and slides up over them: ${JSON.stringify(grownBefore)}`);
        // A session more redraws the sessions column, which shares the document's scroll with Needs you.
        store.upsertSession({ id: other, provider: "Test", project: { name: "paused-shop", dir: "/home/demo/Projects/paused-shop" }, title: "arrives while paused", state: "working" });
        await page.waitFor(cardOf("arrives while paused"));
        const grown = await motions("grownCard");
        const folding = await motions("pausedCard");
        const log = JSON.stringify({ grownBefore, grown, folding });
        assert.ok(of(folding, "height").length === 1 && of(grown, "height").length === 1 && of(grown, "zIndex 2").length === 1, `each change of height and its stacking runs once: ${log}`);
        assert.ok([...folding, ...grown].every((m) => m.state === "paused"), `all stay paused: ${log}`);
        assert.ok(of(grown, "height")[0]!.left > of(grownBefore, "height")[0]!.left, `the redraw started the card's change of height again: ${log}`);
        assert.equal(of(grown, "zIndex 2")[0]!.left, of(grown, "height")[0]!.left, `its stacking is held as long as its height changes: ${log}`);
        assert.equal(await page.eval("grownCard.getAnimations().includes(slideHold) && slideHold.playState"), "paused", `the slide's stacking is not started again: ${log}`);
        assert.equal(of(grown, "zIndex 1")[0]!.left, of(grown, "transform")[0]!.left, `the slide's stacking ends with its slide: ${log}`);
        await page.eval("new Promise((done) => { for (const a of document.getAnimations()) if (a.id === 'motion') a.play(); const tick = () => (pausedCard.isConnected ? requestAnimationFrame(tick) : done()); requestAnimationFrame(tick); })");
      } finally {
        if (store.getSession(other)) store.updateSession(other, (s) => ({ ...s, state: "ended" }));
        done();
      }
    });

    it("on a phone, a redraw that changes the view at once mid-way stops the header and the strip with the cards", async () => {
      const id = "scrolled-instant";
      const done = asking(id, "stopped mid-way");
      // A project of its own, shown alone: what earlier tests left on the desk would fill the window, and the page would not slide.
      store.upsertSession({ id, provider: "Test", project: { name: "instant-shop", dir: "/home/demo/Projects/instant-shop" }, title: "stopped mid-way", state: "waiting" });
      // A context nearly full keeps a chip in the phone's strip, which hides when empty.
      store.mergeMetrics({ sessionId: id, contextPercent: 90 });
      const context = Array.from({ length: 28 }, (_, i) => `Line ${i + 1}: what the session found before asking.`).join("\n");
      store.ask({ sessionId: id, kind: "question", text: "Dismissed, then all projects?", context, options: ["Yes", "No"] });
      try {
        const page = await open(390, 1000);
        await page.click("#projects button", "instant-shop");
        await page.waitFor(`document.querySelector('.next:not([data-leaving])')?.textContent.includes('Dismissed, then all projects?') && document.querySelector('#strip .chip.warn') && ${STILL}`);
        // Dismissed 120 px past its top, the page slides down as it goes; 4 frames on, All projects redraws the view at once.
        const seen = await page.eval<{ top: number; moving: [string, number][]; left: [string, number, string][] }>(`new Promise((done) => {
          const card = document.querySelector('.next');
          document.scrollingElement.scrollTop += card.getBoundingClientRect().top + 120;
          const top = card.getBoundingClientRect().top;
          ${DISMISS};
          const parts = ['header.top', '#strip'].map((s) => document.querySelector(s));
          const motion = (el) => el.getAnimations().filter((a) => a.id === 'motion').length;
          const named = (el) => (el.matches('header') ? 'header' : el.id);
          let frames = 0;
          const tick = () => {
            if (!card.hasAttribute('data-leaving') || ++frames < 4) return requestAnimationFrame(tick);
            const moving = parts.map((el) => [named(el), motion(el)]);
            document.querySelector('#projects button[data-key=""]').click();
            done({ top, moving, left: parts.map((el) => [named(el), motion(el), getComputedStyle(el).transform]) });
          };
          requestAnimationFrame(tick);
        })`);
        assert.ok(seen.top < -100, `the card's top starts out of sight: ${JSON.stringify(seen)}`);
        assert.ok(seen.moving.every(([, n]) => n > 0), `the header and the strip slid with the page: ${JSON.stringify(seen)}`);
        assert.deepEqual(seen.left, [["header", 0, "none"], ["strip", 0, "none"]], "they stand where the layout puts them, as the board does");
      } finally {
        done();
      }
    });
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

});
