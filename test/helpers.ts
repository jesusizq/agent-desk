import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store/store.ts";

export function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-desk-test-"));
}

/** A store with a clock that advances one second per call, so ordering is deterministic. */
export function testStore(home = tempHome()): Store {
  let t = Date.parse("2026-10-28T08:00:00.000Z");
  return new Store(home, () => new Date((t += 1000)));
}

export function addSession(store: Store, id = "s1"): void {
  store.upsertSession({ id, provider: "Test", project: { name: "shop", dir: "/work/shop" } });
}

// Smallest valid PNG header; the store only checks the signature.
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
