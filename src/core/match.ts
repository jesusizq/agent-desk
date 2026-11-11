// Past decisions that read like a new question: plain word overlap, weighed by how rare each word is in
// the project's questions. Deterministic, local, no model: the same records always give the same matches.
import { PAST_SHOWN, type PastDecision, type Question } from "./protocol.ts";

/** How alike two questions must read (0..1, cosine of their rare-word-weighted word sets) to be shown. */
export const MATCH_MIN = 0.34;

/** Words that say nothing about a question's topic, in the languages the developer writes. */
const STOP = new Set(
  (
    "the and for with that this from into onto your you our are was were will would should could shall can may might must have has had " +
    "not but all any each per out off now then than them they their there here what which when where who why how its it's also just only " +
    "use using used one two yes no do does did done be been being so if or of to in on at by as is an a we i me my mine " +
    "el la los las un una unos unas de del al que en por para con sin sobre como pero mas más ya lo le les se su sus mi mis tu tus " +
    "es son ser fue era hay este esta estos estas ese esa esos esas aqui aquí si sí no o y e u ni cual cuál cuando cuándo donde dónde quien quién"
  ).split(" "),
);

/** Folded words (no case, no accents), stop words and words under 3 letters left out, plurals, -ed and -ing cut. */
export function words(value: string): Set<string> {
  const out = new Set<string>();
  for (const raw of value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

function stem(word: string): string {
  const cut = (n: number) => (word.length - n >= 4 ? word.slice(0, -n) : undefined);
  if (word.endsWith("ies") || word.endsWith("ied")) return cut(3) === undefined ? word : `${word.slice(0, -3)}y`;
  if (word.endsWith("ing")) return cut(3) ?? word;
  if (word.endsWith("ed")) return cut(2) ?? word;
  // "boxes", "branches": -es; "invoices", "notes": -s, as their singular ends in e.
  if (/(?:s|x|z|ch|sh)es$/.test(word)) return cut(2) ?? word;
  if (word.endsWith("s") && !word.endsWith("ss")) return cut(1) ?? word;
  return word;
}

/** An answered question of the project, as the store found it. */
export type Answered = Pick<Question, "id" | "text" | "options"> & { answer: NonNullable<Question["answer"]> };

/**
 * The past decisions that read most like `asked` (its text and options), best first, at most
 * PAST_SHOWN: two shared topic words or more (all of them for a question of one or two), and a
 * similarity of MATCH_MIN or more. The same question answered again keeps only its latest answer.
 */
export function pastDecisions(asked: { text: string; options: readonly string[] }, answered: readonly Answered[]): PastDecision[] {
  const latest = new Map<string, Answered>();
  for (const q of answered) {
    const key = [...words(q.text)].sort().join(" ");
    const kept = latest.get(key);
    if (!kept || kept.answer.at < q.answer.at) latest.set(key, q);
  }
  const pool = [...latest.values()].map((q) => ({ q, w: words([q.text, ...q.options].join("\n")) }));
  const query = words([asked.text, ...asked.options].join("\n"));
  if (query.size === 0 || pool.length === 0) return [];
  // A word in few of the project's questions says more about the topic than one in many.
  const df = new Map<string, number>();
  for (const { w } of pool) for (const t of w) df.set(t, (df.get(t) ?? 0) + 1);
  const weight = (t: string) => Math.log(1 + (pool.length + 1) / ((df.get(t) ?? 0) + 1)) ** 2;
  const norm = (w: Set<string>) => Math.sqrt([...w].reduce((n, t) => n + weight(t), 0));
  const qNorm = norm(query);
  const needed = Math.min(2, query.size);
  const scored = pool.flatMap(({ q, w }) => {
    const shared = [...query].filter((t) => w.has(t));
    if (shared.length < needed) return [];
    const score = shared.reduce((n, t) => n + weight(t), 0) / (qNorm * norm(w));
    return score >= MATCH_MIN ? [{ q, score }] : [];
  });
  scored.sort((a, b) => b.score - a.score || b.q.answer.at.localeCompare(a.q.answer.at) || a.q.id.localeCompare(b.q.id));
  return scored.slice(0, PAST_SHOWN).map(({ q }) => ({
    questionId: q.id,
    text: q.text,
    answer: q.answer.text,
    at: q.answer.at,
    ...(q.answer.probable ? { probable: true } : {}),
  }));
}
