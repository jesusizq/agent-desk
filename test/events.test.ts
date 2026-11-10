// The desk's event stream (GET /api/events): what it tells the page, when, and to whom.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as http from "node:http";
import { describe, it } from "node:test";
import { procInfo } from "../src/core/proc.ts";
import { MAX_STREAMS } from "../src/server/feed.ts";
import { RemoteUnlock, setPin } from "../src/server/remote-unlock.ts";
import { addSession, serve, testStore } from "./helpers.ts";

/** An event stream as a client reads it: its answer, and its messages as they come, blank-line separated. */
type Stream = { status: number; headers: http.IncomingHttpHeaders; messages: string[]; next: (match: (m: string) => boolean, ms?: number) => Promise<string>; ended: Promise<void>; close: () => void };

function openStream(port: number, headers: Record<string, string> = {}): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/events", headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const messages: string[] = [];
      const waiting = new Set<() => void>();
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
        for (const wake of [...waiting]) wake();
      });
      const ended = new Promise<void>((done) => res.on("close", done));
      let seen = 0;
      /** The first message from here on that matches, within `ms`. */
      const next = (match: (m: string) => boolean, ms = 5000) =>
        new Promise<string>((found, fail) => {
          const look = () => {
            while (seen < messages.length) {
              const m = messages[seen++] ?? "";
              if (!match(m)) continue;
              waiting.delete(look);
              clearTimeout(timer);
              return found(m);
            }
          };
          const timer = setTimeout(() => (waiting.delete(look), fail(new Error(`no matching message within ${ms} ms; got ${JSON.stringify(messages)}`))), ms);
          waiting.add(look);
          look();
        });
      resolve({ status: res.statusCode ?? 0, headers: res.headers, messages, next, ended, close: () => req.destroy() });
    });
    req.on("error", reject);
  });
}

const version = (m: string) => /^event: changed\ndata: (.+)$/m.exec(m)?.[1];
const isChange = (m: string) => version(m) !== undefined;

async function etag(base: string): Promise<string> {
  const res = await fetch(base + "/api/state");
  await res.arrayBuffer();
  return res.headers.get("etag") ?? "";
}

describe("event stream", () => {
  it("sends the state's version on opening, then a new one within a second of a change to the store", async () => {
    const store = testStore();
    addSession(store);
    // No check at a pace within the test: only the watch on the store's folders can tell of the change.
    const server = await serve(store, undefined, { checkEveryMs: 600_000 });
    const stream = await openStream(server.port);
    try {
      assert.equal(stream.status, 200);
      assert.match(stream.headers["content-type"] ?? "", /^text\/event-stream/);
      assert.equal(stream.headers["cache-control"], "no-store");
      assert.match(String(stream.headers["content-security-policy"]), /default-src 'self'/);
      const first = version(await stream.next(isChange));
      assert.equal(first, await etag(server.base), "the same version /api/state sends as its ETag");

      const asked = Date.now();
      const q = store.ask({ sessionId: "s1", kind: "question", text: "Ship it?" });
      const second = version(await stream.next(isChange));
      assert.ok(Date.now() - asked < 1000, `told within a second, took ${Date.now() - asked} ms`);
      assert.notEqual(second, first);
      assert.equal(second, await etag(server.base));
      assert.ok(!stream.messages.some((m) => m.includes("Ship it?")), "the stream never carries what the state says");

      // A new folder, made after the stream opened, is watched too: an agent's first record.
      store.upsertAgent("s1", "builder", { goal: "Build" });
      const third = version(await stream.next(isChange));
      store.upsertAgent("s1", "builder", { goal: "Build", state: "done" });
      assert.notEqual(version(await stream.next(isChange)), third, "a change inside the agent's folder");
      store.dismiss(q.id);
    } finally {
      stream.close();
      await server.close();
    }
  });

  it("tells, at its pace, of a change no file says: a session's process that ended", async () => {
    const store = testStore();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const pid = child.pid ?? 0;
    const start = procInfo(pid)?.start;
    assert.ok(start, "the child's start time is readable");
    store.upsertSession({ id: "s1", provider: "Test", project: { name: "shop", dir: "/work/shop" }, process: { pid, start, ancestors: [] } });
    const server = await serve(store, undefined, { checkEveryMs: 100 });
    const stream = await openStream(server.port);
    try {
      const alive = version(await stream.next(isChange));
      const exited = new Promise((r) => child.once("exit", r));
      child.kill();
      await exited;
      assert.notEqual(version(await stream.next(isChange)), alive);
      const state = (await (await fetch(server.base + "/api/state")).json()) as { gone: string[] };
      assert.deepEqual(state.gone, ["s1"]);
    } finally {
      child.kill();
      stream.close();
      await server.close();
    }
  });

  it("sends a comment now and then, so proxies keep a quiet stream open", async () => {
    const store = testStore();
    const server = await serve(store, undefined, { heartbeatMs: 50 });
    const stream = await openStream(server.port);
    try {
      await stream.next((m) => m === ": ping");
      await stream.next((m) => m === ": ping");
    } finally {
      stream.close();
      await server.close();
    }
  });

  it("lets go of a stream whose client left, and opens no more than its limit at once", async () => {
    const store = testStore();
    const server = await serve(store);
    const streams: Stream[] = [];
    try {
      for (let i = 0; i < MAX_STREAMS; i++) streams.push(await openStream(server.port));
      assert.ok(streams.every((s) => s.status === 200));
      const refused = await openStream(server.port);
      assert.equal(refused.status, 503, "past the limit, the page polls instead");
      await refused.ended;
      for (const s of streams.splice(0)) {
        s.close();
        await s.ended;
      }
      // Each left stream gave its place back: as many open again.
      for (let i = 0; i < MAX_STREAMS; i++) streams.push(await openStream(server.port));
      assert.ok(streams.every((s) => s.status === 200));
      await streams[0]?.next(isChange);
    } finally {
      for (const s of streams) s.close();
      await server.close();
    }
  });

  it("is refused to an unknown Host and to a remote device still locked, and ends with a remote device's unlock", async () => {
    const store = testStore();
    const remote = { host: "laptop.tail1234.ts.net:8443", user: "dev@example.com" };
    const server = await serve(store, remote);
    const asRemote = { Host: remote.host, "Tailscale-User-Login": remote.user };
    try {
      const rebinding = await openStream(server.port, { Host: `evil.example:${server.port}` });
      assert.equal(rebinding.status, 421);
      const stranger = await openStream(server.port, { Host: remote.host, "Tailscale-User-Login": "someone@else.com" });
      assert.equal(stranger.status, 421);
      const locked = await openStream(server.port, asRemote);
      assert.equal(locked.status, 401);
      assert.equal(locked.headers["x-agent-desk-locked"], "1");

      setPin(store.paths.pin, "424242");
      // An unlock that ends a moment from now: issued as if 24 hours ago, less 400 ms.
      const issuedEarlier = new RemoteUnlock(store.paths.pin, store.secret(), () => Date.now() - 24 * 3600_000 + 400);
      const cookie = issuedEarlier.unlock("424242").split(";")[0] ?? "";
      const unlocked = await openStream(server.port, { ...asRemote, Cookie: cookie });
      assert.equal(unlocked.status, 200);
      await unlocked.next(isChange);
      await unlocked.ended;
      assert.equal((await openStream(server.port, { ...asRemote, Cookie: cookie })).status, 401, "and is refused once it ended");
    } finally {
      await server.close();
    }
  });

  it("answers only GET", async () => {
    const store = testStore();
    const server = await serve(store);
    try {
      const res = await fetch(server.base + "/api/events", { method: "HEAD" });
      assert.equal(res.status, 405);
    } finally {
      await server.close();
    }
  });
});
