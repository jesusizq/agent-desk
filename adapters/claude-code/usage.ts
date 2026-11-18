// Claude Code adapter: what a sub-agent's requests used and cost, summed from its own transcript.
import * as fs from "node:fs";
import { bool, compact, fields, type Fields, int, num, optional, text } from "../../src/core/check.ts";
import { isCode } from "../../src/store/fsx.ts";
import { costOf, type Served, type Usage } from "./prices.ts";

/**
 * The sums so far of one transcript, and where reading stopped: the next hook reads only what was
 * written since. `last` is the last request counted: Claude Code writes one line per block of a
 * reply, each with the reply's usage, so the lines after it with the same id are the same request.
 */
export type Tally = { file: string; ino: number; offset: number; last?: string; tokens: number; costUsd: number; unpriced: boolean };

export function readTally(value: unknown, where: string): Tally {
  const f = fields(value, where);
  return compact({
    file: text(f.file, `${where}.file`, 4096),
    ino: int(f.ino, `${where}.ino`),
    offset: int(f.offset, `${where}.offset`),
    last: optional(f.last, `${where}.last`, (v, w) => text(v, w, 200)),
    tokens: int(f.tokens, `${where}.tokens`),
    costUsd: num(f.costUsd, `${where}.costUsd`, 0),
    unpriced: bool(f.unpriced, `${where}.unpriced`),
  });
}

/**
 * `before` brought up to date with what `file` gained since: the same object when nothing new was
 * written, a fresh count when the file was replaced or cut. The line being written is left for the
 * next hook. A request whose model or terms the price table does not cover leaves the cost unknown
 * (`unpriced`), never counted short; its tokens still count.
 */
export function tallyTranscript(file: string, before: Tally | undefined, problems: string[]): Tally | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    if (isCode(error, "ENOENT")) return before; // an agent that has not written its transcript yet
    throw error;
  }
  try {
    const st = fs.fstatSync(fd);
    const kept = before && before.file === file && before.ino === st.ino && before.offset <= st.size ? before : undefined;
    const start = kept?.offset ?? 0;
    if (kept && st.size === start) return kept;
    const buf = Buffer.alloc(st.size - start);
    const read = buf.length ? fs.readSync(fd, buf, 0, buf.length, start) : 0;
    const end = buf.subarray(0, read).lastIndexOf(10) + 1;
    if (end === 0) return kept;
    let { last, tokens, costUsd, unpriced } = kept ?? { last: undefined, tokens: 0, costUsd: 0, unpriced: false };
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      if (!line.includes('"usage"')) continue;
      const row = usageRow(line, file, problems);
      if (row === "unreadable") unpriced = true;
      if (typeof row !== "object" || row.id === last) continue;
      last = row.id;
      const used = row.usage.input + row.usage.write5m + row.usage.write1h + row.usage.read + row.usage.output;
      if (used === 0) continue; // a line Claude Code wrote itself (an error it shows), not a request
      tokens += used;
      const cost = costOf(row.model, row.usage, row.served);
      if (cost === undefined) unpriced = true;
      else costUsd += cost;
    }
    return compact({ file, ino: st.ino, offset: start + end, last, tokens, costUsd, unpriced });
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A reply's usage line: its request id, model, tokens by kind and how it was served; undefined for
 * any other line, "unreadable" for a reply whose usage cannot be read.
 */
function usageRow(line: string, file: string, problems: string[]): { id: string; model: string; usage: Usage; served: Served } | "unreadable" | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch (error) {
    problems.push(`${file}: a line that is not JSON was left out of the agent's tokens, and its cost is left unknown (${(error as Error).message})`);
    return "unreadable";
  }
  const e = obj(entry);
  const message = obj(e.message);
  const u = obj(message.usage);
  if (e.type !== "assistant" || typeof message.id !== "string" || typeof message.model !== "string" || message.usage === undefined) return undefined;
  const where = `${file}: the usage of ${message.id}`;
  try {
    const count = (v: unknown, w: string) => optional(v, `${where}.${w}`, (x, ww) => int(x, ww)) ?? 0;
    const written = count(u.cache_creation_input_tokens, "cache_creation_input_tokens");
    const split = obj(u.cache_creation);
    // Without the split by lifetime, every write is the default 5-minute one.
    const write1h = split.ephemeral_1h_input_tokens === undefined ? 0 : count(split.ephemeral_1h_input_tokens, "cache_creation.ephemeral_1h_input_tokens");
    const write5m = split.ephemeral_5m_input_tokens === undefined ? written - write1h : count(split.ephemeral_5m_input_tokens, "cache_creation.ephemeral_5m_input_tokens");
    const label = (v: unknown, w: string) => optional(v, `${where}.${w}`, (x, ww) => text(x, ww, 100));
    return {
      id: message.id,
      model: message.model,
      usage: {
        input: count(u.input_tokens, "input_tokens"),
        write5m: Math.max(0, write5m),
        write1h,
        read: count(u.cache_read_input_tokens, "cache_read_input_tokens"),
        output: count(u.output_tokens, "output_tokens"),
        webSearches: count(obj(u.server_tool_use).web_search_requests, "server_tool_use.web_search_requests"),
      },
      served: compact({ geo: label(u.inference_geo, "inference_geo"), speed: label(u.speed, "speed"), tier: label(u.service_tier, "service_tier") }),
    };
  } catch (error) {
    problems.push(`${(error as Error).message}; the agent's cost is left unknown`);
    return "unreadable";
  }
}

const obj = (v: unknown): Fields => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Fields) : {});
