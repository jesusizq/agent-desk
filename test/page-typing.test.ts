// The page in a real headless Chrome, over the demo store: the answer box and what sessions wrote.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { arrived, base, browser, coveringKeyboard, DRAWN, elsewhere, fetchNow, open, openDialogs, pages, setupPage, SKIP, STILL, store } from "./page-harness.ts";
import { type Page } from "./browser.ts";

describe("page: the answer box and what sessions wrote", SKIP, () => {
  setupPage();

  describe("the box being typed in stays the same element while the desk changes around it", () => {
    /** Watches the box: iOS drops its autocorrect and its paste menu when the element leaves the page or the focus. */
    const watch = (page: Page, box: string) =>
      page.eval(`(() => {
        window.kept = ${box};
        window.blurs = 0;
        kept.addEventListener("blur", () => blurs++);
        window.drops = 0;
        new MutationObserver((changes) => {
          for (const c of changes) for (const n of c.removedNodes) if (n === kept || n.contains(kept)) drops++;
        }).observe(document, { childList: true, subtree: true });
      })()`);
    const untouched = async (page: Page, box: string) => {
      assert.deepEqual(
        await page.eval(`({ same: ${box} === kept, focused: document.activeElement === kept, blurs, drops })`),
        { same: true, focused: true, blurs: 0, drops: 0 },
      );
    };

    it("in a session's chat, and what is sent is what it holds", async () => {
      store.upsertSession({ id: "writing", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "writing on a phone", takesMessagesWhileWorking: true });
      const page = await open(390, 844);
      await page.click(".tabbar button", "Sessions");
      await page.click(".scard", "writing on a phone");
      await page.click("#session .chat-footer textarea");
      await page.type("half a thought");
      const box = "document.querySelector('#session .chat-footer textarea')";
      await watch(page, box);
      await page.eval("kept.setSelectionRange(4, 4)");

      store.upsertAgent("writing", "helper", { goal: "Redraw around the box" });
      await page.waitFor("document.querySelector('#session').textContent.includes('Redraw around the box')");
      await untouched(page, box);
      assert.deepEqual(await page.eval("[kept.value, kept.selectionStart, kept.selectionEnd]"), ["half a thought", 4, 4]);

      // The buttons drawn around it act on the box that stayed.
      await page.type(" more");
      await page.eval("document.querySelector('#session .chat-footer .primary').click()"); // a tap on iOS leaves the focus in the box
      await page.waitFor(`[...document.querySelectorAll('#session .msg.from-developer')].some((m) => m.textContent.includes('half more a thought') && m.querySelector('.delivered')) && ${box}?.value === ''`);
      assert.deepEqual(store.takeInbox("writing").map((e) => e.answer), ["half more a thought"]);
      assert.equal(await page.eval<boolean>(`${box} === kept`), true, "the box empties, it is not replaced");
    });

    it("on the inbox's large card, whose options answer at once", async () => {
      store.upsertSession({ id: "answering", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "answering a question", state: "waiting" });
      const stop = store.listen("answering");
      const asked = store.ask({ sessionId: "answering", kind: "question", text: "Which colour for the button?", options: ["Green", "Blue"] });
      try {
        const page = await open();
        await page.click(".qrow", "Which colour for the button?");
        await page.waitFor("document.querySelector('.next')?.textContent.includes('Which colour for the button?')");
        const box = "document.querySelector('.next textarea')";
        await page.waitFor(STILL); // a card still moving in takes the click elsewhere
        await page.click(".next textarea");
        await page.waitFor(`document.activeElement === ${box}`);
        await page.type("my own answer");
        await watch(page, box);

        const other = store.ask({ sessionId: "demo-pagos", kind: "question", text: "Asked while the other was being answered?" });
        await page.waitFor("document.body.textContent.includes('Asked while the other was being answered?')");
        await untouched(page, box);
        assert.equal(await page.eval<string>("kept.value"), "my own answer");
        store.dismiss(other.id);

        // An option clicked is the answer, sent at once, whatever the box held.
        await page.click(".next .opts button", "Blue");
        await page.waitFor("document.querySelector('.next.resolved')?.textContent.includes('Blue')");
        assert.deepEqual(store.takeInbox("answering").map((e) => e.answer), ["Blue"]);
      } finally {
        store.dismiss(asked.id);
        stop();
      }
    });

    it("turns inert when what it answers stops taking messages, in place, saying where to answer", async () => {
      store.upsertSession({ id: "closing", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "closing under the box", takesMessagesWhileWorking: true });
      const page = await open();
      await page.click(".scard", "closing under the box");
      await page.click("#session .chat-footer textarea");
      await page.type("half a thought");
      const box = "document.querySelector('#session .chat-footer textarea')";
      await watch(page, box);
      store.updateSession("closing", (s) => ({ ...s, state: "waiting" }));
      await page.waitFor(`${box}.readOnly`);
      await untouched(page, box);
      assert.deepEqual(
        await page.eval(`[kept.value, kept.placeholder, kept.getAttribute("aria-disabled"), document.querySelector('#session .chat-footer .send').disabled]`),
        ["half a thought", "Answer in its terminal", "true", true],
        "the draft stays, nothing can be sent, and the box says why",
      );
      await page.press("Escape");
    });
  });

  it("on a phone, keeps the box being typed in above a keyboard that covers the page, as iOS's does", async () => {
    store.upsertSession({ id: "covered", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "covered by the keyboard", state: "waiting" });
    const stop = store.listen("covered");
    const asked = store.ask({ sessionId: "covered", kind: "question", text: "Is the box still in view?", options: ["Yes", "No"] });
    store.upsertSession({ id: "covered-chat", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "chat under the keyboard", takesMessagesWhileWorking: true });
    try {
      const page = await browser.newPage(390, 844);
      pages.push(page);
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: coveringKeyboard(844) });
      await page.goto(base + "/");
      await page.waitFor("document.querySelector('.next')");
      const inView = (box: string) => page.eval<boolean>(`(() => { const r = ${box}.getBoundingClientRect(); return r.top >= 0 && r.bottom <= visualViewport.height; })()`);

      await page.click(".qrow", "Is the box still in view?");
      await page.waitFor("document.querySelector('.next')?.textContent.includes('Is the box still in view?')");
      await page.waitFor(STILL); // the card grows out of its row: measured once it has
      const onCard = "document.querySelector('.next textarea')";
      // Covers the box's last 20 px, whatever its place on the page.
      await page.eval(`(() => { ${onCard}.focus(); window.scrollTo(0, 0); setKeyboard(innerHeight - ${onCard}.getBoundingClientRect().bottom + 20); })()`);
      assert.equal(await inView(onCard), true, "on the inbox's card");
      await page.eval(`(() => { setKeyboard(0); ${onCard}.blur(); })()`);

      await page.click(".tabbar button", "Sessions");
      await page.click(".scard", "chat under the keyboard");
      const inChat = "document.querySelector('#session .chat-footer textarea')";
      await page.waitFor(inChat);
      await page.eval(`(() => { ${inChat}.focus(); setKeyboard(340); })()`);
      assert.equal(await inView(inChat), true, "in a session's chat");
      // Waited for: the window slides in as it opens.
      await page.waitFor("document.querySelector('#session').getBoundingClientRect().bottom <= visualViewport.height");
      await page.eval("setKeyboard(0)");
      await page.waitFor("document.querySelector('#session').getBoundingClientRect().height === 844");
      await page.press("Escape");
    } finally {
      store.dismiss(asked.id);
      stop();
    }
  });

  it("on a phone, the connection's error wraps inside the screen", async () => {
    const page = await open(390, 844);
    await page.eval(`(() => {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = () => timeout(200);
      window.realFetch = window.fetch;
      window.fetch = (url, init) => String(url) === "/api/state" ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))) : window.realFetch(url, init);
    })()`);
    await fetchNow(page);
    await page.waitFor("document.querySelector('#strip .offline')");
    assert.ok(await page.eval<boolean>("document.querySelector('#strip .offline').getBoundingClientRect().right <= innerWidth"), "the whole text is in view, with no sideways scroll");
    assert.ok(await page.eval<boolean>("document.querySelector('#strip .offline').getBoundingClientRect().height > 20"), "on several lines");
    await page.eval("window.fetch = window.realFetch");
    await page.waitFor("!document.querySelector('#strip .offline')");
  });

  it("gives a table's long columns room to read, scrolling sideways when they do not fit", async () => {
    const long = "A long explanation that a narrow column would break into a very tall tower of a few words on each line";
    store.upsertSession({ id: "tables", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "a wide table", state: "waiting" });
    store.addMessage({ sessionId: "tables", from: "session", text: `Summary:\n\n| # | What | Why | Next |\n|---|---|---|---|\n| 1 | ${long} | ${long} | ${long} |` });
    const page = await open(390, 844);
    await page.click(".tabbar button", "Sessions");
    await page.click(".scard", "a wide table");
    await page.waitFor("document.querySelector('#session .md-table td')");
    await page.waitFor(arrived("session"));
    const widths = await page.eval<number[]>("[...document.querySelectorAll('#session .md-table td')].map((c) => c.getBoundingClientRect().width)");
    assert.ok((widths[0] ?? 999) < 60, `a short column stays short: ${widths}`);
    for (const w of widths.slice(1)) assert.ok(w >= 220, `a long column has room: ${widths}`);
    assert.ok(await page.eval<boolean>("(() => { const t = document.querySelector('#session .md-table'); return t.scrollWidth > t.clientWidth && t.getBoundingClientRect().right <= innerWidth; })()"), "the table scrolls inside the screen");
    assert.equal(await page.eval<boolean>("document.querySelector('#session .session-body').scrollWidth <= document.querySelector('#session .session-body').clientWidth"), true, "the conversation does not");
    await page.press("Escape");
  });

  it("folds what a session wrote between its tool calls once something followed it", async () => {
    store.upsertSession({ id: "steps", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "steps folded", state: "working" });
    store.addMessage({ sessionId: "steps", from: "developer", text: "fix the build", via: "terminal" });
    store.addMessage({ sessionId: "steps", from: "session", text: "Looking at the logs first.", step: true });
    store.addMessage({ sessionId: "steps", from: "session", text: "Found it: a missing import.", step: true });
    store.addMessage({ sessionId: "steps", from: "session", text: "Fixed and tested." });
    store.addMessage({ sessionId: "steps", from: "session", text: "Now running the e2e suite.", step: true });
    const page = await open();
    await page.click(".scard", "steps folded");
    await page.waitFor("document.querySelector('#session .steps-fold')");
    const texts = () => page.eval<string[]>("[...document.querySelectorAll('#session .msg:not(.working-now) .md')].map((m) => m.textContent)");
    assert.deepEqual(await texts(), ["fix the build", "Fixed and tested.", "Now running the e2e suite."], "the latest run, still being written, stays open");
    assert.match(await page.eval<string>("document.querySelector('#session .steps-fold').textContent"), /2 messages while it worked/);
    await page.click("#session .steps-fold");
    await page.waitFor("document.querySelectorAll('#session .msg.step').length === 3");
    assert.deepEqual((await texts()).slice(1, 3), ["Looking at the logs first.", "Found it: a missing import."]);
    await page.press("Escape");
  });

  it("quotes what another session or an agent sent under their name, never as the developer's, an agent's report folded", async () => {
    store.upsertSession({ id: "peers", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "told by peers", state: "waiting" });
    store.addMessage({ sessionId: "peers", from: "peer", sender: "portfolio-78", text: "Can you rebase onto **main** first?" });
    store.addMessage({ sessionId: "peers", from: "agent", sender: "Review the zoom", text: "No critical findings." });
    store.addMessage({ sessionId: "peers", from: "session", text: "Rebased, and the review found nothing." });
    const page = await open();
    await page.click(".scard", "told by peers");
    await page.waitFor("document.querySelector('#session .msg.from-peer')");
    assert.equal(await page.eval<number>("document.querySelectorAll('#session .msg.from-developer').length"), 0);
    assert.match(await page.eval<string>("document.querySelector('#session .msg.from-peer .msg-meta').textContent"), /^From portfolio-78 · /);
    assert.equal(await page.eval<string>("document.querySelector('#session .msg.from-peer .md b').textContent"), "main", "its Markdown is rendered, as the session's is");
    assert.equal(await page.eval<boolean>("!!document.querySelector('#session .msg.from-agent')"), false, "the report is folded");
    const fold = "[...document.querySelectorAll('#session .steps-fold')].find((b) => b.textContent.includes('Agent report: Review the zoom'))";
    assert.equal(await page.eval<string>(`${fold}.getAttribute('aria-expanded')`), "false");
    await page.click("#session .steps-fold", "Agent report: Review the zoom");
    await page.waitFor("document.querySelector('#session .msg.from-agent .md')?.textContent === 'No critical findings.'");
    await page.press("Escape");
  });

  it("keeps the line breaks of what the developer pasted, and joins the session's wrapped lines", async () => {
    store.upsertSession({ id: "pasted", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "pasted output" });
    store.addMessage({ sessionId: "pasted", from: "developer", text: "$ git push\nfatal: 403", via: "terminal" });
    store.addMessage({ sessionId: "pasted", from: "session", text: "The push was\nrefused." });
    const page = await open();
    await page.click(".scard", "pasted output");
    await page.waitFor("document.querySelector('#session .msg.from-developer')");
    const shown = (who: string) => page.eval<string>(`document.querySelector('#session .msg.from-${who} .md p').innerText`);
    assert.equal(await shown("developer"), "$ git push\nfatal: 403");
    assert.equal(await shown("session"), "The push was refused.");
    await page.press("Escape");
  });

  it("sets the theme and the text size from the display menu, kept for the next visit", async () => {
    const page = await open();
    const rootSize = "getComputedStyle(document.documentElement).fontSize";
    assert.equal(await page.eval<string>(rootSize), "16px");
    await page.click("#theme");
    await page.click("#display-menu .sizes button:last-child");
    await page.waitFor(`${rootSize} === "20px"`);
    assert.equal(await page.eval<boolean>("!document.querySelector('#display-menu').hidden"), true, "a choice leaves the menu open");
    await page.click("#display-menu button", "Dark");
    await page.waitFor("document.documentElement.dataset.theme === 'dark'");
    await page.goto(base + "/");
    await page.waitFor(`document.querySelector('.scard') && ${rootSize} === "20px" && document.documentElement.dataset.theme === 'dark'`);
    await page.eval("localStorage.clear()");
  });

  describe("on a phone, the answer box works as a chat app's", () => {
    /** The desk as a phone shows it: a finger, no hover, the page's own viewport. */
    /** A phone's screen, touched with a finger, or with a mouse when `mouse` (a tablet's keyboard cover, a desktop browser's device mode). */
    async function phone(width = 390, height = 844, setup = "", mouse = false): Promise<Page> {
      const page = await browser.newPage(width, height);
      pages.push(page);
      await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true });
      if (!mouse) {
        await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        await page.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });
      }
      if (setup) await page.send("Page.addScriptToEvaluateOnNewDocument", { source: setup });
      await page.goto(base + "/");
      await page.waitFor(DRAWN);
      return page;
    }
    /** A session waiting on a question with options, its listener running until `stop`. */
    function asking(id: string, title: string) {
      store.upsertSession({ id, provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title, state: "waiting" });
      const stop = store.listen(id);
      const q = store.ask({ sessionId: id, kind: "question", text: `Which colour, ${title}?`, options: ["Green", "Blue"] });
      return () => (store.dismiss(q.id), stop());
    }
    const openPanel = async (page: Page, title: string) => {
      await page.click(".tabbar button", "Sessions");
      await page.click(".scard", title);
      await page.waitFor(`document.querySelector('#session .chat-footer textarea') && ${STILL}`);
    };

    it("one line when empty, round buttons, clear of the home indicator, with the conversation resting on it", async () => {
      store.upsertSession({ id: "composer", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "a phone's composer", takesMessagesWhileWorking: true });
      const page = await phone();
      await openPanel(page, "a phone's composer");
      const shape = await page.eval<Record<string, unknown>>(`(() => {
        const box = document.querySelector('#session .chat-footer textarea'), send = document.querySelector('#session .chat-footer .send');
        const foot = document.querySelector('#session .chat-footer'), chat = document.querySelector('#session .conversation');
        return { rows: box.rows, oneLine: box.getBoundingClientRect().height <= 46, resize: getComputedStyle(box).resize,
          send: [send.offsetWidth, send.offsetHeight], name: send.getAttribute('aria-label'), footPad: getComputedStyle(foot).paddingBottom,
          resting: foot.getBoundingClientRect().top - chat.getBoundingClientRect().bottom <= 12 };
      })()`);
      assert.deepEqual(shape, { rows: 1, oneLine: true, resize: "none", send: [44, 44], name: "Send to the session", footPad: "12px", resting: true });
      await page.press("Escape");
    });

    it("a tapped option is sent at once without raising the keyboard; a tap on the box does", async () => {
      const done = asking("picking", "picking on a phone");
      try {
        const page = await phone();
        await openPanel(page, "picking on a phone");
        await page.tap("#session .opts button", "Blue");
        const box = "document.querySelector('#session .chat-footer textarea')";
        await page.waitFor("[...document.querySelectorAll('#session .msg.from-developer')].some((m) => m.textContent.includes('Blue') && m.querySelector('.delivered'))");
        assert.deepEqual(store.takeInbox("picking").map((e) => e.answer), ["Blue"], "sent as tapped, once");
        assert.equal(await page.eval<boolean>(`document.activeElement === ${box}`), false, "the box is not focused, so no keyboard rose");
        await page.tap("#session .chat-footer textarea");
        await page.waitFor(`document.activeElement === ${box}`);
        await page.press("Escape");
      } finally {
        done();
      }
    });

    it("keeps the box focused after Send, so the keyboard stays up for the next message", async () => {
      store.upsertSession({ id: "chatting", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "chatting on a phone", takesMessagesWhileWorking: true });
      const page = await phone();
      await openPanel(page, "chatting on a phone");
      const box = "document.querySelector('#session .chat-footer textarea')";
      await page.tap("#session .chat-footer textarea");
      await page.waitFor(`document.activeElement === ${box}`);
      await page.type("first of two");
      await page.tap("#session .chat-footer .send");
      await page.waitFor(`[...document.querySelectorAll('#session .msg.from-developer')].some((m) => m.textContent.includes('first of two') && m.querySelector('.delivered')) && ${box}.value === ''`);
      assert.equal(await page.eval<boolean>(`document.activeElement === ${box}`), true);
      assert.deepEqual(store.takeInbox("chatting").map((e) => e.answer), ["first of two"]);
      await page.press("Escape");
    });

    it("slides the tab bar away only once a keyboard is up, with nothing moving under the finger", async () => {
      const done = asking("kbd-room", "room for the keyboard");
      try {
        const page = await phone();
        await page.click(".qrow", "room for the keyboard");
        const box = "document.querySelector('.next textarea')";
        await page.waitFor(`${box} && ${STILL}`);
        const where = `[Math.round(scrollY), Math.round(${box}.getBoundingClientRect().top), document.documentElement.scrollHeight]`;
        await page.eval("window.scrollTo(0, document.documentElement.scrollHeight)");
        const before = await page.eval<number[]>(where);
        await page.eval(`${box}.focus({ preventScroll: true })`);
        await page.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        assert.deepEqual(await page.eval<number[]>(where), before, "focus alone moves nothing: the keyboard may not even come");
        const bar = "getComputedStyle(document.querySelector('.tabbar')).visibility";
        assert.equal(await page.eval<string>(bar), "visible");
        // As Android with interactive-widget=resizes-content: the whole viewport shrinks for the keyboard.
        await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 508, deviceScaleFactor: 1, mobile: true });
        await page.waitFor(`document.documentElement.hasAttribute('data-keyboard') && ${bar} === "hidden"`);
        assert.ok(await page.eval<boolean>("document.querySelector('.tabbar').getBoundingClientRect().top >= innerHeight"), "slid below the screen");
        await page.eval(`${box}.blur()`);
        await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await page.waitFor(`!document.documentElement.hasAttribute('data-keyboard') && ${bar} === "visible"`);
      } finally {
        done();
      }
    });

    it("under a keyboard that covers the page, as iOS's, turns compact, sits on the keyboard, and toasts come from the top", async () => {
      const done = asking("compact", "compact under the keyboard");
      store.upsertSession({ id: "compact-other", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "another session", state: "working" });
      try {
        const page = await phone(390, 844, coveringKeyboard(844));
        await openPanel(page, "compact under the keyboard");
        const box = "document.querySelector('#session .chat-footer textarea')";
        await page.tap("#session .chat-footer textarea");
        await page.eval("setKeyboard(336)");
        await page.waitFor("document.documentElement.hasAttribute('data-compact')");
        const fit = await page.eval<Record<string, unknown>>(`(() => {
          const foot = document.querySelector('#session .chat-footer');
          return { chips: getComputedStyle(document.querySelector('#session .pchips')).display, kind: getComputedStyle(document.querySelector('#session .panel-question > .meta')).display,
            onKeyboard: 508 - ${box}.getBoundingClientRect().bottom, roomLeft: foot.getBoundingClientRect().height < 508 * 0.45 };
        })()`);
        assert.deepEqual(fit, { chips: "none", kind: "none", onKeyboard: 8, roomLeft: true });
        await page.tap("#session .opts button", "Green");
        await page.waitFor("[...document.querySelectorAll('#session .msg.from-developer')].some((m) => m.textContent.includes('Green') && m.querySelector('.delivered'))");
        store.updateSession("compact-other", (s) => ({ ...s, state: "waiting", lastMessage: { text: "Done elsewhere.", at: new Date().toISOString() } }));
        await page.waitFor("document.querySelector('.toast')?.textContent.includes('another session')");
        assert.deepEqual(
          await page.eval("(() => { const t = document.querySelector('.toast').getBoundingClientRect(); return [t.top >= document.querySelector('#session .dhead').getBoundingClientRect().bottom, t.bottom < 508 / 2]; })()"),
          [true, true],
          "under the window's head, so its title, Go and Close stay in sight, and far from the box",
        );
        await page.press("Escape");
      } finally {
        done();
      }
    });

    it("on a short phone, a long draft under the keyboard keeps the question, the box's end and Send above the keyboard", async () => {
      const done = asking("short", "a long draft on a short phone");
      try {
        const page = await phone(375, 667, coveringKeyboard(667));
        await openPanel(page, "a long draft on a short phone");
        await page.tap("#session .chat-footer textarea");
        await page.eval("setKeyboard(260)");
        await page.waitFor("document.documentElement.hasAttribute('data-compact')");
        for (let i = 0; i < 9; i++) await page.type(`Line ${i} of a long draft\n`);
        const fit = await page.eval<Record<string, unknown>>(`(() => {
          const foot = document.querySelector('#session .chat-footer'), box = foot.querySelector('textarea'), send = foot.querySelector('.send');
          return { footScrolls: foot.scrollHeight - foot.clientHeight, question: foot.querySelector('.qtext').getBoundingClientRect().top >= foot.getBoundingClientRect().top,
            boxOnKeyboard: 407 - Math.round(box.getBoundingClientRect().bottom), sendOnKeyboard: 407 - Math.round(send.getBoundingClientRect().bottom), boxScrolls: box.scrollHeight > box.clientHeight };
        })()`);
        assert.deepEqual(fit, { footScrolls: 0, question: true, boxOnKeyboard: 8, sendOnKeyboard: 8, boxScrolls: true });
        await page.press("Escape");
      } finally {
        done();
      }
    });

    for (const mouse of [false, true]) {
      it(`under a keyboard that covers the page, a box on the inbox's card growing line by line keeps its end and Send above the keyboard${mouse ? ", with a mouse" : ""}`, async () => {
        const id = mouse ? "growing-mouse" : "growing";
        const done = asking(id, "a growing answer");
        try {
          const page = await phone(390, 844, coveringKeyboard(844), mouse);
          await page.click(".qrow", "a growing answer");
          const box = "document.querySelector('.next textarea')";
          await page.waitFor(`${box} && document.querySelector('.next').textContent.includes('a growing answer') && ${STILL}`);
          // The keyboard leaves 20 px under the box: no scroll is needed until it grows. Measured whatever the pointer
          // (with a mouse, no data-keyboard: a box focused there raises no keyboard of the phone's own).
          await page.eval(`(() => { ${box}.focus(); setKeyboard(innerHeight - ${box}.getBoundingClientRect().bottom - 20); })()`);
          await page.waitFor(`parseFloat(document.documentElement.style.getPropertyValue('--keyboard')) > 0 && ${mouse ? "!" : ""}document.documentElement.hasAttribute('data-keyboard')`);
          for (let i = 0; i < 4; i++) await page.type(`Line ${i} of a longer answer\n`);
          const room = await page.eval<number[]>(`(() => {
            const send = document.querySelector('.next .send');
            return [${box}, send].map((el) => Math.round(visualViewport.height - el.getBoundingClientRect().bottom));
          })()`);
          assert.ok(room.every((px) => px >= 16), `the box's end and Send stay 16 px above the keyboard: ${room}`);
        } finally {
          done();
        }
      });
    }

    it("keeps a toast where it came in when the window it came over closes", async () => {
      store.upsertSession({ id: "toast-edge", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "a toast's edge", takesMessagesWhileWorking: true });
      store.upsertSession({ id: "toast-edge-other", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "finishing elsewhere", state: "working" });
      const page = await phone();
      await openPanel(page, "a toast's edge");
      store.updateSession("toast-edge-other", (s) => ({ ...s, state: "waiting", lastMessage: { text: "Finished over there.", at: new Date().toISOString() } }));
      const toast = "[...document.querySelectorAll('.toast')].find((t) => t.textContent.includes('finishing elsewhere'))";
      await page.waitFor(`${toast} && !${toast}.getAnimations().length`);
      const top = await page.eval<number>(`${toast}.getBoundingClientRect().top`);
      assert.ok(top < 844 / 2, "over the window, it comes from the top");
      await page.press("Escape");
      await page.waitFor("!document.getElementById('session').open");
      assert.equal(await page.eval<number>(`${toast}.getBoundingClientRect().top`), top, "the window gone, it stays there until it leaves");
    });
  });

  it("keeps the large card's shape when its session starts or stops listening", async () => {
    store.upsertSession({ id: "flipping", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "listening on and off", state: "waiting" });
    const asked = store.ask({ sessionId: "flipping", kind: "question", text: "Does the card hold still?", options: ["Yes", "No"] });
    try {
      const page = await open();
      await page.click(".qrow", "Does the card hold still?");
      const card = "document.querySelector('.next')";
      await page.waitFor(`${card}?.textContent.includes('Does the card hold still?') && ${STILL}`);
      const height = () => page.eval<number>(`${card}.getBoundingClientRect().height`);
      const off = await height();
      assert.equal(await page.eval<string>(`${card}.querySelector('textarea').placeholder`), "Answer in its terminal");
      const stop = store.listen("flipping");
      await page.waitFor(`!${card}.querySelector('.answer.off')`);
      assert.equal(await height(), off, "the box, the options and the link stay where they were");
      stop();
      await page.waitFor(`${card}.querySelector('.answer.off')`);
      assert.equal(await height(), off);
    } finally {
      store.dismiss(asked.id);
    }
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
