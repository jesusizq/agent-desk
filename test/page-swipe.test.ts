// The page in a real headless Chrome: on a touch phone, a sideways swipe in a session's panel goes to
// the next or previous session that needs the developer, in the Needs you list's order.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Store } from "../src/store/store.ts";
import { arrived, ownDesk, ownPhone, setupPage, SKIP, STILL, touch } from "./page-harness.ts";
import { type Page } from "./browser.ts";

const BODY = "document.querySelector('#session .session-body')";
const SHOWN = `${BODY}?.dataset.session`;
/** The panel at rest on a session's conversation, fetched and at its end. */
const atEnd = (sid: string) =>
  `${arrived("session")} && ${SHOWN} === '${sid}' && ${BODY}.dataset.fetched === 'yes' && ${BODY}.scrollTop > 0 && ${BODY}.scrollHeight - ${BODY}.clientHeight - ${BODY}.scrollTop < 2 && ${STILL}`;

/** The developer's long exchange with a session, so its panel scrolls and opening it at its end means something. */
function longTalk(own: Store, sessionId: string): void {
  for (let i = 1; i <= 8; i++) {
    own.addMessage({ sessionId, from: "developer", text: `Step ${i}: go on.`, via: "terminal" });
    own.addMessage({ sessionId, from: "session", text: `Step ${i} done.\n\n- one\n- two\n- three`, via: "terminal" });
  }
}
/** Payment webhooks asks after VAT rounding and checkout redesign: the Needs you list is VAT, checkout, payments. */
function threeAsking(own: Store): void {
  own.ask({ sessionId: "demo-pagos", kind: "question", text: "Retry failed webhooks for a day or a week?", options: ["A day", "A week"] });
  for (const sid of ["demo-pagos", "demo-iva", "demo-checkout"]) longTalk(own, sid);
}

/** A finger held on a touch screen read as coarse, the panel of a session opened from the Sessions tab, at its end. */
async function openPanel(page: Page, title: string, sid: string): Promise<void> {
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });
  if (await page.eval<boolean>("!!document.querySelector('.tabbar') && getComputedStyle(document.querySelector('.tabbar')).display !== 'none'")) await page.tap(".tabbar button", "Sessions");
  await page.click(".scard", title);
  await page.waitFor(atEnd(sid));
}

/** A finger from one point to another in even steps, lifted at the end unless `hold`. */
async function swipe(page: Page, [x0, y0]: [number, number], [x1, y1]: [number, number], { hold = false } = {}): Promise<void> {
  await touch(page, "touchStart", [[x0, y0]]);
  const steps = 8;
  for (let i = 1; i <= steps; i++) await touch(page, "touchMove", [[x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps]]);
  if (!hold) await touch(page, "touchEnd", []);
}
/** A point in the middle of the conversation shown, its height in the viewport. */
const onConversation = async (page: Page): Promise<number> => {
  const y = await page.eval<number>(`(() => { const r = ${BODY}.getBoundingClientRect(), f = document.querySelector('#session .chat-footer').getBoundingClientRect(); return Math.round((r.top + Math.min(r.bottom, f.top)) / 2 + 40); })()`);
  assert.ok(await page.eval<boolean>(`!!document.elementFromPoint(195, ${y})?.closest('#session .conversation')`), "the finger lands on the conversation");
  return y;
};
const shift = (page: Page) => page.eval<number>(`new DOMMatrix(getComputedStyle(${BODY}).transform).m41`);

describe("page: a session's panel swiped sideways on a phone", SKIP, () => {
  setupPage();

  it("on a touch phone, a swipe left on the conversation opens the next session that needs the developer and a swipe right the previous, round the ends, each at its end", async () => {
    await ownPhone(async (page) => {
      await openPanel(page, "checkout redesign", "demo-checkout");
      let y = await onConversation(page);
      // Held halfway, the body follows the finger a little, and the edge it uncovers names where it goes.
      await swipe(page, [300, y], [160, y + 6], { hold: true });
      const held = { shift: await shift(page), label: await page.eval<string>("document.querySelector('#session .swipe-to')?.textContent ?? ''"), side: await page.eval<string>("document.querySelector('#session .swipe-to')?.dataset.side ?? ''") };
      assert.ok(held.shift < -20 && held.shift >= -80, `it follows the finger, damped: ${held.shift}`);
      assert.match(held.label, /payment webhooks/, "the next in Needs you: payments asked last");
      assert.equal(held.side, "right");
      await touch(page, "touchEnd", []);
      await page.waitFor(atEnd("demo-pagos"));
      assert.equal(await page.eval<string>("document.querySelector('#session .dhead h3').textContent"), "payment webhooks");
      assert.equal(await page.eval<boolean>("!document.querySelector('#session .swipe-to')"), true, "the label goes with the finger");
      // Back the other way, then on past the first to the last.
      for (const [title, sid] of [["checkout redesign", "demo-checkout"], ["VAT rounding", "demo-iva"], ["payment webhooks", "demo-pagos"]] as const) {
        y = await onConversation(page);
        await swipe(page, [90, y], [260, y - 6]);
        await page.waitFor(atEnd(sid));
        assert.equal(await page.eval<string>("document.querySelector('#session .dhead h3').textContent"), title);
      }
      // And left from the last round to the first.
      y = await onConversation(page);
      await swipe(page, [300, y], [140, y]);
      await page.waitFor(atEnd("demo-iva"));
      assert.equal(await shift(page), 0, "the body comes to rest in its place");
    }, threeAsking);
  });

  it("on a touch phone, a swipe whose touched element a redraw replaced mid-drag still springs back when the finger lifts", async () => {
    await ownPhone(async (page) => {
      await openPanel(page, "checkout redesign", "demo-checkout");
      const y = await onConversation(page);
      await swipe(page, [300, y], [255, y], { hold: true });
      assert.ok((await shift(page)) < -5, "the body follows the finger");
      // What a redraw does to the element under the finger: the touch's later events go to the one taken out.
      const replaced = await page.eval<boolean>(`(() => { const el = document.elementFromPoint(300, ${y}); if (!el?.closest('#session .session-body')) return false; el.replaceWith(el.cloneNode(true)); return !el.isConnected; })()`);
      assert.ok(replaced, "the touched element is out of the page");
      await touch(page, "touchMove", [[250, y]]);
      await touch(page, "touchEnd", []);
      await page.waitFor(`!document.querySelector('#session .swipe-to') && ${STILL}`);
      assert.equal(await shift(page), 0, "the body comes back to its place");
      assert.equal(await page.eval<string>(SHOWN), "demo-checkout", "short of a switch, it stays on the session");
      const at = await onConversation(page);
      await swipe(page, [300, at], [140, at]);
      await page.waitFor(`${SHOWN} === 'demo-pagos'`);
    }, threeAsking);
  });

  it("on a touch phone, a vertical scroll of the conversation scrolls it and stays on the session", async () => {
    await ownPhone(async (page) => {
      await openPanel(page, "checkout redesign", "demo-checkout");
      const y = await onConversation(page);
      const top = await page.eval<number>(`${BODY}.scrollTop`);
      await swipe(page, [180, y - 120], [215, y + 160]);
      await page.waitFor(`${BODY}.scrollTop < ${top - 40} && ${STILL}`);
      assert.equal(await page.eval<string>(SHOWN), "demo-checkout");
      assert.equal(await page.eval<boolean>("!document.querySelector('#session .swipe-to')"), true, "nothing named another session");
      assert.equal(await shift(page), 0, "the body never moved sideways");
      // The same finger sideways goes on to the next.
      const at = await onConversation(page);
      await swipe(page, [300, at], [140, at]);
      await page.waitFor(`${SHOWN} === 'demo-pagos'`);
    }, threeAsking);
  });

  it("on a touch phone, a sideways swipe on the chip row scrolls the chips and stays on the session", async () => {
    await ownPhone(async (page) => {
      await openPanel(page, "checkout redesign", "demo-checkout");
      const chips = `${BODY}.querySelector('.pchips')`;
      assert.ok(await page.eval<boolean>(`${chips}.scrollWidth > ${chips}.clientWidth + 20 && ${chips}.scrollLeft === 0`), "the row is cut at its end");
      const y = await page.eval<number>(`(() => { const r = ${chips}.getBoundingClientRect(); return Math.round(r.top + r.height / 2); })()`);
      await swipe(page, [300, y], [120, y]);
      await page.waitFor(`${chips}.scrollLeft > 40 && ${STILL}`);
      assert.equal(await page.eval<string>(SHOWN), "demo-checkout");
      assert.equal(await page.eval<boolean>("!document.querySelector('#session .swipe-to')"), true);
      const at = await onConversation(page);
      await swipe(page, [300, at], [140, at]);
      await page.waitFor(`${SHOWN} === 'demo-pagos'`);
    }, threeAsking);
  });

  it("on a touch phone, a swipe right from just past the left edge opens the previous session, and one from the edge still closes the panel", async () => {
    await ownPhone(async (page) => {
      await openPanel(page, "checkout redesign", "demo-checkout");
      let y = await onConversation(page);
      await swipe(page, [30, y], [200, y]);
      await page.waitFor(atEnd("demo-iva"));
      y = await onConversation(page);
      await touch(page, "touchStart", [[6, y]]);
      for (let x = 6; x <= 246; x += 30) await touch(page, "touchMove", [[x, y + 2]]);
      assert.equal(await page.eval<boolean>("!document.querySelector('#session .swipe-to')"), true, "the edge is the way back, not to another session");
      await touch(page, "touchEnd", []);
      await page.waitFor("!document.getElementById('session').open");
      assert.equal(await page.eval<string>(SHOWN), "demo-iva", "it closed on the session it showed");
    }, threeAsking);
  });

  it("on a touch phone, with no other session needing the developer the panel only gives a little and stays; from one that asks nothing, a swipe goes to the one that asks", async () => {
    await ownPhone(
      async (page) => {
        await openPanel(page, "checkout redesign", "demo-checkout");
        const y = await onConversation(page);
        await swipe(page, [300, y], [100, y], { hold: true });
        const held = await shift(page);
        assert.ok(held < 0 && held >= -20, `a small resistance, not the pull to another session: ${held}`);
        assert.equal(await page.eval<boolean>("!document.querySelector('#session .swipe-to')"), true, "no session to name");
        await touch(page, "touchEnd", []);
        await page.waitFor(`${arrived("session")} && ${STILL}`);
        assert.equal(await shift(page), 0, "and back");
        assert.equal(await page.eval<string>(SHOWN), "demo-checkout");
        await page.press("Escape");
        await page.waitFor("!document.getElementById('session').open");
        // Payment webhooks asks nothing: a swipe right goes to the last that asks, the only one.
        await openPanel(page, "payment webhooks", "demo-pagos");
        const from = await onConversation(page);
        await swipe(page, [90, from], [260, from]);
        await page.waitFor(atEnd("demo-checkout"));
      },
      (own) => {
        own.closeOpen("demo-iva", { answer: "Per line" });
        for (const sid of ["demo-pagos", "demo-checkout"]) longTalk(own, sid);
      },
    );
  });

  it("with a fine pointer in two columns, a sideways touch swipe on the panel does nothing, and the same swipe at a phone's size switches", async () => {
    await ownDesk(async (page) => {
      await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "fine" }, { name: "hover", value: "hover" }] });
      await page.click(".scard", "checkout redesign");
      await page.waitFor(atEnd("demo-checkout"));
      const wide = await page.eval<[number, number]>(`(() => { const r = ${BODY}.querySelector('.conversation').getBoundingClientRect(); return [Math.round(r.left + r.width * 0.7), Math.round(r.top + r.height / 2)]; })()`);
      await swipe(page, wide, [wide[0] - 260, wide[1]], { hold: true });
      assert.equal(await shift(page), 0, "the body stays put");
      await touch(page, "touchEnd", []);
      await page.waitFor(`${arrived("session")} && ${STILL}`);
      assert.equal(await page.eval<string>(SHOWN), "demo-checkout");
      await page.resize(390, 844);
      await page.waitFor(`${arrived("session")} && ${STILL} && ${BODY}.getBoundingClientRect().width <= 390`);
      const at = await onConversation(page);
      await swipe(page, [300, at], [140, at]);
      await page.waitFor(`${SHOWN} === 'demo-pagos'`);
    }, threeAsking);
  });
});
