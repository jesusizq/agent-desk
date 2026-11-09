// @ts-check
// Formatting: times, durations, sizes, colours and the lines read out of session text.
import { TEXT } from "./text.js";

const WARM_AFTER = 30;
const HOT_AFTER = 120;

const PALETTE = ["#6366f1", "#14b8a6", "#f59e0b", "#ec4899", "#0ea5e9", "#84cc16", "#a855f7", "#d946ef"];

/** The first line of a message, without Markdown markers. @param {string} text */
export const firstLine = (text) => (text.split("\n").map((l) => l.trim()).find(Boolean) ?? "").replace(/^(?:#+|[-*>]|\d+[.)])\s+/, "").replace(/\*\*|`/g, "");

/** @param {string} text */
export const color = (text) => PALETTE[[...text].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length] ?? "#6366f1";
/** @param {string} iso */
export const hm = (iso) => new Date(iso).toTimeString().slice(0, 5);
/** @param {string} iso @param {number} [to] */
const minutes = (iso, to = Date.now()) => Math.max(0, Math.round((to - Date.parse(iso)) / 60000));
/** @param {number} m */
export function duration(m) {
  if (m < 1) return TEXT.now;
  if (m < 60) return `${m} min`;
  const hours = Math.floor(m / 60);
  if (hours < 48) return `${hours} h${m % 60 ? ` ${m % 60} min` : ""}`;
  return `${Math.floor(hours / 24)} d${hours % 24 ? ` ${hours % 24} h` : ""}`;
}
/** When something happened: its time today, its day too before then. @param {string} iso */
export const stamp = (iso) => (new Date(iso).toDateString() === new Date().toDateString() ? hm(iso) : dayLabel(iso));
/** A time to come as a clock time, with its weekday once it is not today. @param {string} iso */
export function clockAt(iso) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? hm(iso) : `${d.toLocaleDateString(TEXT.locale, { weekday: "short" })} ${hm(iso)}`;
}
/** @param {string} iso @param {string} [until] */
export const ago = (iso, until) => duration(minutes(iso, until ? Date.parse(until) : Date.now()));
/** @param {string} iso */
export const heat = (iso) => {
  const m = minutes(iso);
  return m >= HOT_AFTER ? " hot" : m >= WARM_AFTER ? " warm" : "";
};
/** @param {number} bytes */
export const gb = (bytes) => (bytes > 0 && bytes < 0.05e9 ? "< 0.1 GB" : `${(bytes / 1e9).toFixed(1)} GB`);

/** @param {string} provider */
export const providerMark = (provider) =>
  provider.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase() || "?";

/** The line of a question that asks (the line introducing a list of them, or its first line), without list markers. @param {string} text */
export function headline(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const item = /^(?:[-*•]|\d+[.)])\s+/;
  // Several questions in a list: the line that introduces them names them all.
  const first = lines.findIndex((l) => item.test(l));
  const intro = first > 0 && lines.filter((l) => item.test(l) && /[?¿]/.test(l)).length > 1 && /:$/.test(lines[first - 1] ?? "") ? lines[first - 1] : undefined;
  const asking = (intro ?? lines.find((l) => /[?¿]/.test(l)) ?? lines[0] ?? "").replace(item, "");
  if (asking.length <= 240) return asking;
  // A long paragraph: the sentence that asks, cut at a word if it is still too long.
  const sentence = asking.split(/(?<=[.!?…;])\s+/).find((x) => /[?¿]/.test(x)) ?? asking;
  return sentence.length > 240 ? `${sentence.slice(0, 240).replace(/\s+\S*$/, "")}…` : sentence;
}

/** @param {string} iso */
export function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 864e5);
  const t = TEXT.history;
  return days <= 0 ? `${t.today} ${hm(iso)}` : days === 1 ? `${t.yesterday} ${hm(iso)}` : `${d.toLocaleDateString(TEXT.locale, { day: "numeric", month: "short" })} ${hm(iso)}`;
}
