// The page in a real headless Chrome, over the demo store: sessions, the unlock, the connection and the event stream.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PNG, serve, tempHome } from "./helpers.ts";
import { Store } from "../src/store/store.ts";
import { arrived, base, browser, cardOf, DRAWN, elsewhere, fetchNow, open, pages, setupPage, SKIP, STILL, store } from "./page-harness.ts";
import { type Page } from "./browser.ts";

describe("page: sessions, the unlock, the connection and the event stream", SKIP, () => {
  setupPage();

  it("opens a session from its card, shows the turn at work, and closes with Escape", async () => {
    const page = await open();
    await page.click(".scard", "checkout redesign");
    await page.waitFor("document.getElementById('session').open");
    await page.waitFor("document.querySelector('#session .working-now')?.textContent.includes('Edit: src/checkout/OrderSummary.tsx')");
    assert.match(await page.eval<string>("document.querySelector('#session .working-now').textContent"), /^\s*Working/);
    const agents = await page.eval<string[]>("[...document.querySelectorAll('#session .working-now .agoal')].map((g) => g.textContent)");
    assert.ok(agents.includes("Order summary beside the cart"), "its agents at work are listed under it");
    assert.ok(!agents.includes("Three pay button variants"), "finished ones are not");
    // The conversation arrives after the panel opens and moves everything: a click before it lands elsewhere.
    await page.waitFor("document.querySelector('#session .session-body')?.dataset.fetched === 'yes'");
    const fold = "document.querySelector('#session .working-now .agents-fold')";
    assert.equal(await page.eval<boolean>(`${fold}.open`), false, "the agents are folded under one line");
    assert.match(await page.eval<string>(`${fold}.querySelector('summary').textContent`), /^\d+ still running( · \d+ failed)?$/);
    await page.click("#session .working-now .agents-fold > summary");
    await page.waitFor(`${fold}.open`);
    store.upsertAgent("demo-checkout", "summary", { activity: "Editing src/checkout/Totals.tsx" });
    await page.waitFor("document.querySelector('#session .working-now')?.textContent.includes('Totals.tsx')");
    assert.equal(await page.eval<boolean>(`${fold}.open`), true, "unfolded, they stay so across redraws");
    await page.press("Escape");
    await page.waitFor("!document.getElementById('session').open");
  });

  it("writes to a session while it works, when its adapter delivers mid-turn", async () => {
    store.upsertSession({ id: "mid-turn", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "release notes", takesMessagesWhileWorking: true });
    const page = await open();
    await page.click(".scard", "release notes");
    await page.click("#session .chat-footer textarea");
    assert.equal(await page.eval<string>("document.querySelector('#session .chat-footer textarea').placeholder"), "Write to it while it works…");
    await page.type("and push it when the tests pass");
    // A second click before the answer arrives (a slow phone network) sends nothing more.
    const button = "document.querySelector('#session .chat-footer .send')";
    const box = "document.querySelector('#session .chat-footer textarea')";
    const width = await page.eval<number>(`${box}.getBoundingClientRect().width`);
    const mine = "[...document.querySelectorAll('#session .msg.from-developer')].filter((m) => m.textContent.includes('and push it when the tests pass'))";
    assert.deepEqual(
      await page.eval(`(() => { const b = ${button}; b.click(); b.click(); return [b.getAttribute("aria-busy"), ${box}.readOnly, ${box}.getBoundingClientRect().width, ${box}.value, ${mine}.map((m) => m.querySelector('.msg-meta').textContent)]; })()`),
      ["true", true, width, "", ["You, from the desk · Sending…"]],
      "it says at once, in the conversation, that the message is on its way, without resizing the box",
    );
    await page.waitFor(`${mine}.length === 1 && ${mine}[0].querySelector('.msg-meta .delivered') && !${box}.readOnly && !${button}.hasAttribute("aria-busy")`);
    assert.equal(await page.eval<string>(`${mine}[0].querySelector('.delivered').getAttribute('aria-label')`), "Delivered", "its tick is read out");
    assert.deepEqual(store.takeInbox("mid-turn").map((e) => e.answer), ["and push it when the tests pass"], "sent once");
    await page.waitFor(`${mine}.length === 1 && !${mine}[0].classList.contains('out')`); // the conversation itself now holds it, once
    assert.equal(await page.eval<number>("document.querySelectorAll('.toast').length"), 0, "no toast says it was sent");
  });

  it("opens a question's box while its session works, puts the exact text in that session's inbox as its answer, and marks only that message", async () => {
    store.upsertSession({ id: "asked-at-work", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "endpoint cleanup", state: "working", takesMessagesWhileWorking: true });
    const text = "keep it a week,  then drop it";
    // Written the same way in an earlier turn: it was not sent while the session worked.
    store.addMessage({ sessionId: "asked-at-work", from: "developer", text, via: "terminal" });
    // Asked as a turn ended, then a background task woke the session: nothing answered it.
    const asked = store.ask({ sessionId: "asked-at-work", kind: "question", text: "Keep the old endpoint?", options: ["Yes", "No"] });
    try {
      const page = await open();
      await page.click(".qrow", "Keep the old endpoint?");
      await page.waitFor("document.querySelector('.next')?.textContent.includes('Keep the old endpoint?')");
      assert.deepEqual(
        await page.eval("[!!document.querySelector('.next .answer.off'), !!document.querySelector('.next .go-link kbd')]"),
        [false, false],
        "on the desk too, its box answers and Enter is not offered as the only way",
      );
      await page.click(".scard", "endpoint cleanup");
      const panel = "document.querySelector('#session .panel-question')";
      await page.waitFor(`${panel}?.textContent.includes('Keep the old endpoint?')`);
      assert.deepEqual(
        await page.eval(`[!!${panel}.querySelector('.answer.off'), ${panel}.querySelector('textarea').placeholder, ${panel}.querySelector('textarea').readOnly]`),
        [false, "Write to it while it works…", false],
        "the box takes what is written, for the session's next step",
      );
      await page.click("#session .panel-question textarea");
      await page.type(text);
      await page.click("#session .panel-question .send");
      const mine = `[...document.querySelectorAll('#session .msg.from-developer')].filter((m) => m.textContent.includes(${JSON.stringify(text)}))`;
      await page.waitFor(`${mine}.length === 2 && !${mine}.some((m) => m.classList.contains('out'))`);
      assert.deepEqual(store.takeInbox("asked-at-work").map((e) => [e.questionId, e.answer, e.message]), [[asked.id, text, undefined]], "delivered once, exactly as written, to that session, as the answer to that question");
      assert.equal(store.getQuestion(asked.id)?.answer?.via, "desk");
      await page.waitFor(`${mine}[1].querySelector('.msg-meta').textContent.includes('sent while it worked')`);
      assert.equal(await page.eval<boolean>(`${mine}[0].querySelector('.msg-meta').textContent.includes('sent while it worked')`), false, "the earlier same words are not marked");
    } finally {
      store.dismiss(asked.id);
    }
  });

  it("keeps a question's box inert at work when the session takes no message then, or a hook must settle it", async () => {
    store.upsertSession({ id: "deaf-at-work", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "deaf at work", state: "working" });
    store.upsertSession({ id: "prompt-at-work", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "prompt at work", state: "working", takesMessagesWhileWorking: true });
    const asked = [
      store.ask({ sessionId: "deaf-at-work", kind: "question", text: "Rename the table?" }),
      store.ask({ sessionId: "prompt-at-work", kind: "permission", text: "Bash: rm -rf dist", options: ["Allow", "Deny"] }),
      store.ask({ sessionId: "prompt-at-work", kind: "question", text: "Which layout?", options: ["A", "B"], dialog: true }),
    ];
    // Another sub-agent's prompt, whose hook waits: only that one is answered from the desk.
    const awaited = store.ask({ sessionId: "prompt-at-work", kind: "permission", text: "Bash: npm publish", options: ["Allow", "Deny"] });
    const stop = store.listen("prompt-at-work", process.pid, { questions: [awaited.id] });
    try {
      const page = await open();
      await page.click(".qrow", awaited.text);
      await page.waitFor(`document.querySelector('.next')?.textContent.includes(${JSON.stringify(awaited.text)}) && !document.querySelector('.next .answer.off') && !document.querySelector('.next').getAnimations({ subtree: true }).length`);
      for (const q of asked) {
        await page.click(".qrow", q.text);
        await page.waitFor(`document.querySelector('.next')?.textContent.includes(${JSON.stringify(q.text)}) && !document.querySelector('.next').getAnimations({ subtree: true }).length`);
        assert.deepEqual(
          await page.eval(`[!!document.querySelector('.next .answer.off'), document.querySelector('.next textarea').placeholder, !!document.querySelector('.next .go-link kbd')]`),
          [true, "Answer in its terminal", true],
          `${q.text}: answered in its terminal`,
        );
      }
    } finally {
      stop();
      for (const q of [...asked, awaited]) store.dismiss(q.id);
    }
  });

  it("opens what came earlier in a session on the turn right before its question", async () => {
    store.upsertSession({ id: "earlier", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "earlier turns", state: "waiting" });
    for (let i = 1; i <= 8; i++) store.addMessage({ sessionId: "earlier", from: "session", text: `Turn ${i}: ${"what the session reported at length. ".repeat(6)}` });
    const asked = store.ask({ sessionId: "earlier", kind: "question", text: "Ship the earlier turns?" });
    try {
      const page = await open();
      await page.click(".qrow", "Ship the earlier turns?");
      await page.click(".next button", "Earlier in this session");
      const block = "document.querySelector('.next .conversation')";
      await page.waitFor(`${block} && ${STILL}`);
      const [top, height, shown] = await page.eval<[number, number, number]>(`[${block}.scrollTop, ${block}.scrollHeight, ${block}.clientHeight]`);
      assert.ok(height > shown, "longer than its box");
      assert.ok(Math.abs(top + shown - height) <= 1, `scrolled to its newest end: ${top} + ${shown} of ${height}`);
    } finally {
      store.dismiss(asked.id);
    }
  });

  it("titles a turn that ends asking with its question, what the paragraph says around it right under it, and leaves that turn out of the earlier ones", async () => {
    store.upsertSession({ id: "pin-copy", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "pin copy", state: "waiting" });
    store.addMessage({ sessionId: "pin-copy", from: "session", text: "Turn 1: the offline banner is in." });
    // As the Claude Code adapter records a turn that ends asking in plain text.
    store.addMessage({ sessionId: "pin-copy", from: "session", text: "Los tests pasan.\n\nSi el PIN caduca, la copia guardada sigue en el móvil. ¿Lo dejo así, o la borro? Yo recomiendo borrarla." });
    const asked = store.ask({ sessionId: "pin-copy", kind: "waiting", text: "¿Lo dejo así, o la borro?", context: "Si el PIN caduca, la copia guardada sigue en el móvil. Yo recomiendo borrarla.\n\nLos tests pasan." });
    try {
      const page = await open();
      await page.click(".qrow", "¿Lo dejo así, o la borro?");
      assert.equal(await page.eval<string>("document.querySelector('.next .qtext').textContent"), "¿Lo dejo así, o la borro?");
      assert.ok((await page.eval<string>("document.querySelector('.next .qctx').textContent")).startsWith("Si el PIN caduca"), "the rest of its paragraph comes first");
      await page.click(".next button", "Earlier in this session");
      await page.waitFor("document.querySelector('.next .conversation')");
      const earlier = await page.eval<string>("document.querySelector('.next .conversation').textContent");
      assert.ok(earlier.includes("Turn 1: the offline banner is in."));
      assert.ok(!earlier.includes("Yo recomiendo borrarla"), "the asking turn is on the card already");
    } finally {
      store.dismiss(asked.id);
    }
  });

  it("shows in an open session what it writes and what is typed to it while it works, without reopening", async () => {
    store.upsertSession({ id: "live-steps", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "live steps", state: "working" });
    store.addMessage({ sessionId: "live-steps", from: "developer", text: "migrate the schema", via: "terminal" });
    const page = await open();
    await page.click(".scard", "live steps");
    await page.waitFor("document.querySelector('#session .session-body')?.dataset.fetched === 'yes' && document.querySelector('#session').textContent.includes('migrate the schema')");
    // Mid-turn, neither its state nor its last message changes: only the conversation grows.
    store.addMessage({ sessionId: "live-steps", from: "session", text: "Generated the migration for the orders table.", step: true });
    await page.waitFor("document.querySelector('#session').textContent.includes('Generated the migration for the orders table.')");
    store.addMessage({ sessionId: "live-steps", from: "developer", text: "and keep the old column for a week", via: "terminal" });
    await page.waitFor("document.querySelector('#session').textContent.includes('and keep the old column for a week')");
    await page.press("Escape");
  });

  it("asks for the PIN again when the unlock ends, and drops what was being written", async () => {
    store.upsertSession({ id: "pin-ended", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "pin ended", takesMessagesWhileWorking: true });
    const page = await open();
    await page.click(".scard", "pin ended");
    await page.click("#session .chat-footer textarea");
    await page.type("half a thought");
    await page.waitFor("(localStorage.getItem('agent-desk:drafts') ?? '').includes('half a thought')");
    // What the server answers a device whose 24 hours ended; a reload loads the page's real fetch again.
    await page.eval(`(() => {
      window.beforeReload = true;
      const real = window.fetch;
      window.fetch = (url, init) => String(url) === "/api/state" ? Promise.resolve(new Response("{}", { status: 401, headers: { "X-Agent-Desk-Locked": "1" } })) : real(url, init);
    })()`);
    await page.reloadedBy(() => fetchNow(page));
    await page.waitFor("window.beforeReload === undefined && document.querySelector('.scard')");
    assert.equal(await page.eval<string | null>("localStorage.getItem('agent-desk:drafts')"), null, "nothing written outlives the unlock");
    await page.click(".scard", "pin ended");
    await page.waitFor("document.querySelector('#session .chat-footer textarea')");
    assert.equal(await page.eval<string>("document.querySelector('#session .chat-footer textarea').value"), "");
  });

  it("keeps what was being written when the app closes while the desk is unlocked", async () => {
    store.upsertSession({ id: "app-closed", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "app closed", takesMessagesWhileWorking: true });
    const page = await open();
    await page.click(".scard", "app closed");
    await page.click("#session .chat-footer textarea");
    await page.type("half a thought");
    // As iOS closing the app: nothing warned the page, the draft is already on the device.
    await page.goto(base + "/");
    await page.waitFor("document.querySelector('.scard')");
    await page.click(".scard", "app closed");
    await page.waitFor("document.querySelector('#session .chat-footer textarea')?.value === 'half a thought'");
    await page.click("#session .chat-footer .primary");
    await page.waitFor("localStorage.getItem('agent-desk:drafts') === null");
    assert.deepEqual(store.takeInbox("app-closed").map((e) => e.answer), ["half a thought"], "sent, and no longer kept");
  });

  it("reloads when the unlock the desk named ends, so a device offline then shows nothing it saved", async () => {
    const page = await open();
    // What the server tells a device that entered the PIN: when its unlock ends, here in a moment from
    // its first answer, so a slow answer cannot already be past it. The tab's session storage outlives
    // the reload, to compare when it came with that end.
    await page.eval(`(() => {
      window.beforeReload = true;
      const real = window.fetch;
      let ends = "";
      window.fetch = (url, init) => String(url) === "/api/state" ? real(url).then(async (r) => {
        const body = await r.text();
        if (!ends) sessionStorage.setItem("ends", (ends = String(Date.now() + 800)));
        return new Response(body, { headers: { "Content-Type": "application/json", "X-Agent-Desk-Unlock-Ends": ends } });
      }) : real(url, init);
      addEventListener("pagehide", () => sessionStorage.setItem("left", String(Date.now())));
    })()`);
    await page.eval(`localStorage.setItem("agent-desk:drafts", JSON.stringify({ drafts: [["message-demo-pagos", "unsent idea"]], images: [] }))`);
    await page.eval(`localStorage.setItem("agent-desk:reviews", JSON.stringify({ "rv-gone": { ops: [{ op: "set", key: "answers", value: "kept offline" }], at: 0.4 } }))`);
    await page.reloadedBy(() => fetchNow(page));
    await page.waitFor("window.beforeReload === undefined && document.querySelector('.scard')");
    const [ends, left] = await page.eval<[number, number]>(`[Number(sessionStorage.getItem("ends")), Number(sessionStorage.getItem("left"))]`);
    assert.ok(ends > 0 && left >= ends, `not before the end (left at ${left}, the unlock ended at ${ends})`);
    assert.equal(await page.eval<string | null>("localStorage.getItem('agent-desk:drafts')"), null, "its drafts went with the unlock");
    assert.equal(await page.eval<string | null>("localStorage.getItem('agent-desk:reviews')"), null, "and the review changes kept on the device");
  });

  it("drops a saved draft whose question closed or whose session is gone", async () => {
    const page = await open();
    await page.eval(`localStorage.setItem("agent-desk:drafts", JSON.stringify({ drafts: [["answer-closed", "too late"], ["message-gone", "nobody"]], images: [] }))`);
    await page.goto(base + "/");
    await page.waitFor("document.querySelector('.scard') && localStorage.getItem('agent-desk:drafts') === null");
  });

  it("says when the device is not allowed, and how old the saved desk is", async () => {
    const page = await open();
    await page.eval(`(() => {
      window.realFetch = window.fetch;
      window.fetch = (url, init) => String(url) === "/api/state" ? Promise.resolve(new Response("{}", { status: 421 })) : window.realFetch(url, init);
    })()`);
    await fetchNow(page);
    await page.waitFor("document.querySelector('#strip .offline')?.textContent.includes('not allowed')");
    const yesterday = new Date(Date.now() - 864e5).toISOString();
    await page.eval(`(() => {
      window.fetch = async (url, init) => {
        if (String(url) !== "/api/state") return window.realFetch(url, init);
        const headers = new Headers({ "X-Agent-Desk-Saved-At": ${JSON.stringify(yesterday)} });
        return new Response(await (await window.realFetch(url)).blob(), { headers });
      };
    })()`);
    await page.waitFor("document.querySelector('#strip .offline')?.textContent.includes('Offline · last update Yesterday')");
    await page.eval("window.fetch = window.realFetch");
    await page.waitFor("!document.querySelector('#strip .offline')");
  });


  it("a hidden page notifies on the computer, and on a phone leaves it to the push, which carries no text", async () => {
    const away = await elsewhere();
    const remote = away.url;
    /** The titles of the page's own notifications when a question opens while it is hidden. @param url where the page runs */
    const notified = async (url: string, text: string) => {
      const page = await browser.newPage(390, 800);
      pages.push(page);
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `Object.defineProperty(document, "hidden", { get: () => true });
          window.raised = [];
          window.Notification = class { static permission = "granted"; constructor(title) { raised.push(title); } };`,
      });
      await page.goto(url);
      await page.waitFor("document.title.endsWith('Agent Desk') && document.querySelector('.next')");
      const q = store.ask({ sessionId: "demo-iva", kind: "question", text });
      await page.waitFor(`document.body.textContent.includes(${JSON.stringify(text)})`);
      store.dismiss(q.id);
      return page.eval<string[]>("raised");
    };
    try {
      assert.match((await notified(base + "/", "Asked on the computer?")).join(), /New question/);
      assert.deepEqual(await notified(remote, "Asked on the phone?"), []);
    } finally {
      const opened = pages.splice(0);
      await Promise.all(opened.map((page) => page.close()));
      await away.close();
      for (const page of opened) assert.deepEqual(page.errors, [], "the page reports no errors");
    }
  });

  it("a tapped notification shows what needs the developer, whatever was open", async () => {
    const page = await open(390, 800);
    const on = (tab: string) => `document.querySelector('.tabbar button[aria-pressed="true"]')?.textContent.includes(${JSON.stringify(tab)})`;
    await page.click(".tabbar button", "History");
    await page.waitFor(on("History"));
    await page.eval(`navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { show: "needs" } }))`);
    await page.waitFor(on("Needs you"));
    await page.click(".tabbar button", "History");
    await page.waitFor(on("History"));
    await page.eval(`location.hash = "#needs"`);
    await page.waitFor(on("Needs you"));
    await page.eval(`location.hash = ""`);
  });

  it("says the connection is lost when requests hang, also inside a session, and recovers", async () => {
    store.upsertSession({ id: "hung", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "hung line", takesMessagesWhileWorking: true });
    const page = await open();
    await page.click(".scard", "hung line");
    await page.waitFor("document.querySelector('#session .chat-footer textarea')");
    // A computer asleep: no answer and no failure, only the page's own limit ends the wait (shortened here).
    await page.eval(`(() => {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = () => timeout(300);
      window.realFetch = window.fetch;
      window.fetch = (url, init) => String(url) === "/api/state" ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))) : window.realFetch(url, init);
    })()`);
    await fetchNow(page);
    await page.waitFor("document.querySelector('#strip .offline')?.textContent.includes('agent-desk serve')");
    await page.waitFor("document.querySelector('#session .offline-line')?.textContent.includes('agent-desk serve')");
    await page.eval("window.fetch = window.realFetch");
    await page.waitFor("!document.querySelector('#strip .offline') && !document.querySelector('#session .offline-line')");
  });

  it("shows a question as soon as it is asked, told by the desk's event stream, with no poll at all", async () => {
    const page = await browser.newPage(1400, 900);
    pages.push(page);
    // The poll's tick (live.js) taken away: only the event stream can bring the question.
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "const every = window.setInterval; window.setInterval = (fn, ms, ...rest) => (ms === 1500 ? 0 : every(fn, ms, ...rest));" });
    await page.goto(base + "/");
    await page.waitFor("document.querySelector('.next') && document.documentElement.dataset.live === 'stream'");
    const q = store.ask({ sessionId: "demo-iva", kind: "question", text: "Told by the stream?" });
    try {
      await page.waitFor("document.querySelector('.col-needs')?.textContent.includes('Told by the stream?')");
    } finally {
      store.dismiss(q.id);
    }
    await page.waitFor("!document.querySelector('.col-needs')?.textContent.includes('Told by the stream?')");
  });

  it("shows a question the session opened again in Needs you, in its place by when it was asked", async () => {
    const reopened = store.ask({ sessionId: "demo-iva", kind: "waiting", text: "Opened again in its place?" });
    const later = store.ask({ sessionId: "demo-iva", kind: "question", text: "Asked after it?" });
    store.closeOpen("demo-iva", { answer: "something else entirely", probable: true, which: (q) => q.id === reopened.id });
    // What waits, in order: the large card, then the rows.
    const waits = "[...document.querySelectorAll('.col-needs .next .qtext, .col-needs .qrow .qt')].map((e) => e.textContent)";
    const shows = (text: string) => `${waits}.some((t) => t.includes(${JSON.stringify(text)}))`;
    try {
      const page = await open();
      await page.waitFor(shows("Asked after it?"));
      assert.equal(await page.eval<boolean>(shows("Opened again in its place?")), false, "answered, it left Needs you");
      store.unanswered("demo-iva", reopened.id);
      await page.waitFor(shows("Opened again in its place?"));
      const order = await page.eval<string[]>(waits);
      const at = (text: string) => order.findIndex((t) => t.includes(text));
      assert.ok(at("Opened again in its place?") < at("Asked after it?"), `before the question asked after it: ${JSON.stringify(order)}`);
    } finally {
      store.dismiss(reopened.id);
      store.dismiss(later.id);
    }
  });

  it("shares one event stream among the tabs of a browser, handed to another tab when its tab closes", async () => {
    const noPoll = "const every = window.setInterval; window.setInterval = (fn, ms, ...rest) => (ms === 1500 ? 0 : every(fn, ms, ...rest));";
    const tab = async () => {
      const page = await browser.newPage(1400, 900);
      pages.push(page);
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: noPoll });
      await page.goto(base + "/");
      await page.waitFor("document.querySelector('.next') && document.documentElement.dataset.live === 'stream'");
      return page;
    };
    const first = await tab();
    const second = await tab();
    const streams = (page: Page) => page.eval<number[]>("navigator.locks.query().then((s) => [s.held.length, s.pending.length])");
    assert.deepEqual(await streams(second), [1, 1], "one tab holds the stream, the other waits to take it over");
    const shows =(text: string) => `document.querySelector('.col-needs')?.textContent.includes(${JSON.stringify(text)})`;
    const q1 = store.ask({ sessionId: "demo-iva", kind: "question", text: "Heard in both tabs?" });
    try {
      await first.waitFor(shows("Heard in both tabs?"));
      await second.waitFor(shows("Heard in both tabs?"));
    } finally {
      store.dismiss(q1.id);
    }
    await first.close();
    pages.splice(pages.indexOf(first), 1);
    const q2 = store.ask({ sessionId: "demo-iva", kind: "question", text: "Heard once the first tab closed?" });
    try {
      await second.waitFor(shows("Heard once the first tab closed?"));
    } finally {
      store.dismiss(q2.id);
    }
    assert.deepEqual(first.errors, [], "the closed tab reported no errors");
  });

  it("when the desk stops, keeps its last state marked offline, with answering off and the draft kept, and comes back by itself", async () => {
    store.upsertSession({ id: "stopping", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "desk stopping", takesMessagesWhileWorking: true });
    // A desk of its own, to stop and start again on the same port.
    const own = await serve(store);
    const { createDeskServer } = await import("../src/server/server.ts");
    let back: http.Server | undefined;
    // Closed by the test before the desk it streams from: cutting its stream first logs one more unanswered request.
    const page = await browser.newPage(1400, 900);
    try {
      await page.goto(own.base + "/");
      await page.waitFor("document.querySelector('.scard') && document.documentElement.dataset.live === 'stream'");
      await page.click(".scard", "desk stopping");
      await page.click("#session .chat-footer textarea");
      await page.type("half a thought");
      const box = "document.querySelector('#session .chat-footer textarea')";

      await own.close();
      await page.waitFor("document.querySelector('#strip .offline')?.textContent.includes('Offline · last update')");
      assert.match(await page.eval<string>("document.querySelector('#strip .offline').textContent"), /agent-desk serve/, "and why");
      assert.equal(await page.eval<string>("document.documentElement.dataset.live"), "poll", "polled while the stream is away");
      await page.waitFor(`${box}?.readOnly`);
      assert.deepEqual(
        await page.eval(`[${box}.value, ${box}.placeholder, ${box}.getAttribute("aria-disabled"), document.querySelector('#session .chat-footer .send').disabled, document.querySelector('#session .send-hint').textContent]`),
        ["half a thought", "Offline", "true", true, "Offline: it can be sent once the desk answers again."],
        "the draft stays, nothing can be sent, and the box says why",
      );
      assert.ok(await page.eval<boolean>("document.querySelector('#session').textContent.includes('desk stopping') && !!document.querySelector('#session .offline-line')"), "the last state stays in view, marked");

      back = createDeskServer(store, own.port);
      await new Promise<void>((r) => back?.listen(own.port, "127.0.0.1", r));
      await page.waitFor(`!document.querySelector('#strip .offline') && !${box}.readOnly && document.documentElement.dataset.live === 'stream'`, 10_000);
      assert.equal(await page.eval<string>(`${box}.value`), "half a thought");
      await page.press("Escape");
    } finally {
      await page.close();
      back?.closeAllConnections();
      await new Promise((r) => (back ? back.close(r) : r(undefined)));
    }
    // The browser logs each request the stopped desk could not answer; nothing else may have gone wrong.
    const unanswered = (e: string) => /^Failed to load resource: net::ERR_\w+ /.test(e) && e.includes(`${own.base}/api/`);
    assert.deepEqual(page.errors.filter((e) => !unanswered(e)), [], "the page reports no other errors");
  });

  it("shows a question asked during a turn only when the turn has finished writing it", async () => {
    store.upsertSession({ id: "still-writing", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "still writing" });
    store.updateSession("still-writing", (s) => ({ ...s, state: "working" }));
    const q = store.ask({ sessionId: "still-writing", kind: "question", text: "Half-written question?", writing: true });
    const page = await open();
    const seen = "document.body.textContent.includes('Half-written question?')";
    await page.waitFor("document.querySelector('.scard')");
    await new Promise((r) => setTimeout(r, 1800)); // more than a poll
    assert.equal(await page.eval<boolean>(seen), false, "held while its turn runs");
    store.addContext(q.id, "The whole explanation.");
    store.releaseQuestions("still-writing");
    await page.waitFor(seen);
    store.dismiss(q.id);
  });

  it("gives two projects whose names hash alike colours of their own", async () => {
    for (const [id, name] of [["hue-a", "psicolegalmente"], ["hue-b", "cooktops-ng"]] as const) store.upsertSession({ id, provider: "Test", project: { name, dir: `/home/demo/Projects/${name}` }, title: `colour of ${name}` });
    const page = await open();
    const colours = await page.eval<string[]>(`["psicolegalmente", "cooktops-ng"].map((n) => getComputedStyle([...document.querySelectorAll('#projects .pname, .scard .pname')].find((e) => e.textContent === n)).color)`);
    assert.notEqual(colours[0], colours[1], `${colours[0]} and ${colours[1]}`);
    for (const id of ["hue-a", "hue-b"]) store.updateSession(id, (s) => ({ ...s, state: "ended", endedAt: new Date().toISOString() }));
  });

  it("still honours the seen.json cut-off an earlier page wrote: results before it are seen, after it new, and marking leaves the earlier ones alone", async () => {
    const own = new Store(path.join(tempHome(), "store"));
    own.upsertSession({ id: "legacy", provider: "Test", project: { name: "alpha", dir: "/home/demo/Projects/alpha" }, title: "work in alpha", state: "working" });
    const before = own.addResult({ sessionId: "legacy", title: "finished before the cut-off" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    own.addResult({ sessionId: "legacy", title: "finished after it" });
    fs.writeFileSync(own.paths.seen, JSON.stringify({ since: before.at }), { mode: 0o600 });
    const served = await serve(own);
    const page = await browser.newPage(1400, 900);
    try {
      await page.goto(served.base + "/");
      const strip = "document.querySelector('#strip').textContent";
      await page.waitFor(`${strip}.includes('Not reviewed: 1 finished.')`);
      assert.equal(await page.eval<string>("[...document.querySelectorAll('.col-review .rtile-wrap .rt')].map((t) => t.textContent).join()"), "finished after it", "To review lists only what came after the cut-off");
      await page.click("#strip button", "Mark all as seen");
      await page.waitFor(`${strip}.includes('Nothing new to review.')`);
      const seen = Object.fromEntries(own.listResults().map((r) => [r.title, r.seenAt !== undefined]));
      assert.deepEqual(seen, { "finished before the cut-off": false, "finished after it": true }, "only what the line counted is marked; the cut-off keeps the earlier one seen");
      assert.equal(own.getSeen()?.since, before.at, "the cut-off is read, never rewritten");
    } finally {
      // The page first: a desk closed under it breaks its event stream, which the page reports as an error.
      await page.close();
      await served.close();
    }
    assert.deepEqual(page.errors, [], "the page reports no errors");
  });

  it("marks seen from the strip only what its line counts: the project shown, its failures too, no other project's results", async () => {
    // A desk of its own: the shared one has results other tests count on staying new.
    const own = new Store(path.join(tempHome(), "store"));
    for (const name of ["alpha", "beta"]) {
      own.upsertSession({ id: `seen-${name}`, provider: "Test", project: { name, dir: `/home/demo/Projects/${name}` }, title: `work in ${name}`, state: "working" });
      own.addResult({ sessionId: `seen-${name}`, title: `${name} finished` });
      own.addResult({ sessionId: `seen-${name}`, title: `${name} broke`, status: "failed" });
    }
    const served = await serve(own);
    const page = await browser.newPage(1400, 900);
    try {
      await page.goto(served.base + "/");
      const strip = "document.querySelector('#strip').textContent";
      await page.waitFor(`${strip}.includes('Not reviewed: 2 finished, 2 failures.')`);
      await page.click("#projects button", "alpha");
      await page.waitFor(`${strip}.includes('Not reviewed: 1 finished, 1 failure.')`);
      await page.click("#strip button", "Mark all as seen");
      await page.waitFor(`${strip}.includes('Nothing new to review.')`);
      const seen = Object.fromEntries(own.listResults().map((r) => [r.title, r.seenAt !== undefined]));
      assert.deepEqual(seen, { "alpha finished": true, "alpha broke": true, "beta finished": false, "beta broke": false }, "what the line counted is cleared, beta's results stay new");
      assert.equal(own.getSeen(), undefined, "nothing marks everything at once");
      await page.click("#projects button", "All");
      await page.waitFor(`${strip}.includes('Not reviewed: 1 finished, 1 failure.')`);
    } finally {
      await page.close();
      await served.close();
    }
    assert.deepEqual(page.errors, [], "the page reports no errors");
  });

  it("takes a result the store no longer holds as seen, from its × or its window, with no error", async () => {
    const own = new Store(path.join(tempHome(), "store"));
    own.upsertSession({ id: "gone-result", provider: "Test", project: { name: "alpha", dir: "/home/demo/Projects/alpha" }, title: "work in alpha", state: "working" });
    const dismissed = own.addResult({ sessionId: "gone-result", title: "alpha finished" });
    const opened = own.addResult({ sessionId: "gone-result", title: "alpha built" });
    const served = await serve(own);
    const page = await browser.newPage(1400, 900);
    try {
      await page.goto(served.base + "/");
      // Settled once the seen request's answer is read and no fetch of the state runs: a refusal's toast
      // is shown in the microtasks after, so a zero timeout comes after it.
      await page.eval(`import('/server.js').then((m) => {
        window.desk = m;
        const real = window.fetch;
        window.fetch = async (url, init) => {
          const res = await real(url, init);
          if (!String(url).includes('/seen')) return res;
          const json = res.json.bind(res);
          res.json = () => json().finally(() => { window.seenRead = true; });
          return res;
        };
      })`);
      for (const [r, button] of [[dismissed, ".rdismiss"], [opened, ".rtile"]] as const) {
        const tile = `document.querySelector('[data-key="r-${r.id}"]')`;
        await page.waitFor(`!!${tile}?.querySelector('${button}')`);
        // Held before the store loses it: the click comes from a tile still drawn when it went.
        await page.eval(`window.held = ${tile}.querySelector('${button}'); window.seenRead = false`);
        fs.rmSync(own.paths.result(r.id));
        await page.eval("window.held.click()");
        await page.waitFor("window.seenRead && window.desk.requestsWaiting === 0");
        await page.eval("new Promise((done) => setTimeout(done, 0))");
        assert.deepEqual(await page.eval<string[]>("[...document.querySelectorAll('.toast')].map((t) => t.textContent)"), [], `${button}: no toast says it is missing`);
        await page.waitFor(`!${tile}`);
      }
    } finally {
      await page.close();
      await served.close();
    }
    assert.deepEqual(page.errors, [], "the page reports no errors");
  });

  it("keeps what was sent in the conversation while the device's saved copy answers for a slow computer", async () => {
    const sid = "full-load";
    store.upsertSession({ id: sid, provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "a computer at full load", takesMessagesWhileWorking: true });
    store.updateSession(sid, (s) => ({ ...s, state: "working", activityAt: new Date().toISOString() }));
    store.addMessage({ sessionId: sid, from: "session", text: "Running the whole suite" });
    const page = await open();
    await page.click(".scard", "a computer at full load");
    const chat = "document.querySelector('#session .conversation.chat')";
    await page.waitFor(`${chat}?.textContent.includes('Running the whole suite') && ${STILL}`);
    // From now on the conversation comes from the copy the device saved before, as sw.js answers past its wait.
    await page.eval(`(async () => {
      const saved = await (await fetch('/api/sessions/${sid}/messages')).text();
      const real = window.fetch;
      window.savedServed = 0;
      window.slow = true;
      window.fetch = (url, init) => window.slow && String(url).endsWith('/${sid}/messages')
        ? (window.savedServed++, Promise.resolve(new Response(saved, { headers: { 'Content-Type': 'application/json', 'X-Agent-Desk-Saved-At': new Date(Date.now() - 60000).toISOString() } })))
        : real(url, init);
    })()`);
    await page.click("#session .chat-footer textarea");
    await page.type("how is it going?");
    await page.click("#session .chat-footer .send");
    const sent = `[...${chat}.querySelectorAll('.msg.from-developer')].filter((m) => m.textContent.includes('how is it going?'))`;
    await page.waitFor(`${sent}.length === 1 && !!${sent}[0].querySelector('.delivered')`);
    const served = await page.eval<number>("window.savedServed");
    store.addMessage({ sessionId: sid, from: "session", text: "Half of it passes" });
    await page.waitFor(`window.savedServed > ${served}`);
    await page.eval("new Promise((done) => setTimeout(done, 100))");
    assert.equal(await page.eval<number>(`${sent}.length`), 1, "the saved copy predates the message: it stays on the page as sent");
    await page.eval("window.slow = false");
    await page.waitFor(`${chat}.textContent.includes('Half of it passes')`);
    assert.equal(await page.eval<number>(`${sent}.length`), 1, "once the computer answers, the conversation holds it once");
    await page.press("Escape");
  });

  it("marks a session unread back to the list, and opening it reads it again", async () => {
    store.upsertSession({ id: "come-back", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "come back later" });
    store.updateSession("come-back", (s) => ({ ...s, state: "waiting", lastMessage: { text: "Here is the long report", at: new Date().toISOString() } }));
    const page = await open();
    const card = cardOf("come back later");
    await page.waitFor(`${card}?.textContent.includes('New message')`);
    await page.click(".scard", "come back later");
    await page.waitFor(`document.querySelector('#session .dhead')?.textContent.includes('Mark unread')`);
    await page.waitFor(`${card}?.textContent.includes('Waiting for you')`);
    assert.ok(store.getSession("come-back")?.readAt, "opened: read");
    await page.click("#session .dhead button", "Mark unread");
    await page.waitFor(`!document.getElementById('session').open && ${card}?.textContent.includes('New message')`);
    assert.equal(store.getSession("come-back")?.readAt, undefined);
    await page.click(".scard", "come back later");
    await page.waitFor(`${card}?.textContent.includes('Waiting for you')`);
    await page.press("Escape");
  });

  it("fits Mark unread in a session's header on a phone, as an icon large enough to tap", async () => {
    store.upsertSession({ id: "phone-head", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "a long session title that needs two lines on a phone" });
    store.updateSession("phone-head", (s) => ({ ...s, state: "waiting", lastMessage: { text: "Report", at: new Date().toISOString() } }));
    const page = await open(390, 800);
    await page.click(".tabbar button", "Sessions");
    await page.click(".scard", "a long session title");
    const button = "[...document.querySelectorAll('#session .dhead button')].find((b) => b.getAttribute('aria-label') === 'Mark unread')";
    await page.waitFor(`${button} && ${arrived("session")}`); // measured at rest: mid-slide its width is off by a float's error
    const size = await page.eval<{ w: number; h: number; inner: number; label: number }>(`(() => { const b = ${button}; const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, inner: b.scrollWidth, label: b.querySelector('.lbl').getClientRects().length }; })()`);
    assert.equal(size.label, 0, "only its icon: the words do not fit");
    assert.ok(size.w >= 44 && size.h >= 30 && size.inner <= size.w, JSON.stringify(size));
    await page.press("Escape");
  });

  it("keeps in view a session that ended asking, until it is opened", async () => {
    store.upsertSession({ id: "ended-asking", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "gone mid question" });
    store.updateSession("ended-asking", (s) => ({ ...s, state: "ended", endedAsking: true, lastMessage: { text: "Should I delete it?", at: new Date().toISOString() } }));
    const page = await open();
    const card = cardOf("gone mid question");
    await page.waitFor(`${card}?.textContent.includes('It ended while asking')`);
    await page.click(".scard", "gone mid question");
    await page.waitFor(`document.getElementById('session').open`);
    await page.waitFor(`document.querySelector('#session .dhead')?.textContent.includes('Mark unread')`);
    await page.press("Escape");
    await page.waitFor(`!${card}`);
    // Started again, it is an ordinary live session even if an old mark is left on it.
    store.updateSession("ended-asking", (s) => ({ ...s, state: "waiting", readAt: undefined as never, lastMessage: { text: "Should I delete it?", at: new Date().toISOString() } }));
    await page.waitFor(`${card}?.textContent.includes('New message')`);
    assert.ok(!(await page.eval<string>(`${card}.textContent`)).includes("It ended while asking"));
  });

  it("warns only when a plan window fills before it resets", async () => {
    const page = await open();
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const resetsAt = new Date(Date.now() + 3 * 3600_000).toISOString();
    store.recordPlan([{ label: "5 h", percent: 50, resetsAt }], at(40));
    store.recordPlan([{ label: "5 h", percent: 70, resetsAt }], at(1));
    await page.waitFor(`document.querySelector('#strip')?.textContent.includes('5 h limit: at this pace, out around')`);
    fs.rmSync(store.paths.plan);
    await page.waitFor(`!document.querySelector('#strip')?.textContent.includes('5 h limit')`);
  });

  it("sends an image pasted into the box with the message", async () => {
    store.upsertSession({ id: "with-image", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "hero picture", takesMessagesWhileWorking: true });
    const page = await open();
    await page.click(".scard", "hero picture");
    await page.click("#session .chat-footer textarea");
    await page.type("like this one");
    await page.eval(`(() => {
      const png = Uint8Array.from(atob(${JSON.stringify(PNG.toString("base64"))}), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([png], "shot.png", { type: "image/png" }));
      document.querySelector("#session .chat-footer textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    })()`);
    await page.waitFor("document.querySelector('#session .attached img')?.complete");
    assert.equal(await page.eval<string>("document.querySelector('#session .chat-footer textarea').value"), "like this one", "the text typed stays as it was");
    await page.click("#session .chat-footer .primary");
    await page.waitFor("[...document.querySelectorAll('#session .msg.from-developer')].some((m) => m.textContent.includes('like this one') && m.querySelector('.msg-imgs img') && m.querySelector('.delivered'))");
    const [entry] = store.takeInbox("with-image");
    assert.equal(entry?.answer, "like this one");
    assert.equal(entry?.images?.length, 1);
    assert.ok(store.imageFile(entry?.images?.[0] ?? ""), "the image is in the store");
  });

  it("on a phone, shows the project's name whole and keeps a long draft where it is written", async () => {
    store.upsertSession({ id: "long-draft", provider: "Test", project: { name: "invoices-api", dir: "/home/demo/Projects/invoices-api" }, title: "a session whose title is far too long for a phone", takesMessagesWhileWorking: true });
    const page = await open(390, 844);
    await page.click(".tabbar button", "Sessions");
    const proj = `${cardOf("far too long")}.querySelector('.sproj')`;
    await page.waitFor(proj);
    assert.equal(await page.eval<boolean>(`${proj}.scrollWidth <= ${proj}.clientWidth`), true, "the project's name is not cut");
    await page.click(".scard", "far too long");
    await page.click("#session .chat-footer textarea");
    const box = "document.querySelector('#session .chat-footer textarea')";
    const before = await page.eval<number>(`${box}.clientHeight`);
    await page.type(Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
    assert.ok((await page.eval<number>(`${box}.clientHeight`)) > before, "the box grows with the draft");
    const top = await page.eval<number>(`${box}.scrollTop`);
    assert.ok(top > 0, "a draft taller than the box is scrolled to where it is written");
    store.upsertAgent("long-draft", "helper", { goal: "Redraw the panel" });
    await page.waitFor(`document.querySelector('#session').textContent.includes('Redraw the panel')`);
    assert.equal(await page.eval<number>(`${box}.scrollTop`), top, "a redraw keeps the draft's scroll");
    assert.equal(await page.eval<boolean>(`document.activeElement === ${box}`), true);
  });

  it("says why the page did not start when one of its files does not load, instead of staying blank", async () => {
    const page = await browser.newPage(390, 844);
    try {
      // The desk started before a file was added: the page asks for a module the desk does not serve.
      await page.send("Network.enable");
      await page.send("Network.setBypassServiceWorker", { bypass: true });
      await page.send("Network.setBlockedURLs", { urls: ["*/follow.js"] });
      await page.goto(base + "/");
      await page.waitFor("document.querySelector('#boot-failed')?.textContent.includes('could not load all its files')");
      assert.ok(await page.eval<boolean>("!!document.querySelector('#boot-failed button')"), "with a way to reload");
      assert.equal(await page.eval<number>("document.querySelectorAll('.scard').length"), 0, "the desk did not start");
      page.errors.length = 0; // the blocked file is this test's doing
      await page.send("Network.setBlockedURLs", { urls: [] });
      await page.goto(base + "/");
      await page.waitFor(DRAWN);
      assert.equal(await page.eval<boolean>("!!document.querySelector('#boot-failed')"), false, "started, the page says nothing of it");
    } finally {
      await page.close();
    }
  });

});
