// Claude Code adapter: copies what Claude Code hands its status line into the desk's metrics.
import * as fs from "node:fs";
import * as path from "node:path";
import { compact, fields, type Fields } from "../../src/core/check.ts";
import { id } from "../../src/core/ids.ts";
import type { Metrics, PlanWindow } from "../../src/core/model.ts";
import { isCode } from "../../src/store/fsx.ts";
import { ratesOf } from "./prices.ts";

const CONTEXT_FULL = 80;

/**
 * Maps the status-line JSON (see Claude Code's statusline docs) to provider-free metrics.
 * `fresh` is what starts the session's work afresh once its cache has gone cold (freshCommand).
 */
export function metricsFromStatusLine(value: unknown, fresh = COMPACT): Omit<Metrics, "at"> {
  const f = fields(value, "status line input");
  const model = obj(f.model);
  const context = obj(f.context_window);
  const cost = obj(f.cost);
  const limits = obj(f.rate_limits);
  const workspace = obj(f.workspace);
  const contextPercent = num(context.used_percentage);
  const windows: PlanWindow[] = [];
  for (const [key, label] of [["five_hour", "5 h"], ["seven_day", "7 d"]] as const) {
    const w = obj(limits[key]);
    const percent = num(w.used_percentage);
    if (percent !== undefined) windows.push(compact({ label, percent: clamp(percent), resetsAt: epoch(w.resets_at) }));
  }
  const dir = str(workspace.current_dir) ?? str(f.cwd);
  const cache = obj(f.prompt_cache);
  const contextTokens = int(context.total_input_tokens);
  return compact({
    sessionId: id(f.session_id, "status line input.session_id"),
    model: str(model.display_name) ?? str(model.id),
    effort: str(obj(f.effort).level),
    branch: str(obj(f.worktree).branch) ?? (dir ? gitBranch(dir) : undefined),
    contextPercent: contextPercent === undefined ? undefined : clamp(contextPercent),
    contextTokens,
    costUsd: num(cost.total_cost_usd),
    planWindows: windows.length ? windows : undefined,
    cacheExpiresAt: epoch(cache.expires_at),
    suggestion: contextPercent !== undefined && contextPercent >= CONTEXT_FULL ? { reason: "context-full" as const, command: COMPACT } : undefined,
    coldResume: compact({ command: fresh, costUsd: rewriteCost(str(model.id), contextTokens, str(cache.ttl)) }),
  });
}

/**
 * What writing the whole context back to the prompt cache costs, at the model's price for the
 * cache's lifetime (Claude Code writes the main conversation's for 1 h).
 */
function rewriteCost(model: string | undefined, tokens: number | undefined, ttl: string | undefined): number | undefined {
  if (model === undefined || tokens === undefined || (ttl !== undefined && ttl !== "5m" && ttl !== "1h")) return undefined;
  const rates = ratesOf(model, tokens);
  if (!rates) return undefined;
  return (tokens * (ttl === "1h" ? rates.write1h : rates.write5m)) / 1_000_000;
}

const COMPACT = "/compact";
/** Plugins whose command hands the work to a new conversation, better than compacting a cold cache. */
const FRESH_COMMANDS = [{ plugin: "ahorro", command: "/ahorro:handoff" }] as const;

/**
 * The command that starts a session's work afresh: a handoff to a new conversation when a plugin
 * that writes one is enabled in the developer's Claude Code settings (read only), else `/compact`.
 * Settings that cannot be read (also caught mid-write) give `/compact`, with the reason in `problems`.
 */
export function freshCommand(settingsFile: string, problems: string[]): string {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsFile, "utf8");
  } catch (error) {
    if (!isCode(error, "ENOENT")) problems.push(`${settingsFile}: could not be read, so ${COMPACT} is suggested over a cold cache (${(error as Error).message})`);
    return COMPACT;
  }
  let enabled: Fields;
  try {
    enabled = obj(obj(JSON.parse(raw) as unknown).enabledPlugins);
  } catch (error) {
    problems.push(`${settingsFile}: not valid JSON, so its enabled plugins cannot be read and ${COMPACT} is suggested over a cold cache (${(error as Error).message})`);
    return COMPACT;
  }
  const on = (plugin: string) => Object.entries(enabled).some(([key, value]) => value === true && key.split("@")[0] === plugin);
  return FRESH_COMMANDS.find((f) => on(f.plugin))?.command ?? COMPACT;
}

/** Claude Code's user settings file: in CLAUDE_CONFIG_DIR when set, else in the home folder's .claude. */
export function settingsFile(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "settings.json");
}

/** The session's name as Claude Code shows it (a custom name or its generated title), if any. */
export function sessionNameFromStatusLine(value: unknown): string | undefined {
  return str(fields(value, "status line input").session_name);
}

/** The current branch from .git/HEAD (also inside a worktree, where .git is a pointer file). */
export function gitBranch(dir: string): string | undefined {
  try {
    let git = path.join(dir, ".git");
    if (fs.statSync(git).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, "utf8"));
      if (!pointer?.[1]) return undefined;
      git = path.resolve(dir, pointer[1].trim());
    }
    const head = fs.readFileSync(path.join(git, "HEAD"), "utf8");
    return /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim();
  } catch (error) {
    if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return undefined; // not a git checkout
    throw error;
  }
}

const obj = (v: unknown): Fields => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Fields) : {});
const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.slice(0, 200) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
const clamp = (v: number) => Math.min(100, Math.max(0, v));

/** Epoch seconds, epoch milliseconds or an ISO string, as a UTC ISO time. */
function epoch(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return undefined;
}
