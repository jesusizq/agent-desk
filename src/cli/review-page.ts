// A review's page as the desk keeps it: the HTML file a session wrote, with the images it references
// by a relative path inlined as data: URIs, since the desk serves the page with no way to load files.
import * as fs from "node:fs";
import * as path from "node:path";
import { InputError } from "../core/check.ts";
import { REVIEW_PAGE_MAX } from "../core/model.ts";
import { isCode } from "../store/fsx.ts";
import { imageType } from "../store/store.ts";

export type InlinedPage = { html: string; inlined: number; skipped: { ref: string; reason: string }[] };

const TYPES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml" } as const;

const ATTRS = `(?:[^>"']|"[^"]*"|'[^']*')*`;
/** Script and style elements and comments: tags inside them are text, not elements. */
const RAW = new RegExp(`<script\\b${ATTRS}>[\\s\\S]*?</script\\s*>|(<style\\b${ATTRS}>)([\\s\\S]*?)(</style\\s*>)|<!--[\\s\\S]*?-->`, "gi");
const TAG = new RegExp(`<([a-z][^\\s/>]*)${ATTRS}>`, "gi");
const ATTR = /(\s)(src|srcset|style)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)/gi;

/**
 * Reads the page and inlines what its `<img src>`, `srcset`, `<source srcset>` and CSS `url()` (in
 * `<style>` and `style=""`) name by a relative path, only when the file's real path is inside the
 * page's own folder (symlinks resolved) and it is a PNG, JPEG, GIF, WebP, AVIF or SVG image. The
 * rest is left as it is, and listed in `skipped`.
 */
export function inlinePage(file: string): InlinedPage {
  let html: string;
  let folder: string;
  try {
    const page = fs.realpathSync(path.resolve(file));
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
  const inline = (ref: string): string | undefined => {
    const found = dataUri(folder, ref, cache);
    if (found === undefined) return undefined;
    if (typeof found !== "string") {
      skipped.push({ ref, reason: found.reason });
      return undefined;
    }
    inlined++;
    return found;
  };
  const css = (text: string) => text.replace(CSS_URL, (whole, a?: string, b?: string, c?: string) => {
    const uri = inline(decodeEntities(a ?? b ?? c ?? ""));
    return uri === undefined ? whole : `url(${uri})`;
  });
  const tags = (text: string) =>
    text.replace(TAG, (tag, name: string) => {
      const media = /^(img|source)$/i.test(name);
      return tag.replace(ATTR, (whole, space: string, attr: string, eq: string, dq?: string, sq?: string) => {
        const quote = dq === undefined ? "'" : '"';
        const value = dq ?? sq ?? "";
        const kind = attr.toLowerCase();
        let next: string;
        if (kind === "style") next = css(value);
        else if (!media) return whole;
        else if (kind === "src") next = inline(decodeEntities(value)) ?? value;
        else next = srcset(value, (ref) => inline(decodeEntities(ref)));
        return `${space}${attr}${eq}${quote}${next}${quote}`;
      });
    });
  let out = "";
  let last = 0;
  for (const m of html.matchAll(RAW)) {
    out += tags(html.slice(last, m.index));
    out += m[1] !== undefined && m[2] !== undefined && m[3] !== undefined ? m[1] + css(m[2]) + m[3] : m[0];
    last = m.index + m[0].length;
  }
  out += tags(html.slice(last));
  return { html: out, inlined, skipped };
}

/** A `srcset` with each candidate's URL replaced when `swap` gives one; descriptors and commas stay. */
function srcset(value: string, swap: (ref: string) => string | undefined): string {
  // As the HTML spec reads it: a candidate's URL runs to the next space, and commas it ends with
  // end the candidate; otherwise its descriptors run to the next comma.
  let out = "";
  let i = 0;
  while (i < value.length) {
    const gap = /^[\s,]*/.exec(value.slice(i))?.[0] ?? "";
    out += gap;
    i += gap.length;
    if (i >= value.length) break;
    let j = i;
    while (j < value.length && !/\s/.test(value.charAt(j))) j++;
    const word = value.slice(i, j);
    const commas = /,*$/.exec(word)?.[0] ?? "";
    const url = word.slice(0, word.length - commas.length);
    out += (swap(url) ?? url) + commas;
    i = j;
    if (commas !== "") continue;
    let k = i;
    while (k < value.length && value.charAt(k) !== ",") k++;
    out += value.slice(i, k);
    i = k;
  }
  return out;
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

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", "#39": "'", "#34": '"' };

function decodeEntities(value: string): string {
  return value.replace(/&(amp|quot|apos|lt|gt|#39|#34);/g, (whole, e: string) => ENTITIES[e] ?? whole);
}
