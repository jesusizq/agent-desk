// @ts-check
// The header, the display menu, the phone's tab bar and the strip under the header.
import { byId, h, icon, patch } from "./dom.js";
import { reducedMotion } from "./motion.js";
import { TEXT } from "./text.js";
import { clockAt, gb, hm } from "./format.js";
import { awaySummary } from "./away.js";
import { markCut } from "./layout.js";
import { projectMark } from "./pieces.js";
import { mergedOf, openProject, projectsInView, sum, worthWarning } from "./projects.js";
import { offlineNotice, post, run } from "./server.js";
import { openSession } from "./session.js";
import { CONTEXT_WARN, data, inbox, inProject, isLive, isNew, label, metricsOf, onDesk, openItems, page, toReview, ui } from "./state.js";

/** @typedef {import("../core/protocol.ts").Session} Session */

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
  const review = toReview().length;
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

export function renderStrip() {
  const since = data.seen?.since ?? null;
  const fresh = data.results.filter((r) => inProject(r.sessionId) && isNew(r));
  const failed = fresh.filter((r) => r.status === "failed").length;
  const summary = fresh.length
    ? since
      ? TEXT.sinceSummary(hm(since), fresh.length - failed, failed)
      : TEXT.unseenSummary(fresh.length - failed, failed)
    : since
      ? TEXT.nothingNew(hm(since))
      : TEXT.nothingYet;
  const contexts = data.sessions
    .filter((s) => isLive(s) && inProject(s.id))
    .map((s) => ({ s, c: metricsOf(s.id)?.contextPercent }))
    .filter(/** @returns {x is { s: Session, c: number }} */ (x) => x.c !== undefined && x.c >= CONTEXT_WARN);
  // Back from a while away, the summary of what happened meanwhile takes the place of the line on what is new.
  const away = awaySummary();
  patch(
    byId("strip"),
    ui.offline ? offlineNotice("strip-offline") : null,
    // Before the first data, a placeholder: "Nothing has finished yet" would be a false all-clear.
    away ?? (ui.loaded ? h("span", { class: "muted" }, summary) : h("span", { class: "skel", "aria-hidden": "true" })),
    fresh.length ? h("button", { class: "linkish", onclick: () => run(post("/api/seen")) }, TEXT.markSeen) : null,
    h("span", { class: "spacer" }),
    data.problems.length ? h("span", { class: "chip warn problems", title: data.problems.join("\n") }, TEXT.problems(data.problems.length)) : null,
    data.disk.map((d) => h("span", { class: "chip warn", title: d.dir }, TEXT.disk(gb(d.freeBytes), d.projects.join(", ")))),
    contexts.map(({ s, c }) => h("button", { class: "chip warn", onclick: () => openSession(s.id) }, TEXT.contextWarn(label(s), c))),
    data.planForecasts.map((f) => {
      const t = TEXT.limitForecast;
      return f.fullAt !== undefined
        ? h("span", { class: "chip warn" }, t.out(f.label, t.pace[f.pace], clockAt(f.fullAt), clockAt(f.resetsAt)))
        : h("span", { class: "chip" }, t.high(f.label, t.pace[f.pace], f.atReset, clockAt(f.resetsAt)));
    }),
    projectsInView()
      .filter((p) => worthWarning(p))
      .map((p) => {
        const m = mergedOf(p);
        return h("button", { class: "chip warn", onclick: () => openProject(p.id) }, TEXT.worktreeChip(p.name, gb(p.totalBytes), m.length, gb(sum(m))));
      }),
  );
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
