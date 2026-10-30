// @ts-check
// DOM building blocks. Session text only ever enters the page as text nodes or attribute values.

/** @typedef {Node | string | number | null | undefined | false} Leaf */
/** @typedef {Leaf | Leaf[] | (Leaf | Leaf[] | (Leaf | Leaf[])[])[]} Child */
/** @typedef {Record<string, string | number | boolean | null | undefined | EventListener>} Attrs */

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag @param {Attrs} [attrs] @param {Child[]} kids
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = String(v);
    else if (k === "style") el.style.cssText = String(v); // CSSOM, allowed under the page's CSP
    else if (k === "href") el.setAttribute(k, safeHref(String(v)));
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, kids);
  return el;
}

/** Replaces an element's content; skips null, undefined and false like h(). @param {Element} el @param {Child[]} kids */
export function fill(el, ...kids) {
  el.replaceChildren();
  append(el, kids);
}

/** @param {Element} el @param {readonly unknown[]} kids */
function append(el, kids) {
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

// Links leave the desk only to local previews and session links built by the desk.
const SAFE_HREF = /^(https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/|$)|vscode:\/\/agent-desk\.agent-desk\/|#|\/(?!\/))/;
/** @param {string} href */
function safeHref(href) {
  if (!SAFE_HREF.test(href)) throw new Error(`refusing link ${href}`);
  return href;
}

const ICONS = {
  go: '<path d="M7 17 17 7M9 7h8v8"/>',
  tag: '<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/><circle cx="7.5" cy="7.5" r="1.2" fill="currentColor"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  auto: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor"/>',
  board: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  bellOff: '<path d="M8.7 3A6 6 0 0 1 18 8a21 21 0 0 0 .6 5M17 17H3s3-2 3-9a4.7 4.7 0 0 1 .3-1.7"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0M2 2l20 20"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  inbox: '<path d="M3 13h5l1.5 3h5l1.5-3h5"/><path d="M5.5 5h13L21 13v6H3v-6z"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>',
};
/** @typedef {keyof typeof ICONS} IconName */

const SVG_NS = "http://www.w3.org/2000/svg";

/** @param {IconName} name @param {string} [cls] */
export function icon(name, cls = "i") {
  const s = svgEl("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", class: cls, "aria-hidden": "true" });
  s.innerHTML = ICONS[name]; // constants of this file, never session text
  return s;
}

/** @param {string} tag @param {Record<string, string | number>} attrs */
export function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * Session text as blocks: paragraphs, "- " / "* " / "1. " lists nested by indentation, "#" headings,
 * "| a | b |" tables and ``` fences. Everything stays text; inline marks go through md(). With
 * `breaks`, a paragraph keeps its line breaks: what the developer typed or pasted (terminal output).
 * @param {string} text @param {{ breaks?: boolean }} [options] @returns {HTMLElement[]}
 */
export function mdBlocks(text, { breaks = false } = {}) {
  /** @type {HTMLElement[]} */
  const out = [];
  /** @type {{ indent: number, list: HTMLElement }[]} */
  let lists = [];
  /** @type {string[]} */
  let para = [];
  const flush = () => {
    if (para.length) out.push(breaks ? h("p", { class: "md-br" }, md(para.join("\n"))) : h("p", {}, md(para.join(" "))));
    para = [];
  };
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*```/.test(line)) {
      flush();
      lists = [];
      const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i] ?? "")) code.push(lines[i]);
      out.push(h("pre", { "data-copy": true }, code.join("\n")));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      lists = [];
      /** @type {string[][]} */
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? ""); i++) {
        const cells = (lines[i] ?? "").trim().slice(1, -1).split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells); // the |---| line under the header
      }
      i--;
      const [head, ...body] = rows;
      out.push(
        h("div", { class: "md-table" }, h("table", {}, head ? h("thead", {}, h("tr", {}, head.map((c) => h("th", {}, md(c))))) : null, h("tbody", {}, body.map((r) => h("tr", {}, r.map((c) => h("td", {}, md(c)))))))),
      );
      continue;
    }
    const item = /^(\s*)(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const indent = (item[1] ?? "").replace(/\t/g, "  ").length;
      while (lists.length && (lists.at(-1)?.indent ?? 0) > indent) lists.pop();
      let top = lists.at(-1);
      if (!top || top.indent < indent) {
        // A numbered list keeps its first number: a list shown from its third item starts at 3.
        const list = item[2] ? h("ol", Number(item[2]) > 1 ? { start: Number(item[2]) } : {}) : h("ul", {});
        const parentItem = top?.list.lastElementChild;
        if (parentItem) parentItem.append(list);
        else out.push(list);
        top = { indent, list };
        lists.push(top);
      }
      top.list.append(h("li", {}, md(item[3] ?? "")));
      continue;
    }
    if (line.trim() === "") {
      flush();
      lists = [];
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      lists = [];
      out.push(h("p", { class: "md-h" }, h("b", {}, md(heading[1] ?? ""))));
      continue;
    }
    const continued = lists.at(-1)?.list.lastElementChild;
    if (continued && /^\s+\S/.test(line)) continued.append(" ", ...md(line.trim())); // wrapped list item
    else {
      lists = [];
      para.push(line.trim());
    }
  }
  flush();
  return out;
}

/** Inline marks of session text: **bold** and `code`. Code, like a ``` block, is marked as copyable. @param {string} text */
export function md(text) {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part) =>
    part.startsWith("**") && part.length > 4 ? h("b", {}, part.slice(2, -2)) : part.startsWith("`") && part.length > 2 ? h("code", { "data-copy": true }, part.slice(1, -1)) : part,
  );
}

/** @param {string} id @returns {HTMLElement} */
export function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`the page has no #${id}`);
  return el;
}

/** @param {string} id @returns {HTMLDialogElement} */
export function dialog(id) {
  const el = byId(id);
  if (!(el instanceof HTMLDialogElement)) throw new Error(`#${id} is not a dialog`);
  return el;
}
