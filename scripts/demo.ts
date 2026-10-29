// Fills a store with realistic demo content to try the page: `node scripts/demo.ts <empty dir>`,
// then `AGENT_DESK_HOME=<dir> node src/cli/main.ts serve`. Never point it at the real store.
import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "../src/store/store.ts";

const home = process.argv[2];
if (!home || !path.isAbsolute(home)) throw new Error("usage: node scripts/demo.ts <absolute path of an empty directory>");
if (fs.existsSync(home) && fs.readdirSync(home).length > 0) throw new Error(`${home} is not empty; the demo only writes into a new store`);

// A clock that never repeats a millisecond, so what the demo adds first is always the oldest.
let last = 0;
const store = new Store(home, () => new Date((last = Math.max(Date.now(), last + 1))));
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
// Real screenshots of a sample shop page, kept with this script.
const IMAGES = path.join(import.meta.dirname, "demo-images");
const image = (name: string) => path.join(IMAGES, name);

const sessions = [
  { id: "demo-checkout", project: "web-shop", dir: "/home/demo/Projects/web-shop", title: "checkout redesign", started: 130 },
  { id: "demo-pagos", project: "web-shop", dir: "/home/demo/Projects/web-shop", title: "payment webhooks", started: 110 },
  { id: "demo-iva", project: "invoices-api", dir: "/home/demo/Projects/invoices-api", title: "VAT rounding", started: 160 },
];
for (const s of sessions) {
  store.upsertSession({ id: s.id, provider: "Claude Code", project: { name: s.project, dir: s.dir }, title: s.title, terminal: "vscode", startedAt: ago(s.started) });
}
store.mergeMetrics({ sessionId: "demo-checkout", model: "Opus 5.5", effort: "high", branch: "feat/checkout-mobile", contextPercent: 71, planWindows: [{ label: "5 h", percent: 42, resetsAt: new Date(Date.now() + 80 * 60_000).toISOString() }], permissionMode: "auto", cacheExpiresAt: new Date(Date.now() + 3 * 60_000).toISOString(), costUsd: 4.12 });
store.mergeMetrics({ sessionId: "demo-pagos", model: "Sonnet 5.5", effort: "medium", branch: "feat/stripe-webhooks", contextPercent: 34, permissionMode: "default" });
store.mergeMetrics({ sessionId: "demo-iva", model: "Opus 5.5", effort: "xhigh", branch: "fix/vat-rounding", contextPercent: 86, suggestion: { reason: "context-full", command: "/compact" } });

const agents: [string, string, Parameters<Store["upsertAgent"]>[2], number][] = [
  ["demo-checkout", "summary", { goal: "Order summary beside the cart", activity: "Editing src/checkout/OrderSummary.tsx", branch: "agent/summary", commit: "3f2a91c", tokens: 182_000 }, 40],
  ["demo-checkout", "pay-button", { goal: "Three pay button variants", state: "done", activity: "3 variants in Storybook", branch: "agent/pay-button", commit: "9c1e0b4" }, 80],
  ["demo-checkout", "e2e", { goal: "Checkout e2e suite", state: "failed", activity: "No space left on device while writing traces", after: ["pay-button"] }, 70],
  ["demo-checkout", "a11y", { goal: "Accessibility audit", activity: "Running axe on 14 pages (9/14)", after: ["pay-button"] }, 30],
  ["demo-checkout", "cart-rebase", { goal: "Rebase the cart on the new summary", state: "blocked", activity: "Waiting for the summary commit", after: ["summary"] }, 25],
  ["demo-pagos", "webhooks", { goal: "Stripe webhooks", state: "waiting", activity: "stripe listen in the background" }, 60],
  ["demo-pagos", "refunds", { goal: "Partial refunds", activity: "Writing tests for refund.ts" }, 20],
  ["demo-iva", "rounding", { goal: "Per-line rounding", state: "done", activity: "Done on fix/vat-rounding" }, 120],
  ["demo-iva", "migrations", { goal: "Migration 0042", activity: "npm test -- invoices (212/340)", after: ["rounding"] }, 50],
];
for (const [sid, name, fields, minutes] of agents) store.upsertAgent(sid, name, { ...fields, startedAt: ago(minutes) });

store.ask({ sessionId: "demo-iva", kind: "question", text: "Number invoices with one series per year?" });
store.closeOpen("demo-iva", { answer: "Yes, one series per year" });
store.interpret("demo-iva", "Format 2026-0001; the counter restarts at 1 every 1 January.");
store.ask({ sessionId: "demo-iva", kind: "question", text: "Should VAT be rounded per line or on the invoice total?", context: "It is rounded on the total today. With three lines of €0.333 the total is **1 cent** off the customer's PDF.", options: ["Per line, like the customer's PDF", "On the total, as now"] });
store.ask({ sessionId: "demo-checkout", kind: "question", text: "The e2e run failed: the disk is full. Shall I delete the 4 agent worktrees already merged (14 GB)?", options: ["Yes, delete them", "No, I will free space myself"] });

store.addResult({ sessionId: "demo-checkout", title: "Checkout: before and after", summary: "The order summary sits beside the cart and stays in view, so the pay button never scrolls away.", images: [{ path: image("checkout-before.png"), caption: "Before" }, { path: image("checkout-after.png"), caption: "After" }], compare: { before: 0, after: 1 }, url: "http://localhost:5173/checkout", assumptions: ["The total includes VAT, as on the invoice."], decisions: ["Button in the brand indigo, 58 px tall."], checks: [{ criterion: "The pay button is visible without scrolling at 1280 × 720", verification: "visual-diff screenshot" }] });
store.addResult({ sessionId: "demo-checkout", title: "Three pay button variants", summary: "Same text, sizes and states; only the style changes.", images: [{ path: image("pay-button-a.png"), caption: "A" }, { path: image("pay-button-b.png"), caption: "B" }, { path: image("pay-button-c.png"), caption: "C" }], url: "http://localhost:6006" });
store.addResult({ sessionId: "demo-checkout", title: "Checkout e2e: failed, disk full", status: "failed", summary: "Ran out of space while writing the Playwright traces." });
store.addResult({ sessionId: "demo-iva", title: "Migration 0041 applied locally", summary: "The lines table stores each line's VAT rate. 34 tests pass." });
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
store.updateSession("demo-checkout", (s) => ({ ...s, activity: "Edit: src/checkout/OrderSummary.tsx" }));
for (const [from, text] of [
  ["developer", "Move the order summary beside the cart, so the pay button never scrolls out of view."],
  ["session", "On it. Five agents:\n\n- **summary**: the summary beside the cart.\n- **pay-button**: three button variants.\n- **e2e**: the checkout suite.\n- **a11y**: an axe audit.\n- **cart-rebase**: rebase the cart once summary lands."],
  ["developer", "OK. Show the button variants in Storybook."],
  ["session", "Done: Storybook on :6006 with variants A, B and C. The e2e run failed because the **disk is full** while writing traces; I am asking on the desk whether to delete the merged worktrees."],
] as const) store.addMessage({ sessionId: "demo-checkout", from, text, via: "terminal" });

process.stdout.write(`demo store ready in ${home}\n`);
