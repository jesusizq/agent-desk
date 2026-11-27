import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { MachineSources } from "../src/core/machine.ts";
import type { SpeechEngine } from "../src/server/dictation.ts";
import { createDeskServer } from "../src/server/server.ts";
import { Store } from "../src/store/store.ts";

export function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-desk-test-"));
}

/** A store with a clock that advances one second per call, so ordering is deterministic. */
export function testStore(home = tempHome()): Store {
  let t = Date.parse("2026-10-28T08:00:00.000Z");
  return new Store(home, () => new Date((t += 1000)));
}

export function addSession(store: Store, id = "s1"): void {
  store.upsertSession({ id, provider: "Test", project: { name: "shop", dir: "/work/shop" } });
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
export const gitIn = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { env: GIT_ENV }).toString();
const commitIn = (dir: string, file: string, message: string) => {
  fs.writeFileSync(path.join(dir, file), `${message}\n`);
  gitIn(dir, "add", file);
  gitIn(dir, "commit", "-qm", message);
};

/**
 * `shop` (main, no upstream) with an agent worktree per way a branch lands: `merged` by a merge,
 * `picked` (2 commits) and `dirty` (then an untracked file) and `moved` by cherry-pick, `partly`
 * with 1 of its 2 commits picked; main also moves on by a commit of its own.
 */
export function landedRepo() {
  const root = fs.realpathSync(tempHome());
  const main = path.join(root, "shop");
  fs.mkdirSync(main);
  gitIn(main, "init", "-q", "-b", "main");
  commitIn(main, "a.txt", "first");
  const names = ["merged", "picked", "partly", "dirty", "moved"] as const;
  const wt = Object.fromEntries(names.map((n) => [n, path.join(main, ".claude", "worktrees", n)])) as Record<(typeof names)[number], string>;
  for (const n of names) {
    gitIn(main, "worktree", "add", "-q", "-b", `agent/${n}`, wt[n]);
    commitIn(wt[n], `${n}-1.txt`, `${n} one`);
  }
  commitIn(wt.picked, "picked-2.txt", "picked two");
  commitIn(wt.partly, "partly-2.txt", "partly two");
  commitIn(main, "m.txt", "main moves on");
  gitIn(main, "merge", "-q", "--no-ff", "-m", "Merge agent/merged", "agent/merged");
  gitIn(main, "cherry-pick", "agent/picked~1", "agent/picked", "agent/partly~1", "agent/dirty", "agent/moved");
  fs.writeFileSync(path.join(wt.dirty, "notes.txt"), "not committed\n");
  return { root, main, wt };
}

// Smallest valid PNG header; the store only checks the signature.
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** A shell script, in a folder of its own, that says it is waiting and waits until its input closes. */
export function waitingScript(name: string): string {
  const file = path.join(tempHome(), name);
  fs.writeFileSync(file, "#!/bin/sh\necho waiting\nread line\n", { mode: 0o755 });
  return file;
}

/**
 * A shell this process starts, as a session runs a command, running `script` in `cwd`, once it waits:
 * through its shebang (/proc shows `/bin/sh <script>`), or given to the shell command `through`
 * (`["sh", "-o", "errexit"]`: /proc shows that command line with the script last).
 */
export async function runScript(script: string, cwd: string, through: readonly string[] = []): Promise<{ end: () => Promise<void> }> {
  const child = spawn("sh", ["-c", `${through.map((a) => `${a} `).join("")}"${script}"; true`], { cwd, stdio: ["pipe", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`${script} exited (${code}) before it waited`)));
  });
  let ended: Promise<void> | undefined;
  return {
    // Its input closed, the script ends, then its shell, which has reaped it by then.
    end: () =>
      (ended ??= (async () => {
        const exited = once(child, "exit");
        child.stdin.end();
        await exited;
      })()),
  };
}

/** A machine without any of the files its health is read from: the desk warns of nothing, however loaded the one running the tests is. */
export const QUIET_MACHINE: MachineSources = { proc: tempHome(), sys: tempHome(), cores: 1 };

/** A desk server for the store on a free local port. */
export async function serve(store: Store, remote?: Parameters<typeof createDeskServer>[2], feed?: Parameters<typeof createDeskServer>[3], machine = QUIET_MACHINE, speech?: SpeechEngine): Promise<{ base: string; port: number; close: () => Promise<void> }> {
  // Bind first to learn a free port, then build the server for that port (it checks Host against it).
  const probe = createDeskServer(store, 0, remote, feed, machine);
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const real = createDeskServer(store, port, remote, feed, machine, speech);
  await new Promise<void>((r) => real.listen(port, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${port}`, port, close: () => new Promise((r) => (real.close(() => r()), real.closeAllConnections())) };
}

/**
 * A throwaway local server run as a session runs one: a shell this process starts runs `node serve.mjs`,
 * which listens on `host` (a free port) until it is stopped.
 */
export async function shellListener(host = "127.0.0.1", throughShell = true): Promise<{ port: number; pid: number; stop: () => Promise<void> }> {
  const dir = tempHome();
  const script = path.join(dir, "serve.mjs");
  fs.writeFileSync(script, `import { createServer } from "node:http";\nconst s = createServer((_q, r) => r.end("ok")).listen(0, ${JSON.stringify(host)}, () => console.log(\`\${process.pid} \${s.address().port}\`));\n`);
  // "& wait" keeps the shell as the server's parent, as a shell that runs a server in the background does.
  const child = throughShell ? spawn("sh", ["-c", `"${process.execPath}" "${script}" & wait`], { stdio: ["ignore", "pipe", "inherit"] }) : spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
  const line = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d;
      if (out.includes("\n")) resolve(out.trim());
    });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`the listener exited (${code}) before it listened`)));
  });
  const [pid, port] = line.split(" ").map(Number);
  if (!pid || !port) throw new Error(`unexpected listener output ${JSON.stringify(line)}`);
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  let stopping: Promise<void> | undefined;
  // Idempotent, so a test can stop it midway and again in its `finally`.
  const stop = () => (stopping ??= (process.kill(pid, "SIGTERM"), exited));
  return { port, pid, stop };
}
