// The page's event streams (GET /api/events): each tells its page that what it shows has changed,
// by the same version /api/state sends as its ETag, never by what changed. Watching the store's
// folders makes the notice quick; a check at a fixed pace catches what no file says (a process that
// died, a hold that ran out) and any change a watch missed.
import * as fs from "node:fs";
import type { ServerResponse } from "node:http";
import { isCode } from "../store/fsx.ts";
import { PAGE_HEADERS, sendJson } from "./security.ts";

export type FeedOptions = {
  /** The pace of the check that does not rely on watching: as often as the page used to poll. */
  checkEveryMs: number;
  /** How long after a change in a folder the check runs: an atomic write is several events. */
  settleMs: number;
  /** How often a quiet stream sends a comment, so proxies (Tailscale Serve) keep it open. */
  heartbeatMs: number;
  /** Where a failure goes; the feed keeps going on its checks. */
  report: (problem: string) => void;
};

const DEFAULTS: FeedOptions = {
  checkEveryMs: 1500,
  settleMs: 100,
  heartbeatMs: 20_000,
  report: (problem) => process.stderr.write(`agent-desk: ${problem}\n`),
};
/** Streams open at once at most: a few per device. Past it a page polls instead. */
export const MAX_STREAMS = 32;
/** What a stream may hold unread before its client counts as gone (a phone asleep with the socket open). */
const BACKLOG_BYTES = 64 * 1024;

type Listener = (version: string) => void;

/** Watches and checks only while some stream is open. */
export class StateFeed {
  private readonly listeners = new Set<Listener>();
  private readonly watchers = new Map<string, fs.FSWatcher>();
  /** Problems already reported, so a lasting one is said once, not at every check. */
  private readonly reported = new Set<string>();
  private readonly current: () => string;
  private readonly dirs: () => string[];
  private readonly options: FeedOptions;
  private version: string | undefined;
  private pace: NodeJS.Timeout | undefined;
  private soon: NodeJS.Timeout | undefined;

  /**
   * @param current the version of what the page shows now
   * @param dirs the folders whose files make up what the page shows, as they are now
   */
  constructor(current: () => string, dirs: () => string[], options: Partial<FeedOptions> = {}) {
    this.current = current;
    this.dirs = dirs;
    this.options = { ...DEFAULTS, ...options };
  }

  /** How many streams are open. */
  get size(): number {
    return this.listeners.size;
  }

  /**
   * Answers with an event stream: `changed` with the version on opening and at each change, a
   * comment as heartbeat. It ends when the client goes, or at `endsAt` (a remote device's unlock).
   */
  stream(res: ServerResponse, endsAt?: number): void {
    if (this.listeners.size >= MAX_STREAMS) return sendJson(res, 503, { error: `${MAX_STREAMS} event streams are open already; the page polls instead` }, { "Retry-After": "60" });
    res.writeHead(200, { ...PAGE_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    res.socket?.setNoDelay(true);
    const write = (chunk: string) => {
      // A client that stops reading leaves nothing piling up here: it is let go, and reconnects once awake.
      if (res.writableLength > BACKLOG_BYTES) return void res.destroy();
      res.write(chunk);
    };
    const changed = (version: string) => write(`event: changed\ndata: ${version}\n\n`);
    const unsubscribe = this.subscribe(changed);
    write("retry: 2000\n\n");
    changed(this.latest());
    const heartbeat = setInterval(() => write(": ping\n\n"), this.options.heartbeatMs);
    let end: NodeJS.Timeout | undefined;
    // Ended only once the unlock has (RemoteUnlock still accepts its last millisecond): a timer may fire a little early.
    const endLater = (at: number) => (end = setTimeout(() => (Date.now() > at ? res.end() : endLater(at)), at - Date.now() + 1));
    if (endsAt !== undefined) endLater(endsAt);
    res.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
      clearTimeout(end);
    });
  }

  /** Something may have changed: checked once it settles, one check for a burst of changes. */
  poke(): void {
    if (this.soon !== undefined || this.listeners.size === 0) return;
    this.soon = setTimeout(() => {
      this.soon = undefined;
      this.check();
    }, this.options.settleMs);
  }

  /** Calls `listener` with each new version; returns how to stop. */
  private subscribe(listener: Listener): () => void {
    if (this.listeners.size === 0) this.start();
    this.listeners.add(listener);
    return () => {
      if (this.listeners.delete(listener) && this.listeners.size === 0) this.stop();
    };
  }

  private latest(): string {
    this.version ??= this.current();
    return this.version;
  }

  private check(): void {
    let next: string;
    try {
      next = this.current();
      this.watch(); // folders that appeared since the last check
    } catch (error) {
      this.problem(`checking the store for changes failed: ${(error as Error).stack ?? String(error)}`);
      return;
    }
    if (next === this.version) return;
    this.version = next;
    for (const listener of [...this.listeners]) listener(next);
  }

  private start(): void {
    try {
      this.watch();
    } catch (error) {
      this.problem(`listing the store's folders to watch failed: ${(error as Error).message}`); // the checks at a fixed pace still run
    }
    this.pace = setInterval(() => this.check(), this.options.checkEveryMs);
  }

  private stop(): void {
    clearInterval(this.pace);
    clearTimeout(this.soon);
    this.pace = this.soon = this.version = undefined;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  /** Watches the folders wanted now, and stops watching those gone. */
  private watch(): void {
    const wanted = new Set(this.dirs());
    for (const [dir, watcher] of this.watchers) {
      if (wanted.has(dir)) continue;
      watcher.close();
      this.watchers.delete(dir);
    }
    for (const dir of wanted) {
      if (this.watchers.has(dir)) continue;
      let watcher: fs.FSWatcher;
      try {
        watcher = fs.watch(dir, { persistent: false }, () => this.poke());
      } catch (error) {
        if (isCode(error, "ENOENT")) continue; // not made yet: watched at the first check after it is
        this.problem(`watching ${dir} failed, its changes show at the next check instead: ${(error as Error).message}`);
        continue;
      }
      // A watch that fails ends; the folder is watched again at the next check if it is still there.
      watcher.on("error", (error) => {
        watcher.close();
        this.watchers.delete(dir);
        if (!isCode(error, "ENOENT")) this.problem(`watching ${dir} stopped: ${error.message}`);
        this.poke();
      });
      this.watchers.set(dir, watcher);
    }
  }

  private problem(message: string): void {
    if (this.reported.has(message)) return;
    this.reported.add(message);
    this.options.report(message);
  }
}
