import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addSamples, type PlanHistory, planForecasts } from "../src/core/limits.ts";

const NOW = new Date("2026-11-03T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const inMinutes = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

/** Samples of one window: [minutes ago, percent]. */
function history(resetsAt: string | undefined, ...points: [number, number][]): PlanHistory {
  let h: PlanHistory = {};
  for (const [m, percent] of points) h = addSamples(h, [{ label: "5 h", percent, ...(resetsAt ? { resetsAt } : {}) }], ago(m));
  return h;
}

describe("plan forecast", () => {
  it("warns when the pace fills the window before it resets, and when", () => {
    const [f] = planForecasts(history(inMinutes(180), [40, 50], [1, 70]), NOW);
    assert.equal(f?.label, "5 h");
    assert.equal(f?.percent, 70);
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

  it("keeps a sample only when the percentage rises a point, and starts over in a new window", () => {
    const reset = inMinutes(60);
    let h = addSamples({}, [{ label: "5 h", percent: 10, resetsAt: reset }], ago(30));
    h = addSamples(h, [{ label: "5 h", percent: 10.4, resetsAt: new Date(Date.parse(reset) + 5000).toISOString() }], ago(20));
    assert.equal(h["5 h"]?.samples.length, 1, "a reset moved by seconds is the same window");
    h = addSamples(h, [{ label: "5 h", percent: 12, resetsAt: reset }], ago(40));
    assert.equal(h["5 h"]?.samples.length, 1, "an older report changes nothing");
    h = addSamples(h, [{ label: "5 h", percent: 12, resetsAt: reset }], ago(10));
    assert.equal(h["5 h"]?.samples.length, 2);
    h = addSamples(h, [{ label: "5 h", percent: 1, resetsAt: inMinutes(300) }], ago(1));
    assert.deepEqual(h["5 h"]?.samples.map((s) => s.percent), [1], "a later window starts over");
  });
});
