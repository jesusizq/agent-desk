// Runs before the first paint so the page never flashes the wrong theme.
const chosen = localStorage.getItem("agent-desk:theme") || "auto";
document.documentElement.dataset.theme =
  chosen === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : chosen;
