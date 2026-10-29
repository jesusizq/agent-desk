import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createDeskServer } from "../src/server/server.ts";
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

/** A desk server for the store on a free local port. */
export async function serve(store: Store, remote?: Parameters<typeof createDeskServer>[2]): Promise<{ base: string; port: number; close: () => Promise<void> }> {
  // Bind first to learn a free port, then build the server for that port (it checks Host against it).
  const probe = createDeskServer(store, 0, remote);
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const real = createDeskServer(store, port, remote);
  await new Promise<void>((r) => real.listen(port, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${port}`, port, close: () => new Promise((r) => (real.close(() => r()), real.closeAllConnections())) };
}
