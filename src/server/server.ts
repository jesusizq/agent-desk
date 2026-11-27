// The desk's HTTP server: the page, a read-only view of the store, and the few actions the page takes.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { fields, InputError, int, list, oneOf, optional, text } from "../core/check.ts";
import { FRESH_COMMAND, sendTmuxAction, TMUX_ACTIONS, type TmuxAction } from "../core/tmux.ts";
import { ID_PATTERN, id } from "../core/ids.ts";
import { planForecasts } from "../core/limits.ts";
import { sessionBranches } from "../core/branches.ts";
import { type Agent, COMPACT_INSTRUCTIONS_MAX, type DeskCommand, type DeskHistory, type DeskState, type DiskWarning, imageIds, type LiveState, type ProjectScan, type Question, type ReviewState, reviewNote, type Session, SHELL_SUGGESTION_MAX, type SessionBranches } from "../core/model.ts";
import { MACHINE, type MachineSources, machineWarnings } from "../core/machine.ts";
import { agentsAtLoadGate } from "../project/busy.ts";
import { OPTIONS_TEXT_MAX, optionsText } from "../core/options.ts";
import { liveServices } from "../core/ports.ts";
import { endProcess, sessionFinished } from "../core/proc.ts";
import { NO_PIN, Push, subscription } from "./push.ts";
import { isCode } from "../store/fsx.ts";
import { heldOf, IMAGE_MAX_BYTES, IMAGE_TYPES, MissingError, readReviewChange, StaleReview, type Store, Undeliverable } from "../store/store.ts";
import { type FeedOptions, StateFeed } from "./feed.ts";
import { PinRefused, RemoteUnlock } from "./remote-unlock.ts";
import { type Access, deskOrigin, IMAGE_HEADERS, originAllowed, reachOf, remoteFromEnv, reviewHeaders, send, sendJson, writeAllowed } from "./security.ts";

const WEB_DIR = path.join(import.meta.dirname, "..", "web");
const STATIC: Record<string, string> = {
  "/app.js": "text/javascript; charset=utf-8",
  "/agents.js": "text/javascript; charset=utf-8",
  "/alerts.js": "text/javascript; charset=utf-8",
  "/answer.js": "text/javascript; charset=utf-8",
  "/arrivals.js": "text/javascript; charset=utf-8",
  "/away.js": "text/javascript; charset=utf-8",
  "/control.js": "text/javascript; charset=utf-8",
  "/conversation.js": "text/javascript; charset=utf-8",
  "/find.js": "text/javascript; charset=utf-8",
  "/follow.js": "text/javascript; charset=utf-8",
  "/desk.js": "text/javascript; charset=utf-8",
  "/format.js": "text/javascript; charset=utf-8",
  "/header.js": "text/javascript; charset=utf-8",
  "/history.js": "text/javascript; charset=utf-8",
  "/layout.js": "text/javascript; charset=utf-8",
  "/live.js": "text/javascript; charset=utf-8",
  "/notice.js": "text/javascript; charset=utf-8",
  "/pieces.js": "text/javascript; charset=utf-8",
  "/projects.js": "text/javascript; charset=utf-8",
  "/push.js": "text/javascript; charset=utf-8",
  "/result.js": "text/javascript; charset=utf-8",
  "/review.js": "text/javascript; charset=utf-8",
  "/server.js": "text/javascript; charset=utf-8",
  "/session.js": "text/javascript; charset=utf-8",
  "/state.js": "text/javascript; charset=utf-8",
  "/suggest.js": "text/javascript; charset=utf-8",
  "/zoom.js": "text/javascript; charset=utf-8",
  "/dom.js": "text/javascript; charset=utf-8",
  "/motion.js": "text/javascript; charset=utf-8",
  "/theme.js": "text/javascript; charset=utf-8",
  "/text.js": "text/javascript; charset=utf-8",
  "/review-shim.js": "text/javascript; charset=utf-8",
  "/style.css": "text/css; charset=utf-8",
  "/favicon.svg": "image/svg+xml",
  "/unlock.js": "text/javascript; charset=utf-8",
  "/sw.js": "text/javascript; charset=utf-8",
  "/manifest.webmanifest": "application/manifest+json",
  "/apple-touch-icon.png": "image/png",
  "/icon-192.png": "image/png",
  "/icon-512.png": "image/png",
  "/icon-maskable-512.png": "image/png",
};
const BODY_LIMIT = 64 * 1024;
/** A review's saved state (2 MB) with the text its page copies (200 KB), as JSON; the store checks the real limits. */
const REVIEW_BODY_LIMIT = 5 * 1024 * 1024;
/** Results marked seen in one request: every result the desk lists, in one go; each id up to 128 characters, as JSON. */
export const SEEN_IDS_MAX = 5000;
export const SEEN_BODY_LIMIT = SEEN_IDS_MAX * 132 + 64;
/** What the PIN page may load before the device is unlocked. */
const UNLOCK_ASSETS = new Set(["/unlock.js", "/dom.js", "/text.js", "/theme.js", "/style.css", "/favicon.svg", "/manifest.webmanifest", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"]);
/** Marks what a locked device gets: the device never keeps the PIN page as the desk, and drops the desk it kept (sw.js). */
const LOCKED = { "X-Agent-Desk-Locked": "1" };
/** On every answer to an unlocked remote device, when its unlock ends (ms): the device drops its saved desk then (sw.js). */
const UNLOCK_ENDS = "X-Agent-Desk-Unlock-Ends";
const YEAR_S = 31_536_000;
const LOW_DISK_RATIO = 0.1;
const DISK_STEP_BYTES = 1e8;
const REFUSED_PAGE = "This device is not allowed on this desk: it accepts only its owner's Tailscale account. Sign in to Tailscale with that account and open it again.\n";

const BUILD = new Date().toISOString();

export function deskState(store: Store, now = new Date(), machine: MachineSources = MACHINE): DeskState {
  const snap = store.snapshot();
  // From the records the snapshot read: a second read would report each unreadable file twice.
  const held = heldOf(snap.sessions, snap.questions, now.getTime());
  const heard = snap.sessions.map((s) => [s.id, store.listeners(s.id, snap.problems)] as const);
  const branches = snap.sessions.flatMap((s) => {
    if (sessionFinished(s)) return [];
    const scan = snap.projects.find((p) => path.resolve(p.dir) === path.resolve(s.project.dir));
    const shown = sessionBranches(s, snap.agents, scan);
    return shown && scan ? [{ s, scan, shown }] : [];
  });
  const gated = new Set(branches.flatMap(({ s, scan, shown }) => atLoadGate(s, shown, scan, snap.problems).map((name) => `${s.id}/${name}`)));
  return {
    ...snap,
    agents: gated.size === 0 ? snap.agents : snap.agents.map((a) => (gated.has(`${a.sessionId}/${a.name}`) ? { ...a, waitingFor: "machine-load" as const } : a)),
    services: liveServices(snap.services, snap.sessions, snap.problems),
    // The page shows a question's context only while it is open; the history needs no more.
    questions: snap.questions.filter((q) => !held.has(q.id)).map((q) => (q.status === "open" || q.context === undefined ? q : withoutContext(q))),
    now: now.toISOString(),
    gone: goneSessions(snap.sessions),
    listening: heard.filter(([, ls]) => ls.length > 0).map(([id]) => id),
    checking: heard.filter(([, ls]) => ls.some((l) => l.checks)).map(([id]) => id),
    disk: diskWarnings(snap.sessions, snap.problems),
    machine: machineWarnings(snap.problems, machine),
    planForecasts: planForecasts(store.planHistory(snap.problems), now),
    branches: branches.map((b) => b.shown),
    build: BUILD,
  };
}

/** Each closed question without its context, made once per record read, so an unchanged history keeps its objects (stateVersion). */
const contextless = new WeakMap<Question, Question>();
function withoutContext(q: Question): Question {
  let out = contextless.get(q);
  if (out === undefined) {
    const { context: _context, ...rest } = q;
    contextless.set(q, (out = rest));
  }
  return out;
}

/** The session's agents waiting at the load gate, read from its process tree at each state, since a scan is too rare for a wait. */
function atLoadGate(s: Session, shown: SessionBranches, scan: ProjectScan, problems: string[]): string[] {
  try {
    return agentsAtLoadGate(s.process, shown.rows, scan.worktrees.map((w) => w.path));
  } catch (error) {
    problems.push(`agents waiting for the machine in ${s.project.dir}: ${(error as Error).message}`);
    return [];
  }
}

/** Sessions still marked running whose process has disappeared (closed terminal, crash). */
function goneSessions(sessions: Session[]): string[] {
  return sessions.filter((s) => s.state !== "ended" && sessionFinished(s)).map((s) => s.id);
}

/** The filesystems of the projects that running sessions work in, when one runs short of space; a session whose process is gone runs nothing there. */
export function diskWarnings(sessions: Session[], problems: string[], lowRatio = LOW_DISK_RATIO): DiskWarning[] {
  const byDevice = new Map<number, DiskWarning>();
  for (const s of sessions) {
    if (sessionFinished(s)) continue;
    let dev: number;
    let stat: fs.StatsFs;
    try {
      dev = fs.statSync(s.project.dir).dev;
      stat = fs.statfsSync(s.project.dir);
    } catch (error) {
      if (isCode(error, "ENOENT")) continue; // a moved or deleted project has no disk to watch
      problems.push(`disk space of ${s.project.dir}: ${(error as Error).message}`);
      continue;
    }
    const totalBytes = stat.blocks * stat.bsize;
    // To the tenth of a GB the page shows: exact, the free space of a busy disk would change the state's version every check.
    const freeBytes = Math.floor((stat.bavail * stat.bsize) / DISK_STEP_BYTES) * DISK_STEP_BYTES;
    if (totalBytes === 0 || stat.bavail * stat.bsize >= lowRatio * totalBytes) continue;
    const entry = byDevice.get(dev) ?? { dir: s.project.dir, projects: [], freeBytes, totalBytes };
    if (!entry.projects.includes(s.project.name)) entry.projects.push(s.project.name);
    byDevice.set(dev, entry);
  }
  return [...byDevice.values()];
}

/** The session with `command` marked as typed now, `text` after it: its button shows it was sent. */
const sentFromDesk = (s: Session, command: DeskCommand, text: string): Session => ({ ...s, deskSent: { ...s.deskSent, [command]: { text, at: new Date().toISOString() } } });

type Action = (store: Store, target: string, body: unknown) => unknown;

/** What the developer sends a session from the desk: text, images attached, or both. */
function reply(body: unknown): [text: string, images: string[]] {
  const f = fields(body, "body");
  return [text(f.text ?? "", "text"), optional(f.images, "images", imageIds) ?? []];
}

const ACTIONS: Record<string, Action> = {
  "questions/answer": (store, target, body) => store.answerFromDesk(target, ...reply(body)),
  "questions/dismiss": (store, target) => store.dismiss(target),
  "results/seen": (store, target) => store.markResultSeen(target),
  "sessions/read": (store, target) => store.markSessionRead(target),
  "sessions/unread": (store, target) => store.markSessionUnread(target),
  "sessions/message": (store, target, body) => store.messageFromDesk(target, ...reply(body)),
  "sessions/keys": (store, target, body) => {
    const f = fields(body, "body");
    const action = oneOf(Object.keys(TMUX_ACTIONS) as TmuxAction[])(f.action, "action");
    // What the page showed on the button: what is typed is what the session stored, sent only while it is still that.
    const shown = optional(f.instructions, "instructions", (v, w) => text(v, w, COMPACT_INSTRUCTIONS_MAX)) ?? "";
    if (shown !== "" && action !== "compact") throw new InputError(`only compact takes instructions, not ${action}`);
    const shownCommand = optional(f.command, "command", (v, w) => text(v, w, SHELL_SUGGESTION_MAX)) ?? "";
    if (shownCommand !== "" && action !== "fresh" && action !== "shell") throw new InputError(`only fresh and shell take a command, not ${action}`);
    const s = store.getSession(target);
    if (!s?.tmux || !s.process || sessionFinished(s)) {
      throw new InputError("this session does not run in a live tmux pane; use its terminal");
    }
    const instructions = action === "compact" ? (s.compactInstructions?.text ?? "") : "";
    if (shown !== instructions) {
      throw new InputError("the session's suggested compact instructions changed since the page showed them; nothing was sent, look at the button again");
    }
    if (action === "shell") {
      const asked = s.shellSuggestion?.text ?? "";
      if (asked === "" || shownCommand !== asked) {
        throw new InputError("the shell command this session's last reply asked for changed or is gone since the page showed it; nothing was sent, look at the button again");
      }
      // Typed while the session works, it would wait in the terminal's queue and run at some later step.
      if (s.state !== "waiting") throw new InputError("the session is working; a shell command is typed only while it waits; nothing was sent");
      // Waiting from its own Stop hook on, while the other turn-end checks still run and may send it back to work.
      if (store.listeners(target).some((l) => l.checks)) throw new InputError("the checks that run at the session's turn end are still running and may send it back to work; nothing was sent, try again once they end");
      // Dropped before its first key: if tmux fails part way, a retry cannot type the line a second time.
      sendTmuxAction(s.tmux, [s.process.pid, ...s.process.ancestors], "shell", asked, () => store.updateSession(target, ({ shellSuggestion: _typing, ...rest }) => rest));
      store.updateSession(target, (rest) => sentFromDesk(rest, "shell", asked));
      return { sent: action };
    }
    const command = action === "fresh" ? (store.getMetrics(target)?.coldResume?.command ?? "") : "";
    if (action === "fresh" && !FRESH_COMMAND.test(command)) {
      throw new InputError(`this session's adapter names no single slash command that starts it afresh (${JSON.stringify(command.slice(0, 80))}); nothing was sent`);
    }
    if (shownCommand !== command) {
      throw new InputError("the command that starts this session afresh changed since the page showed it; nothing was sent, look at the button again");
    }
    sendTmuxAction(s.tmux, [s.process.pid, ...s.process.ancestors], action, action === "fresh" ? command : instructions);
    if (action === "compact" || action === "fresh") store.updateSession(target, (rest) => sentFromDesk(rest, action, action === "fresh" ? command : instructions));
    return { sent: action };
  },
  "sessions/end": (store, target) => {
    const s = store.getSession(target);
    if (!s?.process?.start || sessionFinished(s)) {
      throw new InputError("this session's process is not running or cannot be identified; nothing was sent");
    }
    endProcess(s.process.pid, s.process.start);
    return { ended: target };
  },
  "sessions/forget": (store, target) => store.forgetSession(target),
};

export function createDeskServer(store: Store, port: number, remote: Access["remote"] = remoteFromEnv(process.env), feedOptions: Partial<FeedOptions> = {}, machine: MachineSources = MACHINE): Server {
  const secret = store.secret();
  const access: Access = remote ? { port, remote } : { port };
  const unlock = new RemoteUnlock(store.paths.pin, secret);
  let history: DeskHistory | undefined;
  const version = () => {
    const v = stateVersion(store, machine, history);
    history = v.history;
    return v;
  };
  const feed = new StateFeed(() => version().etag, () => store.stateDirs(), feedOptions);
  return createServer((req, res) => {
    handle(store, access, secret, unlock, feed, version, req, res).catch((error: unknown) => {
      process.stderr.write(`agent-desk: ${req.method} ${req.url}: ${(error as Error).stack ?? String(error)}\n`);
      if (!res.headersSent) sendJson(res, 500, { error: (error as Error).message });
      else res.destroy();
    });
  });
}

async function handle(store: Store, access: Access, secret: string, unlock: RemoteUnlock, feed: StateFeed, version: () => StateVersion, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reach = reachOf(req, access);
  if ("refused" in reach) {
    // Opened directly, a sentence for the person; the page's own requests read the status.
    if (req.url === "/") return send(res, 421, REFUSED_PAGE, "text/plain; charset=utf-8");
    return sendJson(res, 421, { error: `refused: ${reach.refused}` });
  }
  const remote = reach.from === "remote";
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${access.port}`);
  const route = url.pathname;
  const unlockEnds = remote ? unlock.unlockedUntil(req) : undefined;
  if (remote && unlockEnds === undefined) return locked(route, access, unlock, req, res);
  if (unlockEnds !== undefined) res.setHeader(UNLOCK_ENDS, String(unlockEnds));

  if (req.method === "GET" || req.method === "HEAD") {
    if (route === "/") return page(res, secret);
    const type = STATIC[route];
    if (type) return send(res, 200, fs.readFileSync(path.join(WEB_DIR, route.slice(1))), type);
    if (route === "/api/state") {
      const v = version();
      return versioned(() => ({ ...v.stable, now: new Date().toISOString() }), v.etag, req, res);
    }
    if (route === "/api/history") {
      const v = version();
      return versioned(() => v.history, v.history.version, req, res);
    }
    // A remote device's stream ends with its unlock, as its next request would.
    if (route === "/api/events") return req.method === "GET" ? feed.stream(res, unlockEnds) : sendJson(res, 405, { error: "method not allowed" });
    if (route === "/api/push/key") return sendJson(res, 200, { key: new Push(store.paths.push).publicKey() });
    const conversation = /^\/api\/sessions\/([^/]+)\/messages$/.exec(route);
    if (conversation?.[1]) {
      if (!ID_PATTERN.test(conversation[1])) return sendJson(res, 400, { error: "invalid id" });
      return sendJson(res, 200, store.listMessages(conversation[1]));
    }
    const review = /^\/review\/([^/]+)(\/raw)?$/.exec(route);
    if (review?.[1]) return reviewPage(store, review[1], review[2] === undefined, deskOrigin(req, access, reach.from), res);
    const reviewState = /^\/api\/reviews\/([^/]+)\/state$/.exec(route);
    if (reviewState?.[1]) {
      if (!ID_PATTERN.test(reviewState[1])) return sendJson(res, 400, { error: "invalid id" });
      if (!store.getReview(reviewState[1])) return sendJson(res, 404, { error: "not found" });
      const state = store.reviewState(reviewState[1]);
      // What the marks read as, built here once: the Send sheet shows exactly this.
      const options = optionsText(state.data);
      return sendJson(res, 200, options === undefined ? state : { ...state, options });
    }
    const image = /^\/images\/([^/]+)$/.exec(route);
    if (image?.[1]) return imageFile(store, image[1], res, unlockEnds);
    return sendJson(res, 404, { error: "not found" });
  }

  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
  // A device already unlocked may still show an old PIN page (a phone restoring a tab): nothing to do.
  if (route === "/api/unlock" && remote) return sendJson(res, 200, { unlocked: true });
  if (!writeAllowed(req, access, reach.from, secret)) return sendJson(res, 403, { error: "forbidden: this request lacks the page's secret or comes from another origin; reload the page" });
  // What the desk itself writes is told to the other pages at once, without waiting for the watch.
  res.on("finish", () => feed.poke());
  if (route === "/api/results/seen") {
    try {
      const ids = list(fields(await readBody(req, SEEN_BODY_LIMIT), "body").ids, "ids", id, SEEN_IDS_MAX);
      const unexpected = (resultId: string, error: unknown) => process.stderr.write(`agent-desk: ${req.method} ${req.url}: marking ${resultId} seen: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      return sendJson(res, 200, store.markResultsSeen(ids, unexpected));
    } catch (error) {
      if (error instanceof InputError) return sendJson(res, 400, { error: error.message });
      throw error;
    }
  }
  if (route === "/api/images") return attachImage(store, req, res);
  if (route === "/api/push/subscribe" || route === "/api/push/unsubscribe") {
    try {
      const body = await readBody(req);
      const push = new Push(store.paths.push);
      if (route === "/api/push/subscribe") push.subscribe(subscription(body), unlockEnds ?? NO_PIN);
      else push.unsubscribe(text(fields(body, "body").endpoint, "endpoint", 2048));
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      if (error instanceof InputError) return sendJson(res, 400, { error: error.message });
      throw error;
    }
  }
  const r = /^\/api\/reviews\/([^/]+)\/(state|send|opened|close)$/.exec(route);
  if (r?.[1] && r[2]) return reviewAction(store, r[1], r[2], reach.from, req, res);
  const m = /^\/api\/(questions|results|sessions)\/([^/]+)\/(answer|dismiss|seen|message|keys|read|unread|end|forget)$/.exec(route);
  const action = m ? ACTIONS[`${m[1]}/${m[3]}`] : undefined;
  if (!m?.[2] || !action) return sendJson(res, 404, { error: "not found" });
  if (!ID_PATTERN.test(m[2])) return sendJson(res, 400, { error: "invalid id" });
  try {
    return sendJson(res, 200, action(store, m[2], await readBody(req)));
  } catch (error) {
    if (error instanceof MissingError) return sendJson(res, 404, { error: error.message });
    if (error instanceof InputError) return sendJson(res, 400, { error: error.message });
    throw error;
  }
}

/** A remote device that has not unlocked yet gets the PIN page and its assets, and nothing else. */
async function locked(route: string, access: Access, unlock: RemoteUnlock, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET" || req.method === "HEAD") {
    if (route === "/") return send(res, 200, fs.readFileSync(path.join(WEB_DIR, "unlock.html")), "text/html; charset=utf-8", LOCKED);
    const type = UNLOCK_ASSETS.has(route) ? STATIC[route] : undefined;
    if (type) return send(res, 200, fs.readFileSync(path.join(WEB_DIR, route.slice(1))), type, LOCKED);
    return sendJson(res, 401, { error: "locked: enter the PIN" }, LOCKED);
  }
  if (req.method !== "POST" || route !== "/api/unlock") return sendJson(res, 401, { error: "locked: enter the PIN" }, LOCKED);
  if (!originAllowed(req, access)) return sendJson(res, 403, { error: `forbidden: the PIN is accepted only from https://${access.remote?.host ?? "?"}, this came from ${req.headers.origin ?? "no origin"}` });
  try {
    const cookie = unlock.unlock(fields(await readBody(req), "body").pin);
    return sendJson(res, 200, { unlocked: true }, { "Set-Cookie": cookie });
  } catch (error) {
    if (error instanceof PinRefused) return sendJson(res, error.status, { error: error.message }, LOCKED);
    if (error instanceof InputError) return sendJson(res, 400, { error: error.message });
    throw error;
  }
}

/** An image pasted on the desk, kept for an answer or message about to be sent; the body is the image itself. */
async function attachImage(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!/^image\//.test(req.headers["content-type"] ?? "")) return sendJson(res, 415, { error: "expected the image itself, with an image/* Content-Type" });
  try {
    return sendJson(res, 200, { id: store.addImage(await readBytes(req, IMAGE_MAX_BYTES), "the attached image") });
  } catch (error) {
    if (error instanceof InputError) return sendJson(res, 400, { error: error.message });
    throw error;
  }
}

/**
 * A review's page as the desk frames it: `shim` puts the desk's saved state in front of the page,
 * right after its <head> tag, or at its very start without one. The service worker builds the same
 * document offline from /review/<id>/raw (src/web/sw.js), so the two must stay byte for byte alike.
 */
export function reviewDocument(html: string, state: ReviewState, shim: string): string {
  const injected = `<script>window.__agentDeskReview=${JSON.stringify(state).replace(/</g, "\\u003c")};</script><script>${shim}</script>`;
  const head = /<head(?=[\s>/])[^>]*>/i.exec(html);
  if (!head) return injected + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + injected + html.slice(at);
}

/** The latest round of a review, only ever with reviewHeaders: it is a session's HTML, never the desk's. */
function reviewPage(store: Store, reviewId: string, withShim: boolean, origin: string, res: ServerResponse): void {
  if (!ID_PATTERN.test(reviewId)) return sendJson(res, 400, { error: "invalid id" });
  const found = store.reviewPage(reviewId);
  if (!found) return sendJson(res, 404, { error: "not found" });
  const shim = withShim ? fs.readFileSync(path.join(WEB_DIR, "review-shim.js"), "utf8") : undefined;
  res.writeHead(200, reviewHeaders(origin));
  res.end(shim === undefined ? found.html : reviewDocument(found.html, store.reviewState(reviewId), shim));
}

/** What the desk page does with a review: save its state, send it, open it, close it. */
async function reviewAction(store: Store, reviewId: string, action: string, from: "local" | "remote", req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ID_PATTERN.test(reviewId)) return sendJson(res, 400, { error: "invalid id" });
  try {
    const body = await readBody(req, action === "state" ? REVIEW_BODY_LIMIT : BODY_LIMIT);
    if (action === "state") return sendJson(res, 200, store.changeReviewState(reviewId, readReviewChange(body), from));
    if (action === "send") {
      const f = fields(body, "body");
      const note = f.note === undefined || (typeof f.note === "string" && f.note.trim() === "") ? undefined : reviewNote(f.note, "note");
      const options = f.options === undefined ? undefined : text(f.options, "options", OPTIONS_TEXT_MAX);
      return sendJson(res, 200, { line: store.sendReview(reviewId, oneOf(["session", "other"] as const)(f.to, "to"), int(f.rev, "rev"), note, options).line });
    }
    if (action === "opened") return sendJson(res, 200, store.markReviewOpened(reviewId));
    return sendJson(res, 200, store.closeReview(reviewId).review);
  } catch (error) {
    if (error instanceof StaleReview) return sendJson(res, 409, { error: error.message, stale: true, rev: error.rev });
    if (error instanceof Undeliverable) return sendJson(res, 409, { error: error.message });
    if (error instanceof InputError) return sendJson(res, 400, { error: error.message });
    throw error;
  }
}

function page(res: ServerResponse, secret: string): void {
  const html = fs.readFileSync(path.join(WEB_DIR, "index.html"), "utf8").replace("{{SECRET}}", secret);
  send(res, 200, html, "text/html; charset=utf-8");
}

/** What is over: an agent that finished, a question closed. Most of the state, and it changes far less often than the rest. */
const isOver = { agent: (a: Agent) => a.state === "done" || a.state === "failed", question: (q: Question) => q.status !== "open" };
const etagOf = (value: unknown) => `"${createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 22)}"`;

type StateVersion = { stable: Omit<LiveState, "now">; etag: string; history: DeskHistory };
/**
 * What the page shows but the clock, and its version: the ETag ignores the clock, so an unchanged store
 * costs the page a 304. What is over goes apart (/api/history), fetched only when its version changes:
 * sent with the rest, every status-line refresh would carry it again, megabytes to a phone.
 */
function stateVersion(store: Store, machine: MachineSources, before?: DeskHistory): StateVersion {
  const { now: _now, agents, questions, ...rest } = deskState(store, new Date(), machine);
  const over = { agents: agents.filter(isOver.agent), questions: questions.filter(isOver.question) };
  // Records are reused, frozen, while their files are unchanged: the same records are the same history, hashed once.
  const history: DeskHistory = before && sameItems(before.agents, over.agents) && sameItems(before.questions, over.questions) ? before : { ...over, version: etagOf(over) };
  const stable = { ...rest, agents: agents.filter((a) => !isOver.agent(a)), questions: questions.filter((q) => !isOver.question(q)), history: history.version };
  return { stable, etag: etagOf(stable), history };
}

const sameItems = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function versioned(body: () => object, etag: string, req: IncomingMessage, res: ServerResponse): void {
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
    res.end();
    return;
  }
  const json = JSON.stringify(body());
  // Fetched at every change, also from a phone over the tailnet: compressed when the browser takes it.
  const gzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
  send(res, 200, gzip ? gzipSync(json) : json, "application/json; charset=utf-8", { ETag: etag, "Cache-Control": "no-cache", Vary: "Accept-Encoding", ...(gzip ? { "Content-Encoding": "gzip" } : {}) });
}

/** A remote device's browser keeps the image only until its unlock ends, so that it cannot show it after. */
function imageFile(store: Store, imageId: string, res: ServerResponse, unlockEnds: number | undefined): void {
  if (!ID_PATTERN.test(imageId)) return sendJson(res, 400, { error: "invalid id" });
  const found = store.imageFile(imageId);
  if (!found) return sendJson(res, 404, { error: "not found" });
  const maxAge = unlockEnds === undefined ? YEAR_S : Math.max(0, Math.min(YEAR_S, Math.floor((unlockEnds - Date.now()) / 1000)));
  res.writeHead(200, { ...IMAGE_HEADERS, "Content-Type": IMAGE_TYPES[found.ext], "Cache-Control": `private, max-age=${maxAge}, immutable` });
  res.end(fs.readFileSync(found.file));
}

async function readBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<unknown> {
  const body = await readBytes(req, limit);
  if (body.length === 0) return {};
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new InputError("expected Content-Type: application/json");
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new InputError("request body is not valid JSON");
  }
}

function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk); // past the limit the rest is drained, then refused
    });
    req.on("error", reject);
    req.on("close", () => {
      if (!req.complete) reject(new InputError("the request was aborted before its body arrived"));
    });
    req.on("end", () => {
      if (size > limit) return reject(new InputError(`request body larger than ${limit} bytes`));
      resolve(Buffer.concat(chunks));
    });
  });
}

const ARCHIVE_AFTER_DAYS = 60;
const ARCHIVE_EVERY_MS = 6 * 3600_000;

/** Keeps the live store small: what is older than 60 days moves to archive/. */
function archiveOld(store: Store): void {
  const problems: string[] = [];
  const counts = store.archiveOlderThan(new Date(Date.now() - ARCHIVE_AFTER_DAYS * 86_400_000), problems);
  for (const problem of problems) process.stderr.write(`agent-desk: archiving: ${problem}\n`);
  if (counts.questions + counts.results + counts.sessions + counts.images > 0) {
    process.stdout.write(`agent-desk: archived ${counts.questions} questions, ${counts.results} results, ${counts.sessions} sessions, ${counts.images} images older than ${ARCHIVE_AFTER_DAYS} days\n`);
  }
}

const PUSH_EVERY_MS = 5_000;

/**
 * Tells the subscribed phones when a new question opens: only how many wait, never what they say.
 * Questions open when the desk starts were already there to see. Returns the check, for tests.
 */
export function pushNewQuestions(store: Store, push: Push, post: typeof fetch = fetch): () => Promise<void> {
  const shown = () => {
    // Unreadable files are named on the page (deskState); the phones need only the count of the rest.
    const problems: string[] = [];
    const held = store.heldQuestions(undefined, problems);
    return store.openQuestions(undefined, problems).filter((q) => !held.has(q.id));
  };
  const known = new Set(shown().map((q) => q.id));
  return async () => {
    const open = shown();
    const fresh = open.filter((q) => !known.has(q.id));
    for (const q of open) known.add(q.id);
    if (fresh.length === 0 || push.subscriptions().length === 0) return;
    for (const problem of await push.send(JSON.stringify({ count: open.length }), post)) process.stderr.write(`agent-desk: ${problem}\n`);
  };
}

/** Keeps how the plan windows fill, from the freshest report of any session. */
export function recordPlanUsage(store: Store): void {
  // An unreadable metrics file is named on the page (deskState); the freshest readable report is kept.
  const latest = store.listMetrics([]).filter((m) => m.planWindows).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  if (latest?.planWindows) store.recordPlan(latest.planWindows, latest.at);
}

/** Tells a device once that its PIN ended, since from then on it hears nothing more. */
export async function pushEndedUnlocks(push: Push, post: typeof fetch = fetch): Promise<void> {
  for (const problem of await push.sendEnded(JSON.stringify({ pinEnded: true }), post)) process.stderr.write(`agent-desk: ${problem}\n`);
}

export function startServer(store: Store, port: number): Promise<Server> {
  const server = createDeskServer(store, port);
  const push = new Push(store.paths.push);
  const checkPush = pushNewQuestions(store, push);
  let planFailure = "";
  setInterval(() => {
    const failed = (what: string) => (error: unknown) => process.stderr.write(`agent-desk: ${what} failed: ${(error as Error).stack ?? String(error)}\n`);
    checkPush().catch(failed("push"));
    pushEndedUnlocks(push).catch(failed("push of the ended PIN"));
    try {
      recordPlanUsage(store);
      planFailure = "";
    } catch (error) {
      // An unreadable history fails the same way every 5 s until it is fixed: said once, and counted on the page.
      if ((error as Error).message !== planFailure) failed("recording plan usage")(error);
      planFailure = (error as Error).message;
    }
  }, PUSH_EVERY_MS).unref();
  archiveOld(store);
  setInterval(() => {
    try {
      archiveOld(store);
    } catch (error) {
      process.stderr.write(`agent-desk: archiving failed: ${(error as Error).stack ?? String(error)}\n`);
    }
  }, ARCHIVE_EVERY_MS).unref();
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "EADDRINUSE" ? new Error(`port ${port} is in use; is the desk already running? Use --port to pick another`) : error),
    );
    server.listen(port, "127.0.0.1", () => {
      process.stdout.write(`agent-desk: http://127.0.0.1:${port}  (data in ${store.paths.home})\n`);
      resolve(server);
    });
  });
}
