// A PIN in front of remote access: a device reaching the desk through the tailnet must unlock it
// first; the unlock lasts 12 hours on that device. Requests from this machine never need it.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { fields, InputError, text } from "../core/check.ts";
import { readJson, writeJson } from "../store/fsx.ts";

export const UNLOCK_COOKIE = "agent_desk_unlock";
export const UNLOCK_HOURS = 12;
const MIN_PIN = 6;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

type Stored = { salt: string; hash: string };

/** Saves the PIN's scrypt hash (never the PIN) in the store, 0600. */
export function setPin(file: string, pin: string): void {
  if (!/^\d+$/.test(pin) || pin.length < MIN_PIN) throw new InputError(`the PIN must be at least ${MIN_PIN} digits`);
  const salt = randomBytes(16);
  writeJson(file, { salt: salt.toString("hex"), hash: scryptSync(pin, salt, 32, SCRYPT).toString("hex") } satisfies Stored);
}

export function readPin(file: string): Stored | undefined {
  const raw = readJson(file);
  if (raw === undefined) return undefined;
  const f = fields(raw, file);
  return { salt: text(f.salt, `${file}.salt`, 64), hash: text(f.hash, `${file}.hash`, 128) };
}

/**
 * Checks PINs and issues the unlock cookie: an expiry time signed with the per-install secret.
 * Failed attempts are counted in memory; after five, every attempt is refused for 15 minutes.
 */
export class RemoteUnlock {
  private failures: number[] = [];
  private readonly pinFile: string;
  private readonly secret: string;
  private readonly now: () => number;

  constructor(pinFile: string, secret: string, now: () => number = Date.now) {
    this.pinFile = pinFile;
    this.secret = secret;
    this.now = now;
  }

  hasPin(): boolean {
    return readPin(this.pinFile) !== undefined;
  }

  /** The Set-Cookie value for a correct PIN; an InputError (with what to do) otherwise. */
  unlock(pin: unknown): string {
    const stored = readPin(this.pinFile);
    if (!stored) throw new InputError("no PIN is set; set one on the computer with: agent-desk pin");
    const recent = this.failures.filter((t) => this.now() - t < LOCKOUT_MS);
    this.failures = recent;
    if (recent.length >= MAX_FAILURES) throw new InputError("too many wrong PINs; try again in 15 minutes");
    const given = Buffer.from(scryptSync(text(pin, "pin", 64), Buffer.from(stored.salt, "hex"), 32, SCRYPT));
    if (!timingSafeEqual(given, Buffer.from(stored.hash, "hex"))) {
      this.failures.push(this.now());
      throw new InputError("wrong PIN");
    }
    this.failures = [];
    const expires = this.now() + UNLOCK_HOURS * 3600_000;
    const token = `${expires}.${this.sign(String(expires))}`;
    return `${UNLOCK_COOKIE}=${token}; Path=/; Max-Age=${UNLOCK_HOURS * 3600}; HttpOnly; Secure; SameSite=Strict`;
  }

  /** True while the request carries an unexpired cookie signed by this install. */
  unlocked(req: IncomingMessage): boolean {
    const cookie = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${UNLOCK_COOKIE}=`));
    const token = cookie?.slice(UNLOCK_COOKIE.length + 1) ?? "";
    const [expires, signature] = token.split(".");
    if (!expires || !signature || !/^\d+$/.test(expires) || Number(expires) < this.now()) return false;
    const expected = Buffer.from(this.sign(expires));
    const got = Buffer.from(signature);
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  private sign(value: string): string {
    return createHmac("sha256", this.secret).update(`unlock:${value}`).digest("base64url");
  }
}
