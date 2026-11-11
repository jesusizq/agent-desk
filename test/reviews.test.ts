import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { inlinePage } from "../src/cli/review-page.ts";
import { InputError } from "../src/core/check.ts";
import { parseProgress, REVIEW_ROUNDS_KEPT, REVIEW_STATE_MAX, reviewLine } from "../src/core/model.ts";
import { reviewCsp } from "../src/server/security.ts";
import { reviewDocument } from "../src/server/server.ts";
import { readReviewChange, Store, Undeliverable } from "../src/store/store.ts";
import { Browser, findChrome } from "./browser.ts";
import { addSession, PNG, serve, tempHome, testStore } from "./helpers.ts";

const run = promisify(execFile);
const WORKER = path.join(import.meta.dirname, "fixtures", "worker.ts");
const SHIM = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "web", "review-shim.js"), "utf8");
const PAGE = "<!doctype html><html><head><title>Cards</title></head><body><p>12 cards</p></body></html>";

function withReview(title = "Proposals"): { store: Store; id: string } {
  const store = testStore();
  addSession(store);
  return { store, id: store.publishReview({ sessionId: "s1", title, html: PAGE }).id };
}

describe("reviews in the store", () => {
  it("publishes a page, and the same title again as its next round with the state carried over", () => {
    const { store, id } = withReview();
    assert.match(id, /^rv-/);
    store.changeReviewState(id, { ops: [{ op: "set", key: "card-1", value: "yes" }] }, "local");
    const again = store.publishReview({ sessionId: "s1", title: "  proposals ", html: PAGE.replace("12", "13") });
    assert.equal(again.id, id, "same project and title, case and spaces aside");
    assert.deepEqual(again.rounds.map((r) => r.n), [1, 2]);
    assert.equal(store.reviewPage(id)?.html.includes("13 cards"), true, "the latest round's page");
    assert.deepEqual(store.reviewState(id).data, { "card-1": "yes" });
    store.closeReview(id);
    assert.notEqual(store.publishReview({ sessionId: "s1", title: "Proposals", html: PAGE }).id, id, "a closed review is not continued");
    store.upsertSession({ id: "s2", provider: "Test", project: { name: "other", dir: "/work/other" } });
    assert.notEqual(store.publishReview({ sessionId: "s2", title: "Proposals", html: PAGE }).id, id, "nor one of another project");
  });

  it("keeps the page of the last rounds only, and every round's metadata", () => {
    const { store, id } = withReview();
    for (let i = 0; i < 6; i++) store.publishReview({ sessionId: "s1", title: "Proposals", html: PAGE });
    const review = store.getReview(id);
    assert.equal(review?.rounds.length, 7);
    const pages = fs.readdirSync(store.paths.reviewDir(id)).filter((n) => n.endsWith(".html")).sort();
    assert.deepEqual(pages, ["round-3.html", "round-4.html", "round-5.html", "round-6.html", "round-7.html"]);
    assert.equal(pages.length, REVIEW_ROUNDS_KEPT);
    assert.equal(fs.statSync(store.paths.reviewRound(id, 7)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(store.paths.reviewDir(id)).mode & 0o777, 0o700);
  });

  it("refuses a bad title, an oversize page and an unknown session", () => {
    const store = testStore();
    addSession(store);
    for (const title of ["", "two\nlines", "tab\there", "x".repeat(121)]) {
      assert.throws(() => store.publishReview({ sessionId: "s1", title, html: PAGE }), InputError, JSON.stringify(title));
    }
    assert.throws(() => store.publishReview({ sessionId: "s1", title: "Big", html: "x".repeat(25 * 1024 * 1024 + 1) }), /more than/);
    assert.throws(() => store.publishReview({ sessionId: "nobody", title: "T", html: PAGE }), /no session/);
    assert.deepEqual(store.listReviews(), [], "nothing was left behind");
  });

  it("applies the page's operations in order and counts one rev per change", () => {
    const { store, id } = withReview();
    const first = store.changeReviewState(id, { ops: [{ op: "set", key: "a", value: "1" }, { op: "set", key: "b", value: "2" }, { op: "remove", key: "a" }], progress: "12 of 97" }, "remote");
    assert.equal(first.rev, 1);
    assert.deepEqual(store.reviewState(id), { data: { b: "2" }, rev: 1 });
    const review = store.getReview(id);
    assert.deepEqual(review?.progress, { done: 12, total: 97 });
    assert.equal(review?.updatedFrom, "remote");
    assert.equal(store.changeReviewState(id, { ops: [], progress: "all done" }, "local").rev, 2, "an accepted change counts even with no operation");
    assert.deepEqual(store.getReview(id)?.progress, { done: 12, total: 97 }, "a counter without numbers leaves the progress");
    assert.equal(store.getReview(id)?.updatedFrom, "remote", "nor is it a change of the saved state");
    store.changeReviewState(id, { ops: [{ op: "clear" }], summary: "✓ 1\n✗ 2" }, "local");
    assert.deepEqual(store.reviewState(id), { data: {}, summary: "✓ 1\n✗ 2", rev: 3 });
    assert.equal(store.getReview(id)?.hasSummary, true);
    store.changeReviewState(id, { ops: [], summary: "" }, "local");
    assert.equal(store.getReview(id)?.hasSummary, false, "an empty summary clears it");
  });

  it("keeps a key such as __proto__ as a key", () => {
    const { store, id } = withReview();
    store.changeReviewState(id, readReviewChange(JSON.parse('{"ops":[{"op":"set","key":"__proto__","value":"x"},{"op":"set","key":"constructor","value":"y"}]}')), "local");
    const state = store.reviewState(id);
    assert.equal(Object.getPrototypeOf(state.data), Object.prototype);
    assert.deepEqual(Object.keys(state.data).sort(), ["__proto__", "constructor"]);
    assert.equal(state.data["__proto__"], "x");
  });

  it("refuses state past its limits, saving nothing", () => {
    const { store, id } = withReview();
    assert.throws(() => readReviewChange({ ops: [{ op: "set", key: "k".repeat(201), value: "v" }] }), /longer than 200/);
    assert.throws(() => readReviewChange({ ops: [{ op: "rename", key: "a" }] }), /expected one of/);
    assert.throws(() => readReviewChange({ ops: [{ op: "set", key: "a", value: 3 }] }), /expected text/);
    assert.throws(() => readReviewChange({ ops: [], summary: "s".repeat(200 * 1024 + 1) }), /longer than/);
    assert.throws(() => readReviewChange({ ops: [], progress: "p".repeat(201) }), /longer than 200/);
    const half = "v".repeat(REVIEW_STATE_MAX / 2);
    store.changeReviewState(id, { ops: [{ op: "set", key: "a", value: half }] }, "local");
    assert.throws(() => store.changeReviewState(id, { ops: [{ op: "set", key: "b", value: half }] }, "local"), /larger than/);
    assert.deepEqual(Object.keys(store.reviewState(id).data), ["a"]);
    assert.equal(store.reviewState(id).rev, 1);
  });

  it("merges two devices writing at once per key, losing no write", async () => {
    const { store, id } = withReview();
    await Promise.all(Array.from({ length: 2 }, () => run(process.execPath, [WORKER, store.paths.home, "review-state", "25"])));
    const state = store.reviewState(id);
    assert.equal(Object.keys(state.data).filter((k) => k !== "shared").length, 50);
    assert.equal(state.rev, 50);
    assert.ok(state.data.shared !== undefined, "the key both wrote holds the later write");
  });

  it("are part of what the page receives, and of what the feed watches", async () => {
    const { store, id } = withReview();
    const { deskState } = await import("../src/server/server.ts");
    assert.deepEqual(deskState(store).reviews.map((r) => r.id), [id]);
    assert.ok(store.stateDirs().includes(store.paths.reviewDir(id)), "a change from another device reaches an open page");
    fs.writeFileSync(path.join(store.paths.reviewsDir, "rv-broken"), "");
    fs.mkdirSync(path.join(store.paths.reviewsDir, "rv-bad"));
    fs.writeFileSync(path.join(store.paths.reviewsDir, "rv-bad", "review.json"), "{");
    assert.equal(deskState(store).reviews.length, 1);
    assert.match(deskState(store).problems.join("\n"), /rv-bad.*not valid JSON/, "an unreadable review is reported, not skipped");
  });

  it("leaves nothing behind when a send cannot be delivered", () => {
    const { store, id } = withReview();
    store.updateSession("s1", (s) => ({ ...s, state: "working", takesMessagesWhileWorking: true }));
    fs.mkdirSync(store.paths.inboxDir, { recursive: true });
    fs.writeFileSync(store.paths.sessionInbox("s1"), "not a folder");
    store.isListening = () => true; // the listener check cannot read a broken inbox; this test is about the write
    assert.throws(() => store.sendReview(id, "session", 0), /nothing was recorded/);
    assert.deepEqual(store.getReview(id)?.sends, []);
    assert.deepEqual(store.listQuestions(), []);
    assert.deepEqual(store.listMessages("s1"), []);
    assert.equal(store.getSession("s1")?.sentWhileWorking, undefined, "not noted as sent while it worked");
  });

  it("validates ids before they become paths", () => {
    const store = testStore();
    for (const bad of ["../x", "a/b", ".hidden", "", "a.json"]) assert.throws(() => store.paths.reviewDir(bad), /expected an id/, bad);
    assert.throws(() => store.paths.reviewRound("rv-1", 0), /from 1/);
  });

  it("parses the page's counter and builds the line from the review's fields", () => {
    assert.deepEqual(parseProgress("12/97"), { done: 12, total: 97 });
    assert.deepEqual(parseProgress("Reviewed 12 of 97"), { done: 12, total: 97 });
    assert.deepEqual(parseProgress("12 de 97"), { done: 12, total: 97 });
    assert.equal(parseProgress("98/97"), undefined);
    assert.equal(parseProgress("done"), undefined);
    const review = { id: "rv-1", title: "Proposals" };
    assert.equal(reviewLine(review, 2, { done: 37, total: 97 }, "session"), "Review «Proposals» sent from agent-desk (round 2, 37 of 97 reviewed). Read the answers with: agent-desk review rv-1");
    assert.equal(reviewLine(review, 1, undefined, "other"), "Pick up the review «Proposals» from agent-desk (round 1): agent-desk review rv-1");
  });
});

describe("inlining a page's images", () => {
  const page = (html: string, files: Record<string, Buffer> = {}) => {
    const dir = tempHome();
    for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), data);
    fs.writeFileSync(path.join(dir, "page.html"), html);
    return path.join(dir, "page.html");
  };

  it("takes linear time on markup that never closes", () => {
    const n = 200_000;
    for (const [name, html] of [
      ["unclosed quotes in tags", '<a href="x'.repeat(1) + '<img src="'.repeat(n)],
      ["tags with an unclosed quote", '<b title=\'x '.repeat(n)],
      ["unclosed script", `<script>${"<script>".repeat(n)}`],
      ["unclosed style", `<style>${"url(\"".repeat(n)}`],
      ["unclosed comments", "<!--".repeat(n)],
      ["url( without a closing parenthesis", `<style>${"url(a".repeat(n)}</style>`],
      ["style attributes", `<p style="${"url( ".repeat(n)}">`],
      ["a long srcset", `<img srcset="${"a.png 1x, ,,".repeat(n)}">`],
      ["many tags", "<i a=b c='d'>".repeat(n)],
    ] as const) {
      const started = performance.now();
      const out = inlinePage(page(html));
      const ms = performance.now() - started;
      assert.ok(ms < 3000, `${name}: ${Math.round(ms)} ms`);
      assert.equal(out.inlined, 0, name);
    }
  });

  it("stops with an error past the page limit, however often one image is named", () => {
    const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
    const html = `<html><head></head><body>${'<img src="a.png">'.repeat(30)}</body></html>`;
    assert.throws(() => inlinePage(page(html, { "a.png": big })), (error: unknown) => error instanceof InputError && /larger than 26214400 bytes \(at "a\.png"\)/.test(error.message));
    assert.equal(inlinePage(page(html.replace(/<img src="a.png">/g, '<img src="b.png">').replace('<img src="b.png">', '<img src="a.png">'), { "a.png": big })).inlined, 1, "once is within the limit");
  });
});

describe("the review document", () => {
  it("puts the state and the shim right after <head>, with < escaped", () => {
    const doc = reviewDocument('<!doctype html><html><HEAD lang="x"><title>t</title></HEAD><header>h</header></html>', { data: { k: "</script><b>" }, rev: 3 }, "SHIM");
    assert.equal(doc, '<!doctype html><html><HEAD lang="x"><script>window.__agentDeskReview={"data":{"k":"\\u003c/script>\\u003cb>"},"rev":3};</script><script>SHIM</script><title>t</title></HEAD><header>h</header></html>');
    assert.equal(reviewDocument("<header>no head</header>", { data: {}, rev: 0 }, "S"), '<script>window.__agentDeskReview={"data":{},"rev":0};</script><script>S</script><header>no head</header>');
  });

  it("has a shim that cannot end its own script element", () => {
    assert.doesNotMatch(SHIM, /<\/script/i);
    assert.doesNotMatch(SHIM, /<!--/);
  });
});

describe("review routes", () => {
  it("serve the page only with the sandbox CSP, never with the desk's", async () => {
    const { store, id } = withReview();
    store.changeReviewState(id, { ops: [{ op: "set", key: "a", value: "<x>" }] }, "local");
    const server = await serve(store);
    try {
      for (const route of [`/review/${id}`, `/review/${id}/raw`]) {
        const res = await fetch(server.base + route);
        assert.equal(res.status, 200, route);
        assert.equal(res.headers.get("content-security-policy"), reviewCsp(server.base), route);
        assert.equal(res.headers.get("x-content-type-options"), "nosniff");
        assert.equal(res.headers.get("referrer-policy"), "no-referrer");
        assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
        assert.equal(res.headers.get("x-frame-options"), null, "the desk frames it");
        const body = await res.text();
        assert.equal(body.includes("window.__agentDeskReview"), !route.endsWith("/raw"), route);
        if (!route.endsWith("/raw")) assert.ok(body.includes(SHIM) && body.includes('"a":"\\u003cx>"'));
      }
      assert.equal(reviewCsp(server.base), `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors ${server.base}`);
      const viaLocalhost = await new Promise<string>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: server.port, path: `/review/${id}`, headers: { Host: `localhost:${server.port}` } }, (res) => {
          res.resume();
          resolve(String(res.headers["content-security-policy"]));
        }).on("error", reject);
      });
      assert.equal(viaLocalhost, reviewCsp(`http://localhost:${server.port}`), "framed only by the desk at the origin it was reached at");
      const state = await fetch(`${server.base}/api/reviews/${id}/state`);
      assert.deepEqual(await state.json(), { data: { a: "<x>" }, rev: 1 });
      assert.equal((await fetch(`${server.base}/review-shim.js`)).status, 200, "the service worker builds the page offline with it");
      const desk = await fetch(server.base + "/");
      assert.doesNotMatch(desk.headers.get("content-security-policy") ?? "", /frame-src|child-src/, "default-src 'self' lets the desk frame its own /review/");
    } finally {
      await server.close();
    }
  });

  it("refuse bad ids, traversal and unknown reviews", async () => {
    const { store } = withReview();
    const server = await serve(store);
    const raw = (route: string) =>
      new Promise<number>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: server.port, path: route, headers: { Host: `127.0.0.1:${server.port}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }).on("error", reject);
      });
    try {
      for (const route of ["/review/..%2Fsecret", "/review/.hidden", "/api/reviews/..%2F..%2Fsecret/state", "/review/a.b/raw"]) assert.equal(await raw(route), 400, route);
      for (const route of ["/review/../secret", "/review/rv-x/raw/more", "/review/rv-x/state"]) assert.equal(await raw(route), 404, route);
      assert.equal(await raw("/review/rv-unknown"), 404);
      assert.equal(await raw("/api/reviews/rv-unknown/state"), 404);
    } finally {
      await server.close();
    }
  });

  it("stay locked for a tailnet device without the PIN", async () => {
    const { store, id } = withReview();
    const remote = { host: "laptop.tail1234.ts.net:8443", user: "dev@example.com" };
    const server = await serve(store, remote);
    const call = (route: string, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: server.port, path: route, headers: { Host: remote.host, "Tailscale-User-Login": remote.user, ...headers } }, (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, headers: res.headers });
        }).on("error", reject);
      });
    try {
      for (const route of [`/review/${id}`, `/review/${id}/raw`, `/api/reviews/${id}/state`, "/review-shim.js"]) assert.equal((await call(route)).status, 401, route);
      const { RemoteUnlock, setPin } = await import("../src/server/remote-unlock.ts");
      setPin(store.paths.pin, "424242");
      const cookie = new RemoteUnlock(store.paths.pin, store.secret()).unlock("424242").split(";")[0] ?? "";
      const open = await call(`/review/${id}`, { Cookie: cookie });
      assert.equal(open.status, 200);
      assert.equal(open.headers["content-security-policy"], reviewCsp(`https://${remote.host}`));
      assert.ok(open.headers["x-agent-desk-unlock-ends"], "the device deletes its copy when the unlock ends");
    } finally {
      await server.close();
    }
  });
});

describe("review writes", () => {
  it("need the secret and the exact Origin, and validate every body", async () => {
    const { store, id } = withReview();
    const server = await serve(store);
    const secret = store.secret();
    const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(server.base + route, { method: "POST", headers: { "Content-Type": "application/json", Origin: server.base, "X-Agent-Desk-Secret": secret, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    try {
      const ops = { ops: [{ op: "set", key: "a", value: "1" }] };
      for (const headers of [{ Origin: "http://evil.example" }, { Origin: "null" }, { "X-Agent-Desk-Secret": "0".repeat(64) }]) {
        for (const action of ["state", "send", "opened", "close"]) assert.equal((await post(`/api/reviews/${id}/${action}`, action === "send" ? { to: "other", rev: 0 } : ops, headers)).status, 403, `${action} ${JSON.stringify(headers)}`);
      }
      assert.equal(store.reviewState(id).rev, 0, "nothing was written");
      assert.deepEqual(await (await post(`/api/reviews/${id}/state`, { ...ops, progress: "1 of 4" })).json(), { rev: 1 });
      assert.deepEqual(store.getReview(id)?.progress, { done: 1, total: 4 });
      for (const bad of [{ ops: [{ op: "set", key: "a" }] }, { ops: "set" }, { ops: [], summary: 7 }, { ops: [{ op: "set", key: "k".repeat(201), value: "" }] }]) {
        assert.equal((await post(`/api/reviews/${id}/state`, bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await post(`/api/reviews/${id}/state`, "{not json")).status, 400);
      const big = await post(`/api/reviews/${id}/state`, { ops: [{ op: "set", key: "big", value: "v".repeat(REVIEW_STATE_MAX + 1) }] });
      assert.equal(big.status, 400);
      assert.match(((await big.json()) as { error: string }).error, /longer than|larger than/);
      assert.equal((await post(`/api/reviews/${id}/state`, { ops: [{ op: "set", key: "x", value: "v".repeat(6 * 1024 * 1024) }] })).status, 400, "past the body limit");
      assert.equal((await post(`/api/reviews/../state`, ops)).status, 404);
      assert.equal((await post(`/api/reviews/a.b/state`, ops)).status, 400);
      assert.equal((await post(`/api/reviews/rv-none/opened`, {})).status, 400);
      assert.equal((await post(`/api/reviews/${id}/send`, { to: "everyone", rev: 1 })).status, 400);
      assert.ok((await (await post(`/api/reviews/${id}/opened`, {})).json() as { openedAt?: string }).openedAt);
      assert.ok((await (await post(`/api/reviews/${id}/close`, {})).json() as { closedAt?: string }).closedAt);
      assert.equal(store.reviewState(id).rev, 1);
    } finally {
      await server.close();
    }
  });

  it("send the line the server builds: to the session while it takes messages, else 409 with the reason", async () => {
    const { store, id } = withReview("Proposals «2»");
    const server = await serve(store);
    const post = (to: string, rev: unknown = 1) => fetch(`${server.base}/api/reviews/${id}/send`, { method: "POST", headers: { "Content-Type": "application/json", Origin: server.base, "X-Agent-Desk-Secret": store.secret() }, body: JSON.stringify({ to, rev }) });
    try {
      store.changeReviewState(id, { ops: [], progress: "Done: 3/9 <b>", summary: "<b>my answers</b>" }, "local");
      const stale = await post("other", 0);
      assert.equal(stale.status, 409);
      const body = (await stale.json()) as { error: string; stale?: boolean; rev?: number };
      assert.deepEqual([body.stale, body.rev], [true, 1], "sent from an older view: only what the developer saw is recorded");
      assert.match(body.error, /changed since it was shown/);
      assert.equal((await post("other", "1")).status, 400, "rev is a number");
      assert.equal((await post("other", null)).status, 400, "and required");
      const refused = await post("session");
      assert.equal(refused.status, 409);
      assert.match(((await refused.json()) as { error: string }).error, /not taking messages.*another conversation/);
      assert.equal(store.getReview(id)?.sends.length, 0, "nothing recorded");
      assert.equal(store.listQuestions().length, 0);
      const stop = store.listen("s1");
      const sent = await post("session");
      assert.equal(sent.status, 200);
      const line = `Review «Proposals «2»» sent from agent-desk (round 1, 3 of 9 reviewed). Read the answers with: agent-desk review ${id}`;
      assert.deepEqual(await sent.json(), { line });
      assert.deepEqual(store.takeInbox("s1").map((e) => e.answer), [line], "delivered verbatim, as the desk showed it");
      assert.equal(store.listMessages("s1").at(-1)?.text, line);
      stop();
      const other = await post("other");
      assert.deepEqual(await other.json(), { line: `Pick up the review «Proposals «2»» from agent-desk (round 1, 3 of 9 reviewed): agent-desk review ${id}` });
      assert.deepEqual(store.getReview(id)?.sends.map((s) => [s.to, s.round, s.progress]), [["s1", 1, { done: 3, total: 9 }], [null, 1, { done: 3, total: 9 }]]);
      const decisions = store.listQuestions();
      assert.equal(decisions.length, 2);
      assert.ok(decisions.every((q) => q.status === "answered" && q.answer?.text === "<b>my answers</b>" && q.answer.via === "review" && q.review?.id === id && q.text === "Review «Proposals «2»», round 1"));
      assert.deepEqual(store.openQuestions(), [], "never in Needs you");
      const found = store.decisions({ project: { dir: "/work/shop" }, search: "my answers", limit: 10 });
      assert.equal(found.total, 2);
      store.upsertSession({ id: "s1", provider: "Test", project: { name: "shop", dir: "/work/shop" }, state: "ended" });
      assert.match(((await (await post("session")).json()) as { error: string }).error, /has ended/);
    } finally {
      await server.close();
    }
  });

  it("from a tailnet device, only behind the PIN and from its https origin", async () => {
    const { store, id } = withReview();
    const remote = { host: "laptop.tail1234.ts.net:8443", user: "dev@example.com" };
    const server = await serve(store, remote);
    const call = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: server.port, method: "POST", path: `/api/reviews/${id}/state`, headers: { Host: remote.host, "Tailscale-User-Login": remote.user, "Content-Type": "application/json", "X-Agent-Desk-Secret": store.secret(), ...headers } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end(JSON.stringify({ ops: [{ op: "set", key: "phone", value: "yes" }] }));
      });
    try {
      assert.equal(await call({ Origin: `https://${remote.host}` }), 401, "locked without the PIN");
      const { RemoteUnlock, setPin } = await import("../src/server/remote-unlock.ts");
      setPin(store.paths.pin, "424242");
      const cookie = new RemoteUnlock(store.paths.pin, store.secret()).unlock("424242").split(";")[0] ?? "";
      assert.equal(await call({ Origin: `http://127.0.0.1:${server.port}`, Cookie: cookie }), 403);
      assert.equal(await call({ Origin: `https://${remote.host}`, Cookie: cookie }), 200);
      assert.equal(store.getReview(id)?.updatedFrom, "remote");
    } finally {
      await server.close();
    }
  });
});

describe("Undeliverable", () => {
  it("is an input error", () => assert.ok(new Undeliverable("x") instanceof InputError));
});

const chrome = findChrome();
if (!chrome && process.env.CI) throw new Error("no Chrome found: install one or set AGENT_DESK_CHROME");

describe("the shim in a browser", { skip: chrome ? false : "no Chrome found (set AGENT_DESK_CHROME)" }, () => {
  let browser: Browser;
  let store: Store;
  let server: Awaited<ReturnType<typeof serve>>;
  let reviewId: string;
  before(async () => {
    const home = path.join(tempHome(), "store");
    execFileSync(process.execPath, [path.join(import.meta.dirname, "../scripts/demo.ts"), home]);
    store = new Store(home);
    const review = store.listReviews().find((r) => r.title === "Checkout copy proposals");
    assert.ok(review, "the demo has a review partly done");
    reviewId = review.id;
    server = await serve(store);
    browser = await Browser.launch(chrome ?? "");
  });
  after(async () => {
    try {
      await browser?.close();
    } finally {
      await server?.close();
    }
  });

  it("routes the page's storage and copied text to the desk, from its saved state", async () => {
    const page = await browser.newPage(1000, 700);
    try {
      // Opened on its own, the page's parent is itself: what the shim posts arrives here.
      await page.goto(`${server.base}/review/${reviewId}`);
      await page.eval(`(window.seen = [], addEventListener("message", (e) => e.data?.agentDesk && seen.push(e.data)), true)`);
      assert.equal(await page.eval("document.getElementById('count').textContent"), "3/6", "the saved state is the page's localStorage");
      assert.equal(await page.eval("origin"), "null", "the page has no origin: it can reach nothing of the desk");
      await page.click("article[data-i='2'] [data-v='yes']");
      await page.waitFor("seen.some((m) => m.type === 'progress' && m.text === '4/6')");
      const set = await page.eval<{ type: string; key: string; value: string }>("seen.find((m) => m.type === 'set')");
      assert.deepEqual({ ...set, value: JSON.parse(set.value) }, { agentDesk: 1, type: "set", key: "checkout-copy", value: { 0: "yes", 1: "no", 2: "yes", 3: "yes" } });
      await page.eval(`postMessage({ type: "collect" }, "*")`);
      await page.waitFor("seen.some((m) => m.type === 'copy')");
      const copied = await page.eval<string>("seen.find((m) => m.type === 'copy').text");
      assert.match(copied, /^✓ Pay button: Pay €42.90 now\n✗ Summary title/);
      assert.equal(await page.eval("seen.some((m) => m.type === 'notice')"), false, "the 'copied' alert after a copy is the desk's to show");
      assert.equal(await page.eval("window.open('https://example.com') === null && confirm('Sure?') === false"), true);
      await page.waitFor("seen.some((m) => m.type === 'notice' && m.text === 'Sure?')");
      assert.equal(await page.eval("sessionStorage.setItem('x', '1'), sessionStorage.getItem('x')"), "1");
      assert.equal(await page.eval("seen.filter((m) => m.type === 'set').length"), 1, "sessionStorage stays in memory");
      assert.deepEqual(page.errors, []);
    } finally {
      await page.close();
    }
  });

  it("can be framed by the desk, and restores the scroll fraction it is opened at", async () => {
    const page = await browser.newPage(1000, 700);
    try {
      await page.goto(`${server.base}/`);
      await page.eval(`(() => {
        window.framed = [];
        const frame = document.createElement("iframe");
        frame.style.cssText = "position:fixed;inset:0;width:300px;height:200px";
        addEventListener("message", (e) => e.source === frame.contentWindow && e.data?.agentDesk && framed.push(e.data));
        frame.src = "/review/${reviewId}#at=1";
        document.body.append(frame);
        return true;
      })()`);
      await page.waitFor("framed.some((m) => m.type === 'progress' && m.text === '3/6')");
      await page.waitFor("framed.some((m) => m.type === 'scroll' && m.at > 0.9)");
    } finally {
      await page.close();
    }
  });
});
