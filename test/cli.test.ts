import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { procInfo } from "../src/core/proc.ts";
import { Store } from "../src/store/store.ts";
import { PNG, tempHome } from "./helpers.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "main.ts");
const exec = promisify(execFile);

async function cli(home: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], { env: { ...process.env, AGENT_DESK_HOME: home, AGENT_DESK_SESSION: "" } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

/** A session whose process is this test runner, so CLI children find it as their ancestor. */
function sessionOfThisProcess(): Store {
  const store = new Store(tempHome());
  const own = procInfo(process.pid);
  store.upsertSession({ id: "me", provider: "Test", project: { name: "shop", dir: "/work/shop" }, process: { pid: process.pid, ...(own ? { start: own.start } : {}), ancestors: [] } });
  return store;
}

describe("cli", () => {
  it("finds the calling session from its process ancestry", async () => {
    const store = sessionOfThisProcess();
    const out = await cli(store.paths.home, "ask", "Bars or line?", "--option", "Bars", "--option", "Line");
    assert.equal(out.code, 0, out.stderr);
    const [q] = store.openQuestions("me");
    assert.deepEqual([q?.text, q?.options], ["Bars or line?", ["Bars", "Line"]]);
  });

  it("posts a result with images, comparison and checks", async () => {
    const store = sessionOfThisProcess();
    const img = path.join(tempHome(), "a.png");
    fs.writeFileSync(img, PNG);
    const out = await cli(store.paths.home, "result", "Checkout on mobile", "--summary", "Fixed bar", "--image", `${img}::Before`, "--image", `${img}::After`, "--compare", "0,1", "--url", "http://localhost:5173/x", "--check", "Pay button visible => screenshot at 390 px");
    assert.equal(out.code, 0, out.stderr);
    const [r] = store.listResults();
    assert.deepEqual(r?.images.map((i) => i.caption), ["Before", "After"]);
    assert.deepEqual(r?.checks, [{ criterion: "Pay button visible", verification: "screenshot at 390 px" }]);
    assert.ok(r?.compare);
  });

  it("names agents like the hooks do, so the session can add what only it knows", async () => {
    const store = sessionOfThisProcess();
    const out = await cli(store.paths.home, "agent", "Fix pay button", "--after", "Summary bar", "--branch", "agent/pay", "--state", "blocked");
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(store.listAgents("me").map((a) => [a.name, a.after, a.branch, a.state]), [["fix-pay-button", ["summary-bar"], "agent/pay", "blocked"]]);
  });

  it("explains what is wrong with its input and exits 2", async () => {
    const store = sessionOfThisProcess();
    const cases: [string[], RegExp][] = [
      [["result", "x", "--url", "https://example.com"], /only local URLs/],
      [["agent", "x", "--state", "sleeping"], /--state: expected one of/],
      [["ask", "a", "b"], /unexpected argument "b"; quote text/],
      [["ask", "x", "--bogus"], /bogus/],
      [["ask", "x", "--session", "../etc"], /--session/],
      [["result", "x", "--check", "no arrow"], /--check: expected/],
      [["toString"], /unknown command/],
    ];
    for (const [args, message] of cases) {
      const out = await cli(store.paths.home, ...args);
      assert.equal(out.code, 2, args.join(" "));
      assert.match(out.stderr, message, args.join(" "));
    }
  });

  it("refuses to post outside a registered session", async () => {
    const out = await cli(tempHome(), "ask", "Anyone?");
    assert.equal(out.code, 2);
    assert.match(out.stderr, /does not run inside a registered session/);
  });
});
