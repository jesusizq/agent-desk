import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { InputError } from "../src/core/check.ts";
import { procInfo } from "../src/core/proc.ts";
import { DictationError, ON_DEMAND, readWav, WAV_BYTES_MAX } from "../src/server/dictation.ts";
import { transcript, whisperEngine, whisperHome } from "../src/server/whisper.ts";
import { Store } from "../src/store/store.ts";
import { alive, fakeWhisper, wav } from "./fake-whisper.ts";
import { addSession, serve, tempHome, testStore } from "./helpers.ts";

const QUICK = { ...ON_DEMAND, idleMs: 60_000, pollMs: 20, readyMs: 10_000 };
const engines: { stop(): void }[] = [];
const engine = (home: string, options = QUICK, run = path.join(tempHome(), "run")) => {
  const e = whisperEngine(home, run, options);
  engines.push(e);
  return e;
};
const flagOf = (args: string[] | undefined, name: string) => (args && args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
after(() => engines.forEach((e) => e.stop()));
const until = async (what: string, ok: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("the speech engine", () => {
  it("is unavailable until the binary and the model are both installed", () => {
    const home = tempHome();
    assert.equal(engine(home).available(), false, "nothing installed");
    const fake = fakeWhisper();
    assert.equal(engine(fake.home).available(), true);
    fs.rmSync(path.join(fake.home, "models", "ggml-large-v3-turbo-q8_0.bin"));
    assert.equal(engine(fake.home).available(), false, "no model");
    assert.equal(whisperHome({ AGENT_DESK_WHISPER_HOME: "/x" }), "/x");
    assert.match(whisperHome({}), /\.local\/share\/agent-desk-whisper$/);
    assert.throws(() => whisperHome({ AGENT_DESK_WHISPER_HOME: "share/whisper" }), /AGENT_DESK_WHISPER_HOME must be an absolute path, got "share\/whisper"/, "relative to whatever directory the desk starts in: refused");
  });

  it("says why an installed engine cannot be used, instead of hiding it as not installed", () => {
    const fake = fakeWhisper();
    const binary = path.join(fake.home, "whisper.cpp", "build", "bin", "whisper-server");
    fs.chmodSync(binary, 0o644);
    assert.throws(() => engine(fake.home).available(), (e: unknown) => e instanceof DictationError && /cannot use .*whisper-server \(EACCES/.test(e.message));
    fs.chmodSync(binary, 0o755);
    const model = path.join(fake.home, "models", "ggml-large-v3-turbo-q8_0.bin");
    fs.rmSync(model);
    fs.mkdirSync(model);
    assert.throws(() => engine(fake.home).available(), /ggml-large-v3-turbo-q8_0\.bin is not a file/);
  });

  it("starts once for calls made together, on a socket in the store's own directory, and asks it as whisper-server reads it", async () => {
    const fake = fakeWhisper({ startDelayMs: 150, text: " Haz commit y push.\n [BLANK_AUDIO]\n  Mira Needs you. \n" });
    const run = path.join(tempHome(), "run");
    const e = engine(fake.home, QUICK, run);
    await Promise.all([e.warm(), e.warm(), e.warm()]);
    const recording = wav(1.5);
    const [a, b] = await Promise.all([e.transcribe(recording, "commit, push, Needs you."), e.transcribe(recording, "")]);
    assert.equal(a, "Haz commit y push. Mira Needs you.", "segments joined, the sound marker dropped, spaces trimmed");
    assert.equal(b, a);
    const starts = fake.log().filter((l) => l.start);
    assert.equal(starts.length, 1, "one instance shared by every call");
    const args = starts[0]?.args ?? [];
    assert.deepEqual(args, ["--model", path.join(fake.home, "models", "ggml-large-v3-turbo-q8_0.bin"), "--host", path.join(run, "whisper.sock")], "a unix socket: no port, nothing on 127.0.0.1");
    assert.equal(fs.statSync(run).mode & 0o777, 0o700, "a directory only this user reaches");
    assert.ok(!args.includes("--convert"), "the page sends WAV: no ffmpeg conversion");
    assert.equal(starts[0]?.cwd, fake.home);
    const asked = fake.log().filter((l) => l.inference).map((l) => l.inference);
    assert.deepEqual(asked[0], { file: { size: recording.length, type: "audio/wav" }, language: "auto", prompt: "commit, push, Needs you.", response_format: "json", temperature: "0.0", no_timestamps: "true" });
  });

  it("stops after the idle time with SIGTERM, and starts again at the next call", async () => {
    const fake = fakeWhisper();
    const e = engine(fake.home, { ...QUICK, idleMs: 200 });
    await e.warm();
    const pid = e.pid();
    assert.ok(pid && alive(pid));
    await e.transcribe(wav(0.5), "");
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(alive(pid), "a call put the idle clock back");
    await until("the idle stop", () => !alive(pid));
    assert.deepEqual(fake.log().filter((l) => l.stop).map((l) => l.stop), [pid], "stopped by SIGTERM");
    assert.equal(e.pid(), undefined);
    await e.warm();
    assert.notEqual(e.pid(), pid);
    assert.equal(fake.log().filter((l) => l.start).length, 2);
  });

  it("says why it could not start, and tries again at the next call", async () => {
    const fake = fakeWhisper({ failStart: "ggml_cuda_init: failed to initialize CUDA: no CUDA-capable device is detected" });
    const e = engine(fake.home);
    await assert.rejects(e.warm(), (error: unknown) => error instanceof DictationError && /could not start \(exit code 3: .*no CUDA-capable device is detected\)/.test(error.message));
    fake.behave({});
    await e.warm();
    assert.equal(fake.log().filter((l) => l.start).length, 2);
  });

  it("gives up on a server that never gets ready, and stops it", async () => {
    const fake = fakeWhisper({ startDelayMs: 5000 });
    const e = engine(fake.home, { ...QUICK, readyMs: 300 });
    await assert.rejects(e.warm(), /was not ready within 0\.3 s; it was stopped/);
    const pid = fake.log().find((l) => l.start)?.start ?? 0;
    await until("the stuck server's end", () => !alive(pid));
  });

  it("says it crashed while transcribing, and the next call starts it again", async () => {
    const fake = fakeWhisper();
    const e = engine(fake.home);
    await e.warm();
    const pid = e.pid() ?? 0;
    fake.behave({ crash: true });
    await assert.rejects(e.transcribe(wav(0.5), ""), (error: unknown) => error instanceof DictationError && /stopped while transcribing \(exit code 9\)/.test(error.message));
    assert.ok(!alive(pid));
    fake.behave({ text: " otra vez" });
    assert.equal(await e.transcribe(wav(0.5), ""), "otra vez");
    assert.equal(fake.log().filter((l) => l.start).length, 2);
  });

  it("talks to nothing but its own child's socket: one left at the path is removed, never asked", async () => {
    const fake = fakeWhisper({ startDelayMs: 300, text: " del motor" });
    const run = path.join(tempHome(), "run");
    fs.mkdirSync(run, { mode: 0o755 });
    let reached = 0;
    const decoy = net.createServer((c) => (reached++, c.destroy()));
    await new Promise<void>((r) => decoy.listen(path.join(run, "whisper.sock"), r));
    try {
      const e = engine(fake.home, QUICK, run);
      assert.equal(await e.transcribe(wav(0.5), "palabras de la conversación"), "del motor");
      assert.equal(reached, 0, "the socket left there was never connected to, not even while the model loaded");
      assert.equal(fake.log().filter((l) => l.inference).length, 1, "the child got the recording");
      assert.equal(fs.statSync(run).mode & 0o777, 0o700, "made private again");
    } finally {
      decoy.close();
    }
  });

  it("refuses a socket path longer than a unix socket takes, saying how to fix it", async () => {
    const fake = fakeWhisper();
    const run = path.join(tempHome(), "x".repeat(100), "run");
    await assert.rejects(engine(fake.home, QUICK, run).warm(), (e: unknown) => e instanceof DictationError && /longer than the 107 bytes a unix socket takes: set AGENT_DESK_HOME to a shorter path/.test(e.message));
    assert.equal(fake.log().length, 0, "nothing started");
  });

  it("stops a transcription that does not answer in time, and starts afresh at the next call", async () => {
    const fake = fakeWhisper({ inferenceDelayMs: 3000 });
    const e = engine(fake.home, { ...QUICK, answerMs: 300 });
    await e.warm();
    const pid = e.pid() ?? 0;
    await assert.rejects(e.transcribe(wav(0.5), ""), (error: unknown) => error instanceof DictationError && /did not answer within 0\.3 s; it was stopped/.test(error.message));
    await until("the stuck engine's end", () => !alive(pid));
    assert.deepEqual(fake.log().filter((l) => l.stop).map((l) => l.stop), [pid], "stopped by SIGTERM");
    fake.behave({ text: " de nuevo" });
    assert.equal(await e.transcribe(wav(0.5), ""), "de nuevo");
    assert.notEqual(e.pid(), pid);
  });

  it("kills a child that ignores SIGTERM once the grace period ends, and the next start waits for it", async () => {
    const fake = fakeWhisper({ ignoreTerm: true });
    const e = engine(fake.home, { ...QUICK, killMs: 400 });
    await e.warm();
    const pid = e.pid() ?? 0;
    fake.behave({});
    const stoppedAt = Date.now();
    e.stop();
    await e.warm();
    assert.ok(!alive(pid), "the first is gone");
    assert.deepEqual(fake.log().filter((l) => l.ignored).map((l) => l.ignored), [pid], "it ignored SIGTERM");
    const second = fake.log().filter((l) => l.start).at(-1);
    assert.notEqual(second?.start, pid);
    assert.ok((second?.at ?? 0) - stoppedAt >= 350, `the second started only after SIGKILL ended the first (${(second?.at ?? 0) - stoppedAt} ms)`);
  });

  it("stopped while it starts, says so and leaves nothing running; the next call starts it", async () => {
    const fake = fakeWhisper({ startDelayMs: 2000 });
    const e = engine(fake.home);
    const warm = e.warm();
    await until("the child's start", () => fake.log().some((l) => l.start));
    const pid = fake.log().find((l) => l.start)?.start ?? 0;
    e.stop();
    await assert.rejects(warm, (error: unknown) => error instanceof DictationError && /was stopped before it was ready/.test(error.message));
    await until("the stopped child's end", () => !alive(pid));
    fake.behave({});
    await e.warm();
    assert.notEqual(e.pid(), pid);
  });

  it("is not stopped for idleness while a call takes longer than the idle time", async () => {
    const fake = fakeWhisper({ inferenceDelayMs: 600, text: " largo" });
    const e = engine(fake.home, { ...QUICK, idleMs: 150 });
    await e.warm();
    const pid = e.pid() ?? 0;
    assert.equal(await e.transcribe(wav(0.5), ""), "largo", "the idle time passed during the call: it answered all the same");
    assert.ok(alive(pid));
    assert.deepEqual(fake.log().filter((l) => l.stop), [], "not stopped meanwhile");
    await until("the idle stop after the call", () => !alive(pid));
  });

  it("ends the engine a killed desk left running, and records this desk beside its own", { timeout: 30_000 }, async () => {
    const fake = fakeWhisper();
    const home = tempHome();
    const run = path.join(home, "run");
    const first = await realDesk(home, fake.home);
    let left = 0;
    try {
      assert.equal((await first.warm()).status, 200);
      left = fake.log().find((l) => l.start)?.start ?? 0;
      assert.deepEqual(pidFile(run).desk, { pid: first.pid, start: procInfo(first.pid)?.start }, "the desk that started it, beside it");
    } finally {
      first.kill("SIGKILL"); // gone without a word: its child still runs
      await first.exited;
    }
    try {
      assert.ok(alive(left), "a desk killed by SIGKILL leaves its engine running");
      const second = engine(fake.home, QUICK, run);
      await second.warm();
      assert.ok(!alive(left), "the one left running was ended");
      assert.deepEqual(fake.log().filter((l) => l.stop).map((l) => l.stop), [left], "by SIGTERM");
      const own = second.pid() ?? 0;
      assert.deepEqual(pidFile(run), { pid: own, start: procInfo(own)?.start, desk: { pid: process.pid, start: procInfo(process.pid)?.start } });
      second.stop();
      await until("the second's end", () => !alive(own));
      assert.ok(!fs.existsSync(path.join(run, "whisper.sock.pid")), "its pid file goes with it");
    } finally {
      if (left && alive(left)) process.kill(left, "SIGKILL"); // a failed step would leave the fake running for good
    }
  });

  it("refuses, signalling nothing, while the desk that started the engine still runs", { timeout: 30_000 }, async () => {
    const fake = fakeWhisper();
    const home = tempHome();
    const run = path.join(home, "run");
    const first = await realDesk(home, fake.home);
    try {
      assert.equal((await first.warm()).status, 200);
      const theirs = fake.log().find((l) => l.start)?.start ?? 0;
      const recorded = pidFile(run);
      // A trial desk on another port of the same store.
      const second = engine(fake.home, QUICK, run);
      await assert.rejects(second.warm(), (e: unknown) => e instanceof DictationError && e.message.includes(`(pid ${theirs}) is run by another desk on this store (pid ${first.pid}): dictate from that desk, or stop it`));
      assert.ok(alive(theirs), "the other desk's engine still runs");
      assert.deepEqual(fake.log().filter((l) => l.stop), [], "and got no signal");
      assert.equal(fake.log().filter((l) => l.start).length, 1, "no second engine started on its socket");
      assert.deepEqual(pidFile(run), recorded, "its record kept");
      assert.equal(second.pid(), undefined);
    } finally {
      first.kill("SIGTERM");
      await first.exited;
    }
  });

  it("leaves alone a recorded pid that is now another process, and refuses one with other arguments", async () => {
    const fake = fakeWhisper();
    const run = path.join(tempHome(), "run");
    const file = path.join(run, "whisper.sock.pid");
    const gone = { pid: process.pid, start: "0" }; // a desk no longer running: this pid, another start time
    // The pid reused: a process with that pid and these very arguments, but another start time, is not the one recorded.
    const other = engine(fake.home, QUICK, run);
    await other.warm();
    const reused = other.pid() ?? 0;
    fs.writeFileSync(file, JSON.stringify({ pid: reused, start: "1", desk: gone }));
    const next = engine(fake.home, QUICK, run);
    await next.warm();
    assert.ok(alive(reused), "not the recorded process: not ended");
    assert.deepEqual(fake.log().filter((l) => l.stop), []);
    const started = next.pid() ?? 0;
    next.stop();
    other.stop();
    await until("both ends", () => !alive(reused) && !alive(started));

    // That very process (this test, with its own start time), started with other arguments: said, its pid named, never signalled.
    const mine = { pid: process.pid, start: procInfo(process.pid)?.start, desk: gone };
    fs.writeFileSync(file, JSON.stringify(mine));
    const moved = engine(fake.home, QUICK, run);
    await assert.rejects(moved.warm(), (e: unknown) => e instanceof DictationError && e.message.includes(`whisper.sock.pid names pid ${process.pid}, which still runs but with other arguments`));
    assert.ok(alive(process.pid));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), mine, "its record kept, so it is not orphaned for good");
    assert.equal(fake.log().filter((l) => l.start).length, 2, "nothing started");

    for (const bad of ["[1]", JSON.stringify({ pid: 4242, start: "5" })]) {
      fs.writeFileSync(file, bad);
      await assert.rejects(engine(fake.home, QUICK, run).warm(), /whisper\.sock\.pid is not a pid file the desk wrote/, bad);
    }
  });

  it("stops the engine it started when its pid file cannot be written, and starts only one after", async () => {
    // Slow to listen: without the stop it would still run at the next start, which would spawn a second.
    const fake = fakeWhisper({ startDelayMs: 60_000 });
    const run = path.join(tempHome(), "run");
    fs.mkdirSync(run, { mode: 0o700 });
    fs.chmodSync(run, 0o500);
    const e = engine(fake.home, QUICK, run);
    await assert.rejects(e.warm(), (error: unknown) => error instanceof DictationError && /was stopped at its start: .*whisper\.sock\.pid could not be written \(EACCES/.test(error.message));
    assert.equal(e.pid(), undefined);
    fs.chmodSync(run, 0o700);
    fake.behave({});
    await e.warm();
    const own = e.pid() ?? 0;
    await until("every other engine's end", () => fake.log().filter((l) => l.start && l.start !== own).every((l) => !alive(l.start ?? 0)));
  });

  it("is stopped when the desk ends by a signal", { timeout: 30_000 }, async () => {
    const fake = fakeWhisper();
    const home = tempHome();
    const real = await realDesk(home, fake.home);
    try {
      const res = await real.warm();
      assert.equal(res.status, 200, await res.text());
      const pid = fake.log().find((l) => l.start)?.start ?? 0;
      assert.ok(alive(pid));
      real.kill("SIGTERM");
      const [, signal] = await real.exited;
      assert.equal(signal, "SIGTERM", "the desk still ends by the signal");
      await until("the engine's end with the desk", () => !alive(pid));
      assert.deepEqual(fake.log().filter((l) => l.stop).map((l) => l.stop), [pid]);
    } finally {
      real.kill("SIGKILL");
    }
  });
});

/** A desk of its own (`agent-desk serve`) on store `home`, with the engine in `whisper`: one a test can kill. */
async function realDesk(home: string, whisper: string) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "../src/cli/main.ts"), "serve", "--port", String(port)], {
    env: { ...process.env, AGENT_DESK_HOME: home, AGENT_DESK_WHISPER_HOME: whisper },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = once(child, "exit") as Promise<[number | null, string | null]>;
  // A desk that ends before it listens (its port taken meanwhile) fails the test at once, not at its timeout.
  await Promise.race([
    new Promise<void>((resolve) => child.stdout.on("data", (d: Buffer) => d.toString().includes("http://127.0.0.1") && resolve())),
    exited.then(([code, signal]) => Promise.reject(new Error(`the desk on port ${port} ended before it listened (${signal ?? code})`))),
  ]);
  const base = `http://127.0.0.1:${port}`;
  return {
    pid: child.pid ?? 0,
    exited,
    kill: (signal: NodeJS.Signals) => child.kill(signal),
    warm: () => fetch(`${base}/api/dictation/warm`, { method: "POST", headers: { Origin: base, "X-Agent-Desk-Secret": new Store(home).secret() } }),
  };
}

const pidFile = (run: string) => JSON.parse(fs.readFileSync(path.join(run, "whisper.sock.pid"), "utf8")) as { pid: number; start: string; desk: { pid: number; start: string } };

async function freePort(): Promise<number> {
  const net = await import("node:net");
  const s = net.createServer().listen(0, "127.0.0.1");
  await once(s, "listening");
  const address = s.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((r) => s.close(r));
  return port;
}

describe("a recording", () => {
  it("is 16 kHz mono 16-bit PCM WAV with audio in it", () => {
    assert.deepEqual(readWav(wav(2)), { seconds: 2 });
    const refused: [Buffer, RegExp][] = [
      [Buffer.from("not a wav at all"), /expected a WAV recording/],
      [wav(1, { rate: 44_100 }), /expected 16 kHz mono 16-bit PCM, got codec 1, 1 channels, 44100 Hz, 16 bits/],
      [wav(1, { channels: 2 }), /2 channels/],
      [wav(0), /the recording is empty/],
      [wav(1).subarray(0, 1000), /cut short: its "data" chunk says 32000 bytes, 956 came/],
      [Buffer.concat([wav(1).subarray(0, 12), wav(1).subarray(36)]), /audio comes before its format/],
    ];
    for (const [body, error] of refused) assert.throws(() => readWav(body), (e: unknown) => e instanceof InputError && error.test(e.message), String(error));
  });

  it("transcribed, keeps what was said and drops what only names a sound", () => {
    assert.equal(transcript(" [BLANK_AUDIO]\n"), "");
    assert.equal(transcript(" (música)\n Dile a Claude que haga el rebase.\n"), "Dile a Claude que haga el rebase.");
    assert.equal(transcript(" Abre la [pull request] ya.\n"), "Abre la [pull request] ya.", "brackets inside a sentence stay");
    assert.equal(transcript(" uno\u200b\u0007 dos \n"), "uno dos");
  });
});

describe("the dictation endpoints", () => {
  const store = testStore();
  addSession(store);
  const secret = store.secret();
  const fake = fakeWhisper({ text: " Haz commit.\n" });
  const desk = serve(store, undefined, undefined, undefined, engine(fake.home));
  after(async () => (await desk).close());
  const formOf = (audio: Buffer, prompt?: string, type = "audio/wav") => {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(audio)], { type }), "dictation.wav");
    if (prompt !== undefined) form.append("prompt", prompt);
    return form;
  };
  const post = async (route: string, body: FormData | Buffer | string | undefined, headers: Record<string, string> = {}) => {
    const { base } = await desk;
    return fetch(base + route, { method: "POST", headers: { Origin: base, "X-Agent-Desk-Secret": secret, ...headers }, ...(body === undefined ? {} : { body }) });
  };
  const transcribe = (audio: Buffer, prompt?: string, headers: Record<string, string> = {}) => post("/api/dictation/transcribe", formOf(audio, prompt), headers);

  it("says whether dictation is installed, and what it takes", async () => {
    const { base } = await desk;
    // QUICK waits: 2 × (10 s to kill + 2 s to be gone) + 10 s ready = 34 s to start, 120 s more to answer.
    assert.deepEqual(await (await fetch(base + "/api/dictation")).json(), { available: true, seconds: 120, promptTokens: 224, promptMax: 2000, warmSeconds: 34, transcribeSeconds: 154 });
    const bare = await serve(testStore());
    try {
      assert.deepEqual(await (await fetch(bare.base + "/api/dictation")).json(), { available: false, seconds: 120, promptTokens: 0, promptMax: 2000, warmSeconds: 0, transcribeSeconds: 0 }, "no engine given: none");
      const res = await fetch(bare.base + "/api/dictation/warm", { method: "POST", headers: { Origin: bare.base, "X-Agent-Desk-Secret": store.secret() } });
      assert.equal(res.status, 403, "another desk's secret");
    } finally {
      await bare.close();
    }
  });

  it("warms the engine and transcribes a recording with its prompt, verbatim", async () => {
    assert.deepEqual(await (await post("/api/dictation/warm", undefined)).json(), { ready: true });
    const prompt = "commit, rebase, Needs you. agent-desk, Claude Code, Opus. ¿Hacemos el rebase?";
    const res = await transcribe(wav(1), prompt);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: "Haz commit." });
    assert.equal(fake.log().filter((l) => l.inference).at(-1)?.inference?.prompt, prompt);
    assert.deepEqual(fs.readdirSync(store.paths.home).filter((f) => /\.wav$|audio|dictat/i.test(f)), [], "nothing of the audio is written to the store");
  });

  it("refuses a write without the page's secret or origin", async () => {
    assert.equal((await post("/api/dictation/warm", undefined, { "X-Agent-Desk-Secret": "nope" })).status, 403);
    assert.equal((await transcribe(wav(1), "", { Origin: "http://evil.example" })).status, 403);
    const { base } = await desk;
    assert.equal((await fetch(base + "/api/dictation/transcribe", { method: "GET" })).status, 404);
  });

  it("refuses what is not a recording it can take, or a prompt with hidden characters", async () => {
    const cases: [Promise<Response>, number, RegExp][] = [
      [post("/api/dictation/transcribe", wav(1), { "Content-Type": "audio/wav" }), 415, /multipart\/form-data/],
      [post("/api/dictation/transcribe", "--x\r\nnot a form", { "Content-Type": "multipart/form-data; boundary=x" }), 400, /form is unreadable/],
      [post("/api/dictation/transcribe", formOf(wav(1), "", "audio/webm")), 400, /"audio\/webm"; expected audio\/wav/],
      [post("/api/dictation/transcribe", (() => (f => (f.append("extra", "x"), f))(formOf(wav(1), "")))()), 400, /unknown field "extra"/],
      [post("/api/dictation/transcribe", (() => (f => (f.append("prompt", "otra"), f))(formOf(wav(1), "una")))()), 400, /prompt more than once/],
      [transcribe(wav(1, { rate: 48_000 })), 400, /16 kHz mono/],
      [transcribe(Buffer.alloc(WAV_BYTES_MAX + 1)), 400, /the recording holds 3840045 bytes, more than 3840044 \(120 s\)/],
      [transcribe(wav(1), "haz\ncommit"), 400, /prompt: one line/],
      [transcribe(wav(1), "rm\u202e -rf"), 400, /no control, bidi or invisible character/],
      [transcribe(wav(1), "x".repeat(2001)), 400, /longer than 2000 characters/],
    ];
    for (const [res, status, error] of cases) {
      const r = await res;
      const body = (await r.json()) as { error: string };
      assert.equal(r.status, status, body.error);
      assert.match(body.error, error);
    }
  });

  it("takes the longest prompt it says, in any script", async () => {
    // 2000 characters of three bytes each: percent-encoded in a header they made 18 000 bytes, past Node's 16 KiB of headers (431).
    const prompt = "日".repeat(2000);
    const res = await transcribe(wav(1), prompt);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(fake.log().filter((l) => l.inference).at(-1)?.inference?.prompt, prompt);
  });

  it("says why an installed engine cannot be used, and warms nothing", async () => {
    const broken = fakeWhisper();
    fs.chmodSync(path.join(broken.home, "whisper.cpp", "build", "bin", "whisper-server"), 0o644);
    const other = await serve(testStore(), undefined, undefined, undefined, engine(broken.home));
    try {
      const info = (await (await fetch(other.base + "/api/dictation")).json()) as { available: boolean; problem?: string };
      assert.equal(info.available, false);
      assert.match(info.problem ?? "", /cannot use .*whisper-server \(EACCES/);
    } finally {
      await other.close();
    }
  });

  it("says the engine's failure, and recovers at the next press", async () => {
    fake.behave({ crash: true });
    const res = await transcribe(wav(1), "");
    assert.equal(res.status, 503);
    assert.match(((await res.json()) as { error: string }).error, /stopped while transcribing/);
    fake.behave({ text: " sigue" });
    assert.deepEqual(await (await transcribe(wav(1), "")).json(), { text: "sigue" });
  });

  it("closes the engine's request when the page cancels a transcription, and the engine goes on serving", async () => {
    const { base } = await desk;
    fake.behave({ inferenceDelayMs: 8000, text: " tarde" });
    const asked = fake.log().filter((l) => l.inference).length;
    const page = new AbortController();
    const pending = fetch(base + "/api/dictation/transcribe", { method: "POST", headers: { Origin: base, "X-Agent-Desk-Secret": secret }, body: formOf(wav(1), ""), signal: page.signal });
    await until("the engine's inference", () => fake.log().filter((l) => l.inference).length > asked);
    page.abort();
    await assert.rejects(pending, /abort/i);
    await until("the engine's request closed before its answer", () => fake.log().some((l) => l.closed), 3000);
    fake.behave({ text: " siguiente" });
    assert.deepEqual(await (await transcribe(wav(1), "")).json(), { text: "siguiente" });
    assert.deepEqual(fake.log().filter((l) => l.stop), [], "a cancel is not a failure: the engine keeps running");
  });
});
