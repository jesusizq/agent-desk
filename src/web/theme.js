// Runs before the first paint so the page never flashes the wrong theme or text size.
/** The text sizes offered: the root font size, which every rem in style.css follows. @type {Record<string, string>} */
const TEXT_SIZES = { small: "90%", normal: "100%", large: "112.5%", larger: "125%" };
/** Applies the theme and text size kept in this browser. */
function applyDisplay() {
  const chosen = localStorage.getItem("agent-desk:theme");
  const theme = chosen === "light" || chosen === "dark" ? chosen : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.fontSize = TEXT_SIZES[localStorage.getItem("agent-desk:text") ?? ""] ?? "";
}
applyDisplay();
