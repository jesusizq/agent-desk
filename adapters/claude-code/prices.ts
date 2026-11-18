// Claude Code adapter: what the tokens of a Claude model cost, from the Claude API's list prices.

/** USD per million tokens of each kind a usage row counts. */
export type Rates = { input: number; write5m: number; write1h: number; read: number; output: number };
/** A model's rates, and for a model priced by prompt length, the rates of a prompt over `above` tokens. */
type Price = Rates & { longer?: { above: number; rates: Rates }; usGeo?: number };

/**
 * First-party Claude API list prices, read on PRICES_READ from PRICES_SOURCE. A model not listed
 * gets no cost: its tokens only. Never filled in by guess: update from the source.
 */
export const PRICES_READ = "2026-11-18";
export const PRICES_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";

const rates = (input: number, write5m: number, write1h: number, read: number, output: number): Rates => ({ input, write5m, write1h, read, output });
// US-only inference (`inference_geo: "us"`) costs 1.1x on Claude 4.6 and later.
const US = 1.1;
const FABLE_5_2: Price = { ...rates(8, 10, 16, 0.2, 40), usGeo: US };
const FABLE_5_1: Price = { ...rates(10, 12.5, 20, 0.25, 50), usGeo: US };
const FABLE_5: Price = { ...rates(10, 12.5, 20, 1, 50), usGeo: US };
const OPUS_5: Price = { ...rates(5, 6.25, 10, 0.5, 25), usGeo: US };
const SONNET_4_6: Price = { ...rates(3, 3.75, 6, 0.3, 15), usGeo: US };

const PRICES: Record<string, Price> = {
  "claude-fable-5-2": FABLE_5_2,
  "claude-mythos-5-2": FABLE_5_2,
  "claude-fable-5-1": FABLE_5_1,
  "claude-mythos-5-1": FABLE_5_1,
  "claude-fable-5": FABLE_5,
  "claude-mythos-5": FABLE_5,
  "claude-opus-5-5": { ...rates(4, 5, 8, 0.2, 20), usGeo: US },
  "claude-opus-5": OPUS_5,
  "claude-opus-4-8": OPUS_5,
  "claude-opus-4-7": OPUS_5,
  "claude-opus-4-6": OPUS_5,
  "claude-opus-4-5": rates(5, 6.25, 10, 0.5, 25),
  "claude-sonnet-5-5": { ...rates(2, 2.5, 4, 0.1, 10), usGeo: US },
  "claude-sonnet-5": { ...rates(2, 2.5, 4, 0.2, 10), usGeo: US },
  "claude-sonnet-4-6": SONNET_4_6,
  "claude-sonnet-4-5": rates(3, 3.75, 6, 0.3, 15),
  "claude-haiku-5-5": { ...rates(0.1, 0.125, 0.2, 0.01, 0.5), longer: { above: 100_000, rates: rates(0.5, 0.625, 1, 0.05, 2.5) }, usGeo: US },
  "claude-haiku-4-5": rates(1, 1.25, 2, 0.1, 5),
};

/** USD per web search a request ran (its server tool's `web_search_requests`), from the same source. */
export const WEB_SEARCH_USD = 10 / 1000;

/** The tokens of one request, by how they are billed, and the web searches it ran. */
export type Usage = { input: number; write5m: number; write1h: number; read: number; output: number; webSearches?: number };

/** Where and how a request ran, as its usage row says; absent means the default (global, standard). */
export type Served = { geo?: string; speed?: string; tier?: string };

/**
 * The model's rates for a prompt of `promptTokens` (input, cache writes and reads together), or
 * undefined when the table does not price it: an unknown model, fast mode, a tier or region the
 * source gives no plain rate for. Model ids may carry a release date or a context tag
 * (`claude-haiku-4-5-20251001`, `claude-opus-4-6[1m]`).
 */
export function ratesOf(model: string, promptTokens: number, served: Served = {}): Rates | undefined {
  const price = PRICES[model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "")];
  if (!price) return undefined;
  if (served.speed !== undefined && served.speed !== "standard") return undefined;
  if (served.tier !== undefined && served.tier !== "standard") return undefined;
  const geo = served.geo === undefined || served.geo === "global" ? 1 : served.geo === "us" ? price.usGeo : undefined;
  if (geo === undefined) return undefined;
  const base = price.longer && promptTokens > price.longer.above ? price.longer.rates : price;
  return rates(base.input * geo, base.write5m * geo, base.write1h * geo, base.read * geo, base.output * geo);
}

/** What one request cost, or undefined when its model or terms are not priced. */
export function costOf(model: string, usage: Usage, served: Served = {}): number | undefined {
  const r = ratesOf(model, usage.input + usage.write5m + usage.write1h + usage.read, served);
  if (!r) return undefined;
  return (usage.input * r.input + usage.write5m * r.write5m + usage.write1h * r.write1h + usage.read * r.read + usage.output * r.output) / 1_000_000 + (usage.webSearches ?? 0) * WEB_SEARCH_USD;
}
