// Whether a plan window fills before it resets. Windows have no length here (a provider names them as
// it likes): a window's length is inferred from the reset times of the windows kept before it.
import type { PlanForecast, PlanWindow } from "./protocol.ts";

export type PlanSample = { at: string; percent: number };
/** One window of a plan: when it resets, and each rise of a point or more seen in it. */
export type PlanWindowHistory = { resetsAt?: string; samples: PlanSample[] };
/** Per window label, the windows kept, oldest first; the last one is the current window. */
export type PlanHistory = Record<string, PlanWindowHistory[]>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MIN_LOOKBACK = 30 * MINUTE;
const MIN_SPAN = 15 * MINUTE;
const MIN_RISE = 2;
/** A provider's reset time moves by seconds between reports; only a later window moves it by more. */
const SAME_RESET = 10 * MINUTE;
/** Past this, a window outlasts a working day, and its pace counts nights and pauses. */
const LONG = DAY;
/** The least time a long window's pace is taken from, so a burst of work is never taken for a pace. */
const MIN_HISTORY = 2 * DAY;
const KEEP_FINISHED = 4;
const KEEP_FOR = 35 * DAY;
/** A long window says how full it gets at its reset from this percentage on. */
const HIGH = 85;
/** Rounded, so the state's version (its ETag) changes only when the forecast does. */
const ROUND_SHORT = 5 * MINUTE;
const ROUND_LONG = HOUR;

const sameWindow = (a?: string, b?: string) => (a === undefined || b === undefined ? a === b : Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_RESET);

/** The history with what a session reported at `at`: a sample only when the percentage rose by a point or more. */
export function addSamples(history: PlanHistory, windows: PlanWindow[], at: string): PlanHistory {
  const next: PlanHistory = { ...history };
  for (const w of windows) {
    const kept = next[w.label] ?? [];
    const current = kept.at(-1);
    const last = current?.samples.at(-1);
    const sample = { at, percent: w.percent };
    if (!current || !last || !sameWindow(current.resetsAt, w.resetsAt)) {
      // A report older than what is kept is not a new window.
      if (!last || at > last.at) next[w.label] = [...finished(kept, at), { ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}), samples: [sample] }];
    } else if (at > last.at && w.percent >= last.percent + 1) {
      next[w.label] = [...kept.slice(0, -1), { ...current, samples: [...current.samples, sample] }];
    }
  }
  return next;
}

/** The windows kept once a new one starts at `at`: the latest few that ended in the last weeks. */
function finished(windows: PlanWindowHistory[], at: string): PlanWindowHistory[] {
  const since = Date.parse(at) - KEEP_FOR;
  return windows.filter((w) => {
    const end = w.resetsAt ?? w.samples.at(-1)?.at;
    return end !== undefined && Date.parse(end) >= since;
  }).slice(-KEEP_FINISHED);
}

/** The shortest gap between the reset times of consecutive windows: a missed window only makes a gap longer. */
function windowLength(windows: PlanWindowHistory[]): number | undefined {
  let length: number | undefined;
  for (let i = 1; i < windows.length; i++) {
    const before = windows[i - 1]?.resetsAt;
    const after = windows[i]?.resetsAt;
    if (!before || !after) continue;
    const gap = Date.parse(after) - Date.parse(before);
    if (gap > SAME_RESET && (length === undefined || gap < length)) length = gap;
  }
  return length;
}

type Expected = { pace: PlanForecast["pace"]; perMs: number; round: number };

/** The windows that fill before they reset, or that a long window's usual pace fills nearly; the rest say nothing. */
export function planForecasts(history: PlanHistory, now: Date): PlanForecast[] {
  const forecasts: PlanForecast[] = [];
  for (const [label, windows] of Object.entries(history)) {
    const current = windows.at(-1);
    const last = current?.samples.at(-1);
    const resetsAt = current?.resetsAt;
    if (!current || !resetsAt || !last || last.percent >= 100) continue;
    const left = Date.parse(resetsAt) - now.getTime();
    if (left <= 0) continue;
    const length = windowLength(windows);
    const long = left > LONG || (length !== undefined && length > LONG);
    const expected = long ? usualPace(windows, length, left, now) : recentPace(current.samples, left, now);
    if (!expected || expected.perMs <= 0) continue;
    const toFull = (100 - last.percent) / expected.perMs;
    const base = { label, percent: last.percent, resetsAt, pace: expected.pace };
    if (toFull < left) {
      // Rounded down for a long window, so the hour it names is never past the reset.
      const at = now.getTime() + toFull;
      const fullAt = long ? Math.floor(at / expected.round) * expected.round : Math.round(at / expected.round) * expected.round;
      forecasts.push({ ...base, fullAt: new Date(fullAt).toISOString() });
    } else if (long) {
      const atReset = last.percent + expected.perMs * left;
      if (atReset >= HIGH) forecasts.push({ ...base, atReset: Math.min(99, Math.round(atReset)) });
    }
  }
  return forecasts;
}

/** A short window's pace: the rise over the last while, which follows the time left. */
function recentPace(samples: PlanSample[], left: number, now: Date): Expected | undefined {
  const last = samples.at(-1);
  const start = now.getTime() - Math.max(MIN_LOOKBACK, left / 5);
  const base = samples.findLast((s) => Date.parse(s.at) <= start) ?? samples[0];
  if (!last || !base) return undefined;
  const span = now.getTime() - Date.parse(base.at);
  const rise = last.percent - base.percent;
  if (span < MIN_SPAN || rise < MIN_RISE) return undefined;
  return { pace: "recent", perMs: rise / span, round: ROUND_SHORT };
}

/**
 * A long window's pace, nights and pauses included. With past windows to go by: the usual pace (their
 * use over their time) weighed as one whole window, together with this window so far, so the current
 * window counts more as it goes on and an early burst does not set the pace. Without: this window's
 * own average, once it covers enough time.
 */
function usualPace(windows: PlanWindowHistory[], length: number | undefined, left: number, now: Date): Expected | undefined {
  const current = windows.at(-1);
  const first = current?.samples[0];
  const last = current?.samples.at(-1);
  if (!first || !last) return undefined;
  const past = windows.slice(0, -1).flatMap((w) => w.samples.at(-1) ?? []);
  if (length !== undefined && past.length * length >= MIN_HISTORY) {
    const usual = past.reduce((sum, s) => sum + s.percent, 0) / (past.length * length);
    const elapsed = Math.max(0, length - left);
    return { pace: "usual", perMs: (last.percent + usual * length) / (elapsed + length), round: ROUND_LONG };
  }
  // The window's start, when its length is known, where its percentage was 0; else its first sample.
  const [from, base] = length !== undefined ? [now.getTime() + left - length, 0] : [Date.parse(first.at), first.percent];
  const span = now.getTime() - from;
  if (span < MIN_HISTORY) return undefined;
  return { pace: "window", perMs: (last.percent - base) / span, round: ROUND_LONG };
}
