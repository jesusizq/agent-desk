import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { addSamples, type PlanHistory, planForecasts } from "../src/core/limits.ts";
import { readPlanHistory } from "../src/core/model.ts";
import { Store } from "../src/store/store.ts";
import { tempHome } from "./helpers.ts";

const NOW = new Date("2026-11-03T12:00:00Z");
const HOUR = 60;
const WEEK = 7 * 24 * HOUR;
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const inMinutes = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

/** Samples of one window: [minutes ago, percent]. */
function history(resetsAt: string | undefined, ...points: [number, number][]): PlanHistory {
  return report({}, "5 h", resetsAt, points);
}

function report(h: PlanHistory, label: string, resetsAt: string | undefined, points: [number, number][]): PlanHistory {
  for (const [m, percent] of points) h = addSamples(h, [{ label, percent, ...(resetsAt ? { resetsAt } : {}) }], ago(m));
  return h;
}

/**
 * Finished weekly windows, oldest first, each used evenly over its days up to its final percentage,
 * then the current one, which resets `left` minutes from now, with its own points.
 */
function weeks(finals: number[], left: number, points: [number, number][]): PlanHistory {
  let h: PlanHistory = {};
  finals.forEach((final, i) => {
    const resetsIn = left - (finals.length - i) * WEEK;
    const days = [6, 5, 4, 3, 2, 1, 0].map((d): [number, number] => [-(resetsIn - WEEK) - (7 - d) * 24 * HOUR + 12 * HOUR, Math.round((final * (7 - d)) / 7)]);
    h = report(h, "7 d", inMinutes(resetsIn), days);
  });
  return report(h, "7 d", inMinutes(left), points);
}

describe("plan forecast", () => {
  it("warns when the pace fills the window before it resets, and when", () => {
    const [f] = planForecasts(history(inMinutes(180), [40, 50], [1, 70]), NOW);
    assert.equal(f?.label, "5 h");
    assert.equal(f?.percent, 70);
    assert.equal(f?.pace, "recent");
    assert.equal(f?.fullAt, inMinutes(60), "30 points left at 20 points in 40 minutes");
  });

  it("says nothing when it resets first, was idle, or there is too little to tell", () => {
    assert.deepEqual(planForecasts(history(inMinutes(30), [40, 50], [1, 70]), NOW), [], "it resets first");
    assert.deepEqual(planForecasts(history(inMinutes(180), [300, 50], [200, 70]), NOW), [], "the burst is long past");
    assert.deepEqual(planForecasts(history(inMinutes(180), [5, 50], [1, 70]), NOW), [], "only five minutes seen");
    assert.deepEqual(planForecasts(history(inMinutes(180), [40, 50], [1, 51]), NOW), [], "barely moved");
    assert.deepEqual(planForecasts(history(undefined, [40, 50], [1, 70]), NOW), [], "no reset time to compare with");
    assert.deepEqual(planForecasts(history(inMinutes(-5), [40, 50], [1, 70]), NOW), [], "already reset");
    assert.deepEqual(planForecasts(history(inMinutes(180), [40, 90], [1, 100]), NOW), [], "already full");
  });

  it("does not take a week's busy hour for its pace", () => {
    const week = inMinutes(5 * 24 * 60);
    assert.deepEqual(planForecasts(history(week, [24 * 60, 30], [60, 30.5], [1, 33]), NOW), [], "3 points in a day leave plenty for five days");
  });

  it("does not take two hours of work right after a weekly reset for the week, when past weeks were ordinary", () => {
    const burst: [number, number][] = [[120, 1], [90, 3], [60, 5], [30, 7], [1, 8]];
    const h = weeks([55, 60, 50, 65], WEEK - 2 * HOUR, burst);
    assert.equal(h["7 d"]?.length, 5, "four finished weeks and this one");
    // At the pace of those two hours (4 points an hour) it would be full in a day; the usual week plus this one says 72%.
    assert.deepEqual(planForecasts(h, NOW), []);
  });

  it("does not take that burst for the week either when there is no past week to go by", () => {
    assert.deepEqual(planForecasts(report({}, "7 d", inMinutes(WEEK - 2 * HOUR), [[120, 1], [60, 5], [1, 8]]), NOW), []);
  });

  it("warns, at the usual pace, when a heavy week runs out before it resets", () => {
    const [f] = planForecasts(weeks([55, 60, 50, 65], 4 * 24 * HOUR, [[72 * HOUR, 10], [48 * HOUR, 35], [24 * HOUR, 55], [1, 75]]), NOW);
    assert.equal(f?.pace, "usual");
    assert.equal(f?.percent, 75);
    // Usual: 230 points in 4 weeks. With this window's 75 in 72 h: (75 + 57.5) / 240 h, 25 points in 45.3 h, down to the hour.
    assert.equal(f?.fullAt, inMinutes(45 * HOUR));
    assert.equal(f?.resetsAt, inMinutes(4 * 24 * HOUR));
    assert.equal(f?.atReset, undefined);
  });

  it("says how full a long window gets by its reset when that is high but not full", () => {
    const [f] = planForecasts(weeks([55, 60, 50, 65], 5 * 24 * HOUR, [[48 * HOUR, 10], [24 * HOUR, 25], [1, 40]]), NOW);
    assert.equal(f?.pace, "usual");
    // (40 + 57.5) / 216 h for 120 h more: 94%.
    assert.equal(f?.atReset, 94);
    assert.equal(f?.fullAt, undefined);
    assert.deepEqual(planForecasts(weeks([55, 60, 50, 65], 5 * 24 * HOUR, [[48 * HOUR, 10], [1, 30]]), NOW), [], "under 85% it says nothing");
  });

  it("goes by a long window's own average without past windows, once it covers two days", () => {
    const [f] = planForecasts(report({}, "7 d", inMinutes(4 * 24 * HOUR), [[72 * HOUR, 5], [48 * HOUR, 30], [1, 70]]), NOW);
    assert.equal(f?.pace, "window");
    // 65 points in 72 h: 30 points left in 33.2 h.
    assert.equal(f?.fullAt, inMinutes(33 * HOUR));
    assert.deepEqual(planForecasts(report({}, "7 d", inMinutes(4 * 24 * HOUR), [[36 * HOUR, 5], [1, 70]]), NOW), [], "a day and a half is not enough");
  });

  it("keeps a sample only when the percentage rises a point, and starts a new window after the last", () => {
    const reset = inMinutes(60);
    let h = addSamples({}, [{ label: "5 h", percent: 10, resetsAt: reset }], ago(30));
    h = addSamples(h, [{ label: "5 h", percent: 10.4, resetsAt: new Date(Date.parse(reset) + 5000).toISOString() }], ago(20));
    assert.equal(h["5 h"]?.at(-1)?.samples.length, 1, "a reset moved by seconds is the same window");
    h = addSamples(h, [{ label: "5 h", percent: 12, resetsAt: reset }], ago(40));
    assert.equal(h["5 h"]?.at(-1)?.samples.length, 1, "an older report changes nothing");
    h = addSamples(h, [{ label: "5 h", percent: 12, resetsAt: reset }], ago(10));
    assert.equal(h["5 h"]?.at(-1)?.samples.length, 2);
    h = addSamples(h, [{ label: "5 h", percent: 1, resetsAt: inMinutes(300) }], ago(1));
    assert.deepEqual(h["5 h"]?.at(-1)?.samples.map((s) => s.percent), [1], "a later window starts over");
    assert.deepEqual(h["5 h"]?.[0]?.samples.map((s) => s.percent), [10, 12], "the finished window is kept");
  });

  it("keeps the last four finished windows, none ended more than five weeks ago", () => {
    const h = weeks([10, 20, 30, 40, 50, 60], WEEK - HOUR, [[1, 5]]);
    assert.deepEqual(h["7 d"]?.map((w) => w.samples.at(-1)?.percent), [30, 40, 50, 60, 5]);
    let gap = report({}, "7 d", inMinutes(-6 * WEEK), [[7 * WEEK, 20]]);
    gap = report(gap, "7 d", inMinutes(-4 * WEEK), [[5 * WEEK, 30]]);
    gap = report(gap, "7 d", inMinutes(WEEK - HOUR), [[1, 5]]);
    assert.deepEqual(gap["7 d"]?.map((w) => w.samples.at(-1)?.percent), [30, 5], "the window that reset six weeks ago is gone");
  });

  it("reads the file kept before past windows were, and takes it as the current window", () => {
    const old = { "7 d": { resetsAt: inMinutes(WEEK - HOUR), samples: [{ at: ago(30), percent: 3 }] }, "5 h": { samples: [] } };
    assert.deepEqual(readPlanHistory(old, "plan.json"), { "7 d": [old["7 d"]], "5 h": [{ samples: [] }] });

    const store = new Store(tempHome(), () => NOW);
    fs.writeFileSync(store.paths.plan, JSON.stringify(old));
    store.recordPlan([{ label: "7 d", percent: 1, resetsAt: inMinutes(2 * WEEK - HOUR) }], ago(1));
    assert.deepEqual(store.planHistory()["7 d"]?.map((w) => w.samples.map((s) => s.percent)), [[3], [1]], "the old window is kept as finished");

    fs.writeFileSync(store.paths.plan, JSON.stringify({ "7 d": [{ samples: "none" }] }));
    const problems: string[] = [];
    assert.deepEqual(store.planHistory(problems), {});
    assert.match(problems[0] ?? "", /plan\.json: .*7 d\[0\]\.samples: expected a list/);
  });
});
