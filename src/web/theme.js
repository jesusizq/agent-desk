// Runs before the first paint so the page never flashes the wrong theme or text size.
/** Where this browser keeps the theme and the text size chosen in the display menu (header.js). */
const THEME_KEY = "agent-desk:theme";
const TEXT_KEY = "agent-desk:text";
/** The text sizes offered: the root font size, which every rem in style.css follows. @type {Record<string, string>} */
const TEXT_SIZES = { small: "90%", normal: "100%", large: "112.5%", larger: "125%" };
/** The header's colour per theme (style.css's --surface), which the browser's own bar takes. */
const BAR_COLORS = { light: "#ffffff", dark: "#171a21" };
/** Applies the theme and text size kept in this browser. */
function applyDisplay() {
  const chosen = localStorage.getItem(THEME_KEY);
  const theme = chosen === "light" || chosen === "dark" ? chosen : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  // A theme chosen on the page holds whatever the system's is: each bar colour follows its media query only on Auto.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const own = meta.getAttribute("media")?.includes("dark") ? "dark" : "light";
    meta.setAttribute("content", BAR_COLORS[chosen === "light" || chosen === "dark" ? chosen : own]);
  }
  document.documentElement.style.fontSize = TEXT_SIZES[localStorage.getItem(TEXT_KEY) ?? ""] ?? "";
}
applyDisplay();
