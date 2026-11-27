// A stand-in for whisper.cpp's whisper-server, installed where scripts/setup-whisper puts the real one:
// it listens where --host says (a unix socket when it ends in ".sock", as the pinned server.cpp does),
// answers /health and /inference, and logs what it was asked and a request closed before its answer.
import * as fs from "node:fs";
import * as path from "node:path";
import { tempHome } from "./helpers.ts";

/** What the stand-in does, read again at each request: a test changes it as it goes. */
export type FakeBehaviour = { text?: string; startDelayMs?: number; failStart?: string; crash?: boolean; ignoreTerm?: boolean; inferenceDelayMs?: number };
export type FakeLog = { at: number; start?: number; args?: string[]; cwd?: string; stop?: number; ignored?: number; closed?: number; inference?: Record<string, string | { size: number; type: string }> };

const SCRIPT = String.raw`
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const home = path.resolve(path.dirname(process.argv[1]), "../../..");
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const behaviour = () => JSON.parse(fs.readFileSync(path.join(home, "fake.json"), "utf8"));
const log = (entry) => fs.appendFileSync(path.join(home, "fake.log"), JSON.stringify({ at: Date.now(), ...entry }) + "\n");
log({ start: process.pid, args: process.argv.slice(2), cwd: process.cwd() });
const first = behaviour();
process.on("SIGTERM", () => (first.ignoreTerm ? log({ ignored: process.pid }) : (log({ stop: process.pid }), process.exit(0))));
if (first.failStart) {
  console.error("whisper_init_from_file_with_params_no_state: loading model");
  console.error(first.failStart);
  process.exit(3);
}
if (!fs.existsSync(arg("--model"))) (console.error("error: failed to initialize whisper context"), process.exit(3));
const host = arg("--host") ?? "127.0.0.1";
setTimeout(() => {
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") return res.end('{"status":"ok"}');
    if (req.method === "POST" && req.url === "/inference") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": req.headers["content-type"] } }).formData();
      const fields = {};
      for (const [k, v] of form) fields[k] = typeof v === "string" ? v : { size: v.size, type: v.type };
      log({ inference: fields });
      // The pinned server.cpp aborts an inference whose connection closed (its abort_callback).
      res.on("close", () => res.writableFinished || log({ closed: process.pid }));
      const now = behaviour();
      if (now.crash) process.exit(9);
      await new Promise((r) => setTimeout(r, now.inferenceDelayMs ?? 0));
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ text: now.text ?? " Haz commit.\n" }));
    }
    res.statusCode = 404;
    res.end("File Not Found (" + req.url + ")");
  });
  if (host.endsWith(".sock")) server.listen(host);
  else server.listen(Number(arg("--port") ?? 8080), host);
}, first.startDelayMs ?? 0);
`;

/** A whisper home with the stand-in and a model file in it; `behave` changes what it does from then on. */
export function fakeWhisper(behaviour: FakeBehaviour = {}): { home: string; behave: (b: FakeBehaviour) => void; log: () => FakeLog[] } {
  const home = tempHome();
  const bin = path.join(home, "whisper.cpp", "build", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(home, "models"));
  fs.writeFileSync(path.join(home, "models", "ggml-large-v3-turbo-q8_0.bin"), "not a model");
  fs.writeFileSync(path.join(bin, "whisper-server"), `#!${process.execPath}\n${SCRIPT}`, { mode: 0o755 });
  const behave = (b: FakeBehaviour) => fs.writeFileSync(path.join(home, "fake.json"), JSON.stringify(b));
  behave(behaviour);
  const log = () => {
    const file = path.join(home, "fake.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as FakeLog) : [];
  };
  return { home, behave, log };
}

/** A recording as the page makes it: 16-bit PCM WAV, `seconds` of a quiet tone. */
export function wav(seconds: number, { rate = 16_000, channels = 1 }: { rate?: number; channels?: number } = {}): Buffer {
  const samples = Math.round(seconds * rate) * channels;
  const out = Buffer.alloc(44 + samples * 2);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(36 + samples * 2, 4);
  out.write("WAVEfmt ", 8, "latin1");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "latin1");
  out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) out.writeInt16LE(Math.round(Math.sin(i / 8) * 3000), 44 + i * 2);
  return out;
}

/** Whether a process still runs (a child that exited and was reaped is gone). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH: it is gone
  }
}
