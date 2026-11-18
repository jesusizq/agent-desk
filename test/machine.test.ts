import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { HOT_C, machineWarnings, type MachineSources } from "../src/core/machine.ts";
import { tempHome } from "./helpers.ts";

/** A fake machine: /proc and /sys under a temporary folder, with only the files given. */
function machine(files: { loadavg?: string; meminfo?: string; zones?: (string | null)[] }, cores = 8): MachineSources {
  const root = tempHome();
  const proc = path.join(root, "proc");
  const sys = path.join(root, "sys");
  fs.mkdirSync(proc);
  if (files.loadavg !== undefined) fs.writeFileSync(path.join(proc, "loadavg"), files.loadavg);
  if (files.meminfo !== undefined) fs.writeFileSync(path.join(proc, "meminfo"), files.meminfo);
  if (files.zones) {
    const thermal = path.join(sys, "class", "thermal");
    fs.mkdirSync(path.join(thermal, "cooling_device0"), { recursive: true });
    fs.writeFileSync(path.join(thermal, "cooling_device0", "temp"), "200000\n");
    files.zones.forEach((t, i) => {
      fs.mkdirSync(path.join(thermal, `thermal_zone${i}`));
      if (t !== null) fs.writeFileSync(path.join(thermal, `thermal_zone${i}`, "temp"), t);
    });
  }
  return { proc, sys, cores };
}

const loadavg = (one: string) => `${one} 3.10 2.05 3/1234 98765\n`;
const meminfo = (totalKiB: number, availableKiB: number) => `MemTotal:       ${totalKiB} kB\nMemFree:          123456 kB\nMemAvailable:   ${availableKiB} kB\nBuffers:          1024 kB\n`;
const warnings = (from: MachineSources) => {
  const problems: string[] = [];
  return { warnings: machineWarnings(problems, from), problems };
};

describe("machine health", () => {
  it("warns of a 1-minute load above the core count, not at it", () => {
    assert.deepEqual(warnings(machine({ loadavg: loadavg("8.00") })), { warnings: [], problems: [] });
    assert.deepEqual(warnings(machine({ loadavg: loadavg("7.99") })).warnings, []);
    assert.deepEqual(warnings(machine({ loadavg: loadavg("8.01") })).warnings, [{ reading: "load", value: 8.1, limit: 8 }], "rounded up, so it shows above its limit");
    assert.deepEqual(warnings(machine({ loadavg: loadavg("8.10") })).warnings, [{ reading: "load", value: 8.1, limit: 8 }], "a load the file gives to the digit shown stays as it is");
    assert.deepEqual(warnings(machine({ loadavg: loadavg("34.88") }, 18)).warnings, [{ reading: "load", value: 34.9, limit: 18 }]);
    // A finer reading is compared and shown on the same number: just above its cores shows above them.
    assert.deepEqual(warnings(machine({ loadavg: loadavg("8.001") })).warnings, [{ reading: "load", value: 8.1, limit: 8 }]);
    assert.deepEqual(warnings(machine({ loadavg: loadavg("8.000") })).warnings, []);
    assert.deepEqual(warnings(machine({ loadavg: loadavg("9") })).warnings, [{ reading: "load", value: 9, limit: 8 }]);
  });

  it("warns of memory available under 5 GB, or under 10 % of a smaller machine's total", () => {
    // 100 GB in all: the floor is 5 GB, 4882812.5 KiB.
    const big = 100e9 / 1024;
    assert.deepEqual(warnings(machine({ meminfo: meminfo(big, 4882813) })), { warnings: [], problems: [] });
    assert.deepEqual(warnings(machine({ meminfo: meminfo(big, 4882812) })).warnings, [{ reading: "memory", value: 4.9e9, limit: 5e9 }]);
    // 16 GB in all: the floor is 1.6 GB, 1562500 KiB.
    assert.deepEqual(warnings(machine({ meminfo: meminfo(15625000, 1562500) })).warnings, [], "at the floor is not under it");
    assert.deepEqual(warnings(machine({ meminfo: meminfo(15625000, 1562499) })).warnings, [{ reading: "memory", value: 1.5e9, limit: 1.6e9 }]);
    // 32.2 GB in all: the floor is 3.22 GB; 3.21 GB free would show "3.2 GB free, under 3.2 GB" with the limit rounded to the nearest.
    assert.deepEqual(warnings(machine({ meminfo: meminfo(31445313, 3134766) })).warnings, [{ reading: "memory", value: 3.2e9, limit: 3.3e9 }], "the limit rounded up, the reading down");
    assert.deepEqual(warnings(machine({ meminfo: meminfo(15625000, 4000000) })).warnings, [], "4 GB free is plenty on 16 GB");
  });

  it(`warns when the hottest thermal zone reaches ${HOT_C} °C, reading only the zones' temp files`, () => {
    assert.deepEqual(warnings(machine({ zones: ["47000\n", "94999\n", "-273000\n"] })), { warnings: [], problems: [] }, "a cooling device's file is not a zone's");
    assert.deepEqual(warnings(machine({ zones: ["47000\n", "95000\n", "50\n"] })).warnings, [{ reading: "temperature", value: 95, limit: HOT_C }]);
    assert.deepEqual(warnings(machine({ zones: ["96400\n", "95000\n"] })).warnings, [{ reading: "temperature", value: 96, limit: HOT_C }], "the hottest one, rounded: 96.4 °C is not shown as 97");
    assert.deepEqual(warnings(machine({ zones: ["95499\n"] })).warnings, [{ reading: "temperature", value: 95, limit: HOT_C }], "rounded, it still reads at the limit");
    assert.deepEqual(warnings(machine({ zones: [null, "97000\n"] })).warnings, [{ reading: "temperature", value: 97, limit: HOT_C }], "a zone without its file is skipped");
  });

  it("says nothing of the readings whose files this machine lacks, and all of them at once when they are past their limits", () => {
    assert.deepEqual(warnings(machine({})), { warnings: [], problems: [] }, "another OS, or a VM without thermal zones");
    assert.deepEqual(
      warnings(machine({ loadavg: loadavg("12.5"), meminfo: meminfo(8e6, 500000), zones: ["99000\n"] }, 4)).warnings.map((w) => w.reading),
      ["load", "memory", "temperature"],
    );
  });

  it("reports a malformed file as a problem with what failed, and the other readings all the same", () => {
    const { warnings: found, problems } = warnings(machine({ loadavg: "busy\n", meminfo: "MemTotal: 16 GB\n", zones: ["hot\n", "99000\n"] }));
    assert.deepEqual(found, [{ reading: "temperature", value: 99, limit: HOT_C }]);
    assert.equal(problems.length, 3);
    assert.match(problems[0] ?? "", /proc\/loadavg is not in the expected format \(starts "busy\\n"\)/);
    assert.match(problems[1] ?? "", /proc\/meminfo is not in the expected format/);
    assert.match(problems[2] ?? "", /thermal_zone0\/temp is not in the expected format/);
    const old = warnings(machine({ meminfo: "MemTotal:       16000000 kB\nMemFree:        100 kB\n" }));
    assert.match(old.problems.join("\n"), /meminfo is not in the expected format/, "a kernel without MemAvailable says so");
  });
});
