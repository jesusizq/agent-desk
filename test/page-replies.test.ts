// The page in a real headless Chrome: saved replies, sent with one tap from above a reply box, and their editor.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Page } from "./browser.ts";
import type { Store } from "../src/store/store.ts";
import { arrived, ownDesk, ownPhone, setupPage, SKIP, STILL, touch } from "./page-harness.ts";

const SID = "saved-replies";
/** A session at work whose adapter delivers mid-turn: it takes a message now. */
const atWork = (own: Store, replies: string[] = []) => {
  own.upsertSession({ id: SID, provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "saved replies at work", takesMessagesWhileWorking: true });
  if (replies.length) own.saveReplies(replies, 0);
};
const REPLIES = ["sigue", "haz commit y push", "revísalo con un subagente"];
const box = "document.querySelector('#session .chat-footer textarea')";
const chips = "[...document.querySelectorAll('#session .replies button.reply')]";
const chip = (text: string) => `${chips}.find((b) => b.title === ${JSON.stringify(text)})`;

/** The session's panel open on its conversation, its chips drawn. */
async function openPanel(page: Page, phone = false): Promise<void> {
  if (phone) await page.tap(".tabbar button", "Sessions");
  await page.click(".scard", "saved replies at work");
  await page.waitFor(`${arrived("session")} && document.querySelector('#session .session-body')?.dataset.fetched === 'yes' && document.querySelector('#session .replies .reply-edit') && ${STILL}`);
}
const editor = "document.querySelector('#replies-edit textarea')";
const editorError = "(document.querySelector('#replies-edit .replies-error')?.textContent ?? '')";
/** Sets the editor's text as typing it would. */
const setEditor = (page: Page, text: string) => page.eval(`(() => { const b = ${editor}; b.value = ${JSON.stringify(text)}; b.dispatchEvent(new Event("input", { bubbles: true })); })()`);
/** Holds the page's next request whose method and path are these until `window.release()`, so a test acts while it is on its way. */
const holdRequest = (page: Page, method: string, path: string) =>
  page.eval(`(() => {
    const real = window.fetch;
    window.fetch = (url, init) => {
      if (init?.method !== ${JSON.stringify(method)} || new URL(String(url), location.href).pathname !== ${JSON.stringify(path)}) return real(url, init);
      window.fetch = real;
      return new Promise((go) => (window.release = () => go(real(url, init))));
    };
  })()`);
const origin = (page: Page) => page.eval<string>("location.origin");

/** Where a chip's centre is on the screen, scrolled into sight first. */
const centre = (page: Page, el: string) => page.eval<[number, number]>(`(() => { const el = ${el}; el.scrollIntoView({ block: "nearest", inline: "center", behavior: "instant" }); const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("page: saved replies", SKIP, () => {
  setupPage();

  it("keeps a question's card calm: no chips there with none saved, nor while its session cannot take a reply", async () => {
    const cards = "document.querySelectorAll('#view .answer').length";
    const rows = "document.querySelectorAll('#view .answer .replies').length";
    await ownDesk(async (page) => {
      await page.waitFor(cards);
      assert.equal(await page.eval<number>(rows), 0, "none saved: no row on any card");
    }, atWork);
    // The demo's questions come from sessions at work, here with adapters that take nothing mid-turn: none can take a reply now.
    const deaf = (own: Store) => {
      for (const s of own.listSessions()) if (s.id !== SID) own.updateSession(s.id, (x) => ({ ...x, takesMessagesWhileWorking: false }));
    };
    await ownDesk(
      async (page, own) => {
        await page.waitFor(cards);
        assert.equal(await page.eval<number>(rows), 0, "saved, but no card's session can take one now");
        // Taking messages mid-turn, its session takes the answer at its next step: the card offers them.
        own.updateSession("demo-iva", (s) => ({ ...s, takesMessagesWhileWorking: true }));
        await page.waitFor(`${rows} > 0`);
        // A permission prompt or a choice dialog of that same session is no reply: only its hook settles it.
        for (const q of [
          own.ask({ sessionId: "demo-iva", kind: "permission", text: "Bash: rm -rf dist", options: ["Allow", "Deny"] }),
          own.ask({ sessionId: "demo-iva", kind: "question", text: "Which layout?", options: ["A", "B"], dialog: true }),
        ]) {
          await page.click(".qrow", q.text);
          await page.waitFor(`document.querySelector('.next')?.textContent.includes(${JSON.stringify(q.text)}) && ${STILL}`);
          assert.equal(await page.eval<number>("document.querySelectorAll('.next .answer .replies').length"), 0, `${q.text}: no chips`);
          own.dismiss(q.id);
        }
        await openPanel(page);
        assert.equal(await page.eval<number>(`${chips}.length`), REPLIES.length, "the panel's own box shows them");
      },
      (own) => (atWork(own, REPLIES), deaf(own)),
    );
  });

  it("saves the replies in the editor, one per line, and shows the desk's refusal there with the text kept", async () => {
    await ownDesk(
      async (page, own) => {
        await openPanel(page);
        assert.equal(await page.eval<string>("document.querySelector('#session .replies .reply-edit').textContent"), "Save replies…", "with none saved, one chip to save them");
        await page.click("#session .replies .reply-edit");
        await page.waitFor(arrived("replies-edit"));
        const editor = "document.querySelector('#replies-edit textarea')";
        assert.equal(await page.eval<boolean>(`document.activeElement === ${editor}`), true, "the box takes the focus");
        await page.type("sigue\nhaz commit y push\n  sigue  \n\nrevísalo con un subagente");
        await page.click("#replies-edit button.primary", "Save");
        await page.waitFor(`!document.getElementById('replies-edit').open && ${chips}.length === 3`);
        assert.deepEqual(await page.eval<string[]>(`${chips}.map((b) => b.title)`), REPLIES, "trimmed, in order, a duplicate and an empty line dropped");
        assert.deepEqual(own.savedReplies([]).replies, REPLIES, "kept on the desk, for every device");
        assert.equal(await page.eval<string>("document.querySelector('#session .replies .reply-edit').getAttribute('aria-label')"), "Edit replies");

        await page.click("#session .replies .reply-edit");
        await page.waitFor(arrived("replies-edit"));
        assert.equal(await page.eval<string>(`${editor}.value`), REPLIES.join("\n"), "the editor opens on the replies saved");
        const many = Array.from({ length: 21 }, (_, i) => `reply ${i}`).join("\n");
        await page.eval(`(() => { const b = ${editor}; b.value = ${JSON.stringify(many)}; b.dispatchEvent(new Event("input", { bubbles: true })); })()`);
        await page.click("#replies-edit button.primary", "Save");
        await page.waitFor("document.querySelector('#replies-edit .replies-error')");
        assert.match(await page.eval<string>("document.querySelector('#replies-edit .replies-error').textContent"), /at most 20 saved replies, got 21/, "the desk's reason, in the editor");
        assert.equal(await page.eval<boolean>("document.getElementById('replies-edit').open"), true, "which stays open");
        assert.equal(await page.eval<string>(`${editor}.value`), many, "with the text as typed");
        assert.deepEqual(own.savedReplies([]).replies, REPLIES, "nothing changed on the desk");
        // The browser logs the refused request itself; the page reports nothing else.
        assert.deepEqual(page.errors.splice(0), [`Failed to load resource: the server responded with a status of 400 (Bad Request) ${new URL(await page.eval<string>("location.href")).origin}/api/replies`]);
        await page.click("#replies-edit button.secondary", "Cancel");
        await page.waitFor("!document.getElementById('replies-edit').open");
        assert.equal(await page.eval<number>(`${chips}.length`), 3);
      },
      (own) => atWork(own),
    );
  });

  it("refuses a reply with a bidi or invisible character, naming the line the editor shows it on", async () => {
    await ownDesk(
      async (page, own) => {
        await openPanel(page);
        await page.click("#session .replies .reply-edit");
        await page.waitFor(arrived("replies-edit"));
        await setEditor(page, "sigue\n\n  haz commit y push  \n\nrm\u202e -rf");
        await page.click("#replies-edit button.primary", "Save");
        await page.waitFor(`${editorError} !== '' && !document.querySelector('#replies-edit button.primary').disabled`);
        assert.match(await page.eval<string>(editorError), /line 3: a saved reply is one line with no control character but tab and no bidi or invisible one/);
        assert.equal(await page.eval<string>(`${editor}.value`), "sigue\nhaz commit y push\nrm\u202e -rf", "its empty lines gone, the refused reply on the line named");
        assert.deepEqual(own.savedReplies([]), { replies: REPLIES, rev: 1 }, "nothing changed on the desk");
        assert.deepEqual(page.errors.splice(0), [`Failed to load resource: the server responded with a status of 400 (Bad Request) ${await origin(page)}/api/replies`]);
      },
      (own) => atWork(own, REPLIES),
    );
  });

  it("shows a refusal as a toast when the editor was closed while it saved, and nothing when that save went through", async () => {
    await ownDesk(
      async (page, own) => {
        await openPanel(page);
        for (const [text, refused] of [[Array.from({ length: 21 }, (_, i) => `reply ${i}`).join("\n"), true], ["sigue\nsigue tú", false]] as const) {
          await page.click("#session .replies .reply-edit");
          await page.waitFor(arrived("replies-edit"));
          await setEditor(page, text);
          await holdRequest(page, "PUT", "/api/replies");
          await page.click("#replies-edit button.primary", "Save");
          await page.waitFor("document.querySelector('#replies-edit button.primary')?.getAttribute('aria-busy') === 'true'");
          await page.click("#replies-edit button.secondary", "Cancel");
          await page.waitFor("!document.getElementById('replies-edit').open");
          await page.eval("window.release()");
          if (refused) {
            await page.waitFor("[...document.querySelectorAll('.toast')].some((t) => /not saved: .*at most 20 saved replies, got 21/.test(t.textContent))");
            assert.deepEqual(own.savedReplies([]), { replies: REPLIES, rev: 1 }, "nothing changed on the desk");
            assert.deepEqual(page.errors.splice(0), [`Failed to load resource: the server responded with a status of 400 (Bad Request) ${await origin(page)}/api/replies`]);
            await page.waitFor("!document.querySelector('.toast')");
          } else {
            await page.waitFor(`${chips}.length === 2`);
            assert.deepEqual(own.savedReplies([]), { replies: ["sigue", "sigue tú"], rev: 2 });
            await pause(300);
            assert.equal(await page.eval<number>("document.querySelectorAll('.toast').length"), 0, "saved: nothing to say");
          }
        }
      },
      (own) => atWork(own, REPLIES),
    );
  });

  it("keeps the text typed when another device saved the replies since the editor opened, and a second Save puts it over them", async () => {
    await ownDesk(
      async (page, own) => {
        await openPanel(page);
        await page.click("#session .replies .reply-edit");
        await page.waitFor(arrived("replies-edit"));
        own.saveReplies(["from the phone"], 1);
        await setEditor(page, "sigue\nfrom the laptop");
        await page.click("#replies-edit button.primary", "Save");
        await page.waitFor(`${editorError} !== '' && ${chips}.length === 1`);
        assert.match(await page.eval<string>(editorError), /changed on another device/, "the desk's reason, in the editor");
        assert.equal(await page.eval<boolean>("document.getElementById('replies-edit').open"), true, "which stays open");
        assert.equal(await page.eval<string>(`${editor}.value`), "sigue\nfrom the laptop", "with the text as typed");
        assert.deepEqual(await page.eval<string[]>(`${chips}.map((b) => b.title)`), ["from the phone"], "the chips show the list saved there");
        assert.deepEqual(own.savedReplies([]), { replies: ["from the phone"], rev: 2 }, "nothing changed on the desk");
        assert.deepEqual(page.errors.splice(0), [`Failed to load resource: the server responded with a status of 409 (Conflict) ${await origin(page)}/api/replies`]);
        await page.click("#replies-edit button.primary", "Save");
        await page.waitFor(`!document.getElementById('replies-edit').open && ${chips}.length === 2`);
        assert.deepEqual(own.savedReplies([]), { replies: ["sigue", "from the laptop"], rev: 3 }, "saved again, over the newer list");
      },
      (own) => atWork(own, REPLIES),
    );
  });

  it("keeps a draft that equals a saved reply whose delivery failed: only a message sent from the box takes its draft", async () => {
    await ownDesk(
      async (page) => {
        await openPanel(page);
        await page.click("#session .chat-footer textarea");
        await page.type("sigue");
        await page.eval(`(() => {
          const real = window.fetch;
          window.fetch = (url, init) => new URL(String(url), location.href).pathname === "/api/sessions/${SID}/message"
            ? Promise.resolve(new Response(JSON.stringify({ error: "refused for the test" }), { status: 409, headers: { "Content-Type": "application/json" } }))
            : real(url, init);
        })()`);
        await page.eval(`${chip("sigue")}.click()`);
        await page.waitFor(`${chips}.every((c) => !c.disabled) && [...document.querySelectorAll('#session .msg.from-developer')].some((m) => m.textContent.includes('refused for the test'))`);
        assert.equal(await page.eval<string>(`${box}.value`), "sigue", "the draft stays in the box");
        assert.deepEqual(await page.eval<[string, string][]>("JSON.parse(localStorage.getItem('agent-desk:drafts') ?? '{}').drafts ?? []"), [[`message-${SID}`, "sigue"]], "and on the device");
      },
      (own) => atWork(own, REPLIES),
    );
  });

  it("sends a reply exactly as saved with a click, once, leaving the box as it was; a right-click puts it in the box instead", async () => {
    await ownDesk(
      async (page, own) => {
        await openPanel(page);
        await page.click("#session .chat-footer textarea");
        await page.type("a draft of mine");
        const sent = await page.eval<boolean[]>(`(() => { const b = ${chip("haz commit y push")}; b.click(); b.click(); return ${chips}.map((c) => c.disabled); })()`);
        assert.deepEqual(sent, [true, true, true], "every chip waits while it is on its way: a second click sends nothing more");
        const mine = "[...document.querySelectorAll('#session .msg.from-developer')].filter((m) => m.textContent.includes('haz commit y push'))";
        await page.waitFor(`${mine}.length === 1 && ${mine}[0].querySelector('.msg-meta .delivered') && ${chips}.every((c) => !c.disabled)`);
        assert.deepEqual(own.takeInbox(SID).map((e) => e.answer), ["haz commit y push"], "delivered once, verbatim");
        assert.equal(await page.eval<string>(`${box}.value`), "a draft of mine", "the draft stays in the box");

        const [x, y] = await centre(page, chip("sigue"));
        await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x, y, button: "right", clickCount: 1 });
        await page.waitFor(`${box}.value === "a draft of mine\\nsigue"`);
        assert.equal(await page.eval<boolean>(`document.activeElement === ${box}`), true, "the box has the focus, to change it");
        await pause(300);
        assert.deepEqual(own.takeInbox(SID), [], "and nothing was sent");
      },
      (own) => atWork(own, REPLIES),
    );
  });

  it("disables the replies while the session cannot take a message, and keeps them editable", async () => {
    await ownDesk(
      async (page, own) => {
        await openPanel(page);
        assert.equal(await page.eval<boolean>(`${box}.getAttribute('aria-disabled') === 'true'`), true, "the box cannot send now");
        assert.deepEqual(await page.eval<boolean[]>(`${chips}.map((c) => c.disabled)`), [true, true, true], "nor can the replies");
        assert.equal(await page.eval<boolean>("document.querySelector('#session .replies .reply-edit').disabled"), false, "editing them needs no session");
        await page.eval(`${chip("sigue")}.click()`);
        await pause(300);
        assert.deepEqual(own.takeInbox(SID), [], "a click sends nothing");
      },
      (own) => {
        own.upsertSession({ id: SID, provider: "Test", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "saved replies at work", state: "waiting" });
        own.saveReplies(REPLIES, 0);
      },
    );
  });

  it("on a phone, a long press puts a reply in the box without sending it, and a tap sends it", async () => {
    await ownPhone(
      async (page, own) => {
        await openPanel(page, true);
        const [x, y] = await centre(page, chip("revísalo con un subagente"));
        await touch(page, "touchStart", [[x, y]]);
        await pause(650);
        await touch(page, "touchEnd", []);
        await page.waitFor(`${box}.value === "revísalo con un subagente"`);
        assert.equal(await page.eval<boolean>(`document.activeElement === ${box}`), true, "the box has the focus, to change it");
        await pause(300);
        assert.deepEqual(own.takeInbox(SID), [], "nothing was sent");

        const at = await centre(page, chip("sigue"));
        await touch(page, "touchStart", [at]);
        await touch(page, "touchEnd", []);
        const mine = "[...document.querySelectorAll('#session .msg.from-developer')].filter((m) => m.textContent.trim().includes('sigue'))";
        await page.waitFor(`${mine}.length === 1 && ${mine}[0].querySelector('.msg-meta .delivered')`);
        assert.deepEqual(own.takeInbox(SID).map((e) => e.answer), ["sigue"], "a tap sends it, once");
        assert.equal(await page.eval<string>(`${box}.value`), "revísalo con un subagente", "the box keeps what the long press put in it");
      },
      (own) => atWork(own, REPLIES),
    );
  });

  it("on a phone, the replies scroll sideways in one line, and a swipe over them sends nothing", async () => {
    const long = Array.from({ length: 8 }, (_, i) => `saved reply number ${i + 1}, long enough to be cut`);
    await ownPhone(
      async (page, own) => {
        await openPanel(page, true);
        const row = "document.querySelector('#session .replies')";
        const shape = await page.eval<{ lines: number; wider: boolean; cut: boolean }>(`(() => {
          const r = ${row};
          return { lines: new Set(${chips}.map((c) => Math.round(c.getBoundingClientRect().top))).size, wider: r.scrollWidth > r.clientWidth, cut: ${chips}[0].querySelector('span').scrollWidth > ${chips}[0].querySelector('span').clientWidth };
        })()`);
        assert.deepEqual(shape, { lines: 1, wider: true, cut: true }, "one line, wider than the screen, each long reply cut with an ellipsis");
        const [x, y] = await centre(page, `${chips}[1]`);
        const before = await page.eval<number>(`${row}.scrollLeft`);
        await touch(page, "touchStart", [[x, y]]);
        for (let i = 1; i <= 10; i++) {
          await touch(page, "touchMove", [[x - i * 20, y]]);
          await pause(16);
        }
        await touch(page, "touchEnd", []);
        await page.waitFor(`${row}.scrollLeft > ${before + 50}`);
        await pause(700);
        assert.deepEqual(own.takeInbox(SID), [], "the swipe scrolled the row and sent nothing");
        assert.equal(await page.eval<string>(`${box}.value`), "", "nor put anything in the box");
      },
      (own) => atWork(own, long),
    );
  });
});
