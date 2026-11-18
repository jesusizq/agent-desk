// @ts-check
// The header, the display menu, the phone's tab bar and the strip under the header.
import { byId, dialog, h, icon, patch } from "./dom.js";
import { reducedMotion } from "./motion.js";
import { TEXT } from "./text.js";
import { clockAt, gb } from "./format.js";
import { awaySummary } from "./away.js";
import { markCut, ONE_COLUMN } from "./layout.js";
import { dialogHead, projectMark } from "./pieces.js";
import { mergedOf, openProject, openResumes, pendingNotes, projectsInView, resumesInView, sum, worthWarning } from "./projects.js";
import { markResultsSeen } from "./result.js";
import { offlineNotice, run } from "./server.js";
import { openSession } from "./session.js";
import { CONTEXT_WARN, data, inbox, inProject, isLive, isNew, label, metricsOf, onDesk, openItems, openReviews, page, toReview, ui } from "./state.js";

/** @typedef {import("../core/protocol.ts").Session} Session */
/** @typedef {import("../core/protocol.ts").Result} Result */

export function renderHeader() {
  const n = inbox().count;
  const views = byId("views");
  views.setAttribute("aria-label", TEXT.viewsLabel);
  patch(
    views,
    ...(/** @type {const} */ ([["desk", "board"], ["history", "clock"]])).map(([v, ic]) =>
      h("button", { "aria-pressed": String(ui.view === v), "aria-label": TEXT.views[v], title: TEXT.views[v], onclick: () => ((ui.view = v), page.render()) }, icon(ic), h("span", { class: "lbl" }, TEXT.views[v])),
    ),
  );
  // A project is offered while one of its sessions runs or still has something for the developer.
  const current = (/** @type {Session} */ s) => onDesk(s) || data.results.some((r) => r.sessionId === s.id && isNew(r));
  const names = [...new Set(data.sessions.filter(current).map((s) => s.project.name))].sort();
  if (ui.project !== null && !names.includes(ui.project)) ui.project = null;
  const projects = byId("projects");
  projects.setAttribute("aria-label", TEXT.projectsLabel);
  projects.hidden = names.length < 2;
  patch(
    projects,
    ...[null, ...names].map((name) =>
      h("button", { "data-key": name ?? "", "aria-pressed": String(ui.project === name), title: name, onclick: () => ((ui.project = name), page.render({ instant: true })) }, name ? projectMark(name) : TEXT.allProjects),
    ),
  );
  const pill = byId("needs-pill");
  // Before the first data, a placeholder: "Nothing pending" would be a false all-clear.
  pill.classList.toggle("loading", !ui.loaded);
  pill.classList.toggle("zero", ui.loaded && !n);
  pill.toggleAttribute("aria-busy", !ui.loaded);
  if (!ui.loaded) patch(pill, h("span", { class: "skel" }));
  else patch(pill, n ? h("span", { class: "beacon on-accent", "aria-hidden": "true" }) : null, TEXT.needsPill(n));
  // Shown beside the columns only: in one column the Inbox tab counts.
  pill.onclick = () => {
    ui.view = "desk";
    ui.tab = "inbox";
    ui.sel = openItems()[0]?.key ?? null;
    page.render();
  };
  const q = /** @type {HTMLInputElement} */ (byId("q"));
  q.placeholder = TEXT.search;
  q.setAttribute("aria-label", TEXT.search);
  // History has its own search box; the header's only leads there. Before the first data, nothing to search,
  // and on a phone it would take the projects' place until they arrive.
  const headerSearch = q.closest(".search");
  if (headerSearch instanceof HTMLElement) headerSearch.hidden = !ui.loaded || ui.view === "history";
  document.title = n ? `(${n}) ${TEXT.appName}` : TEXT.appName;
  appBadge(n);
  renderTabbar(n);
  fitProjects();
  markCut(projects);
}

// Same query as style.css: a portrait phone, whose header takes two rows.
const PORTRAIT = matchMedia("(max-width: 700px) and (min-height: 501px)");
let projectsTried = "";
/** On a portrait phone, the projects go up beside the mark and the menus when they fit there whole; else they keep a row of their own. */
function fitProjects() {
  const header = /** @type {HTMLElement} */ (document.querySelector("header.top"));
  const projects = byId("projects");
  const tried = [PORTRAIT.matches, projects.hidden, innerWidth, document.documentElement.style.fontSize, projects.textContent, ui.project].join("|");
  if (tried === projectsTried) return;
  projectsTried = tried;
  header.classList.remove("projects-up");
  if (!PORTRAIT.matches || projects.hidden) return;
  header.classList.add("projects-up");
  const firstRowEnd = header.querySelector(".brand")?.getBoundingClientRect().bottom ?? 0;
  if (![projects, byId("theme")].every((el) => el.getBoundingClientRect().top < firstRowEnd)) header.classList.remove("projects-up");
}
addEventListener("resize", fitProjects);

let badgeShown = -1;
/** The count on the icon of the desk installed as an app, like the title's. @param {number} n */
function appBadge(n) {
  if (n === badgeShown || !("setAppBadge" in navigator)) return;
  badgeShown = n;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); // refused outside an installed app or without notification permission; the title still counts
}

/** On a phone, the parts of the desk and the history sit in a bar at the bottom, under the thumb. @param {number} needs */
function renderTabbar(needs) {
  const review = toReview().length + openReviews().length;
  /** @type {[typeof ui.tab | "history", import("./dom.js").IconName, number, string][]} */
  const tabs = [
    ["inbox", "inbox", needs, "accent"],
    ["sessions", "terminal", 0, ""],
    ["review", "image", review, "review"],
    ["history", "clock", 0, ""],
  ];
  const current = ui.view === "history" ? "history" : ui.tab;
  patch(
    byId("tabbar"),
    tabs.map(([key, ic, count, tone]) =>
      h(
        "button",
        {
          "aria-pressed": String(current === key),
          // As a phone's own tab bar: each tab keeps its place; the tab already shown goes back to its top.
          onclick: () => {
            if (key === current) return window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
            ui.tabScroll.set(current, window.scrollY);
            if (key === "history") ui.view = "history";
            else ((ui.view = "desk"), (ui.tab = key));
            page.render();
            window.scrollTo(0, ui.tabScroll.get(key) ?? 0);
          },
        },
        icon(ic),
        h("span", {}, TEXT.tabbar[key]),
        count ? h("span", { class: `tcount ${tone}` }, count) : null,
      ),
    ),
  );
}

/**
 * A warning of the strip, made once for each place that shows it: a chip in the strip or, on a phone,
 * a row of the sheet its Alerts chip opens. `phone` is where a phone shows it: in the strip, in Alerts,
 * or nowhere (it only informs). One with `open` opens what it names, wherever it is shown.
 * @typedef {{ text: string, warn: boolean, phone: "strip" | "alerts" | "none", cls?: string, title?: string, detail?: string, open?: () => void }} Warning
 */
/** @param {string} text @param {boolean} warn @param {Warning["phone"]} phone @param {Omit<Partial<Warning>, "text" | "warn" | "phone">} [more] @returns {Warning} */
const warning = (text, warn, phone, more = {}) => ({ text, warn, phone, ...more });

/** The strip's warnings, in its order. */
function warnings() {
  const t = TEXT.limitForecast;
  const contexts = data.sessions
    .filter((s) => isLive(s) && inProject(s.id))
    .map((s) => ({ s, c: metricsOf(s.id)?.contextPercent }))
    .filter(/** @returns {x is { s: Session, c: number }} */ (x) => x.c !== undefined && x.c >= CONTEXT_WARN);
  return [
    ...(data.problems.length ? [warning(TEXT.problems(data.problems.length), true, "alerts", { cls: "problems", title: data.problems.join("\n"), detail: data.problems.join("\n") })] : []),
    ...data.disk.map((d) => warning(TEXT.disk(gb(d.freeBytes), d.projects.join(", ")), true, "strip", { title: d.dir })),
    ...data.machine.map((m) => warning(m.reading === "memory" ? TEXT.machine.memory(gb(m.value), gb(m.limit)) : TEXT.machine[m.reading](m.value, m.limit), true, "alerts")),
    ...contexts.map(({ s, c }) => warning(TEXT.contextWarn(label(s), c), true, "strip", { open: () => openSession(s.id) })),
    // A window that runs out before its reset warns; how full one gets by its reset only informs, which a phone leaves out.
    ...data.planForecasts.map((f) =>
      f.fullAt !== undefined ? warning(t.out(f.label, t.pace[f.pace], clockAt(f.fullAt), clockAt(f.resetsAt)), true, "strip") : warning(t.high(f.label, t.pace[f.pace], f.atReset, clockAt(f.resetsAt)), false, "none"),
    ),
    ...resumesInView().map((p) => warning(TEXT.resumes.chip(p.name, pendingNotes(p).length), false, "alerts", { cls: "resume-chip", open: () => openResumes(p.id) })),
    ...projectsInView()
      .filter((p) => worthWarning(p))
      .map((p) => {
        const m = mergedOf(p);
        return warning(TEXT.worktreeChip(p.name, gb(p.totalBytes), m.length, gb(sum(m))), true, "alerts", { open: () => openProject(p.id) });
      }),
  ];
}

/** @param {Warning} w */
function warningChip(w) {
  const attrs = { class: ["chip", w.warn ? "warn" : "", w.cls ?? ""].filter(Boolean).join(" "), title: w.title };
  return w.open ? h("button", { ...attrs, onclick: w.open }, w.text) : h("span", attrs, w.text);
}

export function renderStrip() {
  const fresh = data.results.filter((r) => inProject(r.sessionId) && isNew(r));
  const failed = fresh.filter((r) => r.status === "failed").length;
  const summary = fresh.length
    ? TEXT.unseenSummary(fresh.length - failed, failed)
    : data.results.some((r) => inProject(r.sessionId))
      ? TEXT.emptyResults
      : TEXT.nothingYet;
  // A phone keeps in sight only what wants a look now, the rest behind one chip; its To review tab counts what is new.
  const phone = ONE_COLUMN.matches;
  const all = warnings();
  alertsShown = phone ? all.filter((w) => w.phone === "alerts") : [];
  // Back from a while away, the summary of what happened meanwhile takes the place of the line on what is new.
  const away = awaySummary();
  // Before the first data, a placeholder: "Nothing has finished yet" would be a false all-clear. A phone has no
  // such line, and a placeholder would hold a room its empty strip gives back once loaded, moving the board up.
  const line = phone ? null : !ui.loaded ? h("span", { class: "skel", "aria-hidden": "true" }) : h("span", { class: "muted" }, summary);
  patch(
    byId("strip"),
    ui.offline ? offlineNotice("strip-offline") : null,
    away ?? line,
    // Marks exactly what the line counts, failures included: no result of a project out of view.
    !phone && fresh.length ? h("button", { class: "linkish", onclick: () => run(markResultsSeen(fresh)) }, TEXT.markSeen) : null,
    phone ? null : h("span", { class: "spacer" }),
    // First of the chips on a phone, whose strip scrolls sideways: in sight however many warnings follow.
    alertsShown.length
      ? h("button", { class: `chip alerts-chip${alertsShown.some((w) => w.warn) ? " warn" : ""}`, "aria-haspopup": "dialog", onclick: openAlerts }, TEXT.stripAlerts.chip(alertsShown.length))
      : null,
    all.filter((w) => !phone || w.phone === "strip").map(warningChip),
  );
  const sheet = dialog("strip-alerts");
  if (sheet.open && alertsShown.length) drawAlerts();
  else if (sheet.open) sheet.close();
}
ONE_COLUMN.addEventListener("change", renderStrip);

/** On a phone, the warnings gathered behind the strip's Alerts chip, as last drawn. @type {Warning[]} */
let alertsShown = [];
function openAlerts() {
  drawAlerts();
  const d = dialog("strip-alerts");
  if (!d.open) d.showModal();
}
/** The sheet of the strip's Alerts: a row for each, which opens what it names as its chip does. */
function drawAlerts() {
  const d = dialog("strip-alerts");
  d.setAttribute("aria-label", TEXT.stripAlerts.title);
  /** @param {Warning} w */
  const row = (w) => {
    const what = h("span", { class: "alert-what" }, h("span", {}, w.text), w.detail ? h("span", { class: "alert-detail" }, w.detail) : null);
    const cls = `alert-row${w.warn ? " warn" : ""}`;
    const open = w.open;
    return open ? h("button", { class: cls, onclick: () => (d.close(), open()) }, what, icon("chev")) : h("div", { class: cls }, what);
  };
  patch(d, dialogHead(d, null, TEXT.stripAlerts.title), h("div", { class: "dbody" }, h("div", { class: "alert-list" }, alertsShown.map(row))));
}

const THEMES = /** @type {const} */ (["auto", "light", "dark"]);
/** The display menu: theme and text size, each kept in this browser; on a phone, the credit too. */
export function renderDisplay() {
  const root = document.documentElement;
  const shown = root.dataset.theme;
  applyDisplay();
  if (root.dataset.theme !== shown) {
    // The colours change in one frame: transitions held for it, so no control fades on its own.
    root.classList.add("theme-switching");
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
  }
  const theme = THEMES.find((x) => x === localStorage.getItem(THEME_KEY)) ?? "auto";
  const sizes = Object.keys(TEXT_SIZES);
  const size = sizes.find((x) => x === localStorage.getItem(TEXT_KEY)) ?? "normal";
  const button = byId("theme");
  button.title = TEXT.display.title;
  button.setAttribute("aria-label", TEXT.display.title);
  // Settings, not a light/dark switch: the menu holds the theme and the text size.
  button.replaceChildren(icon("sliders"), h("span", { class: "lbl" }, TEXT.display.title));
  const menu = byId("display-menu");
  // Made once; a choice only moves the pressed state, so the focus stays on the button chosen.
  if (!menu.childElementCount) {
    /** @param {string} key @param {string} value @param {Node | string} text @param {string} [name] */
    const choice = (key, value, text, name) =>
      h("button", { "data-pref": key, "data-value": value, "aria-label": name, title: name, onclick: () => (localStorage.setItem(key, value), renderDisplay()) }, text);
    menu.replaceChildren(
      h("div", { class: "menu-row" }, h("span", {}, TEXT.display.theme), h("div", { class: "seg" }, THEMES.map((t) => choice(THEME_KEY, t, h("span", { class: "row-i" }, icon(t === "auto" ? "auto" : t === "light" ? "sun" : "moon"), TEXT.theme[t]))))),
      h("div", { class: "menu-row" }, h("span", {}, TEXT.display.text), h("div", { class: "seg sizes" }, sizes.map((k, i) => choice(TEXT_KEY, k, h("span", { class: `a${i}` }, "A"), TEXT.display.sizes(k))))),
      // The fixed link written in index.html, copied: on a phone its footer gives its place to the tab bar.
      h("div", { class: "menu-credit" }, document.querySelector(".credits a")?.cloneNode(true) ?? null),
    );
  }
  /** @type {Record<string, string>} */
  const chosen = { [THEME_KEY]: theme, [TEXT_KEY]: size };
  for (const b of menu.querySelectorAll("button[data-pref]")) if (b instanceof HTMLElement) b.setAttribute("aria-pressed", String(chosen[b.dataset.pref ?? ""] === b.dataset.value));
  fitProjects(); // a text size changes the projects' width
}
