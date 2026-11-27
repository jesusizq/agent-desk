// whisper.cpp's whisper-server as the desk's speech engine: where scripts/setup-whisper installs it, how
// it is started and asked. The only module that knows it; the rest of the desk sees a SpeechEngine.
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { isCode } from "../store/fsx.ts";
import { DictationError, ON_DEMAND, OnDemandServer, type OnDemandOptions, oneLine, type SpeechEngine } from "./dictation.ts";

export const WHISPER_MODEL = "ggml-large-v3-turbo-q8_0.bin";
/** Whisper keeps half its 448-token text context for the prompt, its last tokens when longer. */
const PROMPT_TOKENS = 224;
/** An answer is a transcript of two minutes at most: anything longer is not one. */
const ANSWER_BYTES_MAX = 1_000_000;

/** Where scripts/setup-whisper installs it (AGENT_DESK_WHISPER_HOME, by default under ~/.local/share). */
export function whisperHome(env: NodeJS.ProcessEnv): string {
  const override = env.AGENT_DESK_WHISPER_HOME;
  if (!override) return path.join(os.homedir(), ".local", "share", "agent-desk-whisper");
  if (!path.isAbsolute(override)) throw new Error(`AGENT_DESK_WHISPER_HOME must be an absolute path, got ${JSON.stringify(override)}`);
  return override;
}

/**
 * The engine installed in `home`, started only while dictation is used, listening on a unix socket in
 * `runDir` (the store's own, 0700): no other user and no web page can reach it, and no port can be taken
 * from it while its model loads.
 */
export function whisperEngine(home: string, runDir: string, options: OnDemandOptions = ON_DEMAND): SpeechEngine & { pid(): number | undefined } {
  const binary = path.join(home, "whisper.cpp", "build", "bin", "whisper-server");
  const model = path.join(home, "models", WHISPER_MODEL);
  const server = new OnDemandServer({
    name: "the speech engine (whisper-server)",
    // A --host ending in ".sock" is a unix socket's path. Its default public folder (examples/server/public) is relative to the working directory, absent from `home`: it serves no files.
    socket: path.join(runDir, "whisper.sock"),
    command: (socket) => ({ file: binary, args: ["--model", model, "--host", socket], cwd: home }),
    ready: async (socket, signal) => (await ask(socket, "GET", "/health", undefined, signal)).status === 200, // 503 while its model loads
    options,
  });
  return {
    available: () => installed(binary, fs.constants.X_OK) && installed(model, fs.constants.R_OK),
    promptTokens: PROMPT_TOKENS,
    waitMs: { warm: server.startMs, transcribe: server.startMs + server.answerMs },
    warm: () => server.use(async () => {}),
    transcribe: (wav, prompt, cancel) =>
      server.use(async (socket, signal) => {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "dictation.wav");
        // Auto-detected: Spanish with English terms, or English. Greedy at 0, falling back as whisper does; no timestamps in the text.
        // Silence: whisper.cpp already drops a segment whose no-speech probability passes 0.6 (its default); suppress_nst would also drop the symbols a developer dictates (# / _ ( ) [ ]).
        for (const [k, v] of [["language", "auto"], ["prompt", prompt], ["response_format", "json"], ["temperature", "0.0"], ["no_timestamps", "true"]] as const) form.append(k, v);
        const request = new Request("http://whisper/", { method: "POST", body: form });
        const res = await ask(socket, "POST", "/inference", { type: request.headers.get("content-type") ?? "", data: Buffer.from(await request.arrayBuffer()) }, signal);
        const body = parsed(res.body);
        const answer = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
        if (res.status !== 200) throw new DictationError(`the speech engine refused the recording: ${res.status} ${typeof answer.error === "string" ? answer.error : ""}`.trim());
        if (typeof answer.text !== "string") throw new DictationError(`the speech engine answered without a transcript (${res.status})`);
        return transcript(answer.text);
      }, cancel),
    stop: () => server.stop(),
    pid: () => server.pid(),
  };
}

/** One HTTP request to the server on its unix socket, its whole answer read. */
function ask(socket: string, method: string, route: string, body: { type: string; data: Buffer } | undefined, signal: AbortSignal): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers = body ? { "content-type": body.type, "content-length": String(body.data.length) } : {};
    // No pooled connection (agent: false): one kept alive would still reach a previous server whose socket path was replaced.
    const req = http.request({ socketPath: socket, method, path: route, headers, signal, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > ANSWER_BYTES_MAX) req.destroy(new Error(`its answer is longer than ${ANSWER_BYTES_MAX} bytes`));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on("close", () => res.complete || reject(new Error("its answer was cut short")));
    });
    req.on("error", reject);
    req.end(body?.data);
  });
}

/** Its JSON answer, or nothing when it is not JSON (an error page). */
function parsed(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined; // said by the caller: no transcript in it
    throw error;
  }
}

/** Whisper's text, a line per segment, without the segments that only name a sound ("[BLANK_AUDIO]", "(music)"). */
export function transcript(text: string): string {
  return oneLine(
    text
      .split("\n")
      .filter((segment) => !/^\s*(\[[^\]]*\]|\([^)]*\))\s*$/.test(segment))
      .join(" "),
  );
}

/** Whether `file` is installed and usable as `mode` asks; only its absence is silent, anything else is said. */
function installed(file: string, mode: number): boolean {
  try {
    fs.accessSync(file, mode);
  } catch (error) {
    if (isCode(error, "ENOENT")) return false; // not installed: the desk works without dictation
    throw new DictationError(`dictation is installed but cannot use ${file} (${error instanceof Error ? error.message : String(error)}): fix its permissions, or run scripts/setup-whisper again`);
  }
  if (!fs.statSync(file).isFile()) throw new DictationError(`dictation is installed but ${file} is not a file: run scripts/setup-whisper again`);
  return true;
}
