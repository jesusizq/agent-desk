import assert from "node:assert/strict";
import { once } from "node:events";
import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { procInfo } from "../src/core/proc.ts";
import { Push } from "../src/server/push.ts";
import { createDeskServer, deskState, diskWarnings, recordPlanUsage, SEEN_BODY_LIMIT, SEEN_IDS_MAX } from "../src/server/server.ts";
import type { Session } from "../src/core/model.ts";
import type { Store } from "../src/store/store.ts";
import { projectId } from "../src/project/scan.ts";
import { addSession, PNG, QUIET_MACHINE, runScript, serve, shellListener, tempHome, testStore, waitingScript } from "./helpers.ts";

let store: Store;
let base: string;
let port: number;
let secret: string;
let close: () => Promise<void>;

before(async () => {
  store = testStore();
  addSession(store);
  secret = store.secret();
  ({ base, port, close } = await serve(store));
});
after(() => close());
/** A write that changes nothing, to test who may write. */
const NO_IDS = JSON.stringify({ ids: [] });

const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base, "X-Agent-Desk-Secret": secret, ...headers },
    body: JSON.stringify(body),
  });

describe("server", () => {
  it("serves the page with its secret and a strict CSP", async () => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.ok((await res.text()).includes(secret));
  });

  it("rejects an unknown Host (DNS rebinding)", async () => {
    const http = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/api/state", headers: { Host: `evil.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject);
    });
    assert.equal(status, 421);
    const page = await new Promise<{ status: number; type: string }>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/", headers: { Host: `evil.example:${port}` } }, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, type: res.headers["content-type"] ?? "" });
      }).on("error", reject);
    });
    assert.deepEqual(page, { status: 421, type: "text/plain; charset=utf-8" }, "opened directly, a sentence instead of JSON");
  });

  it("returns the state and a 304 while nothing changes", async () => {
    const first = await fetch(base + "/api/state");
    const data = (await first.json()) as { sessions: { id: string }[]; problems: string[] };
    assert.deepEqual(data.sessions.map((s) => s.id), ["s1"]);
    const again = await fetch(base + "/api/state", { headers: { "If-None-Match": first.headers.get("etag") ?? "" } });
    assert.equal(again.status, 304);
  });

  it("sends the state compressed, with the context of open questions only", async () => {
    const open = store.ask({ sessionId: "s1", kind: "question", text: "Open?" });
    store.addContext(open.id, "why it asks");
    const closed = store.ask({ sessionId: "s1", kind: "question", text: "Closed?" });
    store.addContext(closed.id, "a long report");
    store.dismiss(closed.id);
    const res = await fetch(base + "/api/state", { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(res.headers.get("content-encoding"), "gzip");
    const { questions } = (await res.json()) as { questions: { id: string; context?: string }[] };
    assert.equal(questions.find((q) => q.id === open.id)?.context, "why it asks");
    assert.equal(questions.find((q) => q.id === closed.id)?.context, undefined);
    store.dismiss(open.id);
  });

  it("refuses writes without the exact Origin or the secret", async () => {
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Ok?" });
    for (const headers of [{ Origin: "http://evil.example" }, { Origin: `http://127.0.0.1:${port + 1}` }, { "X-Agent-Desk-Secret": "0".repeat(64) }]) {
      const res = await post(`/api/questions/${q.id}/answer`, { text: "yes" }, headers);
      assert.equal(res.status, 403, JSON.stringify(headers));
    }
    assert.equal(store.getQuestion(q.id)?.status, "open");
  });

  it("answers a question from the page into the session's inbox", async () => {
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Which?", options: ["A", "B"] });
    const stop = store.listen("s1");
    const res = await post(`/api/questions/${q.id}/answer`, { text: "B" });
    assert.equal(res.status, 200);
    assert.deepEqual(store.takeInbox("s1").map((e) => e.answer), ["B"]);
    const twice = await post(`/api/questions/${q.id}/answer`, { text: "A" });
    assert.equal(twice.status, 400);
    assert.match(((await twice.json()) as { error: string }).error, /already answered/);
    stop();
  });

  it("keeps an image pasted on the page and sends it with the answer", async () => {
    const upload = (body: Uint8Array, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/images`, { method: "POST", headers: { "Content-Type": "image/png", Origin: base, "X-Agent-Desk-Secret": secret, ...headers }, body });
    assert.equal((await upload(PNG, { "X-Agent-Desk-Secret": "0".repeat(64) })).status, 403, "the secret is required");
    assert.equal((await upload(PNG, { Origin: "http://evil.example" })).status, 403, "the exact origin is required");
    assert.equal((await upload(PNG, { "Content-Type": "application/json" })).status, 415);
    assert.equal((await upload(Buffer.from("<svg onload=alert(1)>"), { "Content-Type": "image/svg+xml" })).status, 400, "only PNG, JPEG, WebP and GIF are kept");
    const res = await upload(PNG);
    assert.equal(res.status, 200);
    const { id } = (await res.json()) as { id: string };
    assert.equal((await fetch(`${base}/images/${id}`)).headers.get("content-type"), "image/png");
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Like this?" });
    const stop = store.listen("s1");
    assert.equal((await post(`/api/questions/${q.id}/answer`, { text: "no", images: ["../secret"] })).status, 400);
    assert.equal((await post(`/api/questions/${q.id}/answer`, { text: "no, like this", images: [id] })).status, 200);
    assert.deepEqual(store.takeInbox("s1").map((e) => e.images), [[id]]);
    stop();
  });

  it("rejects malformed ids and bodies", async () => {
    assert.equal((await post("/api/questions/..%2F..%2Fsecret/answer", { text: "x" })).status, 400);
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Ok?" });
    assert.equal((await post(`/api/questions/${q.id}/answer`, { text: 42 })).status, 400);
    assert.equal((await post(`/api/questions/${q.id}/answer`, "x".repeat(70_000))).status, 400);
    assert.equal(store.getQuestion(q.id)?.status, "open");
  });

  it("serves every script the page loads and every module they import", async () => {
    const page = await (await fetch(base + "/")).text();
    const queue = [...page.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1] ?? "");
    assert.ok(queue.includes("/app.js"), "the page loads app.js");
    const seen = new Set<string>();
    for (let route = queue.shift(); route !== undefined; route = queue.shift()) {
      if (seen.has(route)) continue;
      seen.add(route);
      const res = await fetch(base + route);
      assert.equal(res.status, 200, `${route} is served (a module missing from STATIC in server.ts breaks the page)`);
      assert.match(res.headers.get("content-type") ?? "", /^text\/javascript/, route);
      for (const m of (await res.text()).matchAll(/^import\s[^;]*?["'](\.\/[^"']+)["'];?$/gm)) queue.push(new URL(m[1] ?? "", base + route).pathname);
    }
    assert.ok(seen.size > 3, `the walk found the page's modules (${[...seen].join(", ")})`);
  });

  it("serves stored images as inert data, and nothing else from disk", async () => {
    const dir = tempHome();
    fs.writeFileSync(path.join(dir, "a.png"), PNG);
    const r = store.addResult({ sessionId: "s1", title: "Shot", images: [{ path: path.join(dir, "a.png") }] });
    const res = await fetch(`${base}/images/${r.images[0]?.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
    for (const probe of ["/images/..%2Fsecret", "/secret", "/../secret", "/index.html", "/src/web/app.js"]) {
      const r2 = await fetch(base + probe);
      assert.notEqual(r2.status, 200, probe);
      assert.ok(!(await r2.text()).includes(secret), probe);
    }
  });

  it("marks one result seen, or just the results listed by id, and never everything at once", async () => {
    const r = store.addResult({ sessionId: "s1", title: "Done" });
    assert.equal((await post(`/api/results/${r.id}/seen`, {})).status, 200);
    assert.ok(store.listResults().find((x) => x.id === r.id)?.seenAt);

    const listed = [store.addResult({ sessionId: "s1", title: "Finished" }), store.addResult({ sessionId: "s1", title: "Broke", status: "failed" })];
    const left = store.addResult({ sessionId: "s1", title: "Not listed" });
    const ids = listed.map((x) => x.id);
    assert.equal((await post("/api/results/seen", { ids }, { "X-Agent-Desk-Secret": "wrong" })).status, 403, "behind the secret");
    assert.equal((await post("/api/results/seen", { ids }, { Origin: "http://evil.example" })).status, 403, "and the page's origin");
    for (const bad of [{}, { ids: "r-1" }, { ids: ["../secret"] }, { ids: Array.from({ length: 5001 }, (_, i) => `r-${i}`) }]) {
      assert.equal((await post("/api/results/seen", bad)).status, 400, JSON.stringify(bad).slice(0, 40));
    }
    assert.ok(listed.every((x) => !store.listResults().find((y) => y.id === x.id)?.seenAt), "a refused request marks nothing");

    const unreadable = store.addResult({ sessionId: "s1", title: "Unreadable" });
    fs.writeFileSync(store.paths.result(unreadable.id), "{ half");
    const logged: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = (chunk: string | Uint8Array) => (logged.push(String(chunk)), true);
    let res: Response;
    try {
      res = await post("/api/results/seen", { ids: [...ids, "r-gone", unreadable.id] });
    } finally {
      process.stderr.write = write;
    }
    assert.equal(res.status, 200);
    const reply = (await res.json()) as { seen: number; missing: string[]; failed: { id: string; error: string }[] };
    assert.equal(reply.seen, 2);
    assert.deepEqual(reply.missing, ["r-gone"], "one gone is said apart: the page has nothing left to mark there");
    assert.deepEqual(reply.failed.map((f) => f.id), [unreadable.id], "what could not be marked is said");
    assert.ok(logged.some((l) => l.includes(`marking ${unreadable.id} seen`) && l.includes("not valid JSON")), `the unexpected error goes to the desk's stderr (${logged.join("")})`);
    fs.rmSync(store.paths.result(unreadable.id));
    const now = store.listResults();
    assert.ok(ids.every((id) => now.find((x) => x.id === id)?.seenAt), "the listed ones are marked, the failure too");
    assert.equal(now.find((x) => x.id === left.id)?.seenAt, undefined, "a result not listed stays new");
    assert.equal(store.getSeen(), undefined);
    const gone = await post("/api/results/r-gone/seen", {});
    assert.equal(gone.status, 404, "a result no longer in the store: nothing left to mark, said as such");
    assert.match(((await gone.json()) as { error: string }).error, /no result r-gone in the store/);
    assert.equal((await post("/api/seen", {})).status, 404, "no endpoint marks everything any more");
  });

  it("takes the most ids one request may mark seen, each of the longest an id may be, and refuses a larger body", async () => {
    const ids = Array.from({ length: SEEN_IDS_MAX }, (_, i) => `r${String(i).padStart(127, "0")}`);
    const body = JSON.stringify({ ids });
    assert.ok(body.length <= SEEN_BODY_LIMIT);
    const res = await post("/api/results/seen", { ids });
    assert.equal(res.status, 200);
    const reply = (await res.json()) as { seen: number; missing: string[]; failed: unknown[] };
    assert.deepEqual([reply.seen, reply.missing.length, reply.failed.length], [0, SEEN_IDS_MAX, 0], "every id read, none held by the store");
    const larger = await fetch(base + "/api/results/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, "X-Agent-Desk-Secret": secret },
      body: body + " ".repeat(SEEN_BODY_LIMIT - body.length + 1),
    });
    assert.equal(larger.status, 400);
    assert.match(((await larger.json()) as { error: string }).error, new RegExp(`larger than ${SEEN_BODY_LIMIT} bytes`));
  });

  it("has no way left to take a result off the desk but marking it seen", async () => {
    const r = store.addResult({ sessionId: "s1", title: "Seen and done" });
    assert.equal((await post(`/api/results/${r.id}/dismiss`, {})).status, 404);
    assert.equal(store.listResults().find((x) => x.id === r.id)?.seenAt, undefined);
  });

  it("sends terminal keys only from the allow-list, and only to a session in a live tmux pane", async () => {
    const bad = await post("/api/sessions/s1/keys", { action: "rm -rf /" });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /action: expected one of compact, interrupt/);
    const noTmux = await post("/api/sessions/s1/keys", { action: "compact" });
    assert.equal(noTmux.status, 400);
    assert.match(((await noTmux.json()) as { error: string }).error, /does not run in a live tmux pane/);
    const cross = await post("/api/sessions/s1/keys", { action: "compact" }, { Origin: "http://evil.example" });
    assert.equal(cross.status, 403);
  });

  it("ends a session's process only while it is still that process, and only from the page", async () => {
    const { spawn } = await import("node:child_process");
    const { procInfo } = await import("../src/core/proc.ts");
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
    const pid = child.pid ?? 0;
    const start = procInfo(pid)?.start ?? "";
    addSession(store, "s-end");
    store.updateSession("s-end", (s) => ({ ...s, process: { pid, start: `${start}0`, ancestors: [] } }));
    const reused = await post("/api/sessions/s-end/end", {});
    assert.equal(reused.status, 400, "a pid now held by another process is not signalled");
    assert.equal(procInfo(pid)?.start, start);
    store.updateSession("s-end", (s) => ({ ...s, process: { pid, start, ancestors: [] } }));
    assert.equal((await post("/api/sessions/s-end/end", {}, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await post("/api/sessions/s-end/end", {})).status, 200);
    assert.equal(await exited, "SIGTERM");
  });

  it("shows the servers a running session listens on as its services, under the name it gave one, and drops them when they stop", async () => {
    const own = testStore();
    own.upsertSession({ id: "live", provider: "Test", project: { name: "shop", dir: "/work/shop" }, process: { pid: process.pid, start: procInfo(process.pid)?.start ?? "", ancestors: [] } });
    own.upsertSession({ id: "over", provider: "Test", project: { name: "shop", dir: "/work/shop" }, state: "ended", process: { pid: process.pid, start: procInfo(process.pid)?.start ?? "", ancestors: [] } });
    const vite = await shellListener();
    const named = await shellListener();
    const services = () => deskState(own).services.map((v) => [v.sessionId, v.name, v.url, v.detected]);
    try {
      own.addService({ sessionId: "live", name: "storybook", url: `http://localhost:${named.port}/docs`, detected: true });
      own.addService({ sessionId: "live", name: "db admin", url: "http://localhost:8081/" });
      assert.deepEqual(services(), [
        ["live", "storybook", `http://localhost:${named.port}/docs`, true],
        ["live", "db admin", "http://localhost:8081/", undefined],
        ["live", "serve", `http://127.0.0.1:${vite.port}/`, true],
      ], "an ended session's processes are not scanned");
      const detected = deskState(own).services.find((v) => v.name === "serve");
      assert.equal(detected?.id, deskState(own).services.find((v) => v.name === "serve")?.id, "a stable id, so the state's version stays");
      await vite.stop();
      await named.stop();
      assert.deepEqual(services(), [["live", "db admin", "http://localhost:8081/", undefined]], "a server the desk cannot see stays until the session stops it");
    } finally {
      await vite.stop();
      await named.stop();
    }
  });

  it("forgets a session only from the page, and never one still running", async () => {
    addSession(store, "s-forget");
    store.updateSession("s-forget", (s) => ({ ...s, process: { pid: process.pid, start: procInfo(process.pid)?.start ?? "", ancestors: [] } }));
    const q = store.ask({ sessionId: "s-forget", kind: "question", text: "Still there?" });
    const running = await post("/api/sessions/s-forget/forget", {});
    assert.equal(running.status, 400);
    assert.match(((await running.json()) as { error: string }).error, /still running/);
    store.updateSession("s-forget", (s) => ({ ...s, state: "ended" }));
    assert.equal((await post("/api/sessions/s-forget/forget", {}, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await post("/api/sessions/s-forget/forget", {}, { "X-Agent-Desk-Secret": "wrong" })).status, 403);
    assert.equal(store.getQuestion(q.id)?.status, "open", "a refused request changes nothing");
    const res = await post("/api/sessions/s-forget/forget", {});
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { dismissed: number }).dismissed, 1);
    assert.equal(store.getQuestion(q.id)?.status, "dismissed");
    assert.equal((await post("/api/sessions/..%2Fx/forget", {})).status, 400);
  });

  it("subscribes a phone to push only from the page, and only to a known push service", async () => {
    const { createECDH } = await import("node:crypto");
    const keys = { p256dh: createECDH("prime256v1").generateKeys().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") };
    const key = ((await (await fetch(`${base}/api/push/key`)).json()) as { key: string }).key;
    assert.equal(Buffer.from(key, "base64url").length, 65, "a P-256 point the page subscribes with");
    assert.equal((await post("/api/push/subscribe", { endpoint: "https://web.push.apple.com/x", keys }, { Origin: "http://evil.example" })).status, 403);
    const other = await post("/api/push/subscribe", { endpoint: "https://collector.example/x", keys });
    assert.equal(other.status, 400);
    assert.match(((await other.json()) as { error: string }).error, /only the push services of Apple, Google and Mozilla/);
    assert.equal((await post("/api/push/subscribe", { endpoint: "https://web.push.apple.com/x", keys })).status, 200);
    assert.equal((await post("/api/push/unsubscribe", { endpoint: "https://web.push.apple.com/x" })).status, 200);
  });

  it("serves a session's conversation, desk answers included", async () => {
    store.addMessage({ sessionId: "s1", from: "session", text: "Which name?" });
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Which name?" });
    const stop = store.listen("s1");
    await post(`/api/questions/${q.id}/answer`, { text: "Ñandú" });
    stop();
    const list = (await (await fetch(`${base}/api/sessions/s1/messages`)).json()) as { from: string; text: string; via?: string }[];
    assert.deepEqual(list.slice(-2).map((m) => [m.from, m.text, m.via]), [["session", "Which name?", undefined], ["developer", "Ñandú", "desk"]]);
    assert.equal((await fetch(`${base}/api/sessions/..%2Fx/messages`)).status, 400);
  });

  it("records that a session's conversation was read", async () => {
    assert.equal(store.getSession("s1")?.readAt, undefined);
    assert.equal((await post("/api/sessions/s1/read", {})).status, 200);
    assert.ok(store.getSession("s1")?.readAt);
  });

  it("reports sessions whose process is gone", async () => {
    addSession(store, "s9");
    store.updateSession("s9", (s) => ({ ...s, process: { pid: 2 ** 31 - 1, ancestors: [] } }));
    const data = (await (await fetch(base + "/api/state")).json()) as { gone: string[] };
    assert.ok(data.gone.includes("s9"));
  });
});

describe("remote access through Tailscale Serve", () => {
  it("accepts the tailnet name only with the configured Tailscale user, and its https origin for writes", async () => {
    const store = testStore();
    addSession(store);
    const secret = store.secret();
    const remote = { host: "laptop.tail1234.ts.net:8443", user: "dev@example.com" };
    const server = await serve(store, remote);
    const { port } = server;
    const http = await import("node:http");
    const call = (method: string, path: string, headers: Record<string, string>, body?: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end(body);
      });
    try {
      assert.equal(await call("GET", "/api/state", { Host: remote.host, "Tailscale-User-Login": remote.user }), 401, "let in, but locked until the PIN");
      assert.equal(await call("GET", "/api/state", { Host: remote.host, "Tailscale-User-Login": "someone@else.com" }), 421);
      assert.equal(await call("GET", "/api/state", { Host: remote.host }), 421);
      const { RemoteUnlock, setPin } = await import("../src/server/remote-unlock.ts");
      setPin(store.paths.pin, "424242");
      const cookie = new RemoteUnlock(store.paths.pin, secret).unlock("424242").split(";")[0] ?? "";
      const write = { Host: remote.host, "Tailscale-User-Login": remote.user, "Content-Type": "application/json", "X-Agent-Desk-Secret": secret, Cookie: cookie };
      assert.equal(await call("POST", "/api/results/seen", { ...write, Origin: `https://${remote.host}` }, NO_IDS), 200);
      assert.equal(await call("POST", "/api/results/seen", { ...write, Origin: `http://${remote.host}` }, NO_IDS), 403);
    } finally {
      server.close();
    }
  });
});

describe("a request through a proxy is never local", () => {
  const remote = { host: "laptop.tail1234.ts.net:8443", user: "dev@example.com" };
  /** A raw request, so the Host and proxy headers are exactly the ones given. */
  const call = async (port: number, method: string, path: string, headers: Record<string, string>, body?: string, address = "127.0.0.1") => {
    const http = await import("node:http");
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: address, port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (d: Buffer) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", reject);
      req.end(body);
    });
  };
  // What a port forward, a portproxy, a reverse proxy or Tailscale Serve adds to a request it passes on.
  const PROXY_HEADERS: Record<string, string>[] = [
    { "Tailscale-User-Login": remote.user },
    { "Tailscale-User-Name": "Dev" },
    { "Tailscale-Headers-Info": "https://tailscale.com/s/serve-headers" },
    { "X-Forwarded-For": "192.168.1.20" },
    { "X-Forwarded-Host": "127.0.0.1" },
    { "X-Forwarded-Proto": "http" },
    { Forwarded: "for=192.168.1.20" },
    { Via: "1.1 proxy" },
    { "X-Real-IP": "192.168.1.20" },
  ];

  for (const configured of [undefined, remote]) {
    it(`refuses a local Host carrying any proxy header, and never hands it the secret (${configured ? "remote configured" : "no remote"})`, async () => {
      const store = testStore();
      addSession(store);
      const server = await serve(store, configured);
      try {
        const local = `127.0.0.1:${server.port}`;
        const real = await call(server.port, "GET", "/", { Host: local });
        assert.ok(real.status === 200 && real.body.includes(store.secret()), "a request from this machine is local");
        for (const proxy of PROXY_HEADERS) {
          for (const host of [local, `localhost:${server.port}`]) {
            const page = await call(server.port, "GET", "/", { Host: host, ...proxy });
            assert.equal(page.status, 421, `${host} with ${Object.keys(proxy)[0]} is refused`);
            assert.ok(!page.body.includes(store.secret()), `${host} with ${Object.keys(proxy)[0]} never gets the secret`);
            const write = await call(server.port, "POST", "/api/results/seen", { Host: host, ...proxy, Origin: `http://${local}`, "X-Agent-Desk-Secret": store.secret(), "Content-Type": "application/json" }, NO_IDS);
            assert.equal(write.status, 421, `${host} with ${Object.keys(proxy)[0]} cannot write even with the secret`);
          }
        }
      } finally {
        await server.close();
      }
    });
  }

  it("lets Tailscale Serve's own request in only as the configured remote, behind the PIN and its https origin", async () => {
    const store = testStore();
    addSession(store);
    const server = await serve(store, remote);
    // Tailscale Serve passes the tailnet Host and adds the caller's identity and the X-Forwarded headers.
    const fromServe = { Host: remote.host, "Tailscale-User-Login": remote.user, "Tailscale-User-Name": "Dev", "X-Forwarded-For": "100.64.0.2", "X-Forwarded-Host": remote.host, "X-Forwarded-Proto": "https" };
    try {
      const page = await call(server.port, "GET", "/", fromServe);
      assert.equal(page.status, 200);
      assert.ok(page.body.includes("unlock.js") && !page.body.includes(store.secret()), "the PIN page, without the secret");
      assert.equal((await call(server.port, "GET", "/api/state", fromServe)).status, 401, "locked until the PIN");
      assert.equal((await call(server.port, "GET", "/api/state", { ...fromServe, "Tailscale-User-Login": "someone@else.com" })).status, 421, "another Tailscale user is refused");
      const { "Tailscale-User-Login": _login, ...anonymous } = fromServe;
      assert.equal((await call(server.port, "GET", "/api/state", anonymous)).status, 421, "no Tailscale user is refused");

      const { RemoteUnlock, setPin } = await import("../src/server/remote-unlock.ts");
      setPin(store.paths.pin, "424242");
      const cookie = new RemoteUnlock(store.paths.pin, store.secret()).unlock("424242").split(";")[0] ?? "";
      const write = { ...fromServe, Cookie: cookie, "X-Agent-Desk-Secret": store.secret(), "Content-Type": "application/json" };
      assert.equal((await call(server.port, "POST", "/api/results/seen", { ...write, Origin: `https://${remote.host}` }, NO_IDS)).status, 200);
      assert.equal((await call(server.port, "POST", "/api/results/seen", { ...write, Origin: `http://127.0.0.1:${server.port}` }, NO_IDS)).status, 403, "a remote write needs the remote origin, not this machine's");
    } finally {
      await server.close();
    }
  });

  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i?.family === "IPv4" && !i.internal)?.address;
  it("refuses a connection that does not come from a loopback address, whatever its Host", { skip: lan === undefined ? "no non-loopback IPv4 address on this machine" : false }, async () => {
    const address = lan ?? "";
    const store = testStore();
    addSession(store);
    // Listening on the LAN address stands for a server reached from elsewhere (bound 0.0.0.0, or forwarded).
    const probe = createDeskServer(store, 0).listen(0, address);
    await once(probe, "listening");
    const port = (probe.address() as AddressInfo).port;
    probe.close();
    const server = createDeskServer(store, port).listen(port, address);
    await once(server, "listening");
    try {
      const page = await call(port, "GET", "/", { Host: `127.0.0.1:${port}` }, undefined, address);
      assert.equal(page.status, 421);
      assert.ok(!page.body.includes(store.secret()));
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("PIN in front of remote access", () => {
  it("shows only the PIN page until the right PIN, then lets the device in for 24 hours", async () => {
    const store = testStore();
    addSession(store);
    const remote = { host: "laptop.tail1234.ts.net:8443", user: "dev@example.com" };
    const { setPin } = await import("../src/server/remote-unlock.ts");
    const server = await serve(store, remote);
    const { port } = server;
    const http = await import("node:http");
    const call = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
      new Promise<{ status: number; body: string; cookie?: string; locked?: string; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, method, path, headers: { Host: remote.host, "Tailscale-User-Login": remote.user, ...headers } },
          (res) => {
            let text = "";
            res.on("data", (d: Buffer) => (text += d));
            const locked = res.headers["x-agent-desk-locked"];
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers, ...(res.headers["set-cookie"]?.[0] ? { cookie: res.headers["set-cookie"][0] } : {}), ...(typeof locked === "string" ? { locked } : {}) }));
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    const unlock = (pin: string) => call("POST", "/api/unlock", { Origin: `https://${remote.host}`, "Content-Type": "application/json" }, JSON.stringify({ pin }));
    try {
      const page = await call("GET", "/");
      assert.equal(page.status, 200);
      assert.ok(page.body.includes("unlock.js") && !page.body.includes(store.secret()), "the PIN page carries no secret");
      for (const asset of ["/unlock.js", "/dom.js", "/text.js", "/theme.js", "/style.css", "/manifest.webmanifest", "/apple-touch-icon.png"]) assert.equal((await call("GET", asset)).status, 200, `the PIN page loads ${asset}`);
      assert.equal(page.locked, "1", "a locked answer is marked, so the device never keeps it as the desk");
      assert.equal((await call("GET", "/app.js")).status, 401, "but not the desk itself");
      assert.equal((await call("GET", "/api/state")).status, 401);
      assert.match((await unlock("123456")).body, /no PIN is set/);

      setPin(store.paths.pin, "424242");
      assert.equal((await unlock("000000")).status, 401, "a wrong PIN is told apart, for the page to say so");
      assert.equal((await call("POST", "/api/unlock", { Origin: "https://evil.example", "Content-Type": "application/json" }, '{"pin":"424242"}')).status, 403);
      const ok = await unlock("424242");
      assert.equal(ok.status, 200);
      assert.match(ok.cookie ?? "", /HttpOnly; Secure; SameSite=Strict/);
      const cookie = (ok.cookie ?? "").split(";")[0] ?? "";
      assert.equal((await call("GET", "/api/state", { Cookie: cookie })).status, 200);
      const ends = Number(/=(\d+)\./.exec(cookie)?.[1]);
      for (const route of ["/", "/api/state", "/app.js"]) {
        assert.equal((await call("GET", route, { Cookie: cookie })).headers["x-agent-desk-unlock-ends"], String(ends), `${route} says when this device's unlock ends, for the device to drop its saved desk then`);
      }
      assert.equal(page.headers["x-agent-desk-unlock-ends"], undefined, "a locked answer has no unlock to end");
      const imageId = store.addImage(PNG, "a screenshot");
      const maxAge = Number(/max-age=(\d+)/.exec(String((await call("GET", `/images/${imageId}`, { Cookie: cookie })).headers["cache-control"]))?.[1]);
      assert.ok(maxAge > 23 * 3600 && maxAge <= 24 * 3600, `the device's browser keeps an image only until the unlock ends, got max-age=${maxAge}`);
      const { createECDH } = await import("node:crypto");
      const pushKeys = { p256dh: createECDH("prime256v1").generateKeys().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") };
      const subscribed = await call("POST", "/api/push/subscribe", { Cookie: cookie, Origin: `https://${remote.host}`, "Content-Type": "application/json", "X-Agent-Desk-Secret": store.secret() }, JSON.stringify({ endpoint: "https://web.push.apple.com/pin", keys: pushKeys }));
      assert.equal(subscribed.status, 200);
      const [device] = new Push(store.paths.push).subscriptions();
      assert.ok(device && device.until > Date.now() && device.until <= Date.now() + 24 * 3600_000, "push lasts as long as this device's unlock");
      const again = await call("POST", "/api/unlock", { Cookie: cookie, Origin: `https://${remote.host}`, "Content-Type": "application/json" }, '{"pin":"000000"}');
      assert.equal(again.status, 200, "an unlocked device sending the PIN again (an old PIN page) is told it is unlocked");
      assert.ok((await call("GET", "/", { Cookie: cookie })).body.includes(store.secret()), "unlocked, the device gets the desk");
      assert.equal((await call("GET", "/api/state", { Cookie: cookie.replace(/.$/, "x") })).status, 401, "a tampered cookie does not unlock");

      for (let i = 0; i < 5; i++) await unlock("111111");
      const lockedOut = await unlock("424242");
      assert.equal(lockedOut.status, 429, "five failures lock out even the right PIN");
      assert.match(lockedOut.body, /too many wrong PINs/);
      const local = await new Promise<number>((resolve) => http.get({ host: "127.0.0.1", port, path: "/api/state" }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }));
      assert.equal(local, 200, "this machine never needs the PIN");
      const localDesk = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(localDesk.headers.get("x-agent-desk-unlock-ends"), null, "this machine has no unlock to end, and keeps its saved desk");
      assert.equal((await fetch(`http://127.0.0.1:${port}/images/${imageId}`)).headers.get("cache-control"), "private, max-age=31536000, immutable");
    } finally {
      server.close();
    }
  });
});

describe("unreadable session files", () => {
  it("answers the state with a malformed and a truncated session file counted as unreadable, and the other sessions' questions shown", async () => {
    const own = testStore();
    addSession(own, "s1");
    addSession(own, "s2");
    const shown = own.ask({ sessionId: "s1", kind: "question", text: "Which layout?" });
    const held = own.ask({ sessionId: "s2", kind: "question", text: "Still writing?", writing: true });
    fs.writeFileSync(own.paths.session("broken"), JSON.stringify({ id: "broken", provider: 7 }));
    fs.writeFileSync(own.paths.session("cut"), '{"id":"cut","provider":"Test","proj');
    const desk = await serve(own);
    try {
      const res = await fetch(desk.base + "/api/state");
      assert.equal(res.status, 200);
      const data = (await res.json()) as { sessions: { id: string }[]; questions: { id: string }[]; problems: string[] };
      assert.deepEqual(data.sessions.map((s) => s.id).sort(), ["s1", "s2"]);
      // The test store's clock is long past, so the desk's real clock shows the question being written too.
      assert.deepEqual(data.questions.map((q) => q.id).sort(), [shown.id, held.id].sort());
      assert.equal(data.problems.length, 2, `each unreadable file counted once: ${data.problems.join(" | ")}`);
      assert.ok(data.problems.some((p) => p.includes("broken.json")) && data.problems.some((p) => p.includes("cut.json")));
      const writing = deskState(own, new Date(Date.parse(held.askedAt) + 1000), QUIET_MACHINE);
      assert.deepEqual(writing.questions.map((q) => q.id), [shown.id], "a question still being written stays held");
      assert.equal(writing.problems.length, 2);
      const problems: string[] = [];
      assert.deepEqual([...own.heldQuestions(Date.parse(held.askedAt) + 1000, problems)], [held.id]);
      assert.equal(problems.length, 2);
    } finally {
      await desk.close();
    }
  });

  it("holds from the state's questions what a live session's later end replaces, never one already dismissed", () => {
    const own = testStore();
    addSession(own, "s1");
    fs.writeFileSync(own.paths.session("cut"), '{"id":"cut","provider":"Test","proj');
    const replaced = own.ask({ sessionId: "s1", kind: "waiting", text: "Shall I fix the four of them?" });
    const settled = own.ask({ sessionId: "s1", kind: "waiting", text: "Shall I fix the old ones?" });
    own.replaceOnceStands("s1", (q) => q.id === replaced.id || q.id === settled.id);
    own.closeOpen("s1", { which: (q) => q.id === settled.id, status: "dismissed" });
    const asked = own.ask({ sessionId: "s1", kind: "waiting", text: "Shall I fix only two?" });
    const at = Date.parse(own.getQuestion(replaced.id)?.replacedAt ?? "");
    assert.equal(own.getQuestion(settled.id)?.replacedAt, new Date(at).toISOString(), "dismissed with its mark kept");
    const shown = (ms: number) => deskState(own, new Date(at + ms), QUIET_MACHINE).questions.map((q) => q.id).sort();
    assert.deepEqual(shown(1000), [settled.id, asked.id].sort(), "the dismissed one stays in the history");
    assert.deepEqual(shown(10 * 60_000 + 1000), [replaced.id, settled.id, asked.id].sort(), "past ten quiet minutes it shows again");
    assert.equal(deskState(own, new Date(at + 1000), QUIET_MACHINE).problems.length, 1);
  });

  it("answers the state with a session's inbox that cannot be listed named in the problems", async () => {
    const own = testStore();
    addSession(own, "s1");
    addSession(own, "s2");
    fs.mkdirSync(own.paths.inboxDir, { recursive: true });
    fs.writeFileSync(own.paths.sessionInbox("s1"), "not a folder");
    const desk = await serve(own);
    try {
      const res = await fetch(desk.base + "/api/state");
      assert.equal(res.status, 200);
      const data = (await res.json()) as { sessions: { id: string }[]; problems: string[] };
      assert.deepEqual(data.sessions.map((s) => s.id).sort(), ["s1", "s2"]);
      assert.ok(data.problems.some((p) => /listeners of session s1 .*ENOTDIR/.test(p)), data.problems.join(" | "));
    } finally {
      await desk.close();
    }
    assert.throws(() => own.listeners("s1"), /ENOTDIR/, "without problems to collect into, the caller is told");
    assert.deepEqual(own.listeners("s2"), [], "a session without an inbox has no listener");
  });

  it("keeps recording the plan's usage while a metrics file is unreadable", () => {
    const own = testStore();
    addSession(own, "s1");
    own.mergeMetrics({ sessionId: "s1", planWindows: [{ label: "5 h", percent: 42 }] });
    fs.writeFileSync(own.paths.metrics("cut"), '{"sessionId":"cut","planW');
    recordPlanUsage(own);
    assert.deepEqual(Object.keys(own.planHistory()), ["5 h"], "the readable report is recorded");
  });

  it("keeps a plan history it cannot read as it is, instead of overwriting it with the new samples", () => {
    const own = testStore();
    addSession(own, "s1");
    own.mergeMetrics({ sessionId: "s1", planWindows: [{ label: "5 h", percent: 42 }] });
    for (const broken of ['{"5 h":[{"samples":[{"at":"2026-01-01T00:00:00Z","percent":', JSON.stringify({ "5 h": [{ samples: "none" }] })]) {
      fs.writeFileSync(own.paths.plan, broken);
      assert.throws(() => recordPlanUsage(own), /plan usage not recorded: .*plan\.json.*; the file is kept as it is, fix or remove it/);
      assert.equal(fs.readFileSync(own.paths.plan, "utf8"), broken, "the history is never overwritten");
      assert.ok(deskState(own, new Date(), QUIET_MACHINE).problems.some((p) => p.includes("plan.json")), "the page counts it");
    }
  });
});

describe("disk warnings", () => {
  it("name only the projects of sessions still running, not one whose process is gone or one that ended", () => {
    const me = procInfo(process.pid);
    assert.ok(me);
    const dir = os.tmpdir();
    const session = (name: string, more: Partial<Session>): Session =>
      ({ id: name, provider: "Test", project: { name, dir }, state: "waiting", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...more }) as Session;
    const sessions = [
      session("live", { process: { pid: process.pid, start: me.start, ancestors: [] } }),
      session("gone", { process: { pid: 2 ** 22 + 1, ancestors: [] } }),
      session("ended", { state: "ended" }),
    ];
    const problems: string[] = [];
    // Every disk counts as short of space at a ratio of 1, so only which sessions are listed is tested.
    assert.deepEqual(diskWarnings(sessions, problems, 1).flatMap((w) => w.projects), ["live"]);
    assert.deepEqual(problems, []);
  });
});

describe("machine warnings", () => {
  it("are read with the state, from the machine the desk was given", () => {
    const fake = tempHome();
    fs.writeFileSync(path.join(fake, "loadavg"), "9.20 4.00 2.00 1/100 200\n");
    const at = (cores: number) => deskState(testStore(), new Date(), { proc: fake, sys: fake, cores }).machine;
    assert.deepEqual(at(4), [{ reading: "load", value: 9.2, limit: 4 }]);
    assert.deepEqual(at(16), [], "quiet while healthy");
  });
});

describe("agents waiting for the machine", () => {
  it("shows a working agent waiting for the machine's load while a process of its own checkout runs the load gate, and only then", async () => {
    const me = procInfo(process.pid);
    assert.ok(me);
    const root = tempHome();
    const main = path.join(root, "shop");
    const nested = path.join(main, ".claude", "worktrees", "gated");
    const beside = path.join(root, "shop-plain");
    const over = path.join(root, "shop-over");
    for (const d of [path.join(nested, "src"), beside, over]) fs.mkdirSync(d, { recursive: true });
    const gate = waitingScript("load-gate.sh");
    const build = waitingScript("build.sh");
    const own = testStore();
    // This test's process stands for the session: what it starts through a shell is its work.
    own.upsertSession({ id: "orch", provider: "Test", project: { name: "shop", dir: main }, process: { pid: process.pid, start: me.start, ancestors: [] } });
    own.upsertAgent("orch", "gated", { goal: "Gated agent", worktree: nested });
    own.upsertAgent("orch", "mainline", { goal: "Agent on the main checkout", branch: "main" });
    own.upsertAgent("orch", "plain", { goal: "Plain agent", worktree: beside });
    own.upsertAgent("orch", "over", { goal: "Finished agent", worktree: over, state: "done" });
    const checkout = (p: string, branch: string, isMain = false) => ({ path: p, branch, head: "abc1234", main: isMain });
    own.putProjectScan({
      id: projectId(main),
      name: "shop",
      dir: main,
      worktrees: [checkout(main, "main", true), checkout(nested, "agent/gated"), checkout(beside, "agent/plain"), checkout(over, "agent/over")],
      totalBytes: 0,
      dayStart: { day: "2026-10-28", bytes: 0 },
      measuredAt: "2026-10-28T08:00:00.000Z",
      problems: [],
    });
    const waiting = () => {
      const state = deskState(own, new Date(), QUIET_MACHINE);
      assert.deepEqual(state.problems, []);
      return state.agents.filter((a) => a.waitingFor === "machine-load").map((a) => a.name).sort();
    };
    assert.deepEqual(waiting(), []);
    const started = [await runScript(build, beside), await runScript(gate, over)];
    try {
      assert.deepEqual(waiting(), [], "another script is no gate, and a finished agent waits for nothing");
      // Given to a shell with an option that takes a value, unlike the shebang runs: /proc shows `sh -o errexit <script>`.
      const gated = await runScript(gate, path.join(nested, "src"), ["sh", "-o", "errexit"]);
      started.push(gated);
      assert.deepEqual(waiting(), ["gated"], "in a folder of the nested worktree, the deepest checkout holding it: not the main checkout's agent");
      const atMain = await runScript(gate, main);
      started.push(atMain);
      assert.deepEqual(waiting(), ["gated", "mainline"], "through its shebang, in the main checkout");
      await gated.end();
      assert.deepEqual(waiting(), ["mainline"], "the nested worktree's gate open, its agent works again, and the main checkout's gate is not its");
      await atMain.end();
      assert.deepEqual(waiting(), []);
    } finally {
      await Promise.all(started.map((s) => s.end()));
    }
  });
});
