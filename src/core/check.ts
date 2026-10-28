// Runtime validation of untrusted input (protocol files, CLI arguments, HTTP bodies, hook input).

export class InputError extends Error {
  override name = "InputError";
}

export type Fields = Readonly<Record<string, unknown>>;

export function fields(value: unknown, where: string): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError(`${where}: expected an object, got ${describe(value)}`);
  }
  return value as Fields;
}

export function text(value: unknown, where: string, max = 20_000): string {
  if (typeof value !== "string") throw new InputError(`${where}: expected text, got ${describe(value)}`);
  if (value.length > max) throw new InputError(`${where}: text longer than ${max} characters`);
  return value;
}

export function nonEmpty(value: unknown, where: string, max = 20_000): string {
  const t = text(value, where, max);
  if (t.trim() === "") throw new InputError(`${where}: must not be empty`);
  return t;
}

export function optional<T>(value: unknown, where: string, read: (v: unknown, where: string) => T): T | undefined {
  return value === undefined || value === null ? undefined : read(value, where);
}

export function int(value: unknown, where: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new InputError(`${where}: expected an integer between ${min} and ${max}, got ${describe(value)}`);
  }
  return value;
}

export function num(value: unknown, where: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new InputError(`${where}: expected a number between ${min} and ${max}, got ${describe(value)}`);
  }
  return value;
}

export function bool(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") throw new InputError(`${where}: expected true or false, got ${describe(value)}`);
  return value;
}

export function list<T>(value: unknown, where: string, read: (v: unknown, where: string) => T, max = 1000): T[] {
  if (!Array.isArray(value)) throw new InputError(`${where}: expected a list, got ${describe(value)}`);
  if (value.length > max) throw new InputError(`${where}: more than ${max} items`);
  return value.map((v, i) => read(v, `${where}[${i}]`));
}

export function oneOf<const T extends string>(values: readonly T[]) {
  return (value: unknown, where: string): T => {
    if (typeof value === "string" && (values as readonly string[]).includes(value)) return value as T;
    throw new InputError(`${where}: expected one of ${values.join(", ")}, got ${describe(value)}`);
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function isoTime(value: unknown, where: string): string {
  if (typeof value !== "string" || !ISO.test(value) || Number.isNaN(Date.parse(value))) {
    throw new InputError(`${where}: expected a UTC ISO time such as 2026-01-31T09:30:00.000Z, got ${describe(value)}`);
  }
  return value;
}

// Only local previews may be linked from the desk.
const LOCAL_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/[^\s]*)?$/;

export function localUrl(value: unknown, where: string): string {
  const t = text(value, where, 2000);
  if (!LOCAL_URL.test(t)) throw new InputError(`${where}: only local URLs (http://localhost:PORT/...) are allowed, got ${describe(t)}`);
  return t;
}

/** Drops keys whose value is undefined, so optional fields stay absent (exactOptionalPropertyTypes). */
export function compact<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value === "object" ? "an object" : String(value);
}
