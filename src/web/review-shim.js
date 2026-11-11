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

  let counted = "";
  const progress = () => {
    const text = document.querySelector("[data-agent-desk-progress]")?.textContent?.trim() ?? "";
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
    new MutationObserver(progress).observe(document.documentElement, { childList: true, characterData: true, subtree: true });
    progress();
  });
  addEventListener("load", () => {
    const at = Number(/^#at=([0-9.]+)$/.exec(location.hash)?.[1]);
    if (at > 0 && at <= 1) requestAnimationFrame(() => scrollTo(0, at * (document.documentElement.scrollHeight - innerHeight)));
  });
})();
