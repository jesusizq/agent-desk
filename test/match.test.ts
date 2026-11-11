// Past decisions found for a new question: deterministic word matching within the same project, shown
// with the question and printed by `agent-desk ask`, never answering it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { type Answered, pastDecisions, words } from "../src/core/match.ts";
import { procInfo } from "../src/core/proc.ts";
import { Store } from "../src/store/store.ts";
import { tempHome, testStore } from "./helpers.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "main.ts");
const exec = promisify(execFile);

const answered = (id: string, text: string, answer: string, at: string, options: string[] = [], probable = false): Answered => ({
  id,
  text,
  options,
  answer: { text: answer, at, via: "terminal", ...(probable ? { probable: true } : {}) },
});

describe("past decisions that read like a question", () => {
  const past = [
    answered("q1", "Round the VAT of credit notes per line or on the total?", "Per line", "2026-10-01T10:00:00.000Z", ["Per line", "On the total"]),
    answered("q2", "Which database for the invoices service: Postgres or SQLite?", "Postgres", "2026-10-02T10:00:00.000Z"),
    answered("q3", "Should the checkout button be indigo or green?", "Indigo, 58 px", "2026-10-03T10:00:00.000Z", [], true),
    answered("q4", "Delete the merged worktrees to free disk space?", "Yes", "2026-10-04T10:00:00.000Z"),
    answered("q5", "Round the VAT of credit notes per line or on the total?", "On the total, after all", "2026-10-05T10:00:00.000Z"),
  ];

  it("finds the same topic in other words, ignoring case, accents, plurals and stop words", () => {
    const found = pastDecisions({ text: "Should VAT be rounded per line or on the invoice total?", options: ["Per line", "On the total"] }, past);
    assert.deepEqual(found.map((p) => [p.questionId, p.answer]), [["q5", "On the total, after all"]], "the same question answered again counts once, with its latest answer");
    assert.equal(pastDecisions({ text: "¿BOTÓN del checkout: índigo o verde? Checkout buttons colour", options: [] }, past)[0]?.questionId, "q3");
    assert.deepEqual(pastDecisions({ text: "Free some disk: remove merged worktrees?", options: [] }, past).map((p) => p.questionId), ["q4"]);
    assert.equal(pastDecisions({ text: "Indigo or green for the checkout button?", options: [] }, past)[0]?.probable, true, "an answer typed next in the terminal says so");
  });

  it("finds nothing for another topic, a single shared word, or nothing to compare", () => {
    assert.deepEqual(pastDecisions({ text: "Run the e2e suite on Firefox too?", options: [] }, past), []);
    assert.deepEqual(pastDecisions({ text: "Which colour for the invoices page header?", options: [] }, past), [], "one word in common is no match");
    assert.deepEqual(pastDecisions({ text: "OK?", options: [] }, past), []);
    assert.deepEqual(pastDecisions({ text: "Round VAT per line?", options: [] }, []), []);
  });

  it("gives the same answer every time, at most three, best first", () => {
    const extra = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    const many = extra.map((x, i) => answered(`m${i}`, `Deploy the staging server on Friday${i % 2 ? "" : " evening"}, ${x}?`, `Answer ${i}`, `2026-10-1${i}T10:00:00.000Z`));
    const a = pastDecisions({ text: "Deploy the staging server on Friday?", options: [] }, many);
    const b = pastDecisions({ text: "Deploy the staging server on Friday?", options: [] }, [...many].reverse());
    assert.equal(a.length, 3);
    assert.deepEqual(a, b);
    assert.deepEqual([...words("The Invoices, rounded; rounding")].sort(), ["invoice", "round"]);
  });

  it("is looked up when a question is asked, in the same project only, never closing it", () => {
    const store = testStore();
    store.upsertSession({ id: "a", provider: "Test", project: { name: "shop", dir: "/work/shop" } });
    store.upsertSession({ id: "b", provider: "Test", project: { name: "shop", dir: "/work/shop", worktree: "/work/shop/.claude/worktrees/x" } });
    store.upsertSession({ id: "far", provider: "Test", project: { name: "other", dir: "/work/other" } });
    const decide = (sid: string, text: string, answer: string, kind: "question" | "permission" = "question") => {
      store.ask({ sessionId: sid, kind, text });
      store.closeOpen(sid, { answer });
    };
    decide("far", "Use Postgres or SQLite for the invoices service?", "SQLite");
    decide("a", "Postgres or SQLite for the invoices service database?", "Postgres");
    decide("a", "Bash: rm -rf dist for the invoices service database", "Allow", "permission");
    const q = store.ask({ sessionId: "b", kind: "question", text: "Which database for the invoices service?", options: ["Postgres", "SQLite"] });
    assert.deepEqual(q.past?.map((p) => [p.answer, p.text]), [["Postgres", "Postgres or SQLite for the invoices service database?"]], "another project's answer and permission prompts are left out");
    assert.equal(store.getQuestion(q.id)?.status, "open");
    assert.equal(store.ask({ sessionId: "b", kind: "permission", text: "Postgres or SQLite for the invoices service database?", options: ["Allow", "Deny"] }).past, undefined, "a permission prompt gets none");
    assert.equal(store.ask({ sessionId: "b", kind: "waiting", text: "Ship the release notes now?" }).past, undefined);
  });

  it("is printed by agent-desk ask, labelled as past decisions, with date and answer", async () => {
    const store = new Store(tempHome());
    const own = procInfo(process.pid);
    store.upsertSession({ id: "me", provider: "Test", project: { name: "shop", dir: "/work/shop" }, process: { pid: process.pid, ...(own ? { start: own.start } : {}), ancestors: [] } });
    store.ask({ sessionId: "me", kind: "question", text: "Round the VAT of credit notes per line or on the total?" });
    store.closeOpen("me", { answer: "Per line, as the PDF does\nand keep a test", probable: true });
    const { stdout } = await exec(process.execPath, [CLI, "ask", "Should VAT be rounded per line or on the total?", "--option", "Per line", "--option", "On the total"], { env: { ...process.env, AGENT_DESK_HOME: store.paths.home, AGENT_DESK_SESSION: "" } });
    const day = new Date().toISOString().slice(0, 10);
    assert.match(stdout, /^asked q-\S+\n/);
    assert.equal(
      stdout.replace(/^asked q-\S+\n/, ""),
      `Past decisions in this project that read like it (the developer has not answered this question yet; it stays open on the desk):\n- ${day}: "Round the VAT of credit notes per line or on the total?"\n  Answer (next message in the terminal): Per line, as the PDF does\n    and keep a test\n`,
    );
    const { stdout: none } = await exec(process.execPath, [CLI, "ask", "Run the e2e suite on Firefox too?"], { env: { ...process.env, AGENT_DESK_HOME: store.paths.home, AGENT_DESK_SESSION: "" } });
    assert.match(none, /^asked q-\S+\n$/, "nothing more when nothing matches");
  });
});
