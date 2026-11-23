// The page in a real headless Chrome, over the demo store: arrivals, time away, forgetting and the question's card.
import * as http from "node:http";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { arrived, base, browser, cardOf, DRAWN, elsewhere, open, openPhone, openResultOf, pages, setupPage, SKIP, STILL, store } from "./page-harness.ts";
import { type Page } from "./browser.ts";

describe("page: arrivals, time away, forgetting and the question's card", SKIP, () => {
  setupPage();

  describe("a question that arrives tells of itself without interrupting", () => {
    /** A waiting session listening on the desk; ended afterwards, its questions dismissed. */
    function listening(id: string, title: string) {
      store.upsertSession({ id, provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title, state: "waiting" });
      const stop = store.listen(id);
      return () => {
        stop();
        for (const q of store.openQuestions(id)) store.dismiss(q.id);
        store.updateSession(id, (s) => ({ ...s, state: "ended" }));
      };
    }
    const bubble = "document.getElementById('arrival')";
    const bubbleUp = `${bubble}.matches(':popover-open') && !${bubble}.inert`;
    /** The bubble's 8 s before it goes back into Needs you take 400 ms here. */
    const quickRetreat = "const later = window.setTimeout; window.setTimeout = (f, ms, ...a) => later(f, ms === 8000 ? 400 : ms, ...a);";
    async function openWith(source: string, width = 1400, height = 900): Promise<Page> {
      const page = await browser.newPage(width, height);
      pages.push(page);
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source });
      await page.goto(base + "/");
      await page.waitFor(DRAWN);
      return page;
    }

    it("in the asking session's open panel, comes into its conversation: no bubble, no toast, the focus left where it was", async () => {
      const done = listening("arrive-panel", "asks in its panel");
      try {
        const page = await open();
        await page.click(".scard", "asks in its panel");
        await page.waitFor(`${arrived("session")} && document.querySelector('#session .session-body')?.dataset.fetched === 'yes'`);
        await page.eval("document.querySelector('#session .dhead .icon-btn').focus()");
        await page.eval("window.rose = 0; const a = Element.prototype.animate; Element.prototype.animate = function (f, o) { if (this.matches('.panel-question') && f[0]?.opacity === 0) rose++; return a.call(this, f, o); }");
        store.ask({ sessionId: "arrive-panel", kind: "question", text: "Asked while its panel is open?", options: ["Yes", "No"] });
        await page.waitFor("document.querySelector('#session .panel-question')?.textContent.includes('Asked while its panel is open?')");
        assert.equal(await page.eval<number>("rose"), 1, "it comes into the panel's foot with a motion");
        await new Promise((r) => setTimeout(r, 400));
        assert.deepEqual(
          await page.eval(`[${bubble}.matches(':popover-open'), document.querySelectorAll('.toast').length, document.activeElement === document.querySelector('#session .dhead .icon-btn')]`),
          [false, 0, true],
        );
        await page.press("Escape");
      } finally {
        done();
      }
    });

    it("in sight on the board, arrives on its row only", async () => {
      const page = await open();
      const asked = store.ask({ sessionId: "demo-pagos", kind: "question", text: "Arriving in plain sight?" });
      try {
        await page.waitFor("[...document.querySelectorAll('.qrow')].some((r) => r.textContent.includes('Arriving in plain sight?'))");
        await new Promise((r) => setTimeout(r, 400));
        assert.deepEqual(await page.eval(`[${bubble}.matches(':popover-open'), document.querySelectorAll('.toast').length]`), [false, 0]);
      } finally {
        store.dismiss(asked.id);
      }
    });

    it("out of sight, a bubble over the window says where and what, answered whole in place, and leaves once answered", async () => {
      const done = listening("arrive-out", "asks out of sight");
      try {
        const page = await open();
        await openResultOf(page, "Three pay button variants");
        store.ask({ sessionId: "arrive-out", kind: "question", text: "Which pay button ships?", context: "Variant B tested best on phones.", options: ["A", "B", "C"] });
        await page.waitFor(`${bubbleUp} && !${bubble}.getAnimations().length`); // come to rest
        assert.deepEqual(
          await page.eval(`[${bubble}.parentElement.id, ${bubble}.getAttribute('aria-label'), [...${bubble}.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent)]`),
          ["result", "New question", ["Hide this notice: the question stays in Needs you", "Expand", "Go"]],
          "inside the window on top, so it can be clicked; every button named",
        );
        assert.match(await page.eval<string>(`${bubble}.querySelector('[role=status]').textContent`), /^web-shop›.*asks out of sightWhich pay button ships\?$/, "it says where and what, read out politely");
        const head = await page.eval<number>("document.querySelector('#result .dhead').getBoundingClientRect().bottom");
        assert.ok((await page.eval<number>(`${bubble}.getBoundingClientRect().top`)) >= head, "under the window's head");
        assert.equal(await page.eval<number>("document.querySelectorAll('.toast').length"), 0, "no toast");
        await page.click("#arrival .arr-expand");
        await page.waitFor("document.querySelector('#arrival .arr-body textarea')");
        assert.match(await page.eval<string>("document.querySelector('#arrival .arr-body').textContent"), /Which pay button ships\?.*Variant B tested best on phones\./, "the whole question, with what was said around it");
        await page.eval("document.querySelector('#arrival textarea').focus()");
        await page.press("Escape");
        assert.deepEqual(await page.eval("[!!document.querySelector('#arrival .arr-body'), document.getElementById('result').open]"), [false, true], "Escape folds the bubble, not the window under it");
        await page.click("#arrival .arr-expand");
        await page.waitFor("document.querySelector('#arrival .arr-body textarea')");
        await page.click("#arrival .opts button", "B");
        await page.waitFor("document.querySelector('#arrival .resolved-line')?.textContent.includes('Answered')");
        assert.deepEqual(store.takeInbox("arrive-out").map((e) => e.answer), ["B"], "delivered as picked, to the session that asked");
        await page.waitFor(`!${bubble}.matches(':popover-open')`);
        assert.deepEqual(await page.eval(`[document.getElementById('result').open, document.querySelectorAll('.toast').length]`), [true, 0], "the window stays; no toast");
        await page.press("Escape");
      } finally {
        done();
      }
    });

    it("Go selects it in Needs you, with the window over the desk closed; one bubble counts the others", async () => {
      const page = await open();
      await page.click("#views button", "History");
      const first = store.ask({ sessionId: "demo-pagos", kind: "question", text: "First while in History?" });
      await page.waitFor(`${bubbleUp} && ${bubble}.textContent.includes('First while in History?')`);
      const second = store.ask({ sessionId: "demo-iva", kind: "question", text: "Second while in History?" });
      try {
        await page.waitFor(`${bubble}.textContent.includes('Second while in History?')`);
        assert.match(await page.eval<string>(`${bubble}.querySelector('.arr-more').textContent`), /^\+1 more$/);
        assert.equal(await page.eval<number>("document.querySelectorAll('#arrival').length"), 1, "one bubble, never a wall");
        await page.click("#arrival .arr-go");
        await page.waitFor(`!${bubble}.matches(':popover-open') && document.querySelector('.next:not([data-leaving])')?.textContent.includes('Second while in History?')`);
        assert.equal(await page.eval<boolean>("document.querySelector('#views button[aria-pressed=true]').textContent.includes('Desk')"), true);
      } finally {
        store.dismiss(first.id);
        store.dismiss(second.id);
      }
    });

    it("goes back into the needs pill by itself, never while expanded or under the pointer; Escape folds it, then hides it", async () => {
      const page = await openWith(quickRetreat);
      await page.click("#views button", "History");
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 400 });
      const first = store.ask({ sessionId: "demo-pagos", kind: "question", text: "Left alone, where does it go?" });
      try {
        await page.waitFor(bubbleUp);
        await page.eval("window.bumped = 0; const a = Element.prototype.animate; Element.prototype.animate = function (f, o) { if (this.id === 'needs-pill' && o?.id === 'bump') bumped++; return a.call(this, f, o); }");
        await page.waitFor(`!${bubble}.matches(':popover-open')`, 3000);
        assert.equal(await page.eval<number>("bumped"), 1, "the pill it went into says so");
        assert.ok(store.openQuestions("demo-pagos").some((q) => q.id === first.id), "the question still waits in Needs you");

        const second = store.ask({ sessionId: "demo-pagos", kind: "question", text: "Expanded, does it stay?" });
        try {
          await page.waitFor(`${bubbleUp} && !${bubble}.getAnimations().length`);
          assert.equal(await page.eval<string>(`getComputedStyle(${bubble}).opacity`), "1", "back after a retreat, it shows whole");
          await page.click("#arrival .arr-expand");
          await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 400 });
          await page.eval("document.activeElement.blur()");
          await new Promise((r) => setTimeout(r, 1200));
          assert.equal(await page.eval<boolean>(bubbleUp), true, "expanded, it stays");
          await page.eval("document.querySelector('#arrival textarea').focus()");
          await page.press("Escape");
          assert.equal(await page.eval<boolean>("!document.querySelector('#arrival .arr-body') && document.activeElement.matches('#arrival .arr-expand')"), true, "Escape folds it");
          await page.press("Escape");
          await page.waitFor(`!${bubble}.matches(':popover-open')`);
          assert.equal(await page.eval<string>("document.querySelector('#views button[aria-pressed=true]').textContent"), "History", "and then hides it, nothing else");
        } finally {
          store.dismiss(second.id);
        }
      } finally {
        store.dismiss(first.id);
      }
    });

    it("leaves when its question is answered elsewhere", async () => {
      const page = await open();
      await page.click("#views button", "History");
      const asked = store.ask({ sessionId: "demo-pagos", kind: "question", text: "Answered in the terminal instead?" });
      await page.waitFor(bubbleUp);
      store.dismiss(asked.id);
      await page.waitFor(`!${bubble}.matches(':popover-open')`);
    });

    it("on a phone, sits above the tab bar, inside the screen, while another tab is shown", async () => {
      const page = await open(390, 844);
      await page.click(".tabbar button", "Sessions");
      const asked = store.ask({ sessionId: "demo-pagos", kind: "question", text: "Seen from the Sessions tab?" });
      try {
        await page.waitFor(`${bubbleUp} && !${bubble}.getAnimations().length`); // come to rest
        const [left, right, bottom, bar] = await page.eval<[number, number, number, number]>(`(() => { const r = ${bubble}.getBoundingClientRect(); return [r.left, r.right, r.bottom, document.querySelector('.tabbar').getBoundingClientRect().top]; })()`);
        assert.ok(left >= 8 && right <= 382 && bottom <= bar, `inside the screen, above the tab bar: ${left} ${right} ${bottom} ${bar}`);
        await page.click(".tabbar button", "Needs you");
        await page.waitFor(`!${bubble}.matches(':popover-open')`); // now in sight
      } finally {
        store.dismiss(asked.id);
      }
    });
  });

  it("a message that cannot be sent stays in the conversation with why and Retry, kept on the device, and Retry sends it once", async () => {
    store.upsertSession({ id: "unsent", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "a message that fails", takesMessagesWhileWorking: true });
    const page = await open();
    await page.click(".scard", "a message that fails");
    await page.click("#session .chat-footer textarea");
    await page.type("deploy after lunch");
    await page.eval(`(() => {
      const real = window.fetch;
      window.fetch = (url, init) => init?.method === "POST" && String(url).endsWith("/message") ? (window.fetch = real, Promise.resolve(new Response(JSON.stringify({ error: "the desk is busy" }), { status: 503 }))) : real(url, init);
    })()`);
    await page.click("#session .chat-footer .send");
    const failed = "document.querySelector('#session .msg.out.failed')";
    await page.waitFor(failed);
    assert.deepEqual(
      await page.eval(`[${failed}.querySelector('.md').textContent, ${failed}.querySelector('.unsent-why').textContent, document.querySelector('#session .chat-footer textarea').value, document.querySelectorAll('.toast').length]`),
      ["deploy after lunch", "Not sent: the desk is busy", "", 0],
      "the message stays where it was sent, saying why, with no toast; the box is free",
    );
    assert.equal(store.takeInbox("unsent").length, 0);
    // Never lost: a reload shows it again, not sent.
    await page.goto(base + "/");
    await page.waitFor("document.querySelector('.scard')");
    await page.click(".scard", "a message that fails");
    await page.waitFor(failed);
    await page.click("#session .msg.out.failed button", "Retry");
    await page.waitFor("[...document.querySelectorAll('#session .msg.from-developer')].some((m) => m.textContent.includes('deploy after lunch') && m.querySelector('.delivered')) && !document.querySelector('#session .msg.out.failed')");
    assert.deepEqual(store.takeInbox("unsent").map((e) => e.answer), ["deploy after lunch"], "sent once, as written");
    await page.waitFor("localStorage.getItem('agent-desk:drafts') === null");
    await page.press("Escape");
  });

  it("on a phone, a result's pictures read one under the other, each with its caption, and a tap opens it in the viewer", async () => {
    const page = await open(390, 844);
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await openResultOf(page, "Three pay button variants");
    const figures = await page.eval<{ top: number; bottom: number; width: number; caption: string }[]>(
      "[...document.querySelectorAll('#result .vimgs figure')].map((f) => { const r = f.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width, caption: f.querySelector('figcaption').textContent }; })",
    );
    const column = await page.eval<number>("document.querySelector('#result .vimgs').clientWidth");
    assert.deepEqual(figures.map((f) => f.caption), ["A", "B", "C"]);
    figures.forEach((f, i) => {
      assert.ok(Math.abs(f.width - column) < 1, `picture ${f.caption} takes the width: ${f.width} of ${column}`);
      if (i) assert.ok(f.top >= figures[i - 1]!.bottom, `picture ${f.caption} sits under the one before`);
    });
    await page.eval("document.querySelectorAll('#result .vimgs img')[1].click()");
    await page.waitFor(arrived("zoom"));
    assert.match(await page.eval<string>("document.querySelector('#zoom .zcount')?.textContent ?? ''"), /^2/, "the viewer opens on the picture tapped");
    await page.press("Escape");
    await page.waitFor("!document.getElementById('zoom').open");
    await page.press("Escape");
    await openResultOf(page, "Checkout: before and after");
    assert.equal(await page.eval<boolean>("!!document.querySelector('#result .compare')"), true, "a before and after keeps its slider");
    await page.press("Escape");
  });

  describe("while you were away", () => {
    /** The desk as this device saw it last `minutes` ago. */
    async function openAway(minutes: number, width = 1400, height = 900, phone = false): Promise<Page> {
      const page = await browser.newPage(width, height);
      pages.push(page);
      if (phone) {
        await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 3, mobile: true });
        await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      }
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("agent-desk:last-looked", String(Date.now() - ${minutes} * 60000));` });
      await page.goto(base + "/");
      await page.waitFor("document.querySelector('.next')");
      return page;
    }
    const lines = (page: Page, group: string) => page.eval<string[]>(`[...document.querySelectorAll('.away [data-key="${group}"] .away-line')].map((l) => l.textContent)`);

    it("sums up what finished, failed, waits and was answered in the terminal, each line opening it, until dismissed", async () => {
      const done = store.addResult({ sessionId: "demo-iva", title: "Finished while away", url: "http://localhost:5173/away" });
      store.addResult({ sessionId: "demo-iva", title: "Failed while away", status: "failed" });
      const q = store.ask({ sessionId: "demo-pagos", kind: "question", text: "Answered in the terminal while away?" });
      store.closeOpen("demo-pagos", { answer: "Yes, from the terminal", which: (x) => x.id === q.id });
      const page = await openAway(120);
      await page.waitFor("document.querySelector('#strip .away')");
      assert.match(await page.eval<string>("document.querySelector('.away-head').textContent"), /^While you were away\s*since \d\d:\d\d · .*finished.*answered in the terminal/);
      assert.ok((await lines(page, "finished")).some((l) => l.includes("Finished while away")));
      assert.ok((await lines(page, "failed")).some((l) => l.includes("Failed while away")));
      assert.ok((await lines(page, "answered")).some((l) => l.includes("Answered in the terminal while away?") && l.includes("Yes, from the terminal")));
      assert.ok((await lines(page, "waits")).length > 0, "what waits, oldest first");
      assert.equal(await page.eval<boolean>("document.querySelector('#strip > .muted') === null"), true, "it takes the place of the line on what is new");
      // A line opens what it names; the summary stays for the next one.
      await page.click(".away .away-line", "Finished while away");
      await page.waitFor(`${arrived("result")} && document.querySelector('#result h3').textContent === 'Finished while away'`);
      await page.press("Escape");
      await page.waitFor("!document.getElementById('result').open");
      await page.click(".away .away-line", "Answered in the terminal while away?");
      await page.waitFor(arrived("session"));
      assert.match(await page.eval<string>("document.querySelector('#session h3').textContent"), /./);
      await page.press("Escape");
      await page.waitFor("!document.getElementById('session').open");
      // Answering stays where it was: the large card answers as without the summary.
      assert.ok(await page.eval<boolean>("!!document.querySelector('.next .answer')"));
      await page.click(".away-close");
      await page.waitFor("!document.querySelector('.away') && document.querySelector('#strip > .muted')");
      store.markResultSeen(done.id);
    });

    it("reminds of the handoffs waiting to be resumed, a line opening its project's list", async () => {
      const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
      const resumes = { id: "web-shop-0badc0de", name: "web-shop", dir: "/home/demo/Projects/web-shop", source: "test-notes", at: iso(0), notes: [{ title: "Pick up the pay page", writtenAt: iso(-10 * 3600_000), expiresAt: iso(38 * 3600_000), command: "/load" }] };
      store.putResumes(resumes);
      try {
        const page = await openAway(600);
        await page.waitFor("document.querySelector('#strip .away')");
        assert.match(await page.eval<string>("document.querySelector('.away-head').textContent"), /1 handoff to resume/);
        assert.deepEqual(await lines(page, "resumes"), ["Pick up the pay page web-shop"]);
        await page.click(".away [data-key=\"resumes\"] .away-line");
        await page.waitFor(`${arrived("session")} && document.querySelector('#session .resume')?.textContent.includes('/load')`);
      } finally {
        store.putResumes({ ...resumes, notes: [] });
      }
    });

    it("opens every project's handoffs from the resumes group's \"more\" when those hidden span several", async () => {
      const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
      const note = (title: string, hoursAgo: number, command: string) => ({ title, writtenAt: iso(-hoursAgo * 3600_000), expiresAt: iso((48 - hoursAgo) * 3600_000), command });
      const shop = { id: "web-shop-0badc0de", name: "web-shop", dir: "/home/demo/Projects/web-shop", source: "test-notes", at: iso(0), notes: [note("Shop newest", 1, "/load 1"), note("Shop older", 5, "/load 2")] };
      const billing = { id: "billing-0badc0de", name: "billing", dir: "/home/demo/Projects/billing", source: "test-notes", at: iso(0), notes: [note("Billing new", 2, "/load 1"), note("Billing oldest", 9, "/load 2")] };
      store.putResumes(shop);
      store.putResumes(billing);
      try {
        const page = await openAway(600);
        await page.waitFor("document.querySelector('.away [data-key=\"resumes\"] .away-more')");
        assert.deepEqual(await lines(page, "resumes"), ["Shop newest web-shop", "Billing new billing", "Shop older web-shop"]);
        await page.click(".away [data-key=\"resumes\"] .away-more");
        await page.waitFor(`${arrived("session")} && document.querySelectorAll('#session .resume').length === 4`);
        assert.deepEqual(await page.eval<string[]>("[...document.querySelectorAll('#session .resume-project h4')].map((x) => x.textContent).sort()"), ["billing", "web-shop"]);
        assert.ok(await page.eval<boolean>("[...document.querySelectorAll('#session .resume .agoal')].some((x) => x.textContent === 'Billing oldest')"), "the hidden one, of the other project");
      } finally {
        store.putResumes({ ...shop, notes: [] });
        store.putResumes({ ...billing, notes: [] });
      }
    });

    it("says nothing after a short absence, and sums up on coming back to a page left hidden for a while", async () => {
      const page = await openAway(5);
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(await page.eval<boolean>("!!document.querySelector('.away')"), false, "5 minutes away is not away");
      // Hidden for an hour: the device noted when it stopped looking, and something finished meanwhile.
      await page.eval(`(() => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => window.fakeHidden });
        window.fakeHidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
        localStorage.setItem("agent-desk:last-looked", String(Date.now() - 60 * 60000));
      })()`);
      const r = store.addResult({ sessionId: "demo-iva", title: "Finished behind a hidden page", url: "http://localhost:5173/hidden" });
      await page.eval(`(() => { window.fakeHidden = false; document.dispatchEvent(new Event("visibilitychange")); })()`);
      await page.waitFor("[...document.querySelectorAll('.away .away-line')].some((l) => l.textContent.includes('Finished behind a hidden page'))");
      // Not in History: it belongs to the desk.
      await page.click("#views button", "History");
      await page.waitFor("!document.querySelector('.away')");
      await page.click("#views button", "Desk");
      await page.waitFor("!!document.querySelector('.away')");
      store.markResultSeen(r.id);
    });

    it("on a phone, sits above Needs you one line per group, on every tab of the desk", async () => {
      const r = store.addResult({ sessionId: "demo-iva", title: "Finished while the phone slept", url: "http://localhost:5173/phone" });
      const page = await openAway(90, 390, 844, true);
      await page.waitFor("document.querySelector('#strip .away')?.getBoundingClientRect().height > 0");
      const away = await page.eval<{ bottom: number; needsTop: number; width: number; groups: number[] }>(`(() => ({
        bottom: document.querySelector('.away').getBoundingClientRect().bottom,
        needsTop: document.querySelector('.col-needs').getBoundingClientRect().top,
        width: document.querySelector('.away').getBoundingClientRect().right,
        groups: [...document.querySelectorAll('.away-group')].map((g) => g.querySelectorAll('.away-line').length),
      }))()`);
      assert.ok(away.bottom <= away.needsTop, "above Needs you, covering nothing");
      assert.ok(away.width <= 390, "inside the screen");
      assert.ok(away.groups.every((n) => n === 1), `one line per group: ${away.groups}`);
      await page.tap(".tabbar button", "Sessions");
      await page.waitFor("document.querySelector('.away')?.getBoundingClientRect().height > 0");
      await page.tap(".away-close");
      await page.waitFor("!document.querySelector('.away')");
      store.markResultSeen(r.id);
    });
  });

  describe("forgetting a session", () => {
    it("offers Forget only on a session that is not running, acts on the second click, and takes it off the desk", async () => {
      const at = new Date(Date.now() - 30 * 60000).toISOString();
      store.upsertSession({ id: "to-forget", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "ended and forgotten", state: "ended", endedAt: at, endedAsking: true, lastMessage: { text: "Shall I go on?", at } });
      const result = store.addResult({ sessionId: "to-forget", title: "Left behind by the ended session", url: "http://localhost:5173/left" });
      const page = await open();
      const card = cardOf("ended and forgotten");
      await page.waitFor(card);
      assert.equal(await page.eval<number>("[...document.querySelectorAll('.scard')].filter((c) => c.querySelector('[data-key=forget]')).length"), 1, "only the session that ended offers it");
      await page.click(".scard [data-key=forget]");
      assert.equal(await page.eval<string>(`${card}.querySelector('[data-key=forget]').getAttribute('aria-label')`), "Forget it?");
      assert.equal(await page.eval<boolean>("document.getElementById('session').open"), false, "the click is the button's, not the card's");
      assert.equal(store.getSession("to-forget")?.endedAsking, true, "one click does nothing yet");
      // Its 3 s countdown runs as a transform, which page.click waits out: the second click comes at once, as a person's does.
      await page.eval("document.querySelector('.scard [data-key=forget]').click()");
      await page.waitFor(`!${card}`);
      await page.waitFor("[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Forgot web-shop › ended and forgotten'))");
      assert.ok(store.listResults().find((r) => r.id === result.id)?.seenAt, "its result went to History");
      assert.equal(await page.eval<boolean>("[...document.querySelectorAll('.rtile')].some((t) => t.textContent.includes('Left behind'))"), false);
      await page.click("#views button", "History");
      await page.waitFor("[...document.querySelectorAll('.hitem')].some((h) => h.textContent.includes('Left behind by the ended session') && h.textContent.includes('ended and forgotten'))");
      await page.click("#views button", "Desk");
    });

    it("keeps a session whose process is gone on the desk while it asks, and forgets it from its panel", async () => {
      store.upsertSession({ id: "gone-asking", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "gone while asking", state: "waiting", process: { pid: 2 ** 31 - 3, ancestors: [] } });
      const q = store.ask({ sessionId: "gone-asking", kind: "question", text: "Asked before its process went away?" });
      const page = await open();
      await page.click(".scard", "gone while asking");
      await page.waitFor(arrived("session"));
      assert.match(await page.eval<string>("document.querySelector('#session .pchips').textContent"), /its process is gone\s*Forget/);
      await page.click("#session .pchips [data-key=forget]");
      await page.eval("document.querySelector('#session .pchips [data-key=forget]').click()");
      await page.waitFor("!document.getElementById('session').open");
      await page.waitFor("![...document.querySelectorAll('.scard, .qrow, .next')].some((c) => c.textContent.includes('gone while asking') || c.textContent.includes('Asked before its process'))");
      assert.equal(store.getQuestion(q.id)?.status, "dismissed");
      assert.equal(store.getSession("gone-asking")?.state, "ended");
    });
  });

  it("asks before leaving only while an image or an answer is on its way", async () => {
    store.upsertSession({ id: "leaving", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "leaving mid-upload", takesMessagesWhileWorking: true });
    const page = await browser.newPage(1400, 900);
    pages.push(page);
    // The image never reaches the store: it stays on its way.
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "const real = window.fetch; window.fetch = (url, init) => (String(url).includes('/api/images') ? new Promise(() => {}) : real(url, init));" });
    await page.goto(base + "/");
    await page.waitFor("document.querySelector('.scard')");
    const asks = "(() => { const e = new Event('beforeunload', { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; })()";
    assert.equal(await page.eval<boolean>(asks), false, "nothing on its way: leaving is free");
    await page.click(".scard", "leaving mid-upload");
    // Pasted once the conversation is in, with no redraw of its own to come after the paste.
    await page.waitFor(`${arrived("session")} && document.querySelector('#session .session-body')?.dataset.fetched === 'yes'`);
    await page.eval(`(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(8)], "shot.png", { type: "image/png" }));
      document.querySelector("#session .chat-footer textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    })()`);
    await page.waitFor("document.querySelector('#session .attached')?.textContent.includes('Attaching')");
    assert.equal(await page.eval<boolean>(asks), true, "an image on its way: the browser asks first");
  });

  describe("a window's first focus", () => {
    const focus = (page: Page) => page.eval<{ active: string; ring: boolean }>("({ active: document.activeElement?.tagName + ' ' + (document.activeElement?.textContent ?? ''), ring: document.activeElement?.matches(':focus-visible') ?? false })");

    it("is its title: no ring after a click or a tap, one for the keyboard", async () => {
      const titles = ["Focus by click", "Focus by key", "Focus by tap"];
      for (const title of titles) store.addResult({ sessionId: "demo-iva", title, url: "http://localhost:5173/focus" });
      const page = await open();
      await page.click(".rtile", "Focus by click");
      await page.waitFor(arrived("result"));
      assert.deepEqual(await focus(page), { active: "H3 Focus by click", ring: false }, "not Open live, and no ring");
      await page.press("Escape");
      await page.waitFor("!document.getElementById('result').open");
      await page.eval("[...document.querySelectorAll('.rtile')].find((t) => t.textContent.includes('Focus by key')).focus()");
      // A button acts on the Enter that types (its "char"), not on the bare key press.
      for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: type === "keyDown" ? "\r" : undefined });
      await page.waitFor(arrived("result"));
      assert.deepEqual(await focus(page), { active: "H3 Focus by key", ring: true }, "the keyboard sees where it is");
      await page.press("Escape");
      const phone = await openPhone();
      await phone.tap(".tabbar button", "To review");
      await phone.tap(".rtile", "Focus by tap");
      await phone.waitFor(arrived("result"));
      assert.deepEqual(await focus(phone), { active: "H3 Focus by tap", ring: false });
      assert.equal(await phone.eval<boolean>("!!document.querySelector('#result :focus-visible')"), false);
      await phone.press("Escape");
    });
  });

  it("knows every window of the page by one list", async () => {
    const page = await open();
    assert.deepEqual(await page.eval<string[]>("import('/dom.js').then((m) => [...m.WINDOWS])"), await page.eval<string[]>("[...document.querySelectorAll('dialog')].map((d) => d.id)"));
  });

  describe("a question's card", () => {
    it("reads the whole message first, then the options, then the box, wherever it shows", async () => {
      store.upsertSession({ id: "reading", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "read then choose", state: "waiting" });
      const context = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of what the session said.`).join("\n");
      const q = store.ask({ sessionId: "reading", kind: "question", text: "Which way after reading?", context, options: ["This way", "That way"] });
      const huge = store.ask({ sessionId: "reading", kind: "question", text: "Which way after a huge message?", context: Array.from({ length: 90 }, (_, i) => `Huge line ${i + 1}.`).join("\n"), options: ["Up", "Down"] });
      try {
        const page = await open();
        await page.click(".qrow", "Which way after reading?");
        await page.waitFor(`document.querySelector('.next')?.textContent.includes('Which way after reading?') && ${STILL}`);
        const order = (scope: string) =>
          page.eval<string[]>(`[...document.querySelectorAll('${scope} :is(.qtext, .qctx, .opts, textarea)')].map((el) => el.matches('.qtext') ? 'title' : el.matches('.qctx') ? 'context' : el.matches('.opts') ? 'options' : 'box')`);
        assert.deepEqual(await order(".next"), ["title", "context", "options", "box"]);
        assert.equal(await page.eval<boolean>("document.querySelector('.next .qctx').classList.contains('folded')"), false, "30 lines read whole");
        assert.ok(await page.eval<boolean>("(() => { const c = document.querySelector('.next .qctx'); return c.scrollHeight <= c.clientHeight + 1 && c.textContent.includes('Line 30 of'); })()"));
        // In its session's panel, the same order.
        await page.click(".scard", "read then choose");
        await page.waitFor(arrived("session"));
        assert.deepEqual(await order("#session .panel-question"), ["title", "context", "options", "box"]);
        await page.press("Escape");
        await page.waitFor("!document.getElementById('session').open");
        // Only a huge message folds, from its end: its start reads as written.
        await page.click(".qrow", "Which way after a huge message?");
        await page.waitFor(`document.querySelector('.next')?.textContent.includes('after a huge message') && ${STILL}`);
        assert.equal(await page.eval<boolean>("document.querySelector('.next .qctx').classList.contains('folded')"), true);
        assert.match(await page.eval<string>("document.querySelector('.next .qctx').firstElementChild.textContent"), /^Huge line 1\./);
        assert.equal(await page.eval<number>("document.querySelector('.next .qctx').scrollTop"), 0);
        await page.click(".next .linkish", "Show the whole message");
        await page.waitFor("!document.querySelector('.next .qctx').classList.contains('folded')");
      } finally {
        store.dismiss(q.id);
        store.dismiss(huge.id);
      }
    });

    it("in its session's panel, leaves out what the conversation right above already shows", async () => {
      store.upsertSession({ id: "said-above", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "said above", state: "waiting" });
      const message = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} of the measurements.`).join("\n\n");
      store.addMessage({ sessionId: "said-above", from: "session", text: `${message}\n\nWhich one do I do?\n- Both (recommended)\n- Only the first` });
      const q = store.ask({ sessionId: "said-above", kind: "waiting", text: "Which one do I do?", context: message, options: ["Both (recommended)", "Only the first"] });
      try {
        const page = await open();
        await page.click(".scard", "said above");
        await page.waitFor(`${arrived("session")} && document.querySelector('#session .panel-question') && [...document.querySelectorAll('#session .chat .msg')].some((el) => el.textContent.includes('Paragraph 12 of the measurements.'))`);
        const order = await page.eval<string[]>(`[...document.querySelectorAll('#session .panel-question :is(.qtext, .pq-text, .qctx, .opts, textarea)')].map((el) => el.matches('.qtext, .pq-text') ? 'title' : el.matches('.qctx') ? 'context' : el.matches('.opts') ? 'options' : 'box')`);
        assert.deepEqual([...new Set(order)], ["title", "options", "box"], "the message is not repeated in the box");
        assert.ok(await page.eval<boolean>("(() => { const f = document.querySelector('#session .chat-footer'); return f.getBoundingClientRect().height <= innerHeight / 2 + 1; })()"), "the box takes at most half the window");
      } finally {
        store.dismiss(q.id);
      }
    });

    it("sends a single choice with one click, as Send does, and the next card takes the keys", async () => {
      store.upsertSession({ id: "one-click", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "one click answers", state: "waiting" });
      store.ask({ sessionId: "one-click", kind: "question", text: "Answered with one click?", options: ["Yes, at once", "No"] });
      const stops = [...new Set(store.openQuestions().map((x) => x.sessionId))].map((id) => store.listen(id));
      try {
        const page = await open();
        await page.click(".qrow", "Answered with one click?");
        await page.waitFor(`document.querySelector('.next')?.textContent.includes('Answered with one click?') && document.querySelector('.next .opts button:not([disabled])') && ${STILL}`);
        assert.deepEqual(await page.eval<string[]>("[...document.querySelectorAll('.next .opts button')].map((b) => b.getAttribute('aria-label'))"), ["Answer: Yes, at once", "Answer: No"]);
        await page.click(".next .opts button", "Yes, at once");
        await page.waitFor("document.querySelector('.next.resolved')?.textContent.includes('Yes, at once')");
        assert.deepEqual(store.takeInbox("one-click").map((e) => e.answer), ["Yes, at once"], "sent once, verbatim");
        await page.waitFor("!document.querySelector('.next.resolved') && document.activeElement?.matches('.next:not([data-leaving]) textarea')", 5000);
      } finally {
        for (const stop of stops) stop();
      }
    });

    it("picks an option with a digit without sending it, and Enter sends it", async () => {
      store.upsertSession({ id: "digits", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "digits pick", state: "waiting" });
      const q = store.ask({ sessionId: "digits", kind: "question", text: "Picked with a digit?", options: ["First", "Second"] });
      const stop = store.listen("digits");
      try {
        const page = await open();
        await page.click(".qrow", "Picked with a digit?");
        await page.waitFor(`document.querySelector('.next')?.textContent.includes('Picked with a digit?') && document.querySelector('.next textarea:not([readonly])') && ${STILL}`);
        await page.eval("document.activeElement.blur()");
        for (const type of ["rawKeyDown", "char", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "2", code: "Digit2", text: type === "char" ? "2" : undefined, windowsVirtualKeyCode: 50 });
        await page.waitFor("document.querySelector('.next textarea').value === 'Second' && document.activeElement === document.querySelector('.next textarea')");
        assert.equal(await page.eval<string>("[...document.querySelectorAll('.next .opts button')].find((b) => b.textContent.includes('Second')).getAttribute('aria-pressed')"), "true");
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(store.getQuestion(q.id)?.status, "open", "a digit alone never sends");
        await page.press("Enter");
        await page.waitFor("document.querySelector('.next.resolved')?.textContent.includes('Second')");
        assert.deepEqual(store.takeInbox("digits").map((e) => e.answer), ["Second"]);
      } finally {
        stop();
      }
    });

    it("on a phone, a tapped option sends at once without raising the keyboard", async () => {
      store.upsertSession({ id: "tap-sends", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "a tap answers", state: "waiting" });
      store.ask({ sessionId: "tap-sends", kind: "question", text: "Answered with a tap?", options: ["Tapped", "Not tapped"] });
      const stops = [...new Set(store.openQuestions().map((x) => x.sessionId))].map((id) => store.listen(id));
      try {
        const page = await openPhone();
        await page.click(".qrow", "Answered with a tap?");
        await page.waitFor(`document.querySelector('.next')?.textContent.includes('Answered with a tap?') && document.querySelector('.next .opts button:not([disabled])') && ${STILL}`);
        await page.eval("document.querySelector('.next').scrollIntoView()");
        await page.tap(".next .opts button", "Tapped");
        await page.waitFor("document.querySelector('.next.resolved')?.textContent.includes('Tapped')");
        assert.deepEqual(store.takeInbox("tap-sends").map((e) => e.answer), ["Tapped"]);
        await new Promise((r) => setTimeout(r, 1500));
        assert.equal(await page.eval<string>("document.activeElement?.tagName"), "BODY", "no box took the focus: no keyboard");
      } finally {
        for (const stop of stops) stop();
      }
    });
  });

});
