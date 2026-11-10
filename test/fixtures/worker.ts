// Child process used by the concurrency tests: `worker.ts <home> <task> <count>`.
import * as path from "node:path";
import { readJson, withLock, writeJson } from "../../src/store/fsx.ts";
import { Store } from "../../src/store/store.ts";

const [home, task, count] = process.argv.slice(2);
if (!home || !task || !count) throw new Error("usage: worker.ts <home> <task> <count>");
const store = new Store(home);

if (task === "increment") {
  const file = path.join(home, "counter.json");
  for (let i = 0; i < Number(count); i++) {
    withLock(file, () => {
      const n = (readJson(file) as number | undefined) ?? 0;
      writeJson(file, n + 1);
    });
  }
} else if (task === "take") {
  const got: string[] = [];
  for (let i = 0; i < Number(count); i++) got.push(...store.takeInbox("s1").map((e) => e.questionId));
  process.stdout.write(JSON.stringify(got));
} else if (task === "message") {
  for (let i = 0; i < Number(count); i++) store.addMessage({ sessionId: "s1", from: "session", text: `step ${process.pid}-${i}`, step: true });
} else if (task === "activity") {
  for (let i = 0; i < Number(count); i++) store.updateSession("s1", (s) => ({ ...s, activity: `Edit ${process.pid}-${i}` }));
} else if (task === "agent") {
  for (let i = 0; i < Number(count); i++) store.upsertAgent("s1", "builder", { activity: `step ${process.pid}-${i}` });
} else if (task === "add") {
  for (let i = 0; i < Number(count); i++) store.addAgent("s1", "worker", { ref: `${process.pid}-${i}` });
} else if (task === "rename") {
  for (let i = 0; i < Number(count); i++) store.renameAgent("s1", "worker", "build-api");
} else if (task === "report") {
  for (let i = 0; i < Number(count); i++) store.upsertAgent("s1", "build-api", { summary: "Builds the API" });
} else if (task === "decide") {
  for (let i = 0; i < Number(count); i++) {
    const asked = store.ask({ sessionId: "s1", kind: "question", text: `Decided ${process.pid}-${i}?` });
    store.closeOpen("s1", { answer: `yes ${process.pid}-${i}`, which: (q) => q.id === asked.id });
  }
} else if (task === "seen-result" || task === "dismiss-result") {
  const [result] = store.listResults();
  if (!result) throw new Error("no result to mark");
  for (let i = 0; i < Number(count); i++) (task === "seen-result" ? store.markResultSeen(result.id) : store.dismissResult(result.id));
} else if (task === "forget") {
  for (let i = 0; i < Number(count); i++) store.forgetSession("s1");
} else {
  throw new Error(`unknown task ${task}`);
}
