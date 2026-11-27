// The page in a real headless Chrome: dictation into a reply box, with a fake microphone and a stand-in speech engine.
import assert from "node:assert/strict";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { ON_DEMAND } from "../src/server/dictation.ts";
import { whisperEngine } from "../src/server/whisper.ts";
import type { Store } from "../src/store/store.ts";
import type { Page } from "./browser.ts";
import { fakeWhisper } from "./fake-whisper.ts";
import { tempHome } from "./helpers.ts";
import { arrived, open, ownDesk, setupPage, SKIP, STILL } from "./page-harness.ts";

const SID = "dictating";
const atWork = (own: Store) => {
  own.upsertSession({ id: SID, provider: "Claude Code", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "dictation at work", takesMessagesWhileWorking: true });
  own.mergeMetrics({ sessionId: SID, model: "Opus 5.5" });
  own.addMessage({ sessionId: SID, from: "developer", text: "Revisa el checkout en el worktree", via: "terminal" });
  own.addMessage({ sessionId: SID, from: "session", text: "Done: the pay button stays in view.\n\n```ts\nconst hidden = true;\n```\nShall I open the pull request against main?" });
};
const box = "document.querySelector('#session .chat-footer textarea')";
const mic = "document.querySelector('#session .chat-footer button.mic')";
/** A microphone that hears a tone, and every request the page makes, kept in `window.asked`. */
const FAKE_MIC = `(() => {
  navigator.mediaDevices.getUserMedia = async () => {
    const c = new AudioContext();
    await c.resume();
    const tone = c.createOscillator();
    const out = c.createMediaStreamDestination();
    tone.connect(out);
    tone.start();
    return out.stream;
  };
  window.asked = [];
  const real = window.fetch;
  window.fetch = (url, init) => (window.asked.push((init?.method ?? "GET") + " " + new URL(String(url), location.href).pathname), real(url, init));
})()`;

async function openPanel(page: Page): Promise<void> {
  await page.click(".scard", "dictation at work");
  await page.waitFor(`${arrived("session")} && document.querySelector('#session .session-body')?.dataset.fetched === 'yes' && ${STILL}`);
}

describe("page: dictation", SKIP, () => {
  setupPage();
  const engines: { stop(): void }[] = [];
  after(() => engines.forEach((e) => e.stop()));
  const engineFor = (home: string) => {
    const e = whisperEngine(home, path.join(tempHome(), "run"), { ...ON_DEMAND, pollMs: 20 });
    engines.push(e);
    return e;
  };

  it("shows no mic when the desk has no speech engine", async () => {
    const page = await open();
    await page.waitFor("document.querySelector('#view .answer textarea')");
    assert.equal(await page.eval<number>("document.querySelectorAll('button.mic').length"), 0);
  });

  it("puts what was said in the box at the caret, as typed, and sends nothing", async () => {
    const fake = fakeWhisper({ text: " Haz commit.\n" });
    await ownDesk(
      async (page, own) => {
        await page.eval(FAKE_MIC);
        await page.eval(`Object.defineProperty(navigator, "language", { value: "es-ES", configurable: true })`);
        await openPanel(page);
        await page.waitFor(mic);
        await page.eval(`(() => { const b = ${box}; b.focus(); b.value = "Primero luego"; b.dispatchEvent(new Event("input", { bubbles: true })); b.setSelectionRange(7, 7); })()`);
        const before = own.listMessages(SID).length;
        await page.click("#session .chat-footer button.mic");
        await page.waitFor(`document.querySelector('#session button.mic.recording') && document.querySelector('#session button.mic .mic-time').textContent === '0:01'`);
        assert.equal(await page.eval<string>(`${mic}.getAttribute('aria-pressed')`), "true");
        await page.click("#session .chat-footer button.mic");
        await page.waitFor(`${box}.value !== "Primero luego"`);
        assert.equal(await page.eval<string>(`${box}.value`), "Primero Haz commit. luego", "at the caret, spaced from the words around it");
        assert.equal(await page.eval<number>(`${box}.selectionStart`), "Primero Haz commit.".length, "the caret after what was said");
        await page.waitFor(`!document.querySelector('#session button.mic.transcribing')`);
        assert.match(await page.eval<string>("localStorage.getItem('agent-desk:drafts') ?? ''"), /Primero Haz commit\. luego/, "kept as a draft, as typing keeps it");
        const writes = (await page.eval<string[]>("window.asked")).filter((r) => r.startsWith("POST"));
        assert.ok(writes.includes("POST /api/dictation/warm") && writes.includes("POST /api/dictation/transcribe"), writes.join(", "));
        assert.ok(!writes.some((r) => /\/(message|answer)$/.test(r)), `nothing sent: ${writes.join(", ")}`);
        assert.equal(own.listMessages(SID).length, before);

        const asked = fake.log().find((l) => l.inference)?.inference;
        const file = asked?.file;
        assert.ok(typeof file === "object" && file.size > 16_000 * 2 && file.type === "audio/wav", `a WAV of over a second: ${JSON.stringify(file)}`);
        const prompt = String(asked?.prompt);
        const spanish = "Vale, haz commit y push de la rama; luego un rebase del worktree, abre el pull request y revisa el diff en el dashboard de Needs you.";
        assert.ok(prompt.startsWith(`${spanish} web-shop, dictation at work, Claude Code, Opus 5.5, `), `a sentence in the page's Spanish first, then this session's names: ${prompt}`);
        assert.match(prompt, /Revisa el checkout en el worktree Done: the pay button stays in view\. Shall I open the pull request against main\?$/, "the conversation last, without its code");

        // A long conversation on an English page: its end fills what the sentence and the names leave of the engine's 224 tokens.
        const [long, tokens] = await page.eval<[string, number]>(`(async () => {
          Object.defineProperty(navigator, "language", { value: "en-GB", configurable: true });
          const { ui } = await import("/state.js");
          const d = await import("/dictate.js");
          ui.conversations.set(${JSON.stringify(SID)}, [...ui.conversations.get(${JSON.stringify(SID)}), { id: "long", sessionId: ${JSON.stringify(SID)}, from: "session", text: "palabra ".repeat(400) + "y el final del todo", at: new Date().toISOString() }]);
          const p = d.vocabulary("message-${SID}", ${JSON.stringify(SID)}, 224);
          return [p, d.tokensOf(p)];
        })()`);
        assert.ok(tokens <= 200 && tokens > 180, `within the engine's prompt, counted high: ${tokens} tokens`);
        const english = "Okay, commit and push the branch, then rebase the worktree, open the pull request and check the diff in the Needs you dashboard.";
        assert.ok(long.startsWith(`${english} web-shop, dictation at work, `), `a sentence in the page's English first, then the names: ${long.slice(0, 200)}`);
        assert.match(long, /\. (palabra )+y el final del todo$/, "the latest words last");
      },
      atWork,
      { speech: engineFor(fake.home) },
    );
  });

  it("on a phone, records in the box's row of buttons, between the plus and Send, leaving the text its whole width, down to 320 px", async () => {
    const fake = fakeWhisper({ text: "Vale." });
    await ownDesk(
      async (page) => {
        await page.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 640, deviceScaleFactor: 1, mobile: true });
        await page.eval(FAKE_MIC);
        await page.click(".tabbar button", "Sessions");
        await openPanel(page);
        await page.waitFor(mic);
        const shape = `(() => {
          const r = (s) => document.querySelector('#session .chat-footer ' + s).getBoundingClientRect();
          const c = r('.compose'), box = r('textarea'), add = r('.add-image'), m = r('.mic'), send = r('.send');
          return { text: box.width, row: [add.right <= m.left, m.right <= send.left, m.top === send.top, m.top >= box.bottom - 1, send.right <= c.right], within: c.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth };
        })()`;
        const idle = await page.eval<{ text: number }>(shape);
        await page.click("#session .chat-footer button.mic");
        await page.waitFor(`document.querySelector('#session button.mic.recording') && document.querySelector('#session button.mic .mic-time').textContent === '0:01'`);
        assert.deepEqual(await page.eval(shape), { text: idle.text, row: [true, true, true, true, true], within: true }, "the wider mic takes room from the row, not from the text");
        await page.click("#session .chat-footer button.mic");
        await page.waitFor(`${box}.value.includes("Vale.") && !document.querySelector('#session button.mic.transcribing')`);
      },
      atWork,
      { phone: true, speech: engineFor(fake.home) },
    );
  });

  it("drops a recording whose box closes, and frees the mics", async () => {
    const fake = fakeWhisper();
    await ownDesk(
      async (page) => {
        await page.eval(FAKE_MIC);
        await openPanel(page);
        await page.waitFor(mic);
        await page.click("#session .chat-footer button.mic");
        await page.waitFor("document.querySelector('#session button.mic.recording')");
        await page.press("Escape");
        await page.waitFor("[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('The recording was dropped: its box closed'))");
        // No take any more, so no mic is held for it (shownMic is what the views redraw on).
        assert.deepEqual(await page.eval<unknown[]>(`(async () => (await import("/dictate.js")).shownMic())()`), [true, null, null]);
        const writes = (await page.eval<string[]>("window.asked")).filter((r) => r.startsWith("POST"));
        assert.ok(!writes.includes("POST /api/dictation/transcribe"), `nothing transcribed: ${writes.join(", ")}`);
        assert.equal(fake.log().filter((l) => l.inference).length, 0);
      },
      atWork,
      { speech: engineFor(fake.home) },
    );
  });

  it("cancels a transcription from its own mic, which stays enabled, and writes nothing", async () => {
    const fake = fakeWhisper({ inferenceDelayMs: 4000, text: " tarde" });
    await ownDesk(
      async (page) => {
        await page.eval(FAKE_MIC);
        await openPanel(page);
        await page.waitFor(mic);
        await page.click("#session .chat-footer button.mic");
        await page.waitFor("document.querySelector('#session button.mic.recording')");
        await page.click("#session .chat-footer button.mic");
        await page.waitFor(`document.querySelector('#session button.mic.transcribing') && !${mic}.disabled`);
        await page.waitFor("window.asked.includes('POST /api/dictation/transcribe')");
        await page.click("#session .chat-footer button.mic");
        await page.waitFor(`!document.querySelector('#session button.mic.transcribing') && !${mic}.disabled`, 1500);
        await new Promise((r) => setTimeout(r, 4500));
        assert.equal(await page.eval<string>(`${box}.value`), "", "the answer that came after the cancel was not written");
        assert.equal(await page.eval<boolean>("[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Dictation failed'))"), false, "a cancel is not a failure");
      },
      atWork,
      { speech: engineFor(fake.home) },
    );
  });

  it("says why when the engine cannot start, and the mic is ready for the next press", async () => {
    const fake = fakeWhisper({ failStart: "ggml_cuda_init: no CUDA-capable device is detected" });
    await ownDesk(
      async (page) => {
        await page.eval(FAKE_MIC);
        await openPanel(page);
        await page.waitFor(mic);
        await page.click("#session .chat-footer button.mic");
        await page.waitFor("[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Dictation failed') && t.textContent.includes('no CUDA-capable device'))");
        await page.waitFor(`!document.querySelector('#session button.mic.recording, #session button.mic.starting') && !${mic}.disabled`);
        assert.equal(await page.eval<string>(`${box}.value`), "", "nothing written");
        assert.deepEqual(page.errors.splice(0), [`Failed to load resource: the server responded with a status of 503 (Service Unavailable) ${await page.eval<string>("location.origin")}/api/dictation/warm`]);
      },
      atWork,
      { speech: engineFor(fake.home) },
    );
  });
});
