// A review page the desk draws itself from a session's data (agent-desk review "<title>" --options
// <file.json>): questions, each with options to choose between, in the desk's look. Every option is
// marked for the desk's controls (data-agent-desk-option, grouped by data-agent-desk-group), which the
// shim adds; the page has no script of its own and holds the session's text only as escaped text.
import * as fs from "node:fs";
import * as path from "node:path";
import { bool, CONTROL, fields, InputError, list, localUrl, nonEmpty, optional, text } from "../core/check.ts";
import { imageDataUri } from "./review-page.ts";

export const OPTIONS_FILE_MAX = 1024 * 1024;
export const OPTIONS_LIMITS = { questions: 20, options: 12, images: 6, label: 40, title: 200, text: 4000 } as const;

type Option = { label: string; title: string; text?: string; images: string[]; recommended: boolean; url?: string };
type Question = { title: string; text?: string; options: Option[] };
export type OptionsReview = { intro?: string; questions: Question[] };

/** Refuses a key the format does not have: a typo must not drop what the session meant to show. */
function only(f: Readonly<Record<string, unknown>>, keys: string[], where: string): void {
  for (const k of Object.keys(f)) if (!keys.includes(k)) throw new InputError(`${where}: unknown field ${JSON.stringify(k)} (expected ${keys.join(", ")})`);
}

function line(value: unknown, where: string, max: number): string {
  const t = nonEmpty(value, where, max).trim();
  if (CONTROL.test(t)) throw new InputError(`${where}: one line without control characters`);
  return t;
}

const prose = (value: unknown, where: string) => text(value, where, OPTIONS_LIMITS.text);

/** The review's data, checked: every limit and every field, with where it failed. */
export function readOptionsReview(value: unknown, where: string): OptionsReview {
  const f = fields(value, where);
  only(f, ["intro", "questions"], where);
  const questions = list(
    f.questions,
    `${where}.questions`,
    (q, qw): Question => {
      const qf = fields(q, qw);
      only(qf, ["title", "text", "options"], qw);
      const options = list(
        qf.options,
        `${qw}.options`,
        (o, ow): Option => {
          const of = fields(o, ow);
          only(of, ["label", "title", "text", "images", "recommended", "url"], ow);
          const t = optional(of.text, `${ow}.text`, prose);
          const url = optional(of.url, `${ow}.url`, localUrl);
          const option: Option = {
            label: line(of.label, `${ow}.label`, OPTIONS_LIMITS.label),
            title: line(of.title, `${ow}.title`, OPTIONS_LIMITS.title),
            images: list(of.images ?? [], `${ow}.images`, (p, pw) => nonEmpty(p, pw, 4096), OPTIONS_LIMITS.images),
            recommended: optional(of.recommended, `${ow}.recommended`, bool) ?? false,
            ...(url === undefined ? {} : { url }),
          };
          return t === undefined || t.trim() === "" ? option : { ...option, text: t };
        },
        OPTIONS_LIMITS.options,
      );
      if (options.length === 0) throw new InputError(`${qw}.options: at least one option`);
      const labels = new Set<string>();
      for (const o of options) {
        if (labels.has(o.label)) throw new InputError(`${qw}.options: the label ${JSON.stringify(o.label)} twice; each option of a question needs its own`);
        labels.add(o.label);
      }
      const t = optional(qf.text, `${qw}.text`, prose);
      const question: Question = { title: line(qf.title, `${qw}.title`, OPTIONS_LIMITS.title), options };
      return t === undefined || t.trim() === "" ? question : { ...question, text: t };
    },
    OPTIONS_LIMITS.questions,
  );
  if (questions.length === 0) throw new InputError(`${where}.questions: at least one question`);
  const titles = new Set<string>();
  for (const q of questions) {
    if (titles.has(q.title)) throw new InputError(`${where}.questions: the title ${JSON.stringify(q.title)} twice; each question needs its own`);
    titles.add(q.title);
  }
  const intro = optional(f.intro, `${where}.intro`, prose);
  return intro === undefined || intro.trim() === "" ? { questions } : { intro, questions };
}

/** Reads and checks the session's JSON file; its images are named relative to its folder. */
export function readOptionsFile(file: string): { review: OptionsReview; folder: string } {
  const where = `--options ${file}`;
  let raw: string;
  let folder: string;
  try {
    const real = fs.realpathSync(path.resolve(file));
    if (!fs.statSync(real).isFile()) throw new InputError(`${where}: not a file`);
    if (fs.statSync(real).size > OPTIONS_FILE_MAX) throw new InputError(`${where}: larger than ${OPTIONS_FILE_MAX} bytes; images go beside it, named by their path`);
    raw = fs.readFileSync(real, "utf8");
    folder = path.dirname(real);
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(`${where}: cannot read it (${(error as Error).message})`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new InputError(`${where}: not valid JSON (${(error as Error).message})`);
  }
  return { review: readOptionsReview(value, where), folder };
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** The session's text as text: never markup, in an element or an attribute. */
const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

// The desk's own colours (src/web/style.css), light and dark: a test keeps them the same.
const LOOK = `
:root { --bg: #f4f5f8; --surface: #fff; --surface-2: #f8f9fb; --border: #e2e5eb; --border-strong: #c9ced8; --text: #161b26; --muted: #586274;
  --accent: #5146dc; --done: #1f9d4f; color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0e1016; --surface: #171a21; --surface-2: #1d2129; --border: #2a2f3a; --border-strong: #3c4352; --text: #e4e7ec; --muted: #9fa7b5;
    --accent: #8a90fb; --done: #42c977; color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased; }
main { max-width: 860px; margin: 0 auto; padding: 20px 16px 48px; display: flex; flex-direction: column; gap: 28px; }
.said { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
.intro { color: var(--muted); }
h1 { font-size: 22px; line-height: 1.25; margin: 0; }
.q { display: flex; flex-direction: column; gap: 12px; }
.q > h2 { font-size: 18px; line-height: 1.3; margin: 0; }
.q > .said { color: var(--muted); }
.opt { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.opt.rec { border-color: color-mix(in srgb, var(--done) 55%, var(--border)); }
.opt header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.opt h3 { font-size: 16px; line-height: 1.35; margin: 0; flex: 1; min-width: 12em; }
.label { flex: none; min-width: 28px; padding: 2px 8px; border-radius: 6px; text-align: center; font-weight: 700; font-size: 13px;
  background: color-mix(in srgb, var(--accent) 14%, var(--surface)); color: var(--accent); }
.rec-badge { flex: none; font-size: 12px; font-weight: 700; color: var(--done); }
.live { margin: 0; }
.live a { color: var(--accent); font-weight: 600; text-decoration: none; }
.live a:hover { text-decoration: underline; text-underline-offset: 2px; }
.shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.shot { display: flex; justify-content: center; cursor: zoom-in; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 6px; }
.shot input { position: absolute; opacity: 0; pointer-events: none; }
/* At its own size at most: a small screenshot is not blown up blurred. */
.shot img { display: block; max-width: 100%; max-height: 420px; height: auto; border-radius: 4px; }
/* Tapped, an image fills the screen; tapped again, it goes back. No script: a checkbox holds the state. */
.shot input:checked + img { position: fixed; inset: 0; z-index: 10; width: 100vw; height: 100vh; max-height: none; border: 0; border-radius: 0; padding: 12px;
  object-fit: contain; background: rgb(0 0 0 / .88); cursor: zoom-out; }
.shot input:focus-visible + img { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 600px) { main { padding: 16px 12px 40px; gap: 24px; } .shots { grid-template-columns: 1fr; } }`;

/** The page: escaped text, inlined images, every option marked for the desk's controls. Throws when an image cannot be inlined. */
export function renderOptionsPage(title: string, review: OptionsReview, folder: string): { html: string; images: number } {
  let images = 0;
  const shot = (ref: string, where: string, alt: string) => {
    const found = imageDataUri(folder, ref);
    if (typeof found !== "string") throw new InputError(`${where}: ${JSON.stringify(ref)} is not inlined: ${found.reason}`);
    images++;
    return `<label class="shot"><input type="checkbox" aria-label="Zoom ${esc(alt)}"><img src="${found}" alt="${esc(alt)}"></label>`;
  };
  const said = (value: string | undefined, cls = "said") => (value === undefined ? "" : `<p class="${cls}">${esc(value)}</p>`);
  const questions = review.questions.map((q, qi) => {
    const options = q.options.map((o, oi) => {
      const where = `--options: questions[${qi}].options[${oi}].images`;
      const shots = o.images.map((ref, i) => shot(ref, `${where}[${i}]`, `${o.label}: ${o.title}${o.images.length > 1 ? ` (${i + 1})` : ""}`));
      return [
        `<article class="opt${o.recommended ? " rec" : ""}" data-agent-desk-option="${esc(o.label)}">`,
        `<header><span class="label">${esc(o.label)}</span><h3>${esc(o.title)}</h3>${o.recommended ? '<span class="rec-badge">Recommended</span>' : ""}</header>`,
        said(o.text),
        o.url === undefined ? "" : `<p class="live"><a href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">Open live ↗</a></p>`,
        shots.length ? `<div class="shots">${shots.join("")}</div>` : "",
        "</article>",
      ].join("");
    });
    return `<section class="q" data-agent-desk-group="${esc(q.title)}"><h2>${esc(q.title)}</h2>${said(q.text)}${options.join("\n")}</section>`;
  });
  const html = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title><style>${LOOK}</style></head><body><main>`,
    `<h1>${esc(title)}</h1>${said(review.intro, "said intro")}`,
    questions.join("\n"),
    "</main></body></html>",
  ].join("\n");
  return { html, images };
}
