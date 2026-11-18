// This machine's health for the desk's early warnings, read only from /proc/loadavg, /proc/meminfo and
// the `temp` files of /sys/class/thermal/thermal_zone*/: no commands, nothing else.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MachineWarning } from "./protocol.ts";
import { isCode } from "../store/fsx.ts";

/** Memory runs short below 5 GB available, or below 10 % of the total on a machine with less than 50 GB. */
export const MEMORY_FLOOR = { bytes: 5e9, ratio: 0.1 } as const;
/** The hottest thermal zone is too hot at this many °C or more. */
export const HOT_C = 95;

/** Where the readings come from, and how many cores the load is weighed against. */
export type MachineSources = { proc: string; sys: string; cores: number };
export const MACHINE: MachineSources = { proc: "/proc", sys: "/sys", cores: os.availableParallelism() };

/**
 * The readings past their limits, each with its value and limit: the 1-minute load above the core
 * count, MemAvailable under MEMORY_FLOOR, the hottest zone at HOT_C or more. A file that does not exist
 * (another OS, a VM without thermal zones) skips its reading; one that cannot be read or parsed goes
 * to `problems`. Each value and limit is rounded to the digit the page shows, the value away from its
 * limit and the limit away from the value, so the shown reading is always past the shown limit, and a
 * reading moving within its last digit leaves the state's version alone.
 */
export function machineWarnings(problems: string[], from: MachineSources = MACHINE): MachineWarning[] {
  const out: MachineWarning[] = [];
  const load = reading(path.join(from.proc, "loadavg"), loadOf, problems);
  // In hundredths first, as the file gives it, so that 8.1 is not taken for 8.1000001 and shown as 8.2.
  if (load !== undefined && load > from.cores) out.push({ reading: "load", value: Math.ceil(Math.round(load * 100) / 10) / 10, limit: from.cores });
  const memory = reading(path.join(from.proc, "meminfo"), memoryOf, problems);
  if (memory) {
    const floor = Math.round(Math.min(MEMORY_FLOOR.bytes, MEMORY_FLOOR.ratio * memory.total));
    if (memory.available < floor) out.push({ reading: "memory", value: Math.floor(memory.available / 1e8) * 1e8, limit: Math.ceil(floor / 1e8) * 1e8 });
  }
  const hottest = hottestZone(path.join(from.sys, "class", "thermal"), problems);
  if (hottest !== undefined && hottest >= HOT_C * 1000) out.push({ reading: "temperature", value: Math.ceil(hottest / 1000), limit: HOT_C });
  return out;
}

/** The hottest zone's reading in m°C, or undefined without any. */
function hottestZone(dir: string, problems: string[]): number | undefined {
  let zones: string[];
  try {
    zones = fs.readdirSync(dir).filter((name) => /^thermal_zone\d+$/.test(name));
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined; // no thermal zones here: nothing to warn of
    problems.push(`machine temperature: ${dir} could not be listed (${(error as Error).message}); the temperature warning is off until it can`);
    return undefined;
  }
  let hottest: number | undefined;
  for (const zone of zones) {
    // A sensor that is switched off answers its read with one of these errors: it has no reading.
    const milli = reading(path.join(dir, zone, "temp"), tempOf, problems, ["ENOENT", "ENODATA", "EINVAL", "EAGAIN", "EIO"]);
    if (milli !== undefined && (hottest === undefined || milli > hottest)) hottest = milli;
  }
  return hottest;
}

/** A file parsed, or undefined: when it is missing (`absent` codes), or, with the reason in `problems`, when it is unreadable or not in the expected format. */
function reading<T>(file: string, parse: (text: string) => T | undefined, problems: string[], absent: readonly string[] = ["ENOENT"]): T | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (absent.some((code) => isCode(error, code))) return undefined; // this machine has no such reading
    problems.push(`machine health: ${file} could not be read (${(error as Error).message}); its warning is off until it can`);
    return undefined;
  }
  const value = parse(text);
  if (value === undefined) problems.push(`machine health: ${file} is not in the expected format (starts ${JSON.stringify(text.slice(0, 60))}); its warning is off until it is`);
  return value;
}

/** The 1-minute load, the first field of /proc/loadavg. */
function loadOf(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s/.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** MemTotal and MemAvailable of /proc/meminfo, in bytes (the file says kB, meaning KiB). */
function memoryOf(text: string): { total: number; available: number } | undefined {
  const kib = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(text);
    return m ? Number(m[1]) * 1024 : undefined;
  };
  const total = kib("MemTotal");
  const available = kib("MemAvailable");
  return total === undefined || available === undefined ? undefined : { total, available };
}

/** A zone's `temp`: an integer in m°C, negative for some sensors. */
function tempOf(text: string): number | undefined {
  return /^-?\d+\n?$/.test(text) ? Number(text) : undefined;
}
