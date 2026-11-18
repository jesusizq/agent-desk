// @ts-check
// The command a session's state calls for now: decided on the page, as time passes, because an idle
// session's metrics are not refreshed when its prompt cache expires.

/** @typedef {import("../core/protocol.ts").Metrics} Metrics */
/** @typedef {import("../core/protocol.ts").Suggestion} Suggestion */
/** @typedef {import("../core/protocol.ts").ColdResume} ColdResume */

/** A context this large costs more to rewrite to the cache than to start afresh: tokens, or a share of its window. */
export const COLD_CONTEXT = { tokens: 150_000, percent: 50 };

/**
 * What resuming the session would cost, when its prompt cache has expired on a large context and its
 * adapter said what starts afresh instead; undefined otherwise.
 * @param {Metrics | undefined} m @param {number} [now]
 * @returns {ColdResume | undefined}
 */
export function coldResume(m, now = Date.now()) {
  if (!m?.coldResume || !m.cacheExpiresAt || Date.parse(m.cacheExpiresAt) > now) return undefined;
  const large = (m.contextTokens ?? 0) >= COLD_CONTEXT.tokens || (m.contextPercent ?? 0) >= COLD_CONTEXT.percent;
  return large ? m.coldResume : undefined;
}

/**
 * The command to suggest: starting afresh over a cold cache comes first, then what its adapter
 * suggested (compacting a full context). @param {Metrics | undefined} m @param {number} [now]
 * @returns {Suggestion | undefined}
 */
export function suggestionOf(m, now = Date.now()) {
  const cold = coldResume(m, now);
  return cold ? { reason: "cache-cold", command: cold.command } : m?.suggestion;
}
