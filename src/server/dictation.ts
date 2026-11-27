// Dictation: what the developer records on the page, made text by a local speech engine the desk runs
// only while it is used. Nothing here knows which engine: that is its own module (whisper.ts).
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONTROL, InputError } from "../core/check.ts";
import { DICTATION_PROMPT_MAX, dictationPrompt, INVISIBLE } from "../core/model.ts";
import { isAlive, procInfo } from "../core/proc.ts";
import { ensureDir, isCode, readJson, writeJson } from "../store/fsx.ts";

/** What the desk asks of a speech engine. The audio and the text stay in memory: never written, never logged. */
export interface SpeechEngine {
  /** Whether it is installed: without it the page shows no mic and the desk works as before. A DictationError says why one installed cannot be used. */
  available(): boolean;
  /** How many tokens of a prompt it keeps; the page fits its prompt in them. */
  readonly promptTokens: number;
  /** The longest the desk waits on a warm-up and on a transcription before it says they failed: the page waits that and the way there. */
  readonly waitMs: { warm: number; transcribe: number };
  /** Starts it when it does not run, resolved once it can transcribe. */
  warm(): Promise<void>;
  /** The text spoken in a recording readWav accepted, with `prompt` (the words likely in it) to bias its spelling; given up when `cancel` aborts. */
  transcribe(wav: Buffer, prompt: string, cancel?: AbortSignal): Promise<string>;
  /** Stops it now if it runs. */
  stop(): void;
}

/** The engine failed or is not there: said to the page as it is, and the next press tries again. */
export class DictationError extends Error {
  override name = "DictationError";
}

/** No engine: what the desk uses unless it is given one (startServer finds the installed one). */
export const NO_SPEECH: SpeechEngine = {
  available: () => false,
  promptTokens: 0,
  waitMs: { warm: 0, transcribe: 0 },
  warm: () => Promise.reject(new DictationError(NOT_INSTALLED)),
  transcribe: () => Promise.reject(new DictationError(NOT_INSTALLED)),
  stop: () => {},
};
export const NOT_INSTALLED = "dictation is not installed on this computer; nothing was transcribed";

/** A recording as the page makes it: 16 kHz mono 16-bit PCM WAV, at most this long. */
export const DICTATION_SECONDS_MAX = 120;
const RATE = 16_000;
const HEADER_BYTES = 44;
export const WAV_BYTES_MAX = HEADER_BYTES + DICTATION_SECONDS_MAX * RATE * 2;

/** A recording checked to be what every engine is given: 16 kHz mono 16-bit PCM, some audio in it. */
export function readWav(body: Buffer): { seconds: number } {
  if (body.length < 12 || body.toString("latin1", 0, 4) !== "RIFF" || body.toString("latin1", 8, 12) !== "WAVE") throw new InputError("expected a WAV recording (RIFF/WAVE)");
  let format = false;
  for (let at = 12; at + 8 <= body.length; ) {
    const chunk = body.toString("latin1", at, at + 4);
    const size = body.readUInt32LE(at + 4);
    const start = at + 8;
    if (size > body.length - start) throw new InputError(`the WAV recording is cut short: its ${JSON.stringify(chunk)} chunk says ${size} bytes, ${body.length - start} came`);
    if (chunk === "fmt ") {
      if (size < 16) throw new InputError(`the WAV recording's format chunk holds ${size} bytes, at least 16 expected`);
      const [codec, channels, rate, bits] = [body.readUInt16LE(start), body.readUInt16LE(start + 2), body.readUInt32LE(start + 4), body.readUInt16LE(start + 14)];
      if (codec !== 1 || channels !== 1 || rate !== RATE || bits !== 16) throw new InputError(`expected 16 kHz mono 16-bit PCM, got codec ${codec}, ${channels} channels, ${rate} Hz, ${bits} bits`);
      format = true;
    } else if (chunk === "data") {
      if (!format) throw new InputError("the WAV recording's audio comes before its format");
      if (size < 2) throw new InputError("the recording is empty: nothing was heard");
      return { seconds: size / (RATE * 2) };
    }
    at = start + size + (size % 2);
  }
  throw new InputError("the WAV recording holds no audio");
}

/** A transcript as one line of what was said: line breaks become spaces, control and invisible characters go. */
export function oneLine(text: string): string {
  return text
    .replace(new RegExp(CONTROL.source, "gu"), " ")
    .replace(new RegExp(INVISIBLE.source, "gu"), "")
    .replace(/\s+/g, " ")
    .trim();
}


/** The most a dictation's request body holds: the longest recording, the longest prompt, and the form's own lines around them. */
export const DICTATION_BODY_MAX = WAV_BYTES_MAX + DICTATION_PROMPT_MAX * 4 + 4096;

/** A dictation as the page posts it, multipart/form-data: the recording in `audio` (a WAV file), the words likely in it in `prompt`. */
export async function readDictation(form: FormData): Promise<{ wav: Buffer; prompt: string }> {
  for (const name of new Set(form.keys())) {
    if (name !== "audio" && name !== "prompt") throw new InputError(`the dictation's form holds an unknown field ${JSON.stringify(name).slice(0, 40)}; expected audio and prompt`);
    if (form.getAll(name).length !== 1) throw new InputError(`the dictation's form holds ${name} more than once`);
  }
  const audio = form.get("audio");
  if (audio === null || typeof audio === "string") throw new InputError("the dictation's form holds no recording: expected a WAV file in its audio field");
  if (!/^audio\/(?:wav|x-wav|wave)$/.test(audio.type)) throw new InputError(`the recording is ${JSON.stringify(audio.type)}; expected audio/wav`);
  if (audio.size > WAV_BYTES_MAX) throw new InputError(`the recording holds ${audio.size} bytes, more than ${WAV_BYTES_MAX} (${DICTATION_SECONDS_MAX} s)`);
  const prompt = form.get("prompt") ?? "";
  if (typeof prompt !== "string") throw new InputError("the dictation's prompt is a file; expected text");
  return { wav: Buffer.from(await audio.arrayBuffer()), prompt: dictationPrompt(prompt, "prompt") };
}

export type ChildCommand = { file: string; args: string[]; cwd: string };
export type OnDemandOptions = {
  /** Stopped after this long without a call. */
  idleMs: number;
  /** Given up, and stopped, when not ready by then (a model loads in seconds; a first GPU start takes longer). */
  readyMs: number;
  pollMs: number;
  /** Killed when SIGTERM has not stopped it by then. */
  killMs: number;
  /** A call's work given up, and the server stopped, when it has not answered by then (two minutes of speech take seconds on a GPU). */
  answerMs: number;
};
export const ON_DEMAND: OnDemandOptions = { idleMs: 5 * 60_000, readyMs: 120_000, pollMs: 150, killMs: 10_000, answerMs: 120_000 };
/** How long a process takes to be gone once SIGKILL is sent: one still there is stuck in the kernel (a GPU driver call). */
const EXIT_MS = 2000;
/** A unix socket's path holds at most 107 bytes on Linux (sun_path, with its NUL). */
const SOCKET_PATH_MAX = 107;

type Running = { child: ChildProcess; exited: Promise<void>; why: () => string };
/** A process as /proc tells it apart from a later one given the same pid. */
type Process = { pid: number; start: string };
/** The process a desk started, and that desk, as its pid file records them: a desk ended by SIGKILL leaves it running. */
type Recorded = Process & { desk: Process };

const seconds = (ms: number) => `${+(ms / 1000).toFixed(1)} s`;
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether `promise` settled within `ms`. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([promise.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A directory only this user reaches (0700): what listens in it is reached by nobody else. */
function privateDir(dir: string): void {
  ensureDir(dir);
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) throw new DictationError(`${dir} is not a directory of this user: remove it, and the desk makes it again`);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

/**
 * A local server the desk runs as its own child only while it is used, listening on a unix socket in a
 * directory only this user reaches: the first call starts it (an argument list, no shell), calls meanwhile
 * share it, it stops `idleMs` after the last one ends, and a call after it stopped or failed starts it
 * again. One at most: the next waits for the last to exit, and ends one a previous desk left running.
 */
export class OnDemandServer {
  private starting: Promise<Running> | undefined;
  private current: Running | undefined;
  private dying: { exited: Promise<void>; pid: number | undefined } = { exited: Promise.resolve(), pid: undefined };
  /** Counts the stops: a start that sees it change was stopped meanwhile. */
  private stops = 0;
  private busy = 0;
  private idle: NodeJS.Timeout | undefined;
  private readonly name: string;
  private readonly socket: string;
  private readonly pidFile: string;
  private readonly command: (socket: string) => ChildCommand;
  private readonly ready: (socket: string, signal: AbortSignal) => Promise<boolean>;
  private readonly options: OnDemandOptions;

  /** `socket`: the path it listens on; `ready`: whether it answers as ready there, false (or a refused connection) while it loads. */
  constructor(spec: { name: string; socket: string; command: (socket: string) => ChildCommand; ready: (socket: string, signal: AbortSignal) => Promise<boolean>; options?: OnDemandOptions }) {
    this.name = spec.name;
    this.socket = spec.socket;
    this.pidFile = `${spec.socket}.pid`;
    this.command = spec.command;
    this.ready = spec.ready;
    this.options = spec.options ?? ON_DEMAND;
  }

  /** The longest a call waits to start it: the last one's exit, one a previous desk left, then its readiness. */
  get startMs(): number {
    return 2 * (this.options.killMs + EXIT_MS) + this.options.readyMs;
  }

  get answerMs(): number {
    return this.options.answerMs;
  }

  /**
   * `work` against the server's socket, started first when it does not run, given up after `answerMs` or
   * when `cancel` aborts (the caller left: the server stops a request whose connection closes). A
   * DictationError from `work` is the server's own answer; any other failure means it did not answer, so
   * it is stopped for the next call to start afresh.
   */
  async use<T>(work: (socket: string, signal: AbortSignal) => Promise<T>, cancel?: AbortSignal): Promise<T> {
    this.busy++;
    clearTimeout(this.idle);
    try {
      const starting = (this.starting ??= this.start());
      const running = await starting.catch((error: unknown) => {
        // Failed: the next call starts it again, unless one already does.
        if (this.starting === starting) this.starting = undefined;
        throw error;
      });
      const late = AbortSignal.timeout(this.options.answerMs);
      try {
        return await work(this.socket, cancel ? AbortSignal.any([late, cancel]) : late);
      } catch (error) {
        if (error instanceof DictationError) throw error;
        if (cancel?.aborted) throw new DictationError(`the call was cancelled before ${this.name} answered`);
        // Its connection may break a moment before its exit is known.
        const exited = await within(running.exited, 500);
        if (!exited) this.stopRunning(running);
        if (exited) throw new DictationError(`${this.name} stopped while transcribing (${running.why()}); press the mic again to start it`);
        throw new DictationError(`${this.name} did not answer ${late.aborted ? `within ${seconds(this.options.answerMs)}` : `(${reason(error)})`}; it was stopped, press the mic again to start it`);
      }
    } finally {
      if (--this.busy === 0) {
        this.idle = setTimeout(() => this.stop(), this.options.idleMs);
        this.idle.unref();
      }
    }
  }

  /** The child's pid while it runs, for tests. */
  pid(): number | undefined {
    return this.current?.child.pid;
  }

  /** Stops it now, also while it starts. */
  stop(): void {
    clearTimeout(this.idle);
    this.stops++;
    this.starting = undefined;
    if (this.current) this.stopRunning(this.current);
  }

  private stopRunning(running: Running): void {
    if (this.current !== running) return;
    this.current = undefined;
    this.starting = undefined;
    running.child.kill("SIGTERM");
    const hard = setTimeout(() => running.child.kill("SIGKILL"), this.options.killMs);
    hard.unref();
    this.dying = { exited: running.exited.then(() => clearTimeout(hard)), pid: running.child.pid };
  }

  private async start(): Promise<Running> {
    const stops = this.stops;
    const stopped = () => new DictationError(`${this.name} was stopped before it was ready; press the mic again to start it`);
    const bound = this.options.killMs + EXIT_MS;
    if (!(await within(this.dying.exited, bound))) throw new DictationError(`${this.name} (pid ${this.dying.pid}) has not exited ${seconds(bound)} after it was stopped; end it, then press the mic again`);
    if (Buffer.byteLength(this.socket) > SOCKET_PATH_MAX) throw new DictationError(`the speech engine's socket ${this.socket} is longer than the ${SOCKET_PATH_MAX} bytes a unix socket takes: set AGENT_DESK_HOME to a shorter path`);
    privateDir(path.dirname(this.socket));
    const { file, args, cwd } = this.command(this.socket);
    await this.endLeftOver(args);
    if (this.stops !== stops) throw stopped();
    // A socket left by one that did not exit cleanly: binding would fail on it, and nothing must answer there but this child.
    fs.rmSync(this.socket, { force: true });
    // Its output tells nothing of the audio or its text (no realtime printing): only the last lines are kept, to say why it failed.
    const child = spawn(file, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    child.stderr?.on("data", (d: Buffer) => (tail = (tail + d.toString("utf8")).slice(-4000)));
    let end = "";
    const exited = new Promise<void>((resolve) => {
      child.once("error", (error) => ((end ||= error.message), resolve()));
      child.once("exit", (code, signal) => ((end ||= code === null ? `stopped by ${signal}` : `exit code ${code}`), resolve()));
    });
    const why = () => {
      const last = tail.split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" / ");
      return last ? `${end}: ${last}` : end;
    };
    const running: Running = { child, exited, why };
    this.current = running;
    let recorded: Recorded | undefined;
    try {
      recorded = this.record(child.pid);
    } catch (error) {
      // Unrecorded, a desk killed later would leave it running for good, and the next start would spawn a second one.
      this.stopRunning(running);
      throw new DictationError(`${this.name} was stopped at its start: ${this.pidFile} could not be written (${reason(error)}); fix that, then press the mic again`);
    }
    void exited.then(() => {
      if (recorded) this.forget(recorded);
      if (this.current === running) {
        this.current = undefined;
        this.starting = undefined;
      }
    });
    let gone = false;
    void exited.then(() => (gone = true));
    const deadline = Date.now() + this.options.readyMs;
    for (;;) {
      if (this.stops !== stops) throw stopped();
      if (gone) throw new DictationError(`${this.name} could not start (${why()})`);
      if (Date.now() > deadline) {
        this.stopRunning(running);
        throw new DictationError(`${this.name} was not ready within ${seconds(this.options.readyMs)}; it was stopped, press the mic again to try again`);
      }
      // Refused (or no socket yet) until it listens, which it does once its model is loaded: that is the wait itself.
      if (await this.ready(this.socket, AbortSignal.timeout(2000)).catch(() => false)) {
        if (this.stops !== stops) throw stopped();
        return running;
      }
      await new Promise((r) => setTimeout(r, this.options.pollMs));
    }
  }

  /** The child written down, so that a desk started after this one was killed can end it. */
  private record(pid: number | undefined): Recorded | undefined {
    const start = pid === undefined ? undefined : procInfo(pid)?.start;
    const desk = procInfo(process.pid)?.start;
    if (pid === undefined || start === undefined || desk === undefined) return undefined; // not started, or no /proc: nothing to end later
    const recorded: Recorded = { pid, start, desk: { pid: process.pid, start: desk } };
    writeJson(this.pidFile, recorded);
    return recorded;
  }

  /** Its record removed at its exit, only while the file still holds it: another is not this one's to remove. */
  private forget(recorded: Recorded): void {
    let now: string;
    try {
      now = fs.readFileSync(this.pidFile, "utf8");
    } catch (error) {
      if (isCode(error, "ENOENT")) return; // already removed
      throw error;
    }
    if (now === `${JSON.stringify(recorded, null, 2)}\n`) fs.rmSync(this.pidFile, { force: true }); // as writeJson wrote it
  }

  private recorded(): Recorded | undefined {
    const value = readJson(this.pidFile);
    if (value === undefined) return undefined;
    const proc = (v: unknown): Process | undefined => {
      const { pid, start } = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
      return typeof pid === "number" && Number.isInteger(pid) && pid > 1 && typeof start === "string" ? { pid, start } : undefined;
    };
    const engine = proc(value);
    const desk = proc(typeof value === "object" && value !== null ? (value as Record<string, unknown>).desk : undefined);
    if (!engine || !desk) throw new DictationError(`${this.pidFile} is not a pid file the desk wrote (${JSON.stringify(value).slice(0, 80)}): remove it, then press the mic again`);
    return { ...engine, desk };
  }

  /**
   * Ends the server a previous desk started and left running (that desk was killed): only a process with the
   * pid and start time it recorded, started with these very arguments (this store's socket among them), and
   * only once that desk is gone. One still running otherwise is said, never signalled, and its record kept.
   */
  private async endLeftOver(args: string[]): Promise<void> {
    const left = this.recorded();
    if (!left) return;
    if (isAlive(left.pid, left.start)) {
      const self = left.desk.pid === process.pid && left.desk.start === procInfo(process.pid)?.start;
      if (!self && isAlive(left.desk.pid, left.desk.start)) throw new DictationError(`${this.name} (pid ${left.pid}) is run by another desk on this store (pid ${left.desk.pid}): dictate from that desk, or stop it, then press the mic again`);
      if (!startedWith(left.pid, args)) throw new DictationError(`${this.pidFile} names pid ${left.pid}, which still runs but with other arguments than this desk gives ${this.name} (${args.join(" ")}): end it if a previous desk left it, then remove that file and press the mic again`);
      signal(left.pid, "SIGTERM");
      if (!(await this.gone(left, this.options.killMs))) {
        signal(left.pid, "SIGKILL");
        if (!(await this.gone(left, EXIT_MS))) throw new DictationError(`${this.name} a previous desk left running (pid ${left.pid}) does not end: end it, then press the mic again`);
      }
    }
    fs.rmSync(this.pidFile, { force: true });
  }

  private async gone(p: Process, ms: number): Promise<boolean> {
    for (const end = Date.now() + ms; isAlive(p.pid, p.start); ) {
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, Math.min(this.options.pollMs, 50)));
    }
    return true;
  }
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (!isCode(error, "ESRCH")) throw error; // ESRCH: it ended meanwhile, as asked
  }
}

/** Whether pid's command line ends with `args` (a script's interpreter comes first). */
function startedWith(pid: number, args: string[]): boolean {
  let cmdline: string;
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT") || isCode(error, "ESRCH")) return false; // gone meanwhile
    throw error;
  }
  const argv = cmdline.split("\0").slice(0, -1);
  return argv.length >= args.length && args.every((a, i) => argv[argv.length - args.length + i] === a);
}
