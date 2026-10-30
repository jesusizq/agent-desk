import { randomBytes } from "node:crypto";
import { InputError } from "./check.ts";

// Ids end up in file paths and links: letters, digits, "_" and "-" only, never "." or "/".
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function id(value: unknown, where: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new InputError(`${where}: expected an id of letters, digits, "_" or "-" (max 128), got ${JSON.stringify(value)}`);
  }
  return value;
}

let lastMs = 0;
let sameMs = 0;
/**
 * Sortable by creation time, unique across processes. Ids made in the same millisecond by one
 * process keep their order through a counter (several messages are recorded at once).
 */
export function newId(prefix: string): string {
  const now = Date.now();
  sameMs = now === lastMs ? sameMs + 1 : 0;
  lastMs = now;
  return `${prefix}-${now.toString(36)}-${sameMs.toString(36).padStart(3, "0")}${randomBytes(4).toString("hex")}`;
}

/** Turns free text (an agent's description) into a valid id: "Fix the pay button!" → "fix-the-pay-button". */
export function slug(value: string): string {
  const s = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return s === "" ? "agent" : s;
}
