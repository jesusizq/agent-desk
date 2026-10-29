import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { InputError } from "../src/core/check.ts";
import { Store } from "../src/store/store.ts";
import { addSession, PNG, tempHome, testStore } from "./helpers.ts";

const run = promisify(execFile);
const WORKER = path.join(import.meta.dirname, "fixtures", "worker.ts");
const workers = (home: string, task: string, count: number, n: number) =>
  Promise.all(Array.from({ length: n }, () => run(process.execPath, [WORKER, home, task, String(count)])));

describe("store files", () => {
  it("creates the home 0700 and records 0600", () => {
    const store = testStore();
    addSession(store);
    assert.equal(fs.statSync(store.paths.home).mode & 0o777, 0o700);
    assert.equal(fs.statSync(store.paths.sessionsDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(store.paths.session("s1")).mode & 0o777, 0o600);
  });

  it("keeps one secret per install, 0600", () => {
    const store = testStore();
    const secret = store.secret();
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.equal(store.secret(), secret);
    assert.equal(new Store(store.paths.home).secret(), secret);
    assert.equal(fs.statSync(store.paths.secret).mode & 0o777, 0o600);
  });

  it("refuses ids that would leave the store", () => {
    const store = testStore();
    for (const bad of ["../x", "a/b", ".hidden", "", "a.b", "x".repeat(200)]) {
      assert.throws(() => store.getSession(bad), InputError, bad);
      assert.throws(() => store.paths.agent("s1", bad), InputError, bad);
    }
  });

  it("ignores temp and lock files, and reports a truncated record instead of hiding it", () => {
    const store = testStore();
    addSession(store);
    fs.writeFileSync(path.join(store.paths.sessionsDir, ".s2.json.123.tmp"), "{");
    fs.writeFileSync(path.join(store.paths.sessionsDir, ".s1.json.lock"), "");
    fs.writeFileSync(path.join(store.paths.sessionsDir, "s3.json"), '{"id": "s3", "prov');
    const snap = store.snapshot();
    assert.deepEqual(snap.sessions.map((s) => s.id), ["s1"]);
    assert.equal(snap.problems.length, 1);
    assert.match(snap.problems[0] ?? "", /s3\.json: not valid JSON/);
    assert.throws(() => store.listSessions(), /s3\.json: not valid JSON/);
  });

  it("rejects a record with a field of the wrong type, naming the file and field", () => {
    const store = testStore();
    addSession(store);
    const file = store.paths.session("s1");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...raw, state: "sleeping" }));
    assert.throws(() => store.getSession("s1"), (e: Error) => e.message.includes("s1.json.state") && e.message.includes("sleeping"));
  });
});

describe("concurrency", () => {
  it("loses no update when processes write the same record at once", async () => {
    const home = tempHome();
    await workers(home, "increment", 50, 6);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "counter.json"), "utf8")), 300);
  });

  it("never leaves a partial record while processes rewrite it", async () => {
    const store = testStore();
    addSession(store);
    store.upsertAgent("s1", "builder", { goal: "Build" });
    const writing = workers(store.paths.home, "agent", 40, 4);
    let reads = 0;
    while (reads < 300) {
      const agent = store.getAgent("s1", "builder");
      assert.equal(agent?.goal, "Build");
      reads++;
      await new Promise((r) => setImmediate(r));
    }
    await writing;
    assert.equal(fs.readdirSync(store.paths.agentDir("s1")).length, 1, "no temp or lock file left behind");
  });

  it("takes over at once a lock whose process is gone (a status line killed mid-write)", async () => {
    const store = testStore();
    addSession(store);
    const gone = execFile(process.execPath, ["-e", ""]);
    await new Promise((r) => gone.on("exit", r));
    const file = store.paths.agent("s1", "builder");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(file), `.${path.basename(file)}.lock`), `${gone.pid}.abc123`);
    const started = Date.now();
    store.upsertAgent("s1", "builder", { goal: "Build" });
    assert.ok(Date.now() - started < 1000, "no wait for the lock to age");
    assert.equal(store.getAgent("s1", "builder")?.goal, "Build");
  });

  it("hands each inbox answer to exactly one waiter", async () => {
    const store = testStore();
    addSession(store);
    const ids = Array.from({ length: 30 }, (_, i) => store.ask({ sessionId: "s1", kind: "question", text: `Q${i}?` }).id);
    const stop = store.listen("s1");
    for (const qid of ids) store.answerFromDesk(qid, "yes");
    stop();
    const outputs = await workers(store.paths.home, "take", 5, 4);
    const taken = outputs.flatMap((o) => JSON.parse(o.stdout) as string[]);
    assert.equal(taken.length, ids.length);
    assert.deepEqual([...taken].sort(), [...ids].sort());
  });
});

describe("questions", () => {
  it("lists open questions oldest first and closes them with the answer typed in the terminal", () => {
    const store = testStore();
    addSession(store);
    addSession(store, "s2");
    const a = store.ask({ sessionId: "s1", kind: "question", text: "Split the table?", options: ["Yes", "No"] });
    const b = store.ask({ sessionId: "s2", kind: "waiting", text: "Done. Next?" });
    const c = store.ask({ sessionId: "s1", kind: "permission", text: "Run npm test?" });
    assert.deepEqual(store.openQuestions().map((q) => q.id), [a.id, b.id, c.id]);

    const closed = store.closeOpen("s1", { answer: "Yes" });
    assert.equal(closed.length, 2);
    assert.deepEqual(store.getQuestion(a.id)?.answer?.text, "Yes");
    assert.equal(store.getQuestion(a.id)?.answer?.via, "terminal");
    assert.equal(store.getQuestion(c.id)?.status, "answered");
    assert.equal(store.getQuestion(c.id)?.answer, undefined, "a permission prompt records no typed answer");
    assert.deepEqual(store.openQuestions().map((q) => q.id), [b.id]);
  });

  it("closes only the kinds asked for", () => {
    const store = testStore();
    addSession(store);
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Which?" });
    const p = store.ask({ sessionId: "s1", kind: "permission", text: "Allow?" });
    store.closeOpen("s1", { kinds: ["permission"] });
    assert.equal(store.getQuestion(q.id)?.status, "open");
    assert.equal(store.getQuestion(p.id)?.status, "answered");
  });

  it("delivers a desk answer exactly as typed, once, only to the asking session", () => {
    const store = testStore();
    addSession(store);
    addSession(store, "s2");
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Name?" });
    store.listen("s1");
    const answer = "  «Ñandú» — no, *really*\n<b>x</b>  ";
    store.answerFromDesk(q.id, answer);
    assert.deepEqual(store.takeInbox("s2"), []);
    const [entry, ...rest] = store.takeInbox("s1");
    assert.equal(rest.length, 0);
    assert.equal(entry?.answer, answer);
    assert.equal(entry?.question, "Name?");
    assert.deepEqual(store.takeInbox("s1"), []);
    assert.equal(store.getQuestion(q.id)?.answer?.via, "desk");
    assert.throws(() => store.answerFromDesk(q.id, "again"), /already answered/);
  });

  it("refuses a desk answer while the session is not listening, so it cannot reach a later turn", () => {
    const store = testStore();
    addSession(store);
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Delete it?" });
    assert.throws(() => store.answerFromDesk(q.id, "yes"), /not taking answers/);
    assert.equal(store.getQuestion(q.id)?.status, "open");
    assert.deepEqual(fs.existsSync(store.paths.sessionInbox("s1")) ? fs.readdirSync(store.paths.sessionInbox("s1")) : [], []);
  });

  it("withdraws undelivered answers when the developer moves on in the terminal", () => {
    const store = testStore();
    addSession(store);
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Delete it?" });
    const stop = store.listen("s1");
    store.answerFromDesk(q.id, "yes");
    stop();
    const [changed] = store.withdrawInbox("s1", "no, keep it");
    assert.equal(changed?.answer?.text, "no, keep it");
    assert.equal(changed?.answer?.via, "terminal");
    assert.deepEqual(store.takeInbox("s1"), []);
  });

  it("puts readable answers back when another claimed entry is unreadable", () => {
    const store = testStore();
    addSession(store);
    const q = store.ask({ sessionId: "s1", kind: "question", text: "A?" });
    store.listen("s1");
    store.answerFromDesk(q.id, "yes");
    fs.writeFileSync(path.join(store.paths.sessionInbox("s1"), "zzz.json"), "{");
    assert.throws(() => store.takeInbox("s1"), /zzz\.json/);
    assert.deepEqual(store.takeInbox("s1").map((e) => e.answer), ["yes"]);
    assert.ok(fs.readdirSync(store.paths.sessionInbox("s1")).includes(".zzz.json.rejected"));
  });

  it("keeps a bounded copy of a very long typed answer", () => {
    const store = testStore();
    addSession(store);
    const q = store.ask({ sessionId: "s1", kind: "waiting", text: "Next?" });
    store.closeOpen("s1", { answer: "x".repeat(50_000) });
    assert.equal(store.getQuestion(q.id)?.answer?.text.length, 20_000);
  });

  it("keeps open questions apart from the history", () => {
    const store = testStore();
    addSession(store);
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Ok?" });
    assert.ok(fs.existsSync(store.paths.question(q.id, "open")));
    store.dismiss(q.id);
    assert.ok(!fs.existsSync(store.paths.question(q.id, "open")));
    assert.ok(fs.existsSync(store.paths.question(q.id, "closed")));
    assert.deepEqual(store.openQuestions(), []);
    assert.equal(store.listQuestions().length, 1);
  });

  it("refuses an empty answer from the desk", () => {
    const store = testStore();
    addSession(store);
    store.listen("s1");
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Ok?" });
    assert.throws(() => store.answerFromDesk(q.id, "   "), /empty/);
    assert.equal(store.getQuestion(q.id)?.status, "open");
  });

  it("carries images attached on the desk with the answer, and refuses them where only text is taken", () => {
    const store = testStore();
    addSession(store);
    store.listen("s1");
    const image = store.addImage(PNG);
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Which layout?" });
    store.answerFromDesk(q.id, "", [image]);
    assert.deepEqual(store.takeInbox("s1").map((e) => [e.answer, e.images]), [["", [image]]]);
    assert.deepEqual(store.getQuestion(q.id)?.answer?.images, [image]);
    assert.deepEqual(store.listMessages("s1").at(-1)?.images, [image]);
    const p = store.ask({ sessionId: "s1", kind: "permission", text: "Bash: ls", options: ["Allow", "Deny"] });
    assert.throws(() => store.answerFromDesk(p.id, "Deny", [image]), /text only/);
    const missing = store.ask({ sessionId: "s1", kind: "question", text: "Ok?" });
    assert.throws(() => store.answerFromDesk(missing.id, "see this", ["img-gone"]), /no image img-gone/);
    assert.equal(store.getQuestion(missing.id)?.status, "open");
    assert.throws(() => store.addImage(Buffer.from("<svg onload=alert(1)>")), /not a PNG, JPEG, WebP or GIF/);
  });

  it("reopens the question when the answer cannot reach the inbox", () => {
    const store = testStore();
    addSession(store);
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Ok?" });
    fs.mkdirSync(store.paths.inboxDir, { recursive: true });
    fs.writeFileSync(store.paths.sessionInbox("s1"), "not a directory");
    store.isListening = () => true; // the listener check cannot read a broken inbox; this test is about the write
    assert.throws(() => store.answerFromDesk(q.id, "yes"), /question is open again/);
    assert.equal(store.getQuestion(q.id)?.status, "open");
    assert.equal(store.getQuestion(q.id)?.answer, undefined);
  });

  it("attaches the session's interpretation to its latest answer", () => {
    const store = testStore();
    addSession(store);
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Ok?" });
    store.closeOpen("s1", { answer: "the second" });
    store.interpret("s1", "Use option B (keep the old table)");
    assert.equal(store.getQuestion(q.id)?.interpretation, "Use option B (keep the old table)");
  });

  it("requires a registered session", () => {
    const store = testStore();
    assert.throws(() => store.ask({ sessionId: "ghost", kind: "question", text: "?" }), /no session ghost/);
  });
});

describe("archive", () => {
  it("moves old closed questions, results with images and finished sessions to archive/, and keeps the rest", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const store = new Store(tempHome(), () => new Date(now));
    addSession(store, "old");
    addSession(store, "live");
    const dir = tempHome();
    fs.writeFileSync(path.join(dir, "a.png"), PNG);
    const oldQ = store.ask({ sessionId: "old", kind: "question", text: "Old?" });
    store.closeOpen("old", { answer: "yes" });
    const oldR = store.addResult({ sessionId: "old", title: "Old result", images: [{ path: path.join(dir, "a.png") }] });
    // An image attached to an answer from the desk, one attached and never sent, one a live session shows.
    const [answered, unsent, shown] = [store.addImage(PNG), store.addImage(PNG), store.addImage(PNG)];
    const stop = store.listen("old");
    store.answerFromDesk(store.ask({ sessionId: "old", kind: "question", text: "Which?" }).id, "this one", [answered]);
    store.takeInbox("old");
    stop();
    store.upsertAgent("old", "worker", { goal: "x" });
    store.updateSession("old", (s) => ({ ...s, state: "ended", endedAt: new Date(now).toISOString() }));
    now = Date.parse("2026-03-15T00:00:00.000Z");
    const openQ = store.ask({ sessionId: "live", kind: "question", text: "Still open?" });
    const old = Date.parse("2026-01-01T00:00:00.000Z") / 1000;
    for (const image of [answered, unsent, shown]) fs.utimesSync(store.imageFile(image)?.file ?? "", old, old);
    store.addMessage({ sessionId: "live", from: "developer", text: "", via: "desk", images: [shown] });
    const counts = store.archiveOlderThan(new Date("2026-03-01T00:00:00.000Z"));
    assert.deepEqual(counts, { questions: 2, results: 1, sessions: 1, images: 2 });
    assert.equal(store.imageFile(answered), undefined, "the image of an archived answer goes with it");
    assert.equal(store.imageFile(unsent), undefined, "an image attached and never sent goes");
    assert.ok(store.imageFile(shown), "an image a live message shows stays");
    assert.equal(store.getQuestion(oldQ.id), undefined);
    assert.ok(fs.existsSync(store.paths.archived(store.paths.question(oldQ.id, "closed"))));
    assert.deepEqual(store.listResults(), []);
    assert.equal(store.imageFile(oldR.images[0]?.id ?? ""), undefined);
    assert.equal(store.getSession("old"), undefined);
    assert.deepEqual(store.listAgents("old"), []);
    assert.equal(store.getQuestion(openQ.id)?.status, "open");
    assert.ok(store.getSession("live"));
  });
});

describe("agents and results", () => {
  it("creates an agent working, merges updates and stamps the end once", () => {
    const store = testStore();
    addSession(store);
    const a = store.upsertAgent("s1", "pay-button", { goal: "Pay button", after: ["api"] });
    assert.equal(a.state, "working");
    store.upsertAgent("s1", "pay-button", { branch: "agent/pay" });
    const done = store.upsertAgent("s1", "pay-button", { state: "done" });
    assert.equal(done.goal, "Pay button");
    assert.equal(done.branch, "agent/pay");
    assert.deepEqual(done.after, ["api"]);
    assert.ok(done.endedAt);
    assert.equal(store.upsertAgent("s1", "pay-button", { activity: "x" }).endedAt, done.endedAt);
  });

  it("copies images into the store and refuses what is not an image", () => {
    const store = testStore();
    addSession(store);
    const dir = tempHome();
    const png = path.join(dir, "before.png");
    fs.writeFileSync(png, PNG);
    fs.writeFileSync(path.join(dir, "evil.png"), "<svg onload=alert(1)>");
    const r = store.addResult({
      sessionId: "s1",
      title: "Checkout",
      images: [{ path: png, caption: "before" }, { path: png }],
      compare: { before: 0, after: 1 },
      url: "http://localhost:5173/checkout",
    });
    assert.equal(r.images.length, 2);
    const stored = store.imageFile(r.images[0]?.id ?? "");
    assert.equal(stored?.ext, "png");
    assert.equal(fs.statSync(stored?.file ?? "").mode & 0o777, 0o600);
    fs.rmSync(png);
    assert.ok(store.imageFile(r.images[0]?.id ?? ""), "the copy outlives the original");

    const before = fs.readdirSync(store.paths.imagesDir).length;
    fs.writeFileSync(png, PNG);
    assert.throws(() => store.addResult({ sessionId: "s1", title: "x", images: [{ path: png }, { path: path.join(dir, "evil.png") }] }), /not a PNG/);
    assert.equal(fs.readdirSync(store.paths.imagesDir).length, before, "no image is left behind by a refused result");
    assert.throws(() => store.addResult({ sessionId: "s1", title: "x", images: [{ path: dir }] }), /not a file/);
    assert.throws(() => store.addResult({ sessionId: "s1", title: "x", url: "https://example.com" }), /only local URLs/);
    assert.throws(() => store.addResult({ sessionId: "s1", title: "x", url: "javascript:alert(1)" }), /only local URLs/);
  });

  it("marks results seen and everything seen", () => {
    const store = testStore();
    addSession(store);
    const r = store.addResult({ sessionId: "s1", title: "Done" });
    assert.equal(r.seenAt, undefined);
    assert.ok(store.markResultSeen(r.id).seenAt);
    const seen = store.markAllSeen();
    assert.equal(store.getSeen()?.since, seen.since);
  });

  it("keeps one service per session and name", () => {
    const store = testStore();
    addSession(store);
    store.addService({ sessionId: "s1", name: "web", url: "http://localhost:5173" });
    store.addService({ sessionId: "s1", name: "web", url: "http://localhost:5174" });
    assert.deepEqual(store.listServices().map((s) => s.url), ["http://localhost:5174"]);
    assert.equal(store.removeService("s1", "web"), true);
    assert.deepEqual(store.listServices(), []);
  });
});
