// The page in a real headless Chrome, over the demo store: reviews.
import * as fs from "node:fs";
import * as http from "node:http";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { handleHook, readHookInput } from "../adapters/claude-code/hooks.ts";
import { Store } from "../src/store/store.ts";
import { arrived, base, browser, cardOf, elsewhere, fetchNow, open, pages, setupPage, SKIP, STILL, store } from "./page-harness.ts";
import { renderOptionsPage } from "../src/cli/review-options.ts";
import { type Page } from "./browser.ts";

describe("page: reviews", SKIP, () => {
  setupPage();

  describe("reviews", () => {
    /** A review page as a session writes one: `n` cards to keep, a counter, and a button that copies the answers; `tall` makes it scroll. */
    const reviewHtml = (n: number, tall = false) => `<!doctype html><html><head><title>cards</title><style>article { ${tall ? "height: 600px;" : ""} }</style></head><body>
<header><span id="count" data-agent-desk-progress></span><button id="copy" data-agent-desk-answers>Copy answers</button></header>
${Array.from({ length: n }, (_, i) => `<article data-i="${i}"><button class="keep">Keep ${i}</button></article>`).join("\n")}
<script>
const answers = JSON.parse(localStorage.getItem("answers") || "{}");
const paint = () => { document.getElementById("count").textContent = Object.keys(answers).length + "/" + ${n}; for (const a of document.querySelectorAll("article")) a.dataset.kept = answers[a.dataset.i] ? "yes" : ""; };
document.body.addEventListener("click", (e) => {
  const b = e.target.closest(".keep");
  if (!b) return;
  answers[b.parentElement.dataset.i] = "yes";
  localStorage.setItem("answers", JSON.stringify(answers));
  paint();
});
document.getElementById("copy").addEventListener("click", () => navigator.clipboard.writeText("kept: " + Object.keys(answers).sort().join(", ")));
paint();
</script></body></html>`;
    /** A session in web-shop, and a review it publishes. */
    function publish(sid: string, title: string, session: Partial<Parameters<Store["upsertSession"]>[0]> = {}, html = reviewHtml(3), at?: Store) {
      store.upsertSession({ id: sid, provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: `${title} session`, ...session });
      return (at ?? store).publishReview({ sessionId: sid, title, html });
    }
    /** The desk with a review open, its page loaded in its frame. */
    async function openReview(title: string, page?: Page): Promise<Page> {
      const p = page ?? (await open());
      await p.click(".rv-tile", title);
      await p.waitFor(`${arrived("review")} && document.querySelector('#review iframe')`);
      await p.inFrame("/review/", "true");
      return p;
    }
    const tile = (title: string) => `[...document.querySelectorAll('.rv-tile')].find((t) => t.textContent.includes(${JSON.stringify(title)}))`;
    /** A real click on the card's button inside the frame, as the developer's. */
    const keepInFrame = (page: Page, i: number) => page.inFrame("/review/", `document.querySelector('[data-i="${i}"] .keep').click(), true`);

    it("lists each review in To review with its round, progress and last change, and on its session's card", async () => {
      const first = publish("rv-list", "Hero copy");
      store.publishReview({ sessionId: "rv-list", title: "hero copy ", html: reviewHtml(5) });
      store.changeReviewState(first.id, { ops: [{ op: "set", key: "answers", value: '{"0":"yes","1":"yes"}' }], progress: "2 of 5" }, "remote");
      const page = await open();
      await page.waitFor(tile("Hero copy"));
      const text = await page.eval<string>(`${tile("Hero copy")}.textContent`);
      assert.match(text, /Round 2/);
      assert.match(text, /2 of 5/);
      assert.match(text, /Last change on your phone/);
      assert.match(text, /New/, "not opened yet");
      assert.equal(await page.eval<string>(`${tile("Hero copy")}.querySelector('.rv-meter i').style.width`), "40%");
      assert.match(await page.eval<string>(`${cardOf("Hero copy session")}.querySelector('.rv-sline').textContent`), /Review · hero copy\s*2 of 5/);
      // Not a question: Needs you does not count it, To review does.
      assert.equal(await page.eval<boolean>("document.querySelector('.col-needs').textContent.includes('Hero copy')"), false);
      store.closeReview(first.id);
      await page.waitFor(`!${tile("Hero copy")} && !${cardOf("Hero copy session")}?.querySelector('.rv-sline')`);
    });

    it("marks a review New again, saying so, when a newer round replaced what the developer saw", async () => {
      const r = publish("rv-round", "Footer copy");
      store.changeReviewState(r.id, { ops: [{ op: "set", key: "answers", value: "{}" }] }, "local");
      store.markReviewOpened(r.id);
      const page = await open();
      await page.waitFor(`${tile("Footer copy")}?.textContent.includes('Last change')`);
      assert.equal(await page.eval<boolean>(`${tile("Footer copy")}.textContent.includes('New')`), false, "seen, and nothing newer");
      store.publishReview({ sessionId: "rv-round", title: "Footer copy", html: reviewHtml(2) });
      await page.waitFor(`${tile("Footer copy")}?.querySelector('.rv-foot').textContent.startsWith('Round 2 published')`);
      assert.match(await page.eval<string>(`${tile("Footer copy")}.querySelector('.rv-badges').textContent`), /Round 2.*New/);
      await openReview("Footer copy", page);
      await page.click(".rv-back");
      await page.waitFor(`!${tile("Footer copy")}.querySelector('.rv-badges').textContent.includes('New')`);
      store.closeReview(r.id);
    });

    it("says calmly when a review was left alone for two days, on its tile and in the summary of the time away", async () => {
      const before = new Store(store.paths.home, () => new Date(Date.now() - 3 * 24 * 3600_000));
      const r = publish("rv-still", "Footer links", {}, reviewHtml(3), before);
      const page = await browser.newPage(1400, 900);
      pages.push(page);
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("agent-desk:last-looked", String(Date.now() - 120 * 60000));` });
      await page.goto(base + "/");
      await page.waitFor(tile("Footer links"));
      assert.match(await page.eval<string>(`${tile("Footer links")}.querySelector('.rv-foot').textContent`), /^Untouched since /);
      await page.waitFor("[...document.querySelectorAll('.away [data-key=\"reviews\"] .away-line')].some((l) => l.textContent.includes('Footer links · untouched since'))");
      await page.click(".away .away-line", "Footer links");
      await page.waitFor(arrived("review"));
      store.closeReview(r.id);
    });

    it("opens a review filling the window in a sandbox, keeps what is marked in it, and closes with Escape or going back", async () => {
      const r = publish("rv-open", "Button labels");
      const page = await openReview("Button labels");
      const box = await page.eval<{ w: number; h: number; vw: number; vh: number }>("(() => { const r = document.getElementById('review').getBoundingClientRect(); return { w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; })()");
      assert.deepEqual([box.w, box.h], [box.vw, box.vh], "the review fills the window");
      assert.deepEqual(
        await page.eval<string[]>("['sandbox', 'referrerpolicy', 'allow'].map((a) => document.querySelector('#review iframe').getAttribute(a))"),
        ["allow-scripts", "no-referrer", ""],
        "scripts only, no referrer, no permissions",
      );
      assert.equal(await page.eval<string>("new URL(document.querySelector('#review iframe').src).pathname"), `/review/${r.id}`);
      assert.equal(await page.eval<string>("location.hash"), `#rv=${r.id}`);
      assert.match(await page.eval<string>("document.querySelector('.rv-bar').textContent"), /Button labels.*web-shop.*0 of 3/);
      await keepInFrame(page, 1);
      await page.waitFor("document.querySelector('.rv-count').textContent === '1 of 3'");
      await page.waitFor("document.querySelector('.rv-saved').textContent.startsWith('Saved')");
      assert.deepEqual(store.reviewState(r.id).data, { answers: '{"1":"yes"}' });
      assert.deepEqual(store.getReview(r.id)?.progress, { done: 1, total: 3 });
      // Escape, with the desk's bar focused (inside the frame, the keys are the page's own).
      await page.click(".rv-name");
      await page.press("Escape");
      await page.waitFor("!document.getElementById('review').open && location.hash === ''");
      await page.waitFor(`${tile("Button labels")}.textContent.includes('1 of 3')`);
      assert.equal(await page.eval<boolean>(`${tile("Button labels")}.textContent.includes('New')`), false, "opened: no longer new");
      assert.ok(store.getReview(r.id)?.openedAt);
      await openReview("Button labels", page);
      assert.equal(await page.inFrame<string>("/review/", "document.querySelector('[data-i=\"1\"]').dataset.kept"), "yes", "the page opens with what was kept");
      await page.eval("history.back()");
      await page.waitFor("!document.getElementById('review').open");
      store.closeReview(r.id);
    });

    it("sends to the session that asked exactly the line shown, with the answers the page copied, and keeps it in To review", async () => {
      const r = publish("rv-send", "Error messages", { state: "working", takesMessagesWhileWorking: true });
      const page = await openReview("Error messages");
      await keepInFrame(page, 0);
      await page.waitFor("document.querySelector('.rv-count').textContent === '1 of 3'");
      await page.click(".rv-send");
      await page.waitFor(`${arrived("review-send")} && document.querySelector('#review-send pre')`);
      assert.equal(await page.eval<boolean>("document.querySelector('#review-send input[value=session]').checked"), true);
      assert.equal(await page.eval<boolean>("document.querySelector('.rv-keep input').checked"), true, "1 of 3: kept to go on later");
      await page.waitFor("document.querySelector('.rv-answers pre')?.textContent === 'kept: 0'");
      assert.equal(await page.eval<boolean>("document.querySelector('.rv-answers').open && document.querySelector('.rv-answers pre').getBoundingClientRect().height > 0"), true, "the answers recorded are in view");
      const line = await page.eval<string>("document.querySelector('#review-send .rv-line-text').textContent");
      assert.equal(line, `Review «Error messages» sent from agent-desk (round 1, 1 of 3 reviewed). Read the answers with: agent-desk review ${r.id}`);
      await page.click("#review-send button[type=submit]");
      await page.waitFor("!document.getElementById('review-send').open");
      assert.deepEqual(store.takeInbox("rv-send").map((e) => e.answer), [line], "delivered word for word");
      assert.equal(store.getReview(r.id)?.sends.length, 1);
      assert.equal(await page.eval<boolean>("document.getElementById('review').open"), true, "kept: the review stays open to go on");
      await page.click(".rv-back");
      await page.waitFor(`${tile("Error messages")}?.querySelector('.rv-sent')?.textContent.includes('Sent to the session')`);
      // Kept as a decision in History, never in Needs you.
      assert.equal(await page.eval<boolean>("document.querySelector('.col-needs').textContent.includes('Error messages')"), false);
      await page.click("#views button", "History");
      await page.waitFor("[...document.querySelectorAll('.hitem')].some((h) => h.querySelector('.k-review') && h.textContent.includes('Error messages') && h.textContent.includes('Answers the review page copied: kept: 0'))");
      store.closeReview(r.id);
    });

    it("sends the developer's note after the line, word for word as the sheet shows it, even with nothing marked, and keeps it as their answer", async () => {
      const r = publish("rv-note", "Hero variants", { state: "working", takesMessagesWhileWorking: true });
      const page = await openReview("Hero variants");
      await page.click(".rv-send");
      await page.waitFor(`${arrived("review-send")} && document.querySelector('.rv-note textarea')`);
      const fixed = `Review «Hero variants» sent from agent-desk (round 1, 0 of 3 reviewed). Read the answers with: agent-desk review ${r.id}`;
      assert.equal(await page.eval<string>("document.querySelector('#review-send .rv-line-text').textContent"), fixed, "no note: the line alone");
      const note = "Drop 2 and 3.\nIterate 1: shorter, <b>no</b> exclamation marks.";
      await page.click(".rv-note textarea");
      await page.send("Input.insertText", { text: `  ${note}\n` });
      const shown = `${fixed}\n\n${note}`;
      await page.waitFor(`document.querySelector('#review-send .rv-line-text').textContent === ${JSON.stringify(shown)}`);
      assert.equal(await page.eval<number>("document.querySelectorAll('#review-send .rv-line-text b').length"), 0, "text, never markup");
      // Closed and opened again before sending, the note is still there.
      await page.click("#review-send button", "Cancel");
      await page.waitFor("!document.getElementById('review-send').open");
      await page.click(".rv-send");
      await page.waitFor(`${arrived("review-send")} && document.querySelector('#review-send .rv-line-text')?.textContent === ${JSON.stringify(shown)}`);
      await page.click("#review-send button[type=submit]");
      await page.waitFor("!document.getElementById('review-send').open");
      assert.deepEqual(store.takeInbox("rv-note").map((e) => e.answer), [shown], "one message: the line, then the note, word for word");
      assert.equal(store.getReview(r.id)?.sends.at(-1)?.note, note, "trimmed at its ends only");
      const recorded = store.listQuestions().filter((q) => q.review?.id === r.id);
      assert.deepEqual(
        recorded.map((q) => [q.text, q.answer?.via, q.review?.note ?? false]).sort(),
        [
          ["Note on the review «Hero variants», round 1", "desk", true],
          ["Review «Hero variants», round 1", "review", false],
        ],
        "the note is the developer's answer, given on the desk, beside what the page copied (nothing kept)",
      );
      assert.equal(recorded.find((q) => q.review?.note)?.answer?.text, note);
      await page.click(".rv-send");
      await page.waitFor(`${arrived("review-send")} && document.querySelector('#review-send .rv-line-text')?.textContent === ${JSON.stringify(fixed)}`);
      assert.equal(await page.eval<string>("document.querySelector('.rv-note textarea').value"), "", "sent: the box is empty again");
      await page.click("#review-send button", "Cancel");
      await page.click(".rv-back");
      await page.click("#views button", "History");
      await page.waitFor(`[...document.querySelectorAll('.hitem')].some((h) => h.querySelector('.k-review') && h.querySelector('.rv-ha')?.textContent === ${JSON.stringify(`Your note: ${note}`)})`);
      store.closeReview(r.id);
    });

    it("shows the options marked in the page in the Send sheet, as the page's words, and records exactly them", async () => {
      const html = `<!doctype html><html><head><title>marked</title></head><body>
<section data-agent-desk-group="Tagline"><article data-agent-desk-option="Plain">Plain</article><article data-agent-desk-option="Bold">Bold</article></section></body></html>`;
      const r = publish("rv-marked", "Taglines", { state: "working", takesMessagesWhileWorking: true }, html);
      const page = await openReview("Taglines");
      await page.inFrame("/review/", "new Promise((r) => { const ready = () => (document.querySelectorAll('agent-desk-control').length === 3 ? r(true) : setTimeout(ready, 50)); ready(); })");
      await page.inFrame("/review/", "document.querySelector('[data-agent-desk-option=\"Bold\"] agent-desk-control').shadowRoot.querySelector('button.choose').click(), true");
      await page.waitFor("document.querySelector('.rv-count').textContent === '1 of 1'");
      await page.click(".rv-send");
      const shown = 'Options marked in the page:\n[Tagline] Chosen: "Bold"';
      await page.waitFor(`${arrived("review-send")} && document.querySelector('.rv-answers pre')?.textContent === ${JSON.stringify(shown)}`);
      await page.click("#review-send button[type=submit]");
      await page.waitFor("!document.getElementById('review-send').open");
      const decision = store.listQuestions().find((q) => q.review?.id === r.id && !q.review.note);
      assert.deepEqual([decision?.answer?.via, decision?.answer?.text], ["review", shown], "the page's words, as shown");
      store.takeInbox("rv-marked");
      store.closeReview(r.id);
    });

    it("on a phone, shows options side by side one at a time under a switch that stays on top, inside the screen", async () => {
      // As a session's comparison of two letters: a grid of two columns, and an address longer than a phone is wide.
      const letter = `<div class="mail">Subject: hello\n\n${"A long letter line. ".repeat(80)}\nwrite to someone.with.a.very.long.address@example-university-of-somewhere.edu</div>`;
      const pair = (group: string) => `<section data-agent-desk-group="${group}"><div class="two"><div data-agent-desk-option="yours"><h3>yours</h3>${letter}</div><div data-agent-desk-option="theirs"><h3>theirs</h3>${letter}</div></div></section>`;
      const html = `<!doctype html><html><head><title>pairs</title><style>.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}.mail{white-space:pre-wrap}</style></head><body>${pair("First")}${pair("Second")}</body></html>`;
      const r = publish("rv-narrow", "Letters side by side", {}, html);
      const page = await open(390, 844);
      await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await page.eval(`import('/review.js').then((m) => m.openReview(${JSON.stringify(r.id)}))`);
      await page.waitFor(`${arrived("review")} && document.querySelector('#review iframe')`);
      const controls = (n: number) => `new Promise((r) => { const ready = () => (document.querySelectorAll('agent-desk-control').length === ${n} ? r(true) : setTimeout(ready, 50)); ready(); })`;
      await page.inFrame("/review/", controls(8)); // an option's controls 4, a group's 2, a switch over each pair 2
      const look = `(() => {
        const two = document.querySelector('.two'), sw = two.previousElementSibling;
        const options = [...two.querySelectorAll('[data-agent-desk-option]')];
        return { wide: document.documentElement.scrollWidth - innerWidth, switch: sw.tagName, top: Math.round(sw.getBoundingClientRect().top),
          buttons: [...sw.shadowRoot.querySelectorAll('button')].map((b) => b.textContent + ' ' + b.getAttribute('aria-pressed')),
          shown: options.map((o) => o.getClientRects().length ? Math.round(o.getBoundingClientRect().width) === two.clientWidth : 'hidden') };
      })()`;
      type Look = { wide: number; switch: string; top: number; buttons: string[]; shown: (boolean | string)[] };
      const before = await page.inFrame<Look>("/review/", look);
      assert.deepEqual({ ...before, top: 0 }, { wide: 0, switch: "AGENT-DESK-CONTROL", top: 0, buttons: ["yours true", "theirs false"], shown: [true, "hidden"] }, "the first option, the whole width; nothing past the screen");
      await page.inFrame("/review/", "document.querySelector('.two').previousElementSibling.shadowRoot.querySelectorAll('button')[1].click(), true");
      await page.inFrame("/review/", "document.querySelector('[data-agent-desk-option=\"theirs\"] agent-desk-control').shadowRoot.querySelector('button.choose').click(), true");
      // Read down the letter: the switch stays at the top of the screen while its pair scrolls by.
      await page.inFrame("/review/", "scrollTo(0, document.querySelector('.two').offsetTop + 600), true");
      const after = await page.inFrame<Look>("/review/", look);
      assert.deepEqual(after, { wide: 0, switch: "AGENT-DESK-CONTROL", top: 4, buttons: ["yours false", "theirs✓ true"], shown: ["hidden", true] }, "the other option shown, its pick marked on the switch");
      // Wide again, the page's own layout comes back as it was.
      await page.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
      await page.inFrame("/review/", controls(6));
      const wide = await page.inFrame<{ styles: string[]; row: boolean }>("/review/", `(() => {
        const options = [...document.querySelectorAll('.two')[0].querySelectorAll('[data-agent-desk-option]')];
        return { styles: options.map((o) => o.getAttribute('style') ?? ''), row: options[0].getBoundingClientRect().top === options[1].getBoundingClientRect().top };
      })()`);
      assert.deepEqual(wide, { styles: ["", ""], row: true });
      store.closeReview(r.id);
    });

    it("opens a review drawn from options data with the desk's controls on every option, counting questions decided", async () => {
      store.upsertSession({ id: "rv-drawn", provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "Drawn session" });
      const data = {
        questions: [
          { title: "Pay button", options: [{ label: "A", title: "Solid", images: [], recommended: true }, { label: "B", title: "Outline", images: [], recommended: false }] },
          { title: "Copy", options: [{ label: "1", title: "Pay now", images: [], recommended: false }] },
        ],
      };
      const r = store.publishReview({ sessionId: "rv-drawn", title: "Drawn choice", html: renderOptionsPage("Drawn choice", data, import.meta.dirname).html });
      const page = await openReview("Drawn choice");
      await page.inFrame("/review/", "new Promise((r) => { const ready = () => (document.querySelectorAll('agent-desk-control').length === 5 ? r(true) : setTimeout(ready, 50)); ready(); })");
      assert.equal(await page.eval<string>("document.querySelector('.rv-count').textContent"), "0 of 2", "no counter of its own: the questions decided");
      await page.inFrame("/review/", "document.querySelector('[data-agent-desk-option=\"B\"] agent-desk-control').shadowRoot.querySelector('button.discard').click(), true");
      await page.inFrame("/review/", "document.querySelector('[data-agent-desk-option=\"A\"] agent-desk-control').shadowRoot.querySelector('button.choose').click(), true");
      await page.waitFor("document.querySelector('.rv-count').textContent === '1 of 2'");
      await page.inFrame("/review/", "[...document.querySelectorAll('section')[1].querySelectorAll(':scope > agent-desk-control')].at(-1).shadowRoot.querySelector('button.none').click(), true");
      await page.waitFor("document.querySelector('.rv-count').textContent === '2 of 2'");
      await page.waitFor("document.querySelector('.rv-saved').textContent.startsWith('Saved')");
      await page.click(".rv-send");
      const shown = ['Options marked in the page:', '[Pay button] Chosen: "A"', '[Pay button] Discarded "B"', "[Copy] None of these"].join("\n");
      await page.waitFor(`${arrived("review-send")} && document.querySelector('.rv-answers pre')?.textContent === ${JSON.stringify(shown)}`);
      await page.click("#review-send button", "Cancel");
      store.closeReview(r.id);
    });

    it("shows the answers again instead of sending when another device changed them after the sheet opened", async () => {
      const r = publish("rv-stale", "Stale answers", { state: "working", takesMessagesWhileWorking: true });
      const page = await openReview("Stale answers");
      await keepInFrame(page, 0);
      await page.waitFor("document.querySelector('.rv-count').textContent === '1 of 3'");
      await page.click(".rv-send");
      await page.waitFor(`${arrived("review-send")} && document.querySelector('.rv-answers pre')?.textContent === 'kept: 0'`);
      store.changeReviewState(r.id, { ops: [], summary: "kept: 0, 1 (from the phone)" }, "remote");
      await page.click("#review-send button[type=submit]", "Send");
      await page.waitFor("document.querySelector('.rv-answers pre')?.textContent === 'kept: 0, 1 (from the phone)'");
      await page.waitFor("[...document.querySelectorAll('#toasts .toast')].some((t) => t.textContent.includes('changed meanwhile'))");
      assert.deepEqual(store.takeInbox("rv-stale"), [], "nothing sent from the older view");
      assert.equal(store.getReview(r.id)?.sends.length, 0);
      const refused = page.errors.findIndex((e) => /409 \(Conflict\) .*\/api\/reviews\/[\w-]+\/send$/.test(e));
      assert.ok(refused >= 0, `the desk refused the older view (${page.errors.join("; ")})`);
      page.errors.splice(refused, 1);
      // What is shown now is what goes.
      await page.click("#review-send button[type=submit]", "Send");
      await page.waitFor("!document.getElementById('review-send').open");
      assert.equal(store.takeInbox("rv-stale").length, 1);
      store.closeReview(r.id);
    });

    it("offers only another conversation when the session that asked has ended, copies the line, and leaves To review when not kept", async () => {
      const r = publish("rv-ended", "Pricing table");
      store.updateSession("rv-ended", (s) => ({ ...s, state: "ended" }));
      const page = await browser.newPage(1400, 900);
      pages.push(page);
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => void copied.push(t) } });" });
      await page.goto(base + "/");
      await page.waitFor(tile("Pricing table"));
      await openReview("Pricing table", page);
      await page.click(".rv-send");
      await page.waitFor(`${arrived("review-send")} && document.querySelector('#review-send pre')`);
      assert.equal(await page.eval<boolean>("document.querySelector('#review-send input[value=session]').disabled"), true);
      assert.equal(await page.eval<boolean>("document.querySelector('#review-send input[value=other]').checked"), true);
      assert.match(await page.eval<string>("document.querySelector('.rv-opt.off small').textContent"), /ended/);
      const line = await page.eval<string>("document.querySelector('#review-send .rv-line-text').textContent");
      assert.equal(line, `Pick up the review «Pricing table» from agent-desk (round 1, 0 of 3 reviewed): agent-desk review ${r.id}`);
      await page.click(".rv-keep input");
      await page.click("#review-send button[type=submit]", "Copy the line");
      await page.waitFor("!document.getElementById('review').open");
      assert.deepEqual(await page.eval<string[]>("copied"), [line]);
      assert.equal(store.getReview(r.id)?.sends.at(-1)?.to, null);
      assert.ok(store.getReview(r.id)?.closedAt, "not kept: it leaves To review");
      await page.waitFor(`!${tile("Pricing table")}`);
    });

    it("switches to another conversation, saying why, when the session stops taking messages before Send", async () => {
      const r = publish("rv-refused", "Toast texts", { state: "working", takesMessagesWhileWorking: true });
      const page = await openReview("Toast texts");
      await page.click(".rv-send");
      await page.waitFor(`${arrived("review-send")} && document.querySelector('#review-send pre')`);
      store.updateSession("rv-refused", (s) => ({ ...s, takesMessagesWhileWorking: false }));
      await page.click("#review-send button[type=submit]", "Send");
      await page.waitFor("document.querySelector('#review-send input[value=other]')?.checked && document.querySelector('#review-send input[value=session]').disabled");
      assert.match(await page.eval<string>("document.querySelector('.rv-opt.off small').textContent"), /not taking messages/);
      await page.waitFor("[...document.querySelectorAll('#toasts .toast')].some((t) => t.textContent.includes('not taking messages'))");
      // The browser logs every refused request; this refusal is what the test is about.
      const refused = page.errors.findIndex((e) => /409 \(Conflict\) .*\/api\/reviews\/[\w-]+\/send$/.test(e));
      assert.ok(refused >= 0, `the desk refused the send (${page.errors.join("; ")})`);
      page.errors.splice(refused, 1);
      assert.equal(store.getReview(r.id)?.sends.length, 0, "nothing sent");
      store.closeReview(r.id);
    });

    it("shows what another window changed as a chip, and updates the page on a tap at the same place", async () => {
      const r = publish("rv-sync", "Long list", {}, reviewHtml(12, true));
      const a = await openReview("Long list");
      const b = await openReview("Long list");
      // Scroll events come with a frame drawn: only the tab in front draws.
      await a.send("Page.bringToFront");
      await a.inFrame("/review/", "scrollTo(0, (document.documentElement.scrollHeight - innerHeight) / 2), true");
      await a.waitFor(`Math.abs(JSON.parse(localStorage.getItem('agent-desk:reviews') ?? '{}')[${JSON.stringify(r.id)}]?.at - 0.5) < 0.05`);
      // Opening it alone changes nothing the page shows: no chip.
      await new Promise((r) => setTimeout(r, 800));
      assert.equal(await a.eval<boolean>("!!document.querySelector('.rv-sync')"), false);
      await b.send("Page.bringToFront");
      await keepInFrame(b, 7);
      await a.send("Page.bringToFront");
      await a.waitFor("document.querySelector('.rv-sync')?.textContent.includes('New changes')");
      assert.equal(await a.inFrame<string>("/review/", "document.querySelector('[data-i=\"7\"]').dataset.kept"), "", "the page does not move under the developer");
      await a.click(".rv-sync button", "Update");
      await a.waitFor("!document.querySelector('.rv-sync')");
      await a.waitFor("document.querySelectorAll('#review iframe').length === 1");
      // The new frame has the other window's change, at the same place.
      const after = await a.inFrame<{ kept: string; at: number }>("/review/", "new Promise((r) => setTimeout(() => r({ kept: document.querySelector('[data-i=\"7\"]').dataset.kept, at: scrollY / (document.documentElement.scrollHeight - innerHeight) }), 300))");
      assert.equal(after.kept, "yes");
      assert.ok(Math.abs(after.at - 0.5) < 0.05, `back at the middle, not ${after.at}`);
      store.closeReview(r.id);
    });

    it("never tells of changes from elsewhere while the one window open is typing", async () => {
      const r = publish("rv-typing", "Typed comment", {}, reviewHtml(3));
      const page = await openReview("Typed comment");
      // A phone over the tailnet: every request takes a while, so the developer types on while the desk checks.
      await page.eval(`(() => { const f = window.fetch; window.fetch = (...a) => f(...a).then((res) => new Promise((r) => setTimeout(() => r(res), 300))); return true; })()`);
      // A comment typed key by key, in bursts with pauses long enough for each to be saved; the page saves its
      // whole state on every key, as a textarea's input does.
      const typed = await page.inFrame<number>(
        "/review/",
        `new Promise(async (done) => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          let n = 0;
          for (const pause of [450, 600, 750, 900, 1050, 1200]) {
            for (let i = 0; i < 15; i++) (localStorage.setItem("comment", "x".repeat(++n)), await wait(60));
            await wait(pause);
          }
          done(n);
        })`,
      );
      await page.waitFor(`document.querySelector('.rv-saved')?.textContent.startsWith('Saved')`);
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(await page.eval<boolean>("!!document.querySelector('.rv-sync')"), false, "no chip: nothing changed anywhere else");
      assert.equal(store.reviewState(r.id).data.comment, "x".repeat(typed));
      store.closeReview(r.id);
    });

    it("closes a page that opens another address in its frame, and opens the review again on a click", async () => {
      // The first time it loads, the page navigates its own frame away, which no CSP stops.
      const leaving = `<!doctype html><html><head><title>leaves</title></head><body><p id="here">here</p><script>
if (!localStorage.getItem("left")) { localStorage.setItem("left", "1"); setTimeout(() => (location.href = "/favicon.svg"), 300); }
</script></body></html>`;
      const r = publish("rv-leaves", "Wandering page", {}, leaving);
      const page = await open();
      await page.click(".rv-tile", "Wandering page");
      await page.waitFor(`${arrived("review")} && document.querySelector('#review .rv-strayed')`);
      assert.equal(await page.eval<number>("document.querySelectorAll('#review iframe').length"), 0, "the frame is gone at once");
      assert.equal(await page.eval<string>("document.querySelector('.rv-strayed p').textContent"), "This page tried to open another address, so the desk closed it.");
      await page.click(".rv-strayed button", "Open the review again");
      await page.waitFor("!document.querySelector('.rv-strayed') && document.querySelectorAll('#review iframe').length === 1");
      assert.equal(await page.inFrame<string>("/review/", "document.getElementById('here').textContent"), "here");
      // The address it went to refuses to be framed too: the browser says so, which is what the test is about.
      const refused = page.errors.findIndex((e) => /^Framing '.*' violates .*frame-ancestors/.test(e));
      assert.ok(refused >= 0, `the desk's own files refuse a frame (${page.errors.join("; ")})`);
      page.errors.splice(refused, 1);
      store.closeReview(r.id);
    });

    it("shows what the page says in an alert as plain text", async () => {
      const r = publish("rv-alert", "Alerting page", {}, `<!doctype html><html><head><title>alert</title></head><body><script>setTimeout(() => alert("<b>bold?</b> <img src=x onerror=alert(2)>"), 200);</script></body></html>`);
      const page = await openReview("Alerting page");
      await page.waitFor("[...document.querySelectorAll('#toasts .toast')].some((t) => t.textContent.includes('<b>bold?</b>'))");
      assert.equal(await page.eval<number>("document.querySelectorAll('#toasts .toast b, #toasts .toast img').length"), 0, "text, never markup");
      store.closeReview(r.id);
    });

    it("keeps what is marked while the desk does not answer, and saves it once it does", async () => {
      const r = publish("rv-offline", "Offline marks");
      const page = await openReview("Offline marks");
      await page.eval(`(() => {
        window.realFetch = window.fetch;
        window.fetch = (url, init) => String(url).startsWith("/api/reviews/") && init?.method === "POST" ? Promise.reject(new TypeError("Failed to fetch")) : window.realFetch(url, init);
      })()`);
      await keepInFrame(page, 2);
      await page.waitFor("document.querySelector('.rv-saved').textContent.startsWith('Kept on this device')");
      assert.match(await page.eval<string>("localStorage.getItem('agent-desk:reviews')"), /"op":"set","key":"answers"/);
      assert.deepEqual(store.reviewState(r.id).data, {}, "nothing reached the desk");
      await page.eval("window.fetch = window.realFetch");
      await fetchNow(page);
      await page.waitFor("!(localStorage.getItem('agent-desk:reviews') ?? '').includes('\"ops\"')");
      assert.deepEqual(store.reviewState(r.id).data, { answers: '{"2":"yes"}' });
      await page.waitFor("document.querySelector('.rv-saved').textContent.startsWith('Saved')");
      store.closeReview(r.id);
    });

    it("keeps a review never opened in To review whatever is typed to its session, and takes the prompt after opening it as its answer", async () => {
      const dir = "/home/demo/Projects/web-shop";
      const live = { store, env: { TERM_PROGRAM: "vscode", CLAUDE_PROJECT_DIR: dir }, sessionProcess: () => ({ pid: process.pid, ancestors: [] }) };
      const hook = (hook_event_name: string, extra: Record<string, unknown>) =>
        handleHook(readHookInput(JSON.stringify({ session_id: "rv-terminal", cwd: dir, hook_event_name, permission_mode: "auto", ...extra })), live);
      hook("UserPromptSubmit", { prompt: "make an autocorrect test page" });
      const r = store.publishReview({ sessionId: "rv-terminal", title: "Autocorrect test", html: reviewHtml(3) });
      hook("Stop", { last_assistant_message: "It is in To review." });
      hook("UserPromptSubmit", { prompt: "now look at the build warnings" });
      // A round an older desk marked answered in the terminal without its being opened shows again.
      const old = publish("rv-terminal-old", "Old autocorrect test");
      const file = store.paths.review(old.id);
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), answered: { at: new Date().toISOString(), round: 1 } }));
      const page = await open();
      await page.waitFor(`${tile("Autocorrect test")} && ${tile("Old autocorrect test")}`);
      assert.equal(store.getReview(r.id)?.answered, undefined);
      // Seen on the desk, the review is what the next prompt answers.
      await openReview("Autocorrect test", page);
      await page.click(".rv-back");
      // The page records the opening without waiting for it: the prompt comes after the store has it.
      for (const end = Date.now() + 5000; store.getReview(r.id)?.openedAt === undefined && Date.now() < end; ) await new Promise((done) => setTimeout(done, 50));
      assert.ok(store.getReview(r.id)?.openedAt, "the opening reached the store");
      hook("Stop", { last_assistant_message: "Done." });
      hook("UserPromptSubmit", { prompt: "keep 1 and 3" });
      await page.waitFor(`!${tile("Autocorrect test")} && ${tile("Old autocorrect test")}`);
      assert.equal(store.getReview(r.id)?.answered?.round, 1);
      await page.click("#views button", "History");
      const answered = (title: string) => `[...document.querySelectorAll('.hitem')].some((h) => h.textContent.includes(${JSON.stringify(title)}) && h.textContent.includes('Round 1 answered in the terminal'))`;
      await page.waitFor(answered("Autocorrect test"));
      assert.equal(await page.eval<boolean>(answered("Old autocorrect test")), false, "a mark on a round never opened answers nothing");
      store.closeReview(r.id);
      store.closeReview(old.id);
    });

    it("closes a review from its tile without opening it, only on a second click, and shows it closed in History", async () => {
      const r = publish("rv-tile-close", "Unwanted variants");
      const page = await open();
      await page.waitFor(tile("Unwanted variants"));
      const x = `${tile("Unwanted variants")}.querySelector('.rv-x button')`;
      assert.equal(await page.eval<string>(`${x}.getAttribute('aria-label')`), "Close the review");
      await page.eval(`${x}.click()`);
      await page.waitFor(`${x}.classList.contains('armed') && ${x}.getAttribute('aria-label') === 'Close?'`);
      assert.equal(await page.eval<boolean>("document.getElementById('review').open"), false, "the tile did not open");
      assert.equal(store.getReview(r.id)?.closedAt, undefined, "one click closes nothing");
      // Left alone, it disarms.
      await page.waitFor(`!${x}.classList.contains('armed')`, 5000);
      await page.eval(`${x}.click()`);
      await page.waitFor(`${x}.classList.contains('armed')`);
      await page.eval(`${x}.click()`);
      await page.waitFor(`!${tile("Unwanted variants")}`);
      assert.ok(store.getReview(r.id)?.closedAt, "closed");
      assert.equal(store.getReview(r.id)?.sends.length, 0, "never sent");
      assert.equal(store.getReview(r.id)?.openedAt, undefined, "never opened");
      await page.waitFor("[...document.querySelectorAll('#toasts .toast')].some((t) => t.textContent === 'Closed «Unwanted variants»: it is in History')");
      await page.click("#views button", "History");
      await page.waitFor("[...document.querySelectorAll('.hitem')].some((h) => h.querySelector('.k-review') && h.textContent.includes('Unwanted variants') && h.querySelector('.rv-hclosed')?.textContent === 'Closed')");
    });

    it("closes the review open from its bar, saving what the page changed first, and shows the session's reason in History", async () => {
      const r = publish("rv-bar-close", "Superseded copy");
      const page = await openReview("Superseded copy");
      await keepInFrame(page, 2);
      await page.click(".rv-close-bar");
      await page.waitFor("document.querySelector('.rv-close-bar').classList.contains('armed')");
      assert.equal(await page.eval<boolean>("document.getElementById('review').open"), true, "one click: still open");
      // The second click at once: armed, it runs a line out (an animation the helper would wait on).
      await page.eval("document.querySelector('.rv-close-bar').click()");
      await page.waitFor("!document.getElementById('review').open && location.hash === ''");
      await page.waitFor(`!${tile("Superseded copy")}`);
      assert.ok(store.getReview(r.id)?.closedAt);
      assert.deepEqual(store.reviewState(r.id).data, { answers: '{"2":"yes"}' }, "what was marked last is saved");
      // A review a session closed with a reason says who and why.
      const other = publish("rv-cli-close", "Old proposals");
      store.closeReview(other.id, { reason: "replaced by the new proposals", by: "rv-cli-close" });
      await page.click("#views button", "History");
      await page.waitFor("[...document.querySelectorAll('.hitem')].some((h) => h.textContent.includes('Old proposals') && h.querySelector('.rv-hclosed')?.textContent === 'Closed by the session: replaced by the new proposals')");
      // Opened again from History, a closed review offers no Close.
      await page.click(".hitem", "Superseded copy");
      await page.waitFor(`${arrived("review")} && document.querySelector('.rv-bar')`);
      assert.equal(await page.eval<boolean>("!!document.querySelector('.rv-close-bar')"), false);
      await page.click(".rv-back");
      await page.waitFor("!document.getElementById('review').open");
    });

    describe("links out of a review", () => {
      /** A local preview, as a session's static server of prototypes: what it was asked, with the referrer sent. */
      let live: http.Server;
      let liveBase = "";
      const asked: { url: string; referer: string | undefined }[] = [];
      before(async () => {
        live = http.createServer((req, res) => {
          asked.push({ url: req.url ?? "", referer: req.headers.referer });
          res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>live</title>live");
        });
        await new Promise<void>((r) => live.listen(0, "127.0.0.1", r));
        liveBase = `http://127.0.0.1:${(live.address() as AddressInfo).port}`;
      });
      after(async () => {
        live.closeAllConnections();
        await new Promise((r) => live.close(r));
      });
      const linksHtml = () => `<!doctype html><html><head><title>links</title></head><body>
<a id="live" href="${liveBase}/r3/desk4.html" target="_blank">Open live →</a>
<a id="far" href="https://example.com/x">Elsewhere</a>
<button id="win">Open in a window</button>
<script>document.getElementById("win").addEventListener("click", () => window.open("${liveBase}/w"));</script>
</body></html>`;
      type Tab = { targetId: string; type: string; url: string; canAccessOpener: boolean };
      const tabs = async () => (await browser.send<{ targetInfos: Tab[] }>("Target.getTargets")).targetInfos.filter((t) => t.type === "page");
      /** The tab opened at `url`, once it is there; closed, so the next test starts without it. */
      async function tabAt(url: string): Promise<Tab> {
        const end = Date.now() + 5000;
        for (;;) {
          const tab = (await tabs()).find((t) => t.url === url);
          if (tab) {
            await browser.send("Target.closeTarget", { targetId: tab.targetId });
            return tab;
          }
          if (Date.now() > end) throw new Error(`no tab opened at ${url}`);
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      /** A real click on an element of the review's page, inside its frame: the developer's, with its user activation. */
      async function clickInFrame(page: Page, selector: string): Promise<void> {
        const frame = await page.eval<{ x: number; y: number }>("(() => { const f = document.querySelector('#review iframe'); const r = f.getBoundingClientRect(); return { x: r.x + f.clientLeft, y: r.y + f.clientTop }; })()");
        const at = await page.inFrame<{ x: number; y: number }>("/review/", `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        const [x, y] = [frame.x + at.x, frame.y + at.y];
        await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
      const toasted = (text: string) => `[...document.querySelectorAll('#toasts .toast')].some((t) => t.textContent === ${JSON.stringify(text)})`;

      it("opens a local preview the developer clicks in a tab of its own, and names any other address without opening it", async () => {
        const r = publish("rv-links", "Desk prototypes", {}, linksHtml());
        const page = await openReview("Desk prototypes");
        await clickInFrame(page, "#live");
        const tab = await tabAt(`${liveBase}/r3/desk4.html`);
        assert.equal(tab.canAccessOpener, false, "opened without an opener");
        assert.deepEqual(asked.find((a) => a.url === "/r3/desk4.html"), { url: "/r3/desk4.html", referer: undefined }, "nor a referrer");
        await clickInFrame(page, "#win");
        await tabAt(`${liveBase}/w`);
        await clickInFrame(page, "#far");
        await page.waitFor(toasted("This page links outside this computer; the desk opens only local previews: https://example.com/x"));
        assert.deepEqual((await tabs()).filter((t) => t.url.includes("example.com")), [], "nothing opened");
        assert.equal(await page.eval<boolean>("!document.querySelector('.rv-strayed') && !document.querySelector('.rv-link')"), true, "the page stays, and the bar offers nothing to open");
        assert.equal(await page.inFrame<string>("/review/", "document.title"), "links", "the frame never left the page");
        store.closeReview(r.id);
      });

      it("offers the preview in the bar when the browser keeps the click in the frame from the desk, as Safari does", async () => {
        const data = { questions: [{ title: "Which desk?", options: [{ label: "A", title: "Dense", images: [], recommended: false, url: `${liveBase}/r3/desk4.html` }] }] };
        const r = store.publishReview({ sessionId: "rv-links", title: "Drawn prototypes", html: renderOptionsPage("Drawn prototypes", data, import.meta.dirname).html });
        const page = await openReview("Drawn prototypes");
        await page.eval(`Object.defineProperty(navigator, "userActivation", { value: { isActive: false, hasBeenActive: true }, configurable: true })`);
        const already = (await tabs()).length;
        await clickInFrame(page, ".live a");
        await page.waitFor("document.querySelector('.rv-link a.chip')");
        const chip = await page.eval<string[]>("['href', 'target', 'rel'].map((a) => document.querySelector('.rv-link a.chip').getAttribute(a)).concat(document.querySelector('.rv-link').textContent)");
        assert.deepEqual(chip, [`${liveBase}/r3/desk4.html`, "_blank", "noopener noreferrer", `Open ${liveBase.slice("http://".length)}/r3/desk4.html`]);
        assert.equal((await tabs()).length, already, "nothing opened without the click");
        await page.click(".rv-link a.chip");
        assert.equal((await tabAt(`${liveBase}/r3/desk4.html`)).canAccessOpener, false, "one click on it opens it, without an opener");
        store.closeReview(r.id);
      });

      it("on a phone, says a local preview is on the computer instead of opening it", async () => {
        const r = publish("rv-links", "Phone prototypes", {}, linksHtml());
        const away = await elsewhere();
        const page = await browser.newPage(1000, 800);
        try {
          await page.goto(away.url);
          await page.waitFor("document.querySelector('.rv-tile')");
          await openReview("Phone prototypes", page);
          const already = (await tabs()).length;
          await clickInFrame(page, "#live");
          await page.waitFor(toasted(`Live at ${liveBase.slice("http://".length)}/r3/desk4.html (on the computer)`));
          assert.equal((await tabs()).length, already, "no tab to the phone's own localhost");
          assert.equal(await page.eval<boolean>("!document.querySelector('.rv-link')"), true);
          assert.deepEqual(page.errors, []);
        } finally {
          await page.close();
          await away.close();
          store.closeReview(r.id);
        }
      });
    });

    it("fills a phone's screen under a slim bar, counts reviews on its tab, and sends from a sheet at the bottom", async () => {
      const r = publish("rv-phone", "Phone copy", { state: "working", takesMessagesWhileWorking: true });
      const page = await browser.newPage(390, 844);
      pages.push(page);
      await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await page.goto(base + "/");
      await page.waitFor("document.querySelector('.tabbar .tcount.review')");
      await page.tap(".tabbar button", "To review");
      await page.waitFor(`${tile("Phone copy")} && ${STILL}`);
      assert.equal(await page.eval<string>("document.querySelector('.tabbar .tcount.review').textContent"), String(await page.eval<number>("document.querySelectorAll('.col-review .rv-tile, .col-review .rtile-wrap').length")));
      await page.tap(".rv-tile", "Phone copy");
      await page.waitFor(arrived("review"));
      await page.inFrame("/review/", "true");
      const shape = await page.eval<{ w: number; h: number; bar: number; frame: number }>(`(() => ({
        w: document.getElementById('review').getBoundingClientRect().width, h: document.getElementById('review').getBoundingClientRect().height,
        bar: document.querySelector('.rv-head').getBoundingClientRect().height, frame: document.querySelector('#review iframe').getBoundingClientRect().height }))()`);
      assert.deepEqual([shape.w, shape.h], [390, 844]);
      assert.ok(shape.bar <= 64 && shape.frame >= 844 - 64, `a slim bar (${shape.bar}px) over the page (${shape.frame}px)`);
      await page.tap(".rv-send");
      await page.waitFor(arrived("review-send"));
      const sheet = await page.eval<{ bottom: number; width: number }>("(() => { const r = document.getElementById('review-send').getBoundingClientRect(); return { bottom: r.bottom, width: r.width }; })()");
      assert.deepEqual([Math.round(sheet.bottom), Math.round(sheet.width)], [844, 390], "a sheet from the bottom edge");
      store.closeReview(r.id);
    });
  });
});
