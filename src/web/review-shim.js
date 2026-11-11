// @ts-check
// Runs first in a review's page, which the desk shows in a sandbox without its origin: the page's
// localStorage is the review's saved state on the desk (window.__agentDeskReview, injected before
// this script), and what it copies goes to the desk. Every message is data for the desk page,
// which checks it; nothing here can make the desk do anything else.
(() => {
  /** @typedef {{ data: Record<string, string>, summary?: string, rev: number }} Saved */
  const w = /** @type {Window & { __agentDeskReview?: Saved }} */ (window);
  const saved = w.__agentDeskReview ?? { data: {}, rev: 0 };
  delete w.__agentDeskReview;

  /** @param {Record<string, unknown>} message */
  const send = (message) => parent.postMessage({ agentDesk: 1, ...message }, "*");

  /** @param {Map<string, string>} data @param {boolean} kept */
  const storage = (data, kept) => {
    /** @type {Storage} */
    const store = {
      getItem: (k) => data.get(String(k)) ?? null,
      setItem: (k, v) => {
        data.set(String(k), String(v));
        if (kept) send({ type: "set", key: String(k), value: String(v) });
      },
      removeItem: (k) => {
        data.delete(String(k));
        if (kept) send({ type: "remove", key: String(k) });
      },
      clear: () => {
        data.clear();
        if (kept) send({ type: "clear" });
      },
      key: (i) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    };
    return store;
  };
  Object.defineProperty(window, "localStorage", { value: storage(new Map(Object.entries(saved.data)), true), configurable: true });
  Object.defineProperty(window, "sessionStorage", { value: storage(new Map(), false), configurable: true });

  // A page usually says "Copied" after copying: that alert is the desk's to show, not the page's.
  let copiedAt = 0;
  /** @param {unknown} text */
  const copy = (text) => {
    copiedAt = Date.now();
    send({ type: "copy", text: String(text ?? "") });
  };
  const clipboard = {
    /** @param {string} text */
    writeText: async (text) => copy(text),
    /** @param {ClipboardItem[]} items */
    write: async (items) => {
      for (const item of items) if (item.types.includes("text/plain")) return copy(await (await item.getType("text/plain")).text());
      copy("");
    },
    readText: async () => "",
  };
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
  const exec = document.execCommand.bind(document);
  document.execCommand = (command, ...rest) => {
    if (String(command).toLowerCase() !== "copy") return exec(command, ...rest);
    // A page copying through a hidden textarea has selected its text there, not in the document.
    const field = document.activeElement;
    const selected = field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement ? field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? field.value.length) : String(getSelection() ?? "");
    copy(selected);
    return true;
  };
  window.alert = (message) => {
    if (Date.now() - copiedAt > 1500) send({ type: "notice", text: String(message ?? "") });
  };
  window.prompt = (_message, text) => {
    if (text !== undefined && text !== null) copy(text);
    return null;
  };
  window.confirm = (message) => {
    send({ type: "notice", text: String(message ?? "") });
    return false;
  };
  window.open = () => null;

  addEventListener("message", (e) => {
    if (e.source !== parent || typeof e.data !== "object" || e.data === null || e.data.type !== "collect") return;
    const button = document.querySelector("[data-agent-desk-answers]");
    if (button instanceof HTMLElement) button.click();
    else copy("");
  });

  // ---------- Options: the desk's own controls on what the page marks ----------
  // Each element marked data-agent-desk-option gets Choose / Iterate / Discard, and each group
  // (data-agent-desk-group, or every option outside one) None of these. What is picked is kept in the
  // routed localStorage under one reserved key, so it syncs and carries over rounds as the page's own
  // answers do; the desk validates it (src/core/options.ts) and reads it as the page's data.
  const OPTIONS_KEY = "agent-desk:options";
  const LABEL_MAX = 200;
  const NOTE_MAX = 2000;
  const routed = window.localStorage;
  /** @typedef {"choose" | "iterate" | "discard"} Pick */
  /** @typedef {{ label: string, pick: Pick, note?: string }} Mark */
  /** @typedef {{ name: string, none?: string, options: Mark[] }} Group */
  /** @typedef {{ name: string, at: Element | null, options: { label: string, el: Element }[] }} Shown */

  /** The marks kept, or none: a value the page itself wrote there that does not read is replaced at the next pick (the desk refuses it on save). @returns {Group[]} */
  const marks = () => {
    try {
      const v = JSON.parse(routed.getItem(OPTIONS_KEY) ?? "null");
      return v && Array.isArray(v.groups) ? v.groups : [];
    } catch {
      return []; // not the shim's JSON: the page wrote over the key; the next pick replaces it
    }
  };
  /** @param {string | null} v */
  const oneLine = (v) => (v ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);

  /** The groups and options the page marks now, in its order; labels made unique within a group. @returns {Shown[]} */
  const shown = () => {
    /** @type {Map<string, Shown>} */
    const groups = new Map();
    for (const el of document.querySelectorAll("[data-agent-desk-option]")) {
      const at = el.parentElement?.closest("[data-agent-desk-group]") ?? null;
      const name = at ? oneLine(at.getAttribute("data-agent-desk-group")) : "";
      const g = groups.get(name) ?? { name, at, options: [] };
      groups.set(name, g);
      const base = oneLine(el.getAttribute("data-agent-desk-option")) || `Option ${g.options.length + 1}`;
      let label = base;
      for (let n = 2; g.options.some((o) => o.label === label); n++) label = `${base} (${n})`.slice(0, LABEL_MAX);
      g.options.push({ label, el });
    }
    return [...groups.values()];
  };

  /** Changes one group's marks and keeps the whole, in the page's order (marks of options no longer on the page go). @param {string} name @param {(g: Group) => Group} change */
  const remark = (name, change) => {
    const kept = new Map(marks().map((g) => [g.name, g]));
    const page = shown();
    const groups = page
      .map((s) => {
        const before = kept.get(s.name) ?? { name: s.name, options: [] };
        const g = s.name === name ? change(before) : before;
        const options = s.options.map((o) => g.options.find((m) => m.label === o.label)).filter((m) => m !== undefined);
        return g.none === undefined ? { name: s.name, options } : { name: s.name, none: g.none, options };
      })
      .filter((g) => g.options.length > 0 || g.none !== undefined);
    if (groups.length) routed.setItem(OPTIONS_KEY, JSON.stringify({ groups }));
    else routed.removeItem(OPTIONS_KEY);
    paint();
    progress();
  };
  /** @param {string} name @param {string} label @param {Pick | null} pick @param {string} [note] */
  const mark = (name, label, pick, note) =>
    remark(name, (g) => {
      const others = g.options.filter((m) => m.label !== label);
      if (pick === null) return { ...g, options: others };
      const m = /** @type {Mark} */ (note ? { label, pick, note: note.slice(0, NOTE_MAX) } : { label, pick });
      // Choosing one is an answer to the group: "None of these" no longer holds.
      const { none, ...rest } = g;
      return { ...(pick === "choose" ? rest : g), options: [...others, m] };
    });

  const LOOK = `
:host { all: initial; display: block; margin: 12px 0 0; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", Arial, sans-serif;
  --surface: #fff; --surface-2: #f8f9fb; --border: #e2e5eb; --border-strong: #c9ced8; --text: #161b26; --muted: #586274;
  --accent: #5146dc; --accent-text: #fff; --done: #1f9d4f; --danger: #d63030; color: var(--text); text-align: left; }
@media (prefers-color-scheme: dark) {
  :host { --surface: #171a21; --surface-2: #1d2129; --border: #2a2f3a; --border-strong: #3c4352; --text: #e4e7ec; --muted: #9fa7b5;
    --accent: #8a90fb; --accent-text: #0e1016; --done: #42c977; --danger: #f04a43; }
}
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.lead { color: var(--muted); font-weight: 600; margin-right: 2px; }
button { font-family: inherit; font-size: 13px; font-weight: 600; line-height: 1; min-height: 32px; padding: 0 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); }
button:hover { border-color: var(--muted); }
button:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
button[aria-pressed="true"] { color: #fff; }
button.choose[aria-pressed="true"] { background: var(--done); border-color: var(--done); }
button.iterate[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button.discard[aria-pressed="true"], button.none[aria-pressed="true"] { background: var(--danger); border-color: var(--danger); }
label { display: block; margin-top: 8px; }
label span { display: block; color: var(--muted); font-weight: 600; margin-bottom: 4px; }
textarea { box-sizing: border-box; display: block; width: 100%; min-height: 3.2em; resize: vertical; font-family: inherit; font-size: 14px; line-height: 1.4;
  color: var(--text); background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 8px; padding: 6px 8px; }
[hidden] { display: none; }
@media (pointer: coarse) { button { min-height: 44px; padding: 0 14px; } textarea { font-size: 16px; } }
.group { padding: 10px 12px; border: 1px dashed var(--border-strong); border-radius: 10px; background: var(--surface); }`;

  /** @type {WeakMap<Element, { host: HTMLElement, paint: () => void }>} */
  const controls = new WeakMap();
  /** @type {Map<string, { host: HTMLElement, paint: () => void }>} */
  const groupControls = new Map();
  // Elements that cannot hold the controls get them right after.
  const VOID = "img, input, video, audio, canvas, iframe, textarea, select, br, hr, picture, svg";

  /**
   * A row of the desk's controls in a shadow root of its own: the page's styles do not reach it and its
   * own do not leak; its clicks and keys stay in it, so the page's handlers never see them.
   * @param {string} cls @param {(box: HTMLElement) => () => void} build returns how to paint it again
   */
  const control = (cls, build) => {
    const host = document.createElement("agent-desk-control");
    host.setAttribute("data-agent-desk-control", "");
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = LOOK;
    const box = document.createElement("div");
    box.className = cls;
    root.append(style, box);
    for (const type of ["click", "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "keydown", "keyup", "keypress", "input", "change", "focusin", "focusout"]) {
      root.addEventListener(type, (e) => e.stopPropagation());
    }
    const paint = build(box);
    return { host, paint };
  };
  /** @param {ParentNode} parent @param {string} tag @param {Record<string, string>} attrs @param {string} [text] */
  const el = (parent, tag, attrs, text) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    parent.append(e);
    return e;
  };
  /** A box for a note, shown while its button is pressed; what is typed is kept as it is typed. @param {ParentNode} parent @param {string} title @param {(v: string) => void} save */
  const noteBox = (parent, title, save) => {
    const label = /** @type {HTMLLabelElement} */ (el(parent, "label", { hidden: "" }));
    el(label, "span", {}, title);
    const area = /** @type {HTMLTextAreaElement} */ (el(label, "textarea", { maxlength: String(NOTE_MAX), rows: "2" }));
    area.addEventListener("input", () => save(area.value));
    /** @param {boolean} open @param {string} value */
    return (open, value) => {
      label.hidden = !open;
      if (area.value !== value && area.getRootNode() instanceof ShadowRoot && /** @type {ShadowRoot} */ (area.getRootNode()).activeElement !== area) area.value = value;
    };
  };

  /** @param {string} group @param {string} label */
  const optionControl = (group, label) =>
    control("option", (box) => {
      const row = el(box, "div", { class: "row", role: "group", "aria-label": `Your choice on ${label}` });
      /** @type {[Pick, string][]} */
      const picks = [["choose", "Choose"], ["iterate", "Iterate"], ["discard", "Discard"]];
      const buttons = picks.map(([pick, text]) => {
        const b = el(row, "button", { type: "button", class: pick, "data-pick": pick, "aria-pressed": "false" }, text);
        b.addEventListener("click", () => {
          const now = marks().find((g) => g.name === group)?.options.find((m) => m.label === label);
          mark(group, label, now?.pick === pick ? null : pick);
        });
        return /** @type {[Pick, Element]} */ ([pick, b]);
      });
      const iterate = noteBox(box, "What to change", (v) => mark(group, label, "iterate", v));
      const discard = noteBox(box, "Why (optional)", (v) => mark(group, label, "discard", v));
      return () => {
        const m = marks().find((g) => g.name === group)?.options.find((x) => x.label === label);
        for (const [pick, b] of buttons) b.setAttribute("aria-pressed", String(m?.pick === pick));
        iterate(m?.pick === "iterate", m?.pick === "iterate" ? (m.note ?? "") : "");
        discard(m?.pick === "discard", m?.pick === "discard" ? (m.note ?? "") : "");
      };
    });

  /** @param {string} group */
  const groupControl = (group) =>
    control("group", (box) => {
      const row = el(box, "div", { class: "row" });
      if (group) el(row, "span", { class: "lead" }, group);
      const b = el(row, "button", { type: "button", class: "none", "aria-pressed": "false" }, "None of these");
      const why = noteBox(box, "Why (optional)", (v) => remark(group, (g) => ({ ...g, none: v.slice(0, NOTE_MAX) })));
      b.addEventListener("click", () =>
        remark(group, (g) => {
          const { none, ...rest } = g;
          // None of these takes back what was chosen in the group; iterations and discards stand.
          return none === undefined ? { ...rest, none: "", options: g.options.filter((m) => m.pick !== "choose") } : rest;
        }),
      );
      return () => {
        const g = marks().find((x) => x.name === group);
        b.setAttribute("aria-pressed", String(g?.none !== undefined));
        why(g?.none !== undefined, g?.none ?? "");
      };
    });

  /** Puts the controls where the page marks options, again after the page redraws them. */
  const place = () => {
    const page = shown();
    for (const g of page) {
      for (const o of g.options) {
        let c = controls.get(o.el);
        if (!c || !c.host.isConnected) {
          c = optionControl(g.name, o.label);
          controls.set(o.el, c);
          if (o.el.matches(VOID)) o.el.after(c.host);
          else o.el.append(c.host);
        }
        c.paint();
      }
      let c = groupControls.get(g.name);
      if (!c || !c.host.isConnected) {
        c = groupControl(g.name);
        groupControls.set(g.name, c);
        (g.at ?? document.body).append(c.host);
      }
      c.paint();
    }
  };
  const paint = () => {
    for (const g of shown()) {
      for (const o of g.options) controls.get(o.el)?.paint();
      groupControls.get(g.name)?.paint();
    }
  };

  let counted = "";
  /** The page's own counter; without one, the groups of options decided of all of them. */
  const progress = () => {
    const counter = document.querySelector("[data-agent-desk-progress]");
    let text = counter?.textContent?.trim() ?? "";
    if (!counter) {
      const page = shown();
      const kept = marks();
      const decided = page.filter((s) => {
        const g = kept.find((x) => x.name === s.name);
        if (!g) return false;
        const picked = (/** @type {Pick} */ p) => g.options.filter((m) => m.pick === p && s.options.some((o) => o.label === m.label)).length;
        return g.none !== undefined || picked("choose") + picked("iterate") > 0 || picked("discard") === s.options.length;
      });
      text = page.length ? `${decided.length}/${page.length}` : "";
    }
    if (text === "" || text === counted) return;
    counted = text;
    send({ type: "progress", text: text.slice(0, 200) });
  };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let scrolled;
  const fraction = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    return max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
  };
  addEventListener(
    "scroll",
    () => {
      clearTimeout(scrolled);
      scrolled = setTimeout(() => send({ type: "scroll", at: fraction() }), 250);
    },
    { passive: true },
  );
  addEventListener("DOMContentLoaded", () => {
    // The counter may be drawn by the page's own script, at any time.
    // So may its options: the controls follow them, and are put back when a redraw drops them.
    new MutationObserver(() => (place(), progress())).observe(document.documentElement, { childList: true, characterData: true, subtree: true });
    place();
    progress();
  });
  addEventListener("load", () => {
    const at = Number(/^#at=([0-9.]+)$/.exec(location.hash)?.[1]);
    if (at > 0 && at <= 1) requestAnimationFrame(() => scrollTo(0, at * (document.documentElement.scrollHeight - innerHeight)));
  });
})();
