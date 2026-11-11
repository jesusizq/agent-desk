// Local servers a session started: TCP ports listening in its own process tree, read from /proc on Linux.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isCode } from "../store/fsx.ts";
import { createHash } from "node:crypto";
import { readService, type Service, type Session } from "./model.ts";
import { procInfo, type ProcInfo, sessionFinished, SHELLS } from "./proc.ts";

/** A port listening in a session's processes, with the local URL that reaches it. */
export type Listener = { port: number; url: string; pid: number; name: string; startedAt: string };

/** userspace clock ticks per second in /proc: USER_HZ, fixed at 100 on Linux whatever the kernel's own rate. */
const USER_HZ = 100;
const LISTEN = "0A";
const NAME_MAX = 80;
const LITTLE_ENDIAN = os.endianness() === "LE";

/**
 * For each session process, the TCP ports in LISTEN state held by the processes it started through a
 * shell (the commands it ran, and theirs), each once, reachable on this machine's loopback. A direct
 * child that is no shell (a tool server the provider runs for itself) is left out, and so is a
 * process that left the tree (one started with `nohup … &` belongs to the init process once its shell
 * exits). Reads only /proc; none for a process that is gone or, by its start time, no longer the one
 * recorded.
 */
export function sessionListeners(roots: readonly { pid: number; start?: string }[]): Listener[][] {
  const live = roots.map((r) => {
    const info = procInfo(r.pid);
    return info !== undefined && (r.start === undefined || info.start === r.start);
  });
  if (!live.some(Boolean)) return roots.map(() => []);
  const sockets = listeningSockets();
  const bootMs = sockets.size === 0 ? 0 : bootTime();
  return roots.map((root, i) => {
    if (!live[i] || sockets.size === 0) return [];
    const found = new Map<number, Listener>();
    for (const proc of startedThroughShell(root.pid)) {
      if (notAServer(commandLine(proc.pid) ?? [])) continue;
      for (const inode of socketInodes(proc.pid)) {
        const socket = sockets.get(inode);
        if (!socket || found.has(socket.port)) continue;
        found.set(socket.port, {
          port: socket.port,
          url: `http://${socket.host}:${socket.port}/`,
          pid: proc.pid,
          name: processName(proc),
          startedAt: new Date(bootMs + (Number(proc.start) / USER_HZ) * 1000).toISOString(),
        });
      }
    }
    return [...found.values()].sort((a, b) => a.port - b.port);
  });
}

/**
 * The services the page shows: each running session's listening ports (src/core/ports.ts), under the
 * name and path the session gave one with `agent-desk service`; a named one that was found listening
 * goes when its port closes, and one the desk cannot see stays until the session stops it.
 */
export function liveServices(stored: Service[], sessions: Session[], problems: string[]): Service[] {
  const running = sessions.filter((s): s is Session & { process: NonNullable<Session["process"]> } => s.process !== undefined && !sessionFinished(s));
  let found: ReturnType<typeof sessionListeners>;
  try {
    found = sessionListeners(running.map((s) => s.process));
  } catch (error) {
    problems.push(`local servers of the sessions: ${(error as Error).message}`);
    return stored.filter((v) => !v.detected);
  }
  const listening = new Map(running.map((s, i) => [s.id, found[i] ?? []]));
  const named = stored.filter((v) => !v.detected || listening.get(v.sessionId)?.some((l) => l.port === urlPort(v.url)));
  const detected = [...listening].flatMap(([sessionId, listeners]) =>
    listeners
      .filter((l) => !stored.some((v) => v.sessionId === sessionId && urlPort(v.url) === l.port))
      .map((l) => readService({ id: `port-${l.port}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`, sessionId, name: l.name, url: l.url, startedAt: l.startedAt, detected: true }, `local server on port ${l.port}`)),
  );
  return [...named, ...detected];
}

/** The port a local URL reaches. */
export function urlPort(url: string): number {
  const u = new URL(url);
  return Number(u.port || (u.protocol === "https:" ? 443 : 80));
}

/**
 * The descendants of `pid` reached through a direct child that is a shell, nearest first: the commands
 * a session (or its agents) ran. A process `skip` refuses is left out with everything under it.
 */
export function startedThroughShell(pid: number, skip?: (proc: ProcInfo) => boolean): ProcInfo[] {
  const out: ProcInfo[] = [];
  const queue = childrenOf(pid).filter((c) => SHELLS.has(c.name));
  const seen = new Set<number>();
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next.pid)) continue;
    seen.add(next.pid);
    if (skip?.(next)) continue;
    out.push(next);
    queue.push(...childrenOf(next.pid));
  }
  return out;
}

/**
 * A process's children, from /proc/<pid>/task/<tid>/children: only the tree's own files are read. A
 * process gone meanwhile has none.
 */
function childrenOf(pid: number): ProcInfo[] {
  let threads: string[];
  try {
    threads = fs.readdirSync(`/proc/${pid}/task`);
  } catch (error) {
    if (isCode(error, "ENOENT") || isCode(error, "ESRCH")) return []; // exited while the tree was read
    throw error;
  }
  const pids = new Set<number>();
  for (const tid of threads) {
    let list: string;
    try {
      list = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8");
    } catch (error) {
      if (!isCode(error, "ENOENT") && !isCode(error, "ESRCH")) throw error;
      if (fs.existsSync(`/proc/${pid}/task/${tid}`)) throw new Error(`/proc/${pid}/task/${tid}/children is missing: this kernel lists no children (CONFIG_PROC_CHILDREN), so the desk cannot find the sessions' servers`);
      continue; // the thread ended while it was read
    }
    for (const child of list.trim().split(/\s+/)) if (/^\d+$/.test(child)) pids.add(Number(child));
  }
  return [...pids].flatMap((child) => procInfo(child) ?? []);
}

/** Inodes of the sockets a process holds open, from the links in /proc/<pid>/fd. */
function socketInodes(pid: number): string[] {
  let fds: string[];
  try {
    fds = fs.readdirSync(`/proc/${pid}/fd`);
  } catch (error) {
    // Gone since the tree was read, or another user's (a sudo child): no ports of the session to show.
    if (isCode(error, "ENOENT") || isCode(error, "ESRCH") || isCode(error, "EACCES")) return [];
    throw error;
  }
  const inodes: string[] = [];
  for (const fd of fds) {
    let link: string;
    try {
      link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch (error) {
      if (isCode(error, "ENOENT") || isCode(error, "ESRCH")) continue; // closed while it was read
      throw error;
    }
    const m = /^socket:\[(\d+)\]$/.exec(link);
    if (m?.[1]) inodes.push(m[1]);
  }
  return inodes;
}

/** Listening TCP sockets by inode, with the host a local URL reaches them on; ports bound elsewhere are left out. */
function listeningSockets(): Map<string, { port: number; host: string }> {
  const out = new Map<string, { port: number; host: string }>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let table: string;
    try {
      table = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (isCode(error, "ENOENT")) continue; // a kernel without IPv6
      throw error;
    }
    for (const row of table.split("\n").slice(1)) {
      const cols = row.trim().split(/\s+/);
      const [local, , state] = cols.slice(1, 4);
      const inode = cols[9];
      if (state !== LISTEN || !local || !inode || inode === "0") continue;
      const [address, portHex] = local.split(":");
      const port = Number.parseInt(portHex ?? "", 16);
      const host = address === undefined ? undefined : localHost(address);
      if (host === undefined || !Number.isInteger(port) || port < 1 || port > 65535) continue;
      out.set(inode, { port, host });
    }
  }
  return out;
}

/**
 * The host of a local URL that reaches an address of /proc/net/tcp{,6} (hex, each 32-bit word in the
 * host's byte order): "localhost" for every address and for ::1, "127.0.0.1" for that one alone;
 * undefined for any other, which a local URL cannot name.
 */
export function localHost(hex: string): string | undefined {
  if (!/^(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{32})$/.test(hex)) return undefined;
  const bytes = Buffer.from(hex, "hex");
  const words = Array.from({ length: bytes.length / 4 }, (_, i) => (LITTLE_ENDIAN ? bytes.readUInt32LE(i * 4) : bytes.readUInt32BE(i * 4)));
  const v4 = (n: number | undefined) => (n === 0 ? "localhost" : n === 0x7f000001 ? "127.0.0.1" : undefined);
  if (words.length === 1) return v4(words[0]);
  const [a, b, c, d] = words;
  if (a !== 0 || b !== 0) return undefined;
  if (c === 0 && (d === 0 || d === 1)) return "localhost"; // :: and ::1
  return c === 0xffff ? v4(d) : undefined; // ::ffff:a.b.c.d
}

/** When the machine booted, in ms since the epoch (`btime` of /proc/stat). */
function bootTime(): number {
  const m = /^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"));
  if (!m?.[1]) throw new Error("/proc/stat: no btime line");
  return Number(m[1]) * 1000;
}

const BROWSER = /^(?:chrome|chromium(?:-browser)?|google-chrome(?:-\w+)?|headless_shell|chrome-headless-shell|firefox|msedge|webkit\w*)$/i;

/** A browser a test drives or a debugger port: it listens, but there is nothing in it to open. */
export function notAServer(args: readonly string[]): boolean {
  const [first] = args;
  if (first !== undefined && BROWSER.test(path.basename(first))) return true;
  return args.some((a) => a.startsWith("--remote-debugging-port") || a.startsWith("--inspect"));
}

const INTERPRETER = /^(?:node|nodejs|bun|deno|python[\d.]*|ruby|php|perl)$/;
const SCRIPT_EXT = /\.(?:[cm]?js|ts|py|rb|php|pl)$/;
const WORD = /^[A-Za-z][\w:.-]*$/;

/** What a server is called after its command line: "vite", "next dev", "python3 -m http.server". */
export function processName(proc: ProcInfo): string {
  return commandName(commandLine(proc.pid) ?? []) || proc.name;
}

/** A process's arguments, from /proc/<pid>/cmdline; undefined once it has exited. */
export function commandLine(pid: number): string[] | undefined {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch (error) {
    if (isCode(error, "ENOENT") || isCode(error, "ESRCH")) return undefined; // exited while it was read
    throw error;
  }
}

export function commandName(args: string[]): string {
  const [first, ...rest] = args;
  if (first === undefined) return "";
  const program = path.basename(first);
  let name = program;
  let words = rest;
  if (INTERPRETER.test(program)) {
    if (rest[0] === "-m" && rest[1] !== undefined) {
      name = `${program} -m ${rest[1]}`;
      words = rest.slice(2);
    } else {
      const at = rest.findIndex((a) => !a.startsWith("-"));
      const script = rest[at];
      if (script !== undefined) {
        name = scriptName(script);
        words = rest.slice(at + 1);
      }
    }
  }
  const sub = [];
  for (const w of words) {
    if (!WORD.test(w) || sub.length === 2) break;
    sub.push(w);
  }
  const whole = [name, ...sub].join(" ").replace(/\p{Cc}+/gu, " ").trim();
  return whole.length > NAME_MAX ? `${whole.slice(0, NAME_MAX - 1)}…` : whole;
}

/** A script's name: the command or package it belongs to inside node_modules, else its file name. */
function scriptName(script: string): string {
  const at = script.lastIndexOf("node_modules/");
  if (at >= 0) {
    const [scope, pkg, file] = script.slice(at + "node_modules/".length).split("/");
    if (scope === ".bin" && pkg) return pkg;
    if (scope?.startsWith("@") && pkg) return `${scope}/${pkg}`;
    if (scope && (pkg !== undefined || file !== undefined)) return scope;
  }
  return path.basename(script).replace(SCRIPT_EXT, "");
}
