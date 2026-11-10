import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { InputError } from "../src/core/check.ts";
import { procInfo } from "../src/core/proc.ts";
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

  it("gives each agent added at once its own name", async () => {
    const store = testStore();
    addSession(store);
    await workers(store.paths.home, "add", 5, 4);
    const agents = store.listAgents("s1");
    assert.equal(new Set(agents.map((a) => a.ref)).size, 20, "no agent took another's record");
    assert.deepEqual(agents.map((a) => a.name).sort(), ["worker", ...Array.from({ length: 19 }, (_, i) => `worker-${i + 2}`)].sort());
  });

  it("keeps one record when processes rename an agent while others report it under the new name", async () => {
    const store = testStore();
    addSession(store);
    store.upsertAgent("s1", "worker", { type: "workflow-subagent", ref: "a1", state: "done" });
    await Promise.all([workers(store.paths.home, "rename", 10, 3), workers(store.paths.home, "report", 10, 3)]);
    assert.deepEqual(store.listAgents("s1").map((a) => [a.name, a.ref, a.state, a.summary]), [["build-api", "a1", "done", "Builds the API"]]);
    assert.deepEqual(fs.readdirSync(store.paths.agentDir("s1")), ["build-api.json"], "no temp or lock file left behind");
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

  it("counts every message on its session while processes add messages and update the session at once", async () => {
    const store = testStore();
    addSession(store);
    await Promise.all([workers(store.paths.home, "message", 25, 4), workers(store.paths.home, "activity", 25, 2)]);
    assert.equal(store.getSession("s1")?.messageCount, 100);
    assert.equal(store.listMessages("s1").length, 100);
    assert.match(store.getSession("s1")?.activity ?? "", /^Edit /, "the other updates are kept too");
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

  it("keeps whether several options can be picked and the group a question was asked in", () => {
    const store = testStore();
    addSession(store);
    const group = { id: "dialog-1", index: 1, size: 2 };
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Which sections?", options: ["Guides", "Blog"], dialog: true, several: true, group });
    assert.deepEqual([store.getQuestion(q.id)?.several, store.getQuestion(q.id)?.group], [true, group]);
    const plain = store.ask({ sessionId: "s1", kind: "question", text: "Which one?", options: ["A", "B"] });
    assert.deepEqual([plain.several, plain.group], [undefined, undefined], "a question asked alone carries neither");
    const file = store.paths.question(q.id, "open");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [field, bad, named] of [
      ["several", "yes", "several"],
      ["group", "dialog-1", "group"],
      ["group", { id: "../x", index: 0, size: 2 }, "group.id"],
      ["group", { id: "dialog-1", index: 2, size: 2 }, "group.index"],
      ["group", { id: "dialog-1", index: 0, size: 1 }, "group.size"],
      ["group", { id: "dialog-1", index: 0 }, "group.size"],
    ] as const) {
      fs.writeFileSync(file, JSON.stringify({ ...raw, [field]: bad }));
      assert.throws(() => store.getQuestion(q.id), (e: Error) => e.message.includes(`.${named}`), `${field}: ${JSON.stringify(bad)}`);
    }
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

  it("reopens the question, and takes its message back, when the answer cannot reach the inbox", () => {
    const store = testStore();
    addSession(store);
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Ok?" });
    fs.mkdirSync(store.paths.inboxDir, { recursive: true });
    fs.writeFileSync(store.paths.sessionInbox("s1"), "not a directory");
    store.isListening = () => true; // the listener check cannot read a broken inbox; this test is about the write
    const count = store.getSession("s1")?.messageCount;
    assert.throws(() => store.answerFromDesk(q.id, "yes"), /question is open again/);
    assert.equal(store.getQuestion(q.id)?.status, "open");
    assert.equal(store.getQuestion(q.id)?.answer, undefined);
    assert.deepEqual(store.listMessages("s1"), [], "its conversation shows no answer as sent");
    assert.equal(store.getSession("s1")?.messageCount ?? 0, count ?? 0);
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

describe("forgetting a session", () => {
  const own = procInfo(process.pid);
  /** A session whose recorded process is this test's own (live), or a pid now held by another process (gone). */
  const withProcess = (store: Store, id: string, live: boolean) =>
    store.updateSession(id, (s) => ({ ...s, process: { pid: process.pid, start: live ? (own?.start ?? "") : "0", ancestors: [] } }));

  it("takes an ended session off the desk: what it asked dismissed, its results seen, its record and history kept", () => {
    const store = testStore();
    addSession(store);
    addSession(store, "other");
    const open = store.ask({ sessionId: "s1", kind: "question", text: "Still there?" });
    const answered = store.ask({ sessionId: "s1", kind: "question", text: "Which?" });
    store.closeOpen("s1", { answer: "this one", which: (q) => q.id === answered.id });
    const otherQ = store.ask({ sessionId: "other", kind: "question", text: "Other?" });
    const result = store.addResult({ sessionId: "s1", title: "Done", url: "http://localhost:3000" });
    const seenBefore = store.markResultSeen(store.addResult({ sessionId: "s1", title: "Seen earlier", url: "http://localhost:3000" }).id);
    const otherR = store.addResult({ sessionId: "other", title: "Other's", url: "http://localhost:3000" });
    store.updateSession("s1", (s) => ({ ...s, state: "ended", endedAt: "2026-10-28T08:00:01.000Z", endedAsking: true, lastMessage: { text: "Bye", at: "2026-10-28T08:00:01.000Z" } }));
    const out = store.forgetSession("s1");
    assert.deepEqual([out.dismissed, out.seen], [1, 1]);
    const s = store.getSession("s1");
    assert.equal(s?.state, "ended");
    assert.equal(s?.endedAt, "2026-10-28T08:00:01.000Z", "the end it recorded is kept");
    assert.equal(s?.endedAsking, undefined);
    assert.ok(s?.readAt && s.lastMessage && s.readAt > s.lastMessage.at, "read, so it no longer waits to be opened");
    assert.equal(store.getQuestion(open.id)?.status, "dismissed");
    assert.equal(store.getQuestion(answered.id)?.answer?.text, "this one", "the history keeps its decisions");
    assert.ok(store.listResults().find((r) => r.id === result.id)?.seenAt, "its result stays, seen");
    assert.equal(store.listResults().find((r) => r.id === seenBefore.id)?.seenAt, seenBefore.seenAt);
    assert.equal(store.getQuestion(otherQ.id)?.status, "open", "another session is left alone");
    assert.equal(store.listResults().find((r) => r.id === otherR.id)?.seenAt, undefined);
    assert.deepEqual([store.forgetSession("s1").dismissed, store.forgetSession("s1").seen], [0, 0], "forgetting again changes nothing");
  });

  it("forgets a session whose process is gone, marking it ended, and withdraws an answer still waiting in its inbox", () => {
    const store = testStore();
    addSession(store);
    withProcess(store, "s1", false);
    const q = store.ask({ sessionId: "s1", kind: "question", text: "Which?" });
    const stop = store.listen("s1");
    store.answerFromDesk(q.id, "never delivered");
    stop();
    const out = store.forgetSession("s1");
    assert.equal(out.dismissed, 1);
    assert.equal(store.getSession("s1")?.state, "ended");
    assert.ok(store.getSession("s1")?.endedAt);
    assert.equal(store.getQuestion(q.id)?.status, "dismissed");
    assert.deepEqual(store.takeInbox("s1"), [], "nothing left for a session that will never read it");
  });

  it("never forgets a session still running, and changes nothing trying", () => {
    const store = testStore();
    addSession(store, "live");
    withProcess(store, "live", true);
    addSession(store, "unknown"); // no process recorded and not ended: it may be running
    for (const id of ["live", "unknown"]) {
      const q = store.ask({ sessionId: id, kind: "question", text: "Still open?" });
      const before = store.getSession(id);
      assert.throws(() => store.forgetSession(id), (e: unknown) => e instanceof InputError && /still running/.test(e.message));
      assert.deepEqual(store.getSession(id), before);
      assert.equal(store.getQuestion(q.id)?.status, "open");
    }
    assert.throws(() => store.forgetSession("missing"), InputError);
  });

  it("closes only what the session had when it was forgotten, should it come back meanwhile", () => {
    const store = testStore();
    addSession(store);
    store.updateSession("s1", (s) => ({ ...s, state: "ended" }));
    const earlier = store.ask({ sessionId: "s1", kind: "question", text: "Before?" });
    // A session resumed under the same id while the forget runs: what it asks from then on is new.
    const resumed = new Store(store.paths.home, () => new Date("2026-10-28T09:00:00.000Z"));
    const later = resumed.ask({ sessionId: "s1", kind: "question", text: "After?" });
    const result = resumed.addResult({ sessionId: "s1", title: "After", url: "http://localhost:3000" });
    store.forgetSession("s1");
    assert.equal(store.getQuestion(earlier.id)?.status, "dismissed");
    assert.equal(store.getQuestion(later.id)?.status, "open");
    assert.equal(store.listResults().find((r) => r.id === result.id)?.seenAt, undefined);
  });

  it("loses no update while processes forget a session and its hooks still write to it", async () => {
    const store = testStore();
    addSession(store);
    store.updateSession("s1", (s) => ({ ...s, state: "ended" }));
    const ids = Array.from({ length: 20 }, (_, i) => store.ask({ sessionId: "s1", kind: "question", text: `Q${i}?` }).id);
    for (let i = 0; i < 10; i++) store.addResult({ sessionId: "s1", title: `R${i}`, url: "http://localhost:3000" });
    await Promise.all([workers(store.paths.home, "forget", 5, 3), workers(store.paths.home, "activity", 25, 2)]);
    const s = store.getSession("s1");
    assert.equal(s?.state, "ended");
    assert.ok(s?.readAt);
    assert.match(s?.activity ?? "", /^Edit /, "the hooks' updates are kept too");
    assert.deepEqual(ids.map((id) => store.getQuestion(id)?.status), ids.map(() => "dismissed"));
    assert.ok(store.listResults().every((r) => r.seenAt));
  });
});

describe("messages", () => {
  it("keeps the order of messages recorded in the same millisecond", () => {
    const store = new Store(tempHome(), () => new Date("2026-10-30T09:00:00.000Z"));
    addSession(store);
    const texts = Array.from({ length: 40 }, (_, i) => `step ${i}`);
    for (const text of texts) store.addMessage({ sessionId: "s1", from: "session", text, step: true });
    assert.deepEqual(store.listMessages("s1").map((m) => m.text), texts);
  });

  it("counts each message added on its session, so a reader sees one added mid-turn", () => {
    const store = testStore();
    addSession(store);
    assert.equal(store.getSession("s1")?.messageCount, undefined);
    store.addMessage({ sessionId: "s1", from: "developer", text: "fix the build", via: "terminal" });
    const before = store.getSession("s1");
    store.addMessage({ sessionId: "s1", from: "session", text: "Looking at the logs first.", step: true });
    const after = store.getSession("s1");
    assert.deepEqual([before?.messageCount, after?.messageCount], [1, 2]);
    assert.ok((after?.updatedAt ?? "") > (before?.updatedAt ?? ""));
  });

  it("adds no message to a session that is not in the store", () => {
    const store = testStore();
    assert.throws(() => store.addMessage({ sessionId: "nobody", from: "session", text: "Hello" }), InputError);
    assert.equal(fs.existsSync(store.paths.messageDir("nobody")), false);
  });

  it("rejects a session whose message count is not a whole number from 0", () => {
    const store = testStore();
    addSession(store);
    const file = store.paths.session("s1");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const bad of [-1, 1.5, "3", true]) {
      fs.writeFileSync(file, JSON.stringify({ ...raw, messageCount: bad }));
      assert.throws(() => store.getSession("s1"), (e: Error) => e.message.includes("s1.json.messageCount"), String(bad));
    }
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

  it("renames an agent with its history, and merges it into a record reported under the new name", () => {
    const store = testStore();
    addSession(store);
    const started = store.upsertAgent("s1", "worker", { type: "workflow-subagent", ref: "a1", activity: "Bash: make" });
    const moved = store.renameAgent("s1", "worker", "build-api");
    assert.deepEqual([moved?.name, moved?.ref, moved?.activity, moved?.startedAt], ["build-api", "a1", "Bash: make", started.startedAt]);
    assert.deepEqual(store.listAgents("s1").map((a) => a.name), ["build-api"]);
    assert.equal(store.renameAgent("s1", "worker", "build-api"), undefined, "already moved: nothing to do");

    // Reported by the session first, then taken by the agent that runs it.
    store.upsertAgent("s1", "build-ui", { summary: "Builds the UI", branch: "agent/ui", after: ["build-api"] });
    const real = store.upsertAgent("s1", "worker-2", { type: "workflow-subagent", ref: "a2", goal: "build:ui", state: "done" });
    const one = store.renameAgent("s1", "worker-2", "build-ui");
    assert.deepEqual(
      [one?.ref, one?.state, one?.summary, one?.branch, one?.after, one?.goal, one?.startedAt, one?.endedAt],
      ["a2", "done", "Builds the UI", "agent/ui", ["build-api"], "build:ui", real.startedAt, real.endedAt],
    );
    assert.deepEqual(store.listAgents("s1").map((a) => a.name).sort(), ["build-api", "build-ui"]);
  });

  it("never merges an agent into one that follows another, and never creates one when updating", () => {
    const store = testStore();
    addSession(store);
    store.upsertAgent("s1", "review", { ref: "a1" });
    store.upsertAgent("s1", "worker", { ref: "a2" });
    assert.equal(store.renameAgent("s1", "worker", "review"), undefined);
    assert.deepEqual(store.listAgents("s1").map((a) => [a.name, a.ref]), [["review", "a1"], ["worker", "a2"]]);
    assert.equal(store.updateAgent("s1", "gone", { state: "done" }), undefined);
    assert.equal(store.getAgent("s1", "gone"), undefined);
    assert.equal(store.updateAgent("s1", "worker", { state: "done" })?.state, "done");
  });

  it("updates an agent only while its record still is what the writer compared", () => {
    const store = testStore();
    addSession(store);
    store.upsertAgent("s1", "lint", { ref: "tool:t1" });
    const unclaimed = (a: { ref?: string }) => a.ref === "tool:t1";
    assert.equal(store.updateAgent("s1", "lint", { ref: "a1" }, unclaimed)?.ref, "a1");
    assert.equal(store.updateAgent("s1", "lint", { ref: "a2" }, unclaimed), undefined, "a second claim of the same record is refused");
    assert.equal(store.getAgent("s1", "lint")?.ref, "a1");
  });

  it("finishes a rename interrupted between its two writes when run again", () => {
    const store = testStore();
    addSession(store);
    store.upsertAgent("s1", "worker", { ref: "a1", state: "done" });
    // As left by a process killed after writing the new record and before removing the old one.
    const copy = { ...JSON.parse(fs.readFileSync(store.paths.agent("s1", "worker"), "utf8")), name: "build-api", summary: "Builds the API" };
    fs.writeFileSync(store.paths.agent("s1", "build-api"), JSON.stringify(copy));
    assert.equal(store.renameAgent("s1", "worker", "build-api")?.summary, "Builds the API");
    assert.deepEqual(store.listAgents("s1").map((a) => [a.name, a.ref, a.state]), [["build-api", "a1", "done"]]);
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

describe("decisions", () => {
  const decide = (store: Store, sessionId: string, text: string, answer: string) => {
    const q = store.ask({ sessionId, kind: "question", text });
    store.closeOpen(sessionId, { answer, which: (x) => x.id === q.id });
    return q.id;
  };
  const texts = (found: ReturnType<Store["decisions"]>) => found.decisions.map((d) => (d.source === "question" ? d.question.text : d.result.title));

  it("keeps to the project: the folder holding the one given, the folders inside it, or every project of that name", () => {
    const store = testStore();
    addSession(store, "main");
    store.upsertSession({ id: "tree", provider: "Test", project: { name: "pay-tree", dir: "/work/shop/.worktrees/pay" } });
    store.upsertSession({ id: "blog", provider: "Test", project: { name: "blog", dir: "/work/blog" } });
    store.upsertSession({ id: "twin", provider: "Test", project: { name: "shop", dir: "/other/shop" } });
    decide(store, "main", "Main?", "a");
    decide(store, "tree", "Worktree?", "b");
    decide(store, "blog", "Blog?", "c");
    decide(store, "twin", "Twin?", "d");
    const all = { limit: 50 };
    assert.deepEqual(texts(store.decisions({ ...all, project: { dir: "/work/shop/src/deep" } })), ["Worktree?", "Main?"]);
    assert.deepEqual(texts(store.decisions({ ...all, project: { dir: "/work/shop/.worktrees/pay" } })), ["Worktree?"]);
    assert.deepEqual(texts(store.decisions({ ...all, project: { name: "shop" } })), ["Twin?", "Main?"]);
    assert.deepEqual(texts(store.decisions({ ...all, project: { dir: "/work/shopping" } })), [], "a sibling whose name starts the same is another project");
    assert.deepEqual(store.decisions({ ...all, project: { dir: "/work/shop" } }).projects, [
      { name: "shop", dir: "/work/shop" },
      { name: "pay-tree", dir: "/work/shop/.worktrees/pay" },
    ]);
    assert.deepEqual(store.decisions({ ...all, project: { dir: "/nowhere" } }).projects, []);
  });

  it("lists answers and the decisions reported with results, newest first, and leaves out prompts and unanswered questions unless asked", () => {
    const store = testStore();
    addSession(store);
    decide(store, "s1", "Bars or line?", "Bars");
    store.addResult({ sessionId: "s1", title: "Chart", url: "http://localhost:5173", decisions: ["Indigo bars"] });
    store.addResult({ sessionId: "s1", title: "No decision in it", url: "http://localhost:5173" });
    store.ask({ sessionId: "s1", kind: "permission", text: "Run rm -rf dist?", options: ["Allow", "Deny"] });
    store.closeOpen("s1", { kinds: ["permission"] });
    store.dismiss(store.ask({ sessionId: "s1", kind: "question", text: "Dismissed?" }).id);
    store.ask({ sessionId: "s1", kind: "question", text: "Moved on?" });
    store.closeOpen("s1", {});
    const turn = store.ask({ sessionId: "s1", kind: "waiting", text: "Deploy now?" });
    store.closeOpen("s1", { answer: "Tomorrow", which: (q) => q.id === turn.id });
    store.ask({ sessionId: "s1", kind: "question", text: "Still open?" });
    const project = { dir: "/work/shop" };
    assert.deepEqual(texts(store.decisions({ project, limit: 50 })), ["Deploy now?", "Chart", "Bars or line?"]);
    assert.deepEqual(texts(store.decisions({ project, limit: 50, permissions: true, unanswered: true })), ["Deploy now?", "Moved on?", "Dismissed?", "Run rm -rf dist?", "Chart", "Bars or line?"]);
  });

  it("finds every word searched for, whatever its case or accents, in the question, its answer or how it was understood", () => {
    const store = testStore();
    addSession(store);
    decide(store, "s1", "¿Redondeo por línea?", "Sí, como el PDF");
    decide(store, "s1", "Which font?", "Inter");
    store.interpret("s1", "Inter for the body, at 16 px");
    store.addResult({ sessionId: "s1", title: "Invoice PDF", url: "http://localhost:5173", decisions: ["Totals in bold"] });
    const found = (search: string) => texts(store.decisions({ project: { dir: "/work/shop" }, search, limit: 50 }));
    assert.deepEqual(found("LINEA redondeo"), ["¿Redondeo por línea?"]);
    assert.deepEqual(found("pdf"), ["Invoice PDF", "¿Redondeo por línea?"]);
    assert.deepEqual(found("body 16"), ["Which font?"]);
    assert.deepEqual(found("bold"), ["Invoice PDF"]);
    assert.deepEqual(found("font serif"), [], "every word must occur");
  });

  it("returns the newest up to the limit and counts all of them", () => {
    const store = testStore();
    addSession(store);
    for (let i = 0; i < 7; i++) decide(store, "s1", `Q${i}?`, `A${i}`);
    const found = store.decisions({ project: { dir: "/work/shop" }, limit: 3 });
    assert.deepEqual(texts(found), ["Q6?", "Q5?", "Q4?"]);
    assert.equal(found.total, 7);
  });

  it("remembers decisions moved to the archive, with their archived session", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const store = new Store(tempHome(), () => new Date((now += 1000)));
    addSession(store, "old");
    decide(store, "old", "Old choice?", "Keep it");
    store.addResult({ sessionId: "old", title: "Old result", url: "http://localhost:5173", decisions: ["Kept"] });
    store.updateSession("old", (s) => ({ ...s, state: "ended" }));
    now = Date.parse("2026-04-01T00:00:00.000Z");
    assert.deepEqual(store.archiveOlderThan(new Date("2026-03-01T00:00:00.000Z")), { questions: 1, results: 1, sessions: 1, images: 0 });
    assert.deepEqual(texts(store.decisions({ project: { dir: "/work/shop" }, limit: 10 })), ["Old result", "Old choice?"]);
  });

  it("skips and reports a malformed record when problems are collected, and throws otherwise", () => {
    const store = testStore();
    addSession(store);
    decide(store, "s1", "Fine?", "yes");
    fs.writeFileSync(path.join(store.paths.questionDir("closed"), "q-broken.json"), '{"id": "q-broken", "sess');
    fs.mkdirSync(store.paths.resultsDir);
    fs.writeFileSync(path.join(store.paths.resultsDir, "r-bad.json"), JSON.stringify({ id: "r-bad", sessionId: "s1", title: "", status: "ok", at: "2026-01-01T00:00:00.000Z" }));
    fs.writeFileSync(path.join(store.paths.sessionsDir, "s-bad.json"), "[]");
    const problems: string[] = [];
    assert.deepEqual(texts(store.decisions({ project: { dir: "/work/shop" }, limit: 10 }, problems)), ["Fine?"]);
    assert.equal(problems.length, 3);
    assert.match(problems.join("\n"), /q-broken\.json: not valid JSON/);
    assert.match(problems.join("\n"), /r-bad\.json\.title/);
    assert.throws(() => store.decisions({ project: { dir: "/work/shop" }, limit: 10 }), /not valid JSON|expected/);
  });

  it("reads every decision whole while processes record new ones", async () => {
    const store = testStore();
    addSession(store);
    const writing = workers(store.paths.home, "decide", 20, 4);
    let done = false;
    void writing.finally(() => (done = true));
    let reads = 0;
    while (!done || reads === 0) {
      const problems: string[] = [];
      const found = store.decisions({ project: { dir: "/work/shop" }, limit: 500 }, problems);
      assert.deepEqual(problems, []);
      for (const d of found.decisions) assert.ok(d.source === "question" && d.question.answer?.text.startsWith("yes "));
      reads++;
      await new Promise((r) => setImmediate(r));
    }
    await writing;
    assert.equal(store.decisions({ project: { dir: "/work/shop" }, limit: 500 }).total, 80);
  });
});
