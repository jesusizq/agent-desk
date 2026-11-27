// @ts-check
// Dictation: the mic beside a reply box records what the developer says, the desk's local speech engine
// makes it text, and the text goes into the box at the caret, to read and send as anything typed.
import { h, icon } from "./dom.js";
import { TEXT } from "./text.js";
import { boxesOf, loadConversation } from "./conversation.js";
import { COARSE } from "./layout.js";
import { toast } from "./pieces.js";
import { getJson, OfflineError, postForm, postJson } from "./server.js";
import { data, metricsOf, page, S, ui } from "./state.js";

/** What the desk said of its engine (/api/dictation): without one, no mic is drawn. Its waits bound the page's own. */
let engine = { available: false, seconds: 120, promptTokens: 0, warmMs: 0, transcribeMs: 0 };
/** Why the engine installed cannot be used, as the desk said it last: said once, not at each look. */
let problem = "";
const RATE = 16_000;
/** Kept off the engine's prompt limit: the count below is an estimate, and the engine keeps only the last tokens of a longer one. */
const TOKEN_MARGIN = 24;
/** The most the names take, so that the conversation's words have room too; a name longer than NAME_TOKENS is left out. */
const NAMES_TOKENS = 60;
const NAME_TOKENS = 16;
/**
 * Words a developer says to a coding session, in a sentence as one would say it in the page's language:
 * the engine reads its prompt as the transcript before the recording, so a sentence teaches it how they are used better than a list.
 */
const opening = () =>
  /^es(-|$)/i.test(navigator.language ?? "")
    ? `Vale, haz commit y push de la rama; luego un rebase del worktree, abre el pull request y revisa el diff en el dashboard de ${TEXT.cols.needs}.`
    : `Okay, commit and push the branch, then rebase the worktree, open the pull request and check the diff in the ${TEXT.cols.needs} dashboard.`;
/** The longest the microphone takes to start (a permission prompt left open, a worklet that does not load): then the take is given up. */
const START_MS = 30_000;
/** Added to what the desk may take on a call: the recording's way up from a phone and the answer's way back. */
const LINK_MS = 30_000;
/** The longest the audio thread takes to hand over its last samples: past it the recording goes without them. */
const FLUSH_MS = 1000;
/** The reason a take is given up by the developer or because its box went: said there, not as a failure. */
const CANCELLED = new DOMException("the recording was cancelled", "AbortError");

/** Fetched when the page starts and when it comes back to the front: the desk looks for the engine at each fetch. */
export function loadDictation() {
  getJson("/api/dictation")
    .then((body) => {
      const b = /** @type {{ available?: unknown, problem?: unknown, seconds?: unknown, promptTokens?: unknown, warmSeconds?: unknown, transcribeSeconds?: unknown }} */ (typeof body === "object" && body !== null ? body : {});
      if (typeof b.available !== "boolean" || !Number.isInteger(b.seconds) || !Number.isInteger(b.promptTokens) || !Number.isInteger(b.warmSeconds) || !Number.isInteger(b.transcribeSeconds) || (b.problem !== undefined && typeof b.problem !== "string"))
        throw new Error(`the desk's dictation answer is unreadable: ${JSON.stringify(body).slice(0, 80)}`);
      const next = { available: b.available, seconds: Number(b.seconds), promptTokens: Number(b.promptTokens), warmMs: Number(b.warmSeconds) * 1000, transcribeMs: Number(b.transcribeSeconds) * 1000 };
      const said = typeof b.problem === "string" ? b.problem : "";
      if (said && said !== problem) toast(TEXT.dictation.failed(said));
      problem = said;
      const changed = next.available !== engine.available;
      engine = next;
      if (changed) page.render();
    })
    .catch((/** @type {unknown} */ e) => {
      // Offline the page says so already; the mic stays as it was until the next fetch.
      if (!(e instanceof OfflineError)) toast(reasonOf(e));
    });
}

/** @param {unknown} error */
const reasonOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * The recording under way, one at a time: whose box (`place`: the part of the page its mic was tapped in),
 * how far it went, and what a tap on its mic does.
 * @typedef {{ key: string, sid: string, place: string, phase: "starting" | "recording" | "transcribing", started: number, level: number, tap: () => void, finish: () => void, cancel: () => void }} Take
 */
/** @type {Take | null} */
let take = null;

/** What the mics show, for a view that redraws only when what it shows changed: their time and level are written in place. */
export const shownMic = () => [engine.available, take?.key, take?.phase];

/** The elapsed time as the mic shows it. @param {number} ms */
const clock = (ms) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

/** The part of the page an element is in (the desk, the session panel…), the same across redraws. @param {Element} el */
const placeOf = (el) => el.closest("[id]")?.id ?? "";

/**
 * The mic of the box `key` (answering in session `sid`), or nothing when the desk has no engine or the
 * browser no microphone (a page not served over https or from this computer). `off`: the box takes nothing
 * now, so no take starts there; one under way can always be stopped from its own mic.
 * @param {string} key @param {string} sid @param {boolean} off
 */
export function micButton(key, sid, off) {
  if (!engine.available || !navigator.mediaDevices?.getUserMedia) return null;
  const mine = take?.key === key ? take : null;
  const label = !mine ? TEXT.dictation.start : mine.phase === "transcribing" ? TEXT.dictation.transcribing : mine.phase === "starting" ? TEXT.dictation.starting : TEXT.dictation.stop;
  const button = h(
    "button",
    {
      class: `icon-btn mic${mine ? ` ${mine.phase}` : ""}`,
      "data-mic": key,
      title: label,
      "aria-label": label,
      "aria-pressed": String(mine !== null && mine.phase !== "transcribing"),
      "aria-busy": mine?.phase === "transcribing" ? "true" : null,
      disabled: !mine && (off || take !== null),
      // The focus stays in the box, and its caret where the text goes.
      onmousedown: (e) => e.preventDefault(),
      onclick: (e) => (take?.key === key ? take.tap() : void record(key, sid, e.currentTarget instanceof Element ? placeOf(e.currentTarget) : "")),
    },
    icon("mic"),
    h("span", { class: "mic-time", "aria-hidden": "true" }, mine?.phase === "recording" ? clock(Date.now() - mine.started) : ""),
  );
  if (mine) button.style.setProperty("--level", mine.level.toFixed(2));
  return button;
}

/** The mic's time and level, written in place between the page's redraws. @param {Take} t */
function showProgress(t) {
  for (const b of document.querySelectorAll(`button.mic[data-mic="${CSS.escape(t.key)}"]`)) {
    if (!(b instanceof HTMLElement)) continue;
    b.style.setProperty("--level", t.level.toFixed(2));
    const time = b.querySelector(".mic-time");
    if (time && t.phase === "recording") time.textContent = clock(Date.now() - t.started);
  }
}

/**
 * `run` given `ms` to answer, and stopped with the take (`outer`): past the bound it fails saying so.
 * @template T @param {number} ms @param {AbortSignal} outer @param {(signal: AbortSignal) => Promise<T>} run @returns {Promise<T>}
 */
function bounded(ms, outer, run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException(TEXT.dictation.noAnswer(Math.round(ms / 1000)), "TimeoutError")), ms);
  const follow = () => controller.abort(outer.reason);
  if (outer.aborted) follow();
  else outer.addEventListener("abort", follow, { once: true });
  return run(controller.signal).finally(() => {
    clearTimeout(timer);
    outer.removeEventListener("abort", follow);
  });
}

/**
 * Records from the microphone until the mic is tapped again (or the longest recording is reached), then
 * has it transcribed. The engine is warmed at the tap, while the developer starts speaking. A take whose
 * box goes before it is transcribed is dropped; one whose microphone does not start in time, given up.
 * @param {string} key @param {string} sid @param {string} place
 */
async function record(key, sid, place) {
  if (take) return;
  // Made in the tap itself: iOS lets audio start only from a gesture.
  const context = new AudioContext();
  /** @type {Float32Array[]} */
  const blocks = [];
  /** @type {MediaStream | null} */
  let stream = null;
  let ended = false;
  let released = false;
  /** The samples still on their way from the audio thread, awaited before the recording is made. */
  let flush = () => Promise.resolve();
  const controller = new AbortController();
  const release = () => {
    stream?.getTracks().forEach((track) => track.stop());
    if (released) return;
    released = true;
    context.close().catch((/** @type {unknown} */ e) => toast(TEXT.dictation.failed(reasonOf(e))));
  };
  /** @type {Take} */
  const t = {
    key,
    sid,
    place,
    phase: "starting",
    started: Date.now(),
    level: 0,
    tap: () => (t.phase === "starting" ? t.cancel() : t.phase === "recording" ? t.finish() : controller.abort(CANCELLED)),
    finish: () => {
      if (ended) return;
      ended = true;
      t.phase = "transcribing";
      page.render();
      void flush().then(() => {
        release();
        return transcribe(t, blocks, context.sampleRate, controller.signal);
      });
    },
    cancel: () => {
      if (ended) return;
      ended = true;
      release();
      controller.abort(CANCELLED);
      take = null;
      page.render();
    },
  };
  take = t;
  page.render();
  // One clock for the take: its box still there, its start bounded, its length and its progress.
  const watch = window.setInterval(() => {
    if (take !== t) return clearInterval(watch);
    if (t.phase === "transcribing") return; // its text, the box gone meanwhile, is said in a toast (insert)
    // Shown, not only in the document: a closed panel keeps its content.
    if (![...document.querySelectorAll(`button.mic[data-mic="${CSS.escape(key)}"]`)].some((b) => b.getClientRects().length > 0)) {
      t.cancel();
      toast(TEXT.dictation.gone);
    } else if (t.phase === "starting" && Date.now() - t.started > START_MS) {
      t.cancel();
      toast(TEXT.dictation.slowStart(START_MS / 1000));
    } else if (t.phase === "recording" && Date.now() - t.started >= engine.seconds * 1000) {
      toast(TEXT.dictation.longest(engine.seconds));
      t.finish();
    } else showProgress(t);
  }, 200);
  const warm = bounded(engine.warmMs + LINK_MS, controller.signal, (signal) => postJson("/api/dictation/warm", {}, "POST", signal));
  warm.catch((/** @type {unknown} */ e) => {
    // Nothing would come of the recording: it stops at once, and the next tap starts the engine again.
    if (controller.signal.aborted || t.phase === "transcribing") return; // cancelled, or said as its transcript's failure
    t.cancel();
    toast(TEXT.dictation.failed(reasonOf(e)));
  });
  warms.set(t, warm);
  // The words of the conversation it answers bias the transcript: fetched now when the page lacks them.
  if (!ui.conversations.has(sid) && S(sid)) loadConversation(sid, () => {});
  /** @param {Float32Array} samples */
  const heard = (samples) => {
    if (released) return;
    blocks.push(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    t.level = Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)) * 6);
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (ended) return release();
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    if (context.audioWorklet) {
      await context.audioWorklet.addModule("/dictate-worklet.js");
      const node = new AudioWorkletNode(context, "agent-desk-capture");
      /** @type {() => void} */
      let flushed = () => {};
      node.port.onmessage = (e) => (e.data === "flushed" ? flushed() : e.data instanceof Float32Array ? heard(e.data) : undefined);
      // The blocks posted before "flushed" arrive before it: the port keeps their order.
      flush = () =>
        new Promise((resolve) => {
          flushed = () => resolve(undefined);
          node.port.postMessage("flush");
          setTimeout(resolve, FLUSH_MS); // an audio thread that does not answer (a suspended context): the recording goes without its last 85 ms
        });
      source.connect(node).connect(context.destination);
    } else {
      // Older browsers: no worklet, the same samples on the main thread.
      const node = context.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => heard(e.inputBuffer.getChannelData(0).slice());
      source.connect(node).connect(context.destination);
    }
    if (ended) return release();
    // A phone locked or the mic taken by another app ends the track: what was said until then is kept.
    for (const track of stream.getAudioTracks()) track.addEventListener("ended", t.finish);
    t.phase = "recording";
    t.started = Date.now();
    page.render();
  } catch (error) {
    if (ended) return release(); // already stopped, and said why
    t.cancel();
    toast(micError(error));
  }
}
/** The warm-up of each recording, awaited before its transcript is asked for. @type {WeakMap<Take, Promise<unknown>>} */
const warms = new WeakMap();

/** Why the microphone could not be used, as the developer can act on it. @param {unknown} error */
function micError(error) {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return TEXT.dictation.denied;
  if (name === "NotFoundError" || name === "OverconstrainedError") return TEXT.dictation.noMic;
  return TEXT.dictation.failed(error instanceof Error ? error.message : String(error));
}

/** @param {Take} t @param {Float32Array[]} blocks @param {number} rate @param {AbortSignal} signal */
async function transcribe(t, blocks, rate, signal) {
  try {
    await warms.get(t);
    const form = new FormData();
    form.append("audio", wavOf(blocks, rate, engine.seconds), "dictation.wav");
    form.append("prompt", vocabulary(t.key, t.sid, engine.promptTokens));
    const body = await bounded(engine.transcribeMs + LINK_MS, signal, (s) => postForm("/api/dictation/transcribe", form, s));
    if (signal.aborted) throw signal.reason; // cancelled while its answer was read
    const text = typeof body === "object" && body !== null && "text" in body && typeof body.text === "string" ? body.text : null;
    if (text === null) throw new Error(`the desk answered without a transcript: ${JSON.stringify(body).slice(0, 80)}`);
    if (text === "") toast(TEXT.dictation.nothing);
    else insert(t, text);
  } catch (error) {
    if (error !== CANCELLED) toast(TEXT.dictation.failed(reasonOf(error)));
  } finally {
    take = null;
    page.render();
  }
}

/**
 * The text put in the box at its caret, spaced from what is around it, as if typed: never sent. The box is
 * the one whose mic was tapped, else the one with the focus, else any showing the same draft.
 * @param {Take} t @param {string} text
 */
function insert(t, text) {
  const boxes = boxesOf(t.key).filter((b) => !b.readOnly);
  const box = boxes.find((b) => placeOf(b) === t.place) ?? boxes.find((b) => b === document.activeElement) ?? boxes[0];
  if (!box) return toast(TEXT.dictation.noBox(text));
  const start = box.selectionStart ?? box.value.length;
  const end = box.selectionEnd ?? start;
  const before = box.value.slice(0, start);
  const after = box.value.slice(end);
  const lead = before !== "" && !/\s$/.test(before) ? " " : "";
  const trail = after !== "" && !/^[\s.,;:!?)]/.test(after) ? " " : "";
  box.setRangeText(lead + text + trail, start, end, "end");
  // As typing does: the draft is kept and the box grows to fit (answer.js).
  box.dispatchEvent(new Event("input", { bubbles: true }));
  // Under a finger the focus would raise the keyboard over what was just written.
  if (!COARSE.matches) box.focus();
}

/**
 * The recording as the desk takes it: 16 kHz mono 16-bit PCM WAV. Each sample out averages the samples
 * it spans at the microphone's rate, which keeps what lies above 8 kHz from folding into speech.
 * @param {Float32Array[]} blocks @param {number} rate @param {number} maxSeconds
 */
export function wavOf(blocks, rate, maxSeconds) {
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const all = new Float32Array(total);
  let at = 0;
  for (const b of blocks) all.set(b, (at += b.length) - b.length);
  const ratio = rate / RATE;
  const n = Math.min(Math.floor(total / ratio), maxSeconds * RATE);
  const view = new DataView(new ArrayBuffer(44 + n * 2));
  const ascii = (/** @type {number} */ offset, /** @type {string} */ s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.max(from + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to; j++) sum += all[j] ?? 0;
    const s = Math.max(-1, Math.min(1, sum / (to - from)));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

/** As the desk refuses them in a prompt (dictationPrompt in src/core/model.ts): control, bidi and invisible characters. */
const HIDDEN = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cs}\u{2800}]`, "gu");
/** Text as words to hear: code blocks, links and markup marks go, and every space is one. @param {string} text */
const spoken = (text) =>
  text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(HIDDEN, " ")
    .replace(/[`*_#>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
/**
 * About how many tokens a text takes, counted high: a byte-level vocabulary takes a word in about a token
 * per 3 bytes or fewer, and each mark apart. @param {string} text
 */
export const tokensOf = (text) => (text.match(/[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]/gu) ?? []).reduce((n, piece) => n + (/^[\p{L}\p{M}\p{N}]/u.test(piece) ? Math.ceil(new TextEncoder().encode(piece).length / 3) : 1), 0);

/**
 * What the engine is told the recording likely holds, within the tokens it keeps: the glossary sentence always
 * (it is what works in a new conversation), then the names of the projects, sessions, providers and
 * models on the desk, this session's first, then the end of what was said in the conversation the box
 * answers, the latest words last, as the transcript before this one would read.
 * @param {string} key @param {string} sid @param {number} tokens
 */
export function vocabulary(key, sid, tokens) {
  const budget = Math.max(0, tokens - TOKEN_MARGIN);
  const glossary = opening();
  let left = budget - tokensOf(glossary);
  const own = S(sid);
  const sessions = [own, ...[...data.sessions].filter((s) => s !== own).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))];
  /** @type {string[]} */
  const names = [];
  let namesLeft = Math.min(NAMES_TOKENS, left);
  for (const s of sessions) {
    if (!s) continue;
    for (const raw of [s.project.name, s.title, s.provider, metricsOf(s.id)?.model]) {
      const name = spoken(raw ?? "");
      const cost = tokensOf(name) + 1;
      if (name === "" || names.includes(name) || cost > NAME_TOKENS || cost > namesLeft) continue;
      names.push(name);
      namesLeft -= cost;
      left -= cost;
    }
  }
  const tail = conversationTail(key, sid, left);
  return [glossary, names.length ? `${names.join(", ")}.` : "", tail].filter(Boolean).join(" ");
}

/** The last words said in the box's conversation, at most `budget` tokens of them: the question it answers last. @param {string} key @param {string} sid @param {number} budget */
function conversationTail(key, sid, budget) {
  const said = (ui.conversations.get(sid) ?? []).filter((m) => m.from !== "agent").map((m) => m.text);
  const q = key.startsWith("answer-") ? data.questions.find((x) => key === `answer-${x.id}`) : undefined;
  if (q && said.at(-1)?.trim() !== q.text.trim()) said.push(q.text);
  /** @type {string[]} */
  const words = [];
  let left = budget;
  for (let i = said.length - 1; i >= 0 && left > 0; i--) {
    const ws = spoken(said[i] ?? "").split(" ").filter(Boolean);
    for (let j = ws.length - 1; j >= 0; j--) {
      const word = ws[j] ?? "";
      const cost = tokensOf(word);
      if (cost > left) {
        left = 0;
        break;
      }
      words.unshift(word);
      left -= cost;
    }
  }
  return words.join(" ");
}
