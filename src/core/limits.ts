// Whether the pace of the last while fills a plan window before it resets. Windows have no length
// here (a provider names them as it likes): how far back to look follows the time left in the window.
import type { PlanForecast, PlanWindow } from "./protocol.ts";

export type PlanHistory = Record<string, { resetsAt?: string; samples: { at: string; percent: number }[] }>;

const MINUTE = 60_000;
const MIN_LOOKBACK = 30 * MINUTE;
const MIN_SPAN = 15 * MINUTE;
const MIN_RISE = 2;
/** A provider's reset time moves by seconds between reports; only a later window moves it by more. */
const SAME_RESET = 10 * MINUTE;
/** Rounded, so the state the page polls changes only when the forecast does. */
const ROUND_TO = 5 * MINUTE;

const sameWindow = (a?: string, b?: string) => (a === undefined || b === undefined ? a === b : Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_RESET);

/** The history with what a session reported at `at`: a sample only when the percentage rose by a point or more. */
export function addSamples(history: PlanHistory, windows: PlanWindow[], at: string): PlanHistory {
  const next: PlanHistory = { ...history };
  for (const w of windows) {
    const current = next[w.label];
    const last = current?.samples.at(-1);
    const sample = { at, percent: w.percent };
    if (!current || !last || !sameWindow(current.resetsAt, w.resetsAt)) {
      // A report older than what is kept is not a new window.
      if (!last || at > last.at) next[w.label] = { ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}), samples: [sample] };
    } else if (at > last.at && w.percent >= last.percent + 1) {
      next[w.label] = { ...current, samples: [...current.samples, sample] };
    }
  }
  return next;
}

/** The windows that fill before they reset at the recent pace; the rest say nothing. */
export function planForecasts(history: PlanHistory, now: Date): PlanForecast[] {
  const forecasts: PlanForecast[] = [];
  for (const [label, { resetsAt, samples }] of Object.entries(history)) {
    const last = samples.at(-1);
    if (!resetsAt || !last || last.percent >= 100) continue;
    const left = Date.parse(resetsAt) - now.getTime();
    if (left <= 0) continue;
    const start = now.getTime() - Math.max(MIN_LOOKBACK, left / 5);
    const base = samples.findLast((s) => Date.parse(s.at) <= start) ?? samples[0];
    if (!base) continue;
    const span = now.getTime() - Date.parse(base.at);
    const rise = last.percent - base.percent;
    if (span < MIN_SPAN || rise < MIN_RISE) continue;
    const toFull = ((100 - last.percent) * span) / rise;
    if (toFull >= left) continue;
    forecasts.push({ label, percent: last.percent, fullAt: new Date(Math.round((now.getTime() + toFull) / ROUND_TO) * ROUND_TO).toISOString(), resetsAt });
  }
  return forecasts;
}
