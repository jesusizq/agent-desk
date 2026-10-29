import assert from "node:assert/strict";
import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createDeskServer } from "../src/server/server.ts";
import type { Store } from "../src/store/store.ts";
import { addSession, PNG, tempHome, testStore } from "./helpers.ts";

let store: Store;
let base: string;
let port: number;
let secret: string;
const server = { close: () => {} };

before(async () => {
  store = testStore();
  addSession(store);
  secret = store.secret();
  // Bind first to learn a free port, then build the server for that port (it checks Host against it).
  const probe = createDeskServer(store, 0);
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const real = createDeskServer(store, port);
  await new Promise<void>((r) => real.listen(port, "127.0.0.1", r));
  server.close = () => real.close();
  base = `http://127.0.0.1:${port}`;
});
after(() => server.close());

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
  });

  it("returns the state and a 304 while nothing changes", async () => {
    const first = await fetch(base + "/api/state");
    const data = (await first.json()) as { sessions: { id: string }[]; problems: string[] };
    assert.deepEqual(data.sessions.map((s) => s.id), ["s1"]);
    const again = await fetch(base + "/api/state", { headers: { "If-None-Match": first.headers.get("etag") ?? "" } });
    assert.equal(again.status, 304);
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

  it("rejects malformed ids and bodies", async () => {
    assert.equal((await post("/api/questions/..%2F..%2Fsecret/answer", { text: "x" })).status, 400);
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Ok?" });
    assert.equal((await post(`/api/questions/${q.id}/answer`, { text: 42 })).status, 400);
    assert.equal((await post(`/api/questions/${q.id}/answer`, "x".repeat(70_000))).status, 400);
    assert.equal(store.getQuestion(q.id)?.status, "open");
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

  it("marks results and everything as seen", async () => {
    const r = store.addResult({ sessionId: "s1", title: "Done" });
    assert.equal((await post(`/api/results/${r.id}/seen`, {})).status, 200);
    assert.ok(store.listResults().find((x) => x.id === r.id)?.seenAt);
    assert.equal((await post("/api/seen", {})).status, 200);
    assert.ok(store.getSeen());
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
    const probe = createDeskServer(store, 0, remote);
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const server = createDeskServer(store, port, remote);
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
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
      assert.equal(await call("POST", "/api/seen", { ...write, Origin: `https://${remote.host}` }, "{}"), 200);
      assert.equal(await call("POST", "/api/seen", { ...write, Origin: `http://${remote.host}` }, "{}"), 403);
    } finally {
      server.close();
    }
  });
});

describe("PIN in front of remote access", () => {
  it("shows only the PIN page until the right PIN, then lets the device in for 12 hours", async () => {
    const store = testStore();
    addSession(store);
    const remote = { host: "laptop.tail1234.ts.net:8443", user: "dev@example.com" };
    const { setPin } = await import("../src/server/remote-unlock.ts");
    const probe = createDeskServer(store, 0, remote);
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const server = createDeskServer(store, port, remote);
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    const http = await import("node:http");
    const call = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
      new Promise<{ status: number; body: string; cookie?: string }>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, method, path, headers: { Host: remote.host, "Tailscale-User-Login": remote.user, ...headers } },
          (res) => {
            let text = "";
            res.on("data", (d: Buffer) => (text += d));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, ...(res.headers["set-cookie"]?.[0] ? { cookie: res.headers["set-cookie"][0] } : {}) }));
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
      for (const asset of ["/unlock.js", "/dom.js", "/text.js", "/theme.js", "/style.css"]) assert.equal((await call("GET", asset)).status, 200, `the PIN page loads ${asset}`);
      assert.equal((await call("GET", "/app.js")).status, 401, "but not the desk itself");
      assert.equal((await call("GET", "/api/state")).status, 401);
      assert.match((await unlock("123456")).body, /no PIN is set/);

      setPin(store.paths.pin, "424242");
      assert.equal((await unlock("000000")).status, 400);
      assert.equal((await call("POST", "/api/unlock", { Origin: "https://evil.example", "Content-Type": "application/json" }, '{"pin":"424242"}')).status, 403);
      const ok = await unlock("424242");
      assert.equal(ok.status, 200);
      assert.match(ok.cookie ?? "", /HttpOnly; Secure; SameSite=Strict/);
      const cookie = (ok.cookie ?? "").split(";")[0] ?? "";
      assert.equal((await call("GET", "/api/state", { Cookie: cookie })).status, 200);
      const again = await call("POST", "/api/unlock", { Cookie: cookie, Origin: `https://${remote.host}`, "Content-Type": "application/json" }, '{"pin":"000000"}');
      assert.equal(again.status, 200, "an unlocked device sending the PIN again (an old PIN page) is told it is unlocked");
      assert.ok((await call("GET", "/", { Cookie: cookie })).body.includes(store.secret()), "unlocked, the device gets the desk");
      assert.equal((await call("GET", "/api/state", { Cookie: cookie.replace(/.$/, "x") })).status, 401, "a tampered cookie does not unlock");

      for (let i = 0; i < 5; i++) await unlock("111111");
      assert.match((await unlock("424242")).body, /too many wrong PINs/, "five failures lock out even the right PIN");
      const local = await new Promise<number>((resolve) => http.get({ host: "127.0.0.1", port, path: "/api/state" }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }));
      assert.equal(local, 200, "this machine never needs the PIN");
    } finally {
      server.close();
    }
  });
});

