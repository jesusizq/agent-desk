// Fills a store with realistic demo content to try the page: `node scripts/demo.ts <empty dir> [<ISO time>]`,
// then `AGENT_DESK_HOME=<dir> node src/cli/main.ts serve`. Never point it at the real store. The time,
// when given, stands for now: the visual test needs the same store on every run.
import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "../src/store/store.ts";

const home = process.argv[2];
if (!home || !path.isAbsolute(home)) throw new Error("usage: node scripts/demo.ts <absolute path of an empty directory> [<ISO time standing for now>]");
if (fs.existsSync(home) && fs.readdirSync(home).length > 0) throw new Error(`${home} is not empty; the demo only writes into a new store`);
const at = process.argv[3] === undefined ? undefined : Date.parse(process.argv[3]);
if (at !== undefined && !Number.isFinite(at)) throw new Error(`${process.argv[3]} is not a time; give an ISO time such as 2026-11-10T10:30:00Z, or none for now`);
const now = () => at ?? Date.now();

// A clock that never repeats a millisecond, so what the demo adds first is always the oldest.
let last = 0;
const store = new Store(home, () => new Date((last = Math.max(now(), last + 1))));
const ago = (min: number) => new Date(now() - min * 60_000).toISOString();
// Real screenshots of a sample shop page, kept with this script.
const IMAGES = path.join(import.meta.dirname, "demo-images");
const image = (name: string) => path.join(IMAGES, name);

const sessions = [
  { id: "demo-checkout", project: "web-shop", dir: "/home/demo/Projects/web-shop", title: "checkout redesign", started: 130 },
  { id: "demo-pagos", project: "web-shop", dir: "/home/demo/Projects/web-shop", title: "payment webhooks", started: 110 },
  { id: "demo-iva", project: "invoices-api", dir: "/home/demo/Projects/invoices-api", title: "VAT rounding", started: 160 },
];
for (const s of sessions) {
  // Its adapter hands it messages from the desk while it works, as Claude Code's does.
  store.upsertSession({ id: s.id, provider: "Claude Code", project: { name: s.project, dir: s.dir }, title: s.title, terminal: "vscode", startedAt: ago(s.started), takesMessagesWhileWorking: true });
}
store.mergeMetrics({ sessionId: "demo-checkout", model: "Opus 5.5", effort: "high", branch: "feat/checkout-mobile", contextPercent: 71, planWindows: [{ label: "5 h", percent: 42, resetsAt: new Date(now() + 80 * 60_000).toISOString() }], permissionMode: "auto", cacheExpiresAt: new Date(now() + 3 * 60_000).toISOString(), costUsd: 4.12 });
store.mergeMetrics({ sessionId: "demo-pagos", model: "Sonnet 5.5", effort: "medium", branch: "feat/stripe-webhooks", contextPercent: 34, permissionMode: "default" });
store.mergeMetrics({ sessionId: "demo-iva", model: "Opus 5.5", effort: "xhigh", branch: "fix/vat-rounding", contextPercent: 86, suggestion: { reason: "context-full", command: "/compact" } });

const agents: [string, string, Parameters<Store["upsertAgent"]>[2], number][] = [
  ["demo-checkout", "summary", { goal: "Order summary beside the cart", activity: "Editing src/checkout/OrderSummary.tsx", branch: "agent/summary", commit: "3f2a91c", tokens: 182_000 }, 40],
  ["demo-checkout", "pay-button", { goal: "Three pay button variants", state: "done", activity: "3 variants in Storybook", branch: "agent/pay-button", commit: "9c1e0b4" }, 80],
  ["demo-checkout", "e2e", { goal: "Checkout e2e suite", state: "failed", activity: "No space left on device while writing traces", after: ["pay-button"] }, 70],
  ["demo-checkout", "a11y", { goal: "Accessibility audit", activity: "Running axe on 14 pages (9/14)", after: ["pay-button"] }, 30],
  ["demo-checkout", "cart-rebase", { goal: "Rebase the cart on the new summary", state: "blocked", activity: "Waiting for the summary commit", branch: "agent/cart-rebase", after: ["summary"] }, 25],
  ["demo-pagos", "webhooks", { goal: "Stripe webhooks", state: "waiting", activity: "stripe listen in the background" }, 60],
  ["demo-pagos", "refunds", { goal: "Partial refunds", activity: "Writing tests for refund.ts" }, 20],
  ["demo-iva", "rounding", { goal: "Per-line rounding", state: "done", activity: "Done on fix/vat-rounding" }, 120],
  ["demo-iva", "migrations", { goal: "Migration 0042", activity: "npm test -- invoices (212/340)", after: ["rounding"] }, 50],
];
for (const [sid, name, fields, minutes] of agents) store.upsertAgent(sid, name, { ...fields, startedAt: ago(minutes) });

// Asked earlier in the same project: the VAT question below reads like it, so it shows as decided before.
store.ask({ sessionId: "demo-iva", kind: "question", text: "Round the VAT of credit notes per line or on the total?", options: ["Per line", "On the total"] });
store.closeOpen("demo-iva", { answer: "Per line, as the customer's PDF does; keep a test that checks the total" });
store.ask({ sessionId: "demo-iva", kind: "question", text: "Number invoices with one series per year?" });
store.closeOpen("demo-iva", { answer: "Yes, one series per year" });
store.interpret("demo-iva", "Format 2026-0001; the counter restarts at 1 every 1 January.");
store.ask({ sessionId: "demo-iva", kind: "question", text: "Should VAT be rounded per line or on the invoice total?", context: "It is rounded on the total today. With three lines of €0.333 the total is **1 cent** off the customer's PDF.", options: ["Per line, like the customer's PDF", "On the total, as now"] });
store.ask({ sessionId: "demo-checkout", kind: "question", text: "The e2e run failed: the disk is full. Shall I delete the 4 agent worktrees already merged (14 GB)?", options: ["Yes, delete them", "No, I will free space myself"] });

store.addResult({ sessionId: "demo-checkout", title: "Checkout: before and after", summary: "The order summary sits beside the cart and stays in view, so the pay button never scrolls away.", images: [{ path: image("checkout-before.png"), caption: "Before" }, { path: image("checkout-after.png"), caption: "After" }], compare: { before: 0, after: 1 }, url: "http://localhost:5173/checkout", assumptions: ["The total includes VAT, as on the invoice."], decisions: ["Button in the brand indigo, 58 px tall."], checks: [{ criterion: "The pay button is visible without scrolling at 1280 × 720", verification: "visual-diff screenshot" }] });
store.addResult({ sessionId: "demo-checkout", title: "Three pay button variants", summary: "Same text, sizes and states; only the style changes.", images: [{ path: image("pay-button-a.png"), caption: "A" }, { path: image("pay-button-b.png"), caption: "B" }, { path: image("pay-button-c.png"), caption: "C" }], url: "http://localhost:6006" });
store.addResult({ sessionId: "demo-checkout", title: "Checkout e2e: failed, disk full", status: "failed", summary: "Ran out of space while writing the Playwright traces." });
store.addResult({ sessionId: "demo-iva", title: "Migration 0041 applied locally", summary: "The lines table stores each line's VAT rate. 34 tests pass." });
// The web shop's checkouts as the last scan read them, two minutes ago.
const shop = "/home/demo/Projects/web-shop";
store.putProjectScan({
  id: "web-shop-demo0001",
  name: "web-shop",
  dir: shop,
  baseBranch: "main",
  worktrees: [
    { path: shop, branch: "main", head: "a41c09e2", bytes: 1.4e9, sizedAt: ago(30), main: true, dirty: 0, subject: "Merge the cart redesign", committedAt: ago(95), busy: ["vite"] },
    { path: `${shop}/.claude/worktrees/summary`, branch: "agent/summary", head: "3f2a91c7", bytes: 0.6e9, sizedAt: ago(30), main: false, merged: false, ahead: 4, behind: 0, dirty: 3, subject: "Order summary beside the cart on desktop", committedAt: ago(6), busy: ["vitest"] },
    { path: `${shop}/.claude/worktrees/pay-button`, branch: "agent/pay-button", head: "9c1e0b48", bytes: 0.4e9, sizedAt: ago(30), main: false, merged: true, ahead: 0, behind: 2, dirty: 0, subject: "Pay button variants A, B and C", committedAt: ago(52) },
    { path: `${shop}/.claude/worktrees/old-header`, branch: "agent/old-header", head: "77d0e1aa", bytes: 0.3e9, sizedAt: ago(30), main: false, merged: true, ahead: 0, behind: 9, dirty: 0, subject: "Sticky header", committedAt: ago(2900) },
  ],
  branches: [{ name: "agent/cart-rebase", exists: false }],
  totalBytes: 2.7e9,
  dayStart: { day: new Date(now()).toISOString().slice(0, 10), bytes: 2.7e9 },
  measuredAt: ago(2),
  problems: [],
});
store.addService({ sessionId: "demo-checkout", name: "vite dev", url: "http://localhost:5173" });
store.addService({ sessionId: "demo-checkout", name: "storybook", url: "http://localhost:6006" });


store.updateSession("demo-pagos", (s) => ({
  ...s,
  state: "waiting",
  lastMessage: {
    at: ago(3),
    text: "Both agents stopped when the session restarted, so I relaunched them.\n\n- **Webhooks:** starts over, the previous run had saved nothing. It will add:\n  - the `/webhooks/stripe` endpoint with signature checks;\n  - idempotent retries.\n- **Refunds:** carries on from what was already saved.\n\n`stripe listen` stopped too. I can start it again if you want.",
  },
}));
store.updateSession("demo-checkout", (s) => ({ ...s, activity: "Edit: src/checkout/OrderSummary.tsx", activityIsCall: true }));
for (const [from, text] of [
  ["developer", "Move the order summary beside the cart, so the pay button never scrolls out of view."],
  ["session", "On it. Five agents:\n\n- **summary**: the summary beside the cart.\n- **pay-button**: three button variants.\n- **e2e**: the checkout suite.\n- **a11y**: an axe audit.\n- **cart-rebase**: rebase the cart once summary lands."],
  ["developer", "OK. Show the button variants in Storybook."],
  ["session", "Done: Storybook on :6006 with variants A, B and C. The e2e run failed because the **disk is full** while writing traces; I am asking on the desk whether to delete the merged worktrees."],
] as const) store.addMessage({ sessionId: "demo-checkout", from, text, via: "terminal" });

// Reviews: one partly done in its second round, from a session at work; one new, from a session that ended.
store.upsertSession({ id: "demo-landing", provider: "Claude Code", project: { name: "web-shop", dir: "/home/demo/Projects/web-shop" }, title: "landing headlines", terminal: "vscode", startedAt: ago(300), state: "ended", endedAt: ago(240), readAt: ago(230) });
const checkoutCards = [
  ["Pay button", "Pay €42.90 now"],
  ["Summary title", "Your order"],
  ["Shipping line", "Free delivery on Thursday"],
  ["Empty cart", "Your cart is empty. Find something you like."],
  ["Promo field", "Have a code? Add it here"],
  ["Card declined", "Your bank declined the card. Try another one."],
] as const;
store.publishReview({ sessionId: "demo-checkout", title: "Checkout copy proposals", html: reviewPage("Checkout copy proposals", "checkout-copy", checkoutCards.slice(0, 5)) });
const checkout = store.publishReview({ sessionId: "demo-checkout", title: "Checkout copy proposals", html: reviewPage("Checkout copy proposals", "checkout-copy", checkoutCards) });
store.changeReviewState(checkout.id, { ops: [{ op: "set", key: "checkout-copy", value: JSON.stringify({ 0: "yes", 1: "no", 3: "yes" }) }], progress: "3/6" }, "local");
store.markReviewOpened(checkout.id);
store.publishReview({
  sessionId: "demo-landing",
  title: "Landing hero headlines",
  html: reviewPage("Landing hero headlines", "hero", [
    ["Calm", "Everything you need, nothing you don't"],
    ["Direct", "Order today, wear it on Friday"],
    ["Playful", "Your new favourite shirt is three clicks away"],
    ["Proof", "40,000 orders shipped this year"],
    ["Price", "Quality basics from €19"],
    ["Local", "Made in Valencia, sent anywhere"],
  ]),
});

process.stdout.write(`demo store ready in ${home}\n`);

/**
 * A small review page as a session writes one: cards to keep or drop, a counter and a button that
 * copies the answers, all kept in the page's own localStorage.
 */
function reviewPage(title: string, key: string, cards: readonly (readonly [string, string])[]): string {
  const escape = (v: string) => v.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const items = cards.map(([name, copy], i) => `<article data-i="${i}"><h2>${escape(name)}</h2><p>${escape(copy)}</p><div><button data-v="yes">✓ Keep</button> <button data-v="no">✗ Drop</button></div></article>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #1d2330; }
header { position: sticky; top: 0; display: flex; gap: 12px; align-items: center; padding: 12px 20px; background: #fff; border-bottom: 1px solid #dde1e8; }
header strong { flex: 1; }
main { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; padding: 20px; }
article { background: #fff; border: 1px solid #dde1e8; border-radius: 10px; padding: 14px 16px; }
article h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #5b6475; margin: 0; }
article p { font-size: 18px; margin: 6px 0 12px; }
button { font: inherit; border: 1px solid #c9ced8; background: #fff; border-radius: 8px; padding: 4px 12px; cursor: pointer; }
article[data-a="yes"] { border-color: #2f9e62; }
article[data-a="yes"] [data-v="yes"] { background: #2f9e62; color: #fff; }
article[data-a="no"] { opacity: .6; }
article[data-a="no"] [data-v="no"] { background: #c4443a; color: #fff; }
</style>
</head>
<body>
<header><strong>${escape(title)}</strong><span id="count" data-agent-desk-progress></span><button id="copy" data-agent-desk-answers>Copy answers</button></header>
<main>
${items}
</main>
<script>
const KEY = ${JSON.stringify(key)};
const answers = JSON.parse(localStorage.getItem(KEY) || "{}");
const cards = [...document.querySelectorAll("article")];
function paint() {
  for (const card of cards) card.dataset.a = answers[card.dataset.i] || "";
  document.getElementById("count").textContent = Object.keys(answers).length + "/" + cards.length;
}
document.querySelector("main").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-v]");
  if (!button) return;
  const i = button.closest("article").dataset.i;
  if (answers[i] === button.dataset.v) delete answers[i];
  else answers[i] = button.dataset.v;
  localStorage.setItem(KEY, JSON.stringify(answers));
  paint();
});
document.getElementById("copy").addEventListener("click", async () => {
  const mark = (i) => (answers[i] === "yes" ? "✓" : answers[i] === "no" ? "✗" : "·");
  const lines = cards.map((c) => mark(c.dataset.i) + " " + c.querySelector("h2").textContent + ": " + c.querySelector("p").textContent);
  await navigator.clipboard.writeText(lines.join("\\n"));
  alert("Answers copied");
});
paint();
</script>
</body>
</html>
`;
}

