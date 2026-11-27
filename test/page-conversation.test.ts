// The page in a real headless Chrome: the session panel's conversation follows its end, and finds in it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { arrived, ownDesk, ownPhone, setupPage, SKIP, STILL } from "./page-harness.ts";
import { type Page } from "./browser.ts";
import { type Store } from "../src/store/store.ts";

const BODY = "document.querySelector('#session .session-body')";
const FROM_END = `(() => { const b = ${BODY}; return b.scrollHeight - b.scrollTop - b.clientHeight; })()`;
const BUTTON_SHOWN = "!document.querySelector('#session .to-end').hidden";
const frames = (page: Page) => page.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");

/** A waiting session with a conversation long enough to scroll many screens. */
function longTalk(own: Store): void {
  own.upsertSession({ id: "long-talk", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "long talk", state: "waiting" });
  for (let i = 0; i < 40; i++) own.addMessage({ sessionId: "long-talk", from: i % 2 ? "developer" : "session", text: `Round ${i}: the migration of the orders table, its indexes and the backfill of the totals, checked against a copy of production before going on to the next table.` });
  own.addMessage({ sessionId: "long-talk", from: "session", text: "Checking the schema", step: true });
  own.addMessage({ sessionId: "long-talk", from: "session", text: "The trigger on refunds needs a rewrite", step: true });
  own.addMessage({ sessionId: "long-talk", from: "session", text: "Done: the **Búsqueda** del `índice` is fast again, see [the notes](http://localhost:3000/notes)." });
}

async function openLongTalk(page: Page): Promise<void> {
  await page.eval("location.hash = '#s=long-talk'");
  await page.waitFor(`${arrived("session")} && ${BODY}?.dataset.fetched === 'yes' && ${STILL}`);
  await frames(page);
}

/** Turns the phone, as its browser does: the viewport swaps its sides and the orientation changes. */
const turn = (page: Page, landscape: boolean) =>
  page.send("Emulation.setDeviceMetricsOverride", { width: landscape ? 844 : 390, height: landscape ? 390 : 844, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: landscape ? "landscapePrimary" : "portraitPrimary", angle: landscape ? 90 : 0 } });

describe("page: the session panel's conversation", SKIP, () => {
  setupPage();

  it("on a phone, stays on the latest message however often it turns, and a button brings it down once scrolled up", async () => {
    await ownPhone(async (page) => {
      await openLongTalk(page);
      assert.ok((await page.eval<number>(FROM_END)) < 2, "it opens on the latest message");
      assert.equal(await page.eval<boolean>(BUTTON_SHOWN), false, "no button at the end");
      for (const landscape of [true, false, true, false]) {
        await turn(page, landscape);
        await frames(page);
        await frames(page);
        assert.ok((await page.eval<number>(FROM_END)) < 2, `turned to ${landscape ? "landscape" : "portrait"}, it stays on the latest message: ${await page.eval<number>(FROM_END)} px from the end`);
        assert.equal(await page.eval<boolean>(BUTTON_SHOWN), false);
      }
      await page.eval(`(() => { const b = ${BODY}; b.scrollTop = b.scrollHeight - b.clientHeight - 100; })()`);
      await frames(page);
      assert.equal(await page.eval<boolean>(BUTTON_SHOWN), false, "a little up, the end is in sight: no button over it");
      await page.eval(`(() => { const b = ${BODY}; b.scrollTop = b.scrollHeight - b.clientHeight - 900; })()`);
      await frames(page);
      assert.equal(await page.eval<boolean>(BUTTON_SHOWN), true, "scrolled up, the button shows");
      await turn(page, true);
      await frames(page);
      await frames(page);
      assert.ok((await page.eval<number>(FROM_END)) > 100, "scrolled up to read, turning does not pull it down");
      const r = await page.eval<{ x: number; y: number; foot: number }>("(() => { const r = document.querySelector('#session .to-end').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.bottom, foot: document.querySelector('#session .chat-footer').getBoundingClientRect().top }; })()");
      assert.ok(r.y <= r.foot, `the button sits above the answer box: ${r.y} over ${r.foot}`);
      assert.ok(await page.eval<boolean>("(() => { const b = document.querySelector('#session .to-end'); const r = b.getBoundingClientRect(); return b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })()"), "nothing covers it");
      await page.click("#session .to-end");
      await frames(page);
      assert.ok((await page.eval<number>(FROM_END)) < 2, "the button brings it to the end at once");
      assert.equal(await page.eval<boolean>(BUTTON_SHOWN), false, "and hides");
      await turn(page, false);
      await frames(page);
      await frames(page);
      assert.ok((await page.eval<number>(FROM_END)) < 2, "back at the end, it follows it again");
    }, longTalk);
  });

  it("on a touch phone, stops a glide still going before the jump to the end, and only there", async () => {
    await ownPhone(async (page) => {
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });
      await openLongTalk(page);
      /** Taps the button scrolled far up: what the body's overflow is at the jump, and in the frames after. */
      const jump = () => page.eval<{ at: string; after: string[]; fromEnd: number }>(`new Promise((done) => {
        const b = ${BODY};
        b.scrollTop = b.scrollHeight - b.clientHeight - 2000;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          document.querySelector('#session .to-end').click();
          const at = getComputedStyle(b).overflowY;
          const after = [];
          const frame = () => {
            after.push(getComputedStyle(b).overflowY);
            if (after.length < 4) requestAnimationFrame(frame);
            else done({ at, after, fromEnd: b.scrollHeight - b.scrollTop - b.clientHeight });
          };
          requestAnimationFrame(frame);
        }));
      })`);
      // iOS ends a glide only when its element can no longer scroll; a scrollTop set alone loses to it.
      const touch = await jump();
      assert.equal(touch.at, "hidden", "at the jump the conversation cannot scroll, which ends a glide on iOS");
      assert.equal(touch.after.at(-1), "auto", `it scrolls again two frames later: ${touch.after.join(", ")}`);
      assert.ok(touch.fromEnd < 2, `at the end: ${touch.fromEnd} px from it`);
      assert.equal(await page.eval<boolean>(BUTTON_SHOWN), false);
      await page.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "fine" }, { name: "hover", value: "hover" }] });
      assert.equal(await page.eval<boolean>("matchMedia('(pointer: coarse)').matches"), false);
      const mouse = await jump();
      assert.deepEqual([mouse.at, ...mouse.after], ["auto", "auto", "auto", "auto", "auto"], "with a mouse its scrollbar never goes: no flicker");
      assert.ok(mouse.fromEnd < 2);
    }, longTalk);
  });

  it("finds in the conversation: each match in turn, accents aside, inside a fold too, marked, and Escape closes only the search", async () => {
    await ownDesk(async (page) => {
      await openLongTalk(page);
      await page.click("#session .dhead .find-open");
      await page.waitFor("document.activeElement?.matches('#session .find-bar input')");
      const count = "document.querySelector('#session .find-count').textContent";
      const nowIn = "(() => { const h = CSS.highlights.get('find-now'); const [r] = h ? [...h] : []; return r ? r.startContainer.parentElement.closest('.msg').textContent : ''; })()";
      const inSight = "(() => { const h = CSS.highlights.get('find-now'); const [r] = [...h]; const box = r.getBoundingClientRect(); const b = document.querySelector('#session .session-body').getBoundingClientRect(); const foot = document.querySelector('#session .chat-footer').getBoundingClientRect().top; return box.top >= b.top && box.bottom <= foot; })()";
      const clear = "(() => { const i = document.querySelector('#session .find-bar input'); i.value = ''; i.dispatchEvent(new Event('input')); })()";
      await page.type("busqueda del indice");
      await page.waitFor(`${count} === '1 of 1'`);
      assert.equal(await page.eval<string>("[...CSS.highlights.get('find-now')][0].toString()"), "Búsqueda del índice", "without its accents, across its bold and code, the words are found and marked whole");
      await page.eval(clear);
      await page.type("localhost");
      await page.waitFor(`${count} === 'No matches'`); // a link's target is not what the message shows
      await page.eval(clear);
      // At the end, as the panel opens: what the search shows must not be pulled back there.
      await page.eval(`(() => { const b = ${BODY}; b.scrollTop = b.scrollHeight; })()`);
      await frames(page);
      assert.ok((await page.eval<number>(FROM_END)) < 2);
      await page.click("#session .find-bar input");
      await page.type("round 1");
      await page.waitFor(`${count} === '11 of 11'`); // Round 1 and Round 10 to 19
      assert.match(await page.eval<string>(nowIn), /Round 19:/, "a match screens up is brought into sight");
      assert.ok(await page.eval<boolean>(inSight));
      assert.ok((await page.eval<number>(FROM_END)) > 400, "away from the end");
      await page.press("Enter");
      await page.waitFor(`${count} === '10 of 11'`);
      await page.eval("new Promise((r) => setTimeout(r, 300))");
      assert.match(await page.eval<string>(nowIn), /Round 18:/);
      assert.ok(await page.eval<boolean>(inSight), "and not pulled back to the end");
      await page.eval(clear);
      await page.type("round 3");
      await page.waitFor(`${count} === '11 of 11'`); // Round 3 and Round 30 to 39
      assert.match(await page.eval<string>(nowIn), /Round 39:/, "it starts from the newest match");
      assert.ok(await page.eval<boolean>(inSight), "shown in sight, above the answer box");
      assert.equal(await page.eval<number>("CSS.highlights.get('find').size"), 10, "the other matches are marked too");
      await page.press("Enter");
      await page.waitFor(`${count} === '10 of 11'`);
      assert.match(await page.eval<string>(nowIn), /Round 38:/, "Enter goes to the earlier one");
      assert.ok(await page.eval<boolean>(inSight));
      await page.eval("new Promise((r) => setTimeout(r, 300))");
      assert.ok(await page.eval<boolean>(inSight), "a match is not pulled back to the end");
      await page.click("#session .find-bar button[aria-label='Later match']");
      await page.waitFor(`${count} === '11 of 11'`);
      await page.press("Escape");
      await page.waitFor("!document.querySelector('#session .find-bar')");
      assert.equal(await page.eval<boolean>("document.getElementById('session').open"), true, "Escape from the bar's buttons too closes only the search");
      await page.click("#session .dhead .find-open");
      await page.waitFor("document.activeElement?.matches('#session .find-bar input')");
      await page.eval(clear);
      await page.type("refunds");
      await page.waitFor(`${count} === '1 of 1'`);
      assert.match(await page.eval<string>(nowIn), /trigger on refunds/, "a match in folded steps opens their fold");
      assert.ok(await page.eval<boolean>(inSight));
      await page.press("Escape");
      await page.waitFor("!document.querySelector('#session .find-bar')");
      assert.equal(await page.eval<boolean>("document.getElementById('session').open"), true, "Escape closes the search, not the panel");
      assert.equal(await page.eval<number>("CSS.highlights.size"), 0, "and its marks");
      for (const type of ["rawKeyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 2 });
      await page.waitFor("document.activeElement?.matches('#session .find-bar input')");
    }, longTalk);
  });
});
