// A review's page as the desk keeps it: the HTML file a session wrote, with the images it references
// by a relative path inlined as data: URIs, since the desk serves the page with no way to load files.
import * as fs from "node:fs";
import * as path from "node:path";
import { InputError } from "../core/check.ts";
import { REVIEW_PAGE_MAX, REVIEW_TITLE_MAX } from "../core/model.ts";
import { isCode } from "../store/fsx.ts";
import { imageType } from "../store/store.ts";

/** `file`: the page's real path (symlinks resolved). */
export type InlinedPage = { file: string; html: string; inlined: number; skipped: { ref: string; reason: string }[] };

const TYPES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml" } as const;

const NAME = /[a-zA-Z][^\s/>]*/y;
const SPACE = /[\s,]*/y;

/**
 * Reads the page and inlines what its `<img src>`, `srcset`, `<source srcset>` and CSS `url()` (in
 * `<style>` and `style=""`) name by a relative path, only when the file's real path is inside the
 * page's own folder (symlinks resolved) and it is a PNG, JPEG, GIF, WebP, AVIF or SVG image. The
 * rest is left as it is, and listed in `skipped`. One pass over the page, in time and memory linear
 * in its size; past REVIEW_PAGE_MAX with its images it stops with an error.
 */
export function inlinePage(file: string): InlinedPage {
  let html: string;
  let folder: string;
  let page: string;
  try {
    page = fs.realpathSync(path.resolve(file));
    if (!fs.statSync(page).isFile()) throw new InputError(`--page: ${file} is not a file`);
    if (fs.statSync(page).size > REVIEW_PAGE_MAX) throw new InputError(`--page: ${file} is larger than ${REVIEW_PAGE_MAX} bytes`);
    html = fs.readFileSync(page, "utf8");
    folder = path.dirname(page);
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(`--page: cannot read ${file} (${(error as Error).message})`);
  }
  const skipped: InlinedPage["skipped"] = [];
  const cache = new Map<string, string | { reason: string }>();
  let inlined = 0;
  let bytes = Buffer.byteLength(html);
  /** The data: URI to put in place of `raw` (the reference as written), or undefined to leave it. */
  const inline = (raw: string): string | undefined => {
    const ref = decodeEntities(raw);
    const found = dataUri(folder, ref, cache);
    if (found === undefined) return undefined;
    if (typeof found !== "string") {
      skipped.push({ ref, reason: found.reason });
      return undefined;
    }
    bytes += found.length - Buffer.byteLength(raw);
    if (bytes > REVIEW_PAGE_MAX) throw new InputError(`--page: with its images inlined the page would be larger than ${REVIEW_PAGE_MAX} bytes (at ${JSON.stringify(ref)}); use fewer or smaller images, or reference one file fewer times`);
    inlined++;
    return found;
  };
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    out.push(html.slice(i, lt));
    i = lt;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) break; // an unclosed comment runs to the end: the rest stays as it is
      out.push(html.slice(lt, end + 3));
      i = end + 3;
      continue;
    }
    NAME.lastIndex = lt + 1;
    const name = NAME.exec(html)?.[0];
    if (name === undefined) {
      out.push("<");
      i = lt + 1;
      continue;
    }
    const close = tagEnd(html, lt + 1 + name.length);
    if (close < 0) break; // an unclosed tag runs to the end
    const lower = name.toLowerCase();
    out.push(rewriteTag(html, lt, close, lower === "img" || lower === "source", inline));
    i = close + 1;
    if (lower !== "script" && lower !== "style") continue;
    // Script and style text runs to its closing tag; none, and it runs to the end.
    const closer = new RegExp(`</${lower}`, "gi");
    closer.lastIndex = i;
    const found = closer.exec(html);
    if (!found) break;
    const content = html.slice(i, found.index);
    out.push(lower === "style" ? css(content, inline) : content);
    i = found.index;
  }
  out.push(html.slice(i));
  return { file: page, html: out.join(""), inlined, skipped };
}

/** Where the tag whose attributes start at `from` ends (its ">"), or -1 when it never does. */
function tagEnd(html: string, from: number): number {
  let quote = "";
  let afterEquals = false;
  for (let k = from; k < html.length; k++) {
    const c = html.charAt(k);
    if (quote !== "") {
      if (c === quote) quote = "";
      continue;
    }
    if (c === ">") return k;
    if ((c === '"' || c === "'") && afterEquals) quote = c;
    if (c === "=") afterEquals = true;
    else if (!/\s/.test(c)) afterEquals = false;
  }
  return -1;
}

/** The tag from `start` to `close`, its `src`, `srcset` (on media only) and `style` values inlined. */
function rewriteTag(html: string, start: number, close: number, media: boolean, inline: (raw: string) => string | undefined): string {
  const tag = html.slice(start, close + 1);
  const parts: string[] = [];
  let last = 0;
  let k = tag.search(/[\s/>]/);
  while (k >= 0 && k < tag.length - 1) {
    while (k < tag.length - 1 && /[\s/]/.test(tag.charAt(k))) k++;
    const nameStart = k;
    while (k < tag.length - 1 && !/[\s/=>]/.test(tag.charAt(k))) k++;
    const attr = tag.slice(nameStart, k).toLowerCase();
    let j = k;
    while (j < tag.length - 1 && /\s/.test(tag.charAt(j))) j++;
    if (tag.charAt(j) !== "=") {
      if (k === nameStart) k++;
      continue;
    }
    j++;
    while (j < tag.length - 1 && /\s/.test(tag.charAt(j))) j++;
    const q = tag.charAt(j);
    let valueStart: number;
    let valueEnd: number;
    if (q === '"' || q === "'") {
      valueStart = j + 1;
      valueEnd = tag.indexOf(q, valueStart);
      if (valueEnd < 0) break;
      k = valueEnd + 1;
    } else {
      valueStart = j;
      valueEnd = j;
      while (valueEnd < tag.length - 1 && !/[\s>]/.test(tag.charAt(valueEnd))) valueEnd++;
      k = valueEnd;
    }
    const value = tag.slice(valueStart, valueEnd);
    let next: string | undefined;
    if (attr === "style") next = css(value, inline);
    else if (media && attr === "src") next = inline(value);
    else if (media && attr === "srcset") next = srcset(value, inline);
    if (next !== undefined && next !== value) {
      parts.push(tag.slice(last, valueStart), next);
      last = valueEnd;
    }
  }
  parts.push(tag.slice(last));
  return parts.join("");
}

/** CSS text with each `url()` inlined; a quote or parenthesis never closed leaves the rest as it is. */
function css(text: string, inline: (raw: string) => string | undefined): string {
  const out: string[] = [];
  const opener = /url\(/gi;
  let last = 0;
  for (;;) {
    const m = opener.exec(text);
    if (!m) break;
    let k = m.index + 4;
    while (k < text.length && /\s/.test(text.charAt(k))) k++;
    const q = text.charAt(k);
    let raw: string;
    if (q === '"' || q === "'") {
      const end = text.indexOf(q, k + 1);
      if (end < 0) break; // none later either
      raw = text.slice(k + 1, end);
      k = end + 1;
    } else {
      const from = k;
      while (k < text.length && !/[)\s"']/.test(text.charAt(k))) k++;
      raw = text.slice(from, k);
    }
    while (k < text.length && /\s/.test(text.charAt(k))) k++;
    opener.lastIndex = k;
    if (text.charAt(k) !== ")") continue;
    const uri = inline(raw);
    if (uri === undefined) continue;
    out.push(text.slice(last, m.index), `url(${uri})`);
    last = k + 1;
    opener.lastIndex = k + 1;
  }
  out.push(text.slice(last));
  return out.join("");
}

/** A `srcset` with each candidate's URL replaced when `swap` gives one; descriptors and commas stay. */
function srcset(value: string, swap: (raw: string) => string | undefined): string {
  // As the HTML spec reads it: a candidate's URL runs to the next space, and commas it ends with
  // end the candidate; otherwise its descriptors run to the next comma.
  const out: string[] = [];
  let i = 0;
  while (i < value.length) {
    SPACE.lastIndex = i;
    const gap = SPACE.exec(value)?.[0] ?? "";
    out.push(gap);
    i += gap.length;
    if (i >= value.length) break;
    let j = i;
    while (j < value.length && !/\s/.test(value.charAt(j))) j++;
    let end = j;
    while (end > i && value.charAt(end - 1) === ",") end--;
    const url = value.slice(i, end);
    out.push(swap(url) ?? url, value.slice(end, j));
    i = j;
    if (end < j) continue;
    let k = value.indexOf(",", i);
    if (k < 0) k = value.length;
    out.push(value.slice(i, k));
    i = k;
  }
  return out.join("");
}

/**
 * An image a review names by a path relative to `folder`, as a data: URI, under the same rules as a
 * page's images (inside the folder, symlinks resolved; a PNG, JPEG, GIF, WebP, AVIF or SVG); or why not.
 */
export function imageDataUri(folder: string, ref: string): string | { reason: string } {
  return dataUri(folder, ref, new Map()) ?? { reason: "no file named" };
}

/**
 * The file a relative reference names as a data: URI, or why it is not inlined; undefined for what
 * is no file to inline (already a data: URI, a fragment).
 */
function dataUri(folder: string, ref: string, cache: Map<string, string | { reason: string }>): string | { reason: string } | undefined {
  const trimmed = ref.trim();
  if (trimmed === "" || trimmed.startsWith("#") || /^data:/i.test(trimmed)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return { reason: "not a file beside the page (the desk loads nothing from the network)" };
  if (trimmed.startsWith("/")) return { reason: "an absolute path; only paths relative to the page's folder are inlined" };
  let relative: string;
  try {
    relative = decodeURIComponent(trimmed.replace(/[?#].*$/, ""));
  } catch {
    return { reason: "a malformed %-escape" }; // reported in the list, as every reference left out is
  }
  const lexical = path.resolve(folder, relative);
  const known = cache.get(lexical);
  if (known !== undefined) return known;
  const found = readImage(folder, lexical);
  cache.set(lexical, found);
  return found;
}

function readImage(folder: string, file: string): string | { reason: string } {
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch (error) {
    // Reported in the list with the others: a missing image is the page's to fix, not a failure to publish.
    return { reason: isCode(error, "ENOENT") ? "no such file" : (error as Error).message };
  }
  const rel = path.relative(folder, real);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { reason: "outside the page's folder (symlinks resolved)" };
  const stat = fs.statSync(real);
  if (!stat.isFile()) return { reason: "not a file" };
  if (stat.size > REVIEW_PAGE_MAX) return { reason: `larger than ${REVIEW_PAGE_MAX} bytes` };
  const data = fs.readFileSync(real);
  const type = imageType(data) ?? avifOrSvg(data, real);
  if (!type) return { reason: "not a PNG, JPEG, GIF, WebP, AVIF or SVG image" };
  return `data:${TYPES[type]};base64,${data.toString("base64")}`;
}

function avifOrSvg(data: Buffer, file: string): "avif" | "svg" | undefined {
  if (data.subarray(4, 8).toString("latin1") === "ftyp" && /^avi[fs]$/.test(data.subarray(8, 12).toString("latin1"))) return "avif";
  // An SVG is text: named so, and opening with its root element after any prolog.
  const head = data.subarray(0, 4096).toString("utf8").replace(/^﻿/, "");
  if (/\.svg$/i.test(file) && /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head)) return "svg";
  return undefined;
}

/**
 * What names a page that a session opened without naming it: its `<title>` as it reads (entities
 * decoded, spacing collapsed, cut to a review title's length), else the file's name.
 */
export function pageTitle(html: string, file: string): string {
  const written = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? "";
  const title = decodeEntities(written.replace(/<[^>]*>/g, "")).replace(/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim() || path.basename(file);
  return title.length > REVIEW_TITLE_MAX ? `${title.slice(0, REVIEW_TITLE_MAX - 1).trimEnd()}…` : title;
}

/**
 * The scripts and stylesheets a page loads from files beside it (`<script src>`, `<link
 * rel=stylesheet href>` with a relative reference): a page made of several files (an app's build, a
 * generated report), which a review, kept as one file, cannot carry.
 */
export function localAssets(html: string): string[] {
  const local = (ref: string | undefined) => ref !== undefined && ref !== "" && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref);
  const value = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);
  const found: string[] = [];
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const ref = /^<script/i.test(tag) ? value(tag, "src") : /stylesheet/i.test(value(tag, "rel") ?? "") ? value(tag, "href") : undefined;
    if (local(ref)) found.push(decodeEntities(ref ?? ""));
  }
  return found;
}

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", "#39": "'", "#34": '"' };

function decodeEntities(value: string): string {
  return value.replace(/&(amp|quot|apos|lt|gt|#39|#34);/g, (whole, e: string) => ENTITIES[e] ?? whole);
}
