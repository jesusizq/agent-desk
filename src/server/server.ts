// The desk's HTTP server: the page, a read-only view of the store, and the few actions the page takes.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { fields, InputError, int, oneOf, optional, text } from "../core/check.ts";
import { sendTmuxAction, TMUX_ACTIONS, type TmuxAction } from "../core/tmux.ts";
import { ID_PATTERN } from "../core/ids.ts";
import { planForecasts } from "../core/limits.ts";
import { type DeskState, type DiskWarning, imageIds, readService, type ReviewState, type Service, type Session } from "../core/model.ts";
import { sessionListeners, urlPort } from "../core/ports.ts";
import { endProcess, sessionFinished } from "../core/proc.ts";
import { NO_PIN, Push, subscription } from "./push.ts";
import { isCode } from "../store/fsx.ts";
import { IMAGE_MAX_BYTES, IMAGE_TYPES, readReviewChange, StaleReview, type Store, Undeliverable } from "../store/store.ts";
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
/** What the PIN page may load before the device is unlocked. */
const UNLOCK_ASSETS = new Set(["/unlock.js", "/dom.js", "/text.js", "/theme.js", "/style.css", "/favicon.svg", "/manifest.webmanifest", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"]);
/** Marks what a locked device gets: the device never keeps the PIN page as the desk, and drops the desk it kept (sw.js). */
const LOCKED = { "X-Agent-Desk-Locked": "1" };
/** On every answer to an unlocked remote device, when its unlock ends (ms): the device drops its saved desk then (sw.js). */
const UNLOCK_ENDS = "X-Agent-Desk-Unlock-Ends";
const YEAR_S = 31_536_000;
const LOW_DISK_RATIO = 0.1;
const REFUSED_PAGE = "This device is not allowed on this desk: it accepts only its owner's Tailscale account. Sign in to Tailscale with that account and open it again.\n";

const BUILD = new Date().toISOString();

export function deskState(store: Store, now = new Date()): DeskState {
  const snap = store.snapshot();
  const held = store.heldQuestions(now.getTime());
  return {
    ...snap,
    services: liveServices(snap.services, snap.sessions, snap.problems),
    // The page shows a question's context only while it is open; the history needs no more.
    questions: snap.questions.filter((q) => !held.has(q.id)).map(({ context, ...q }) => (q.status === "open" && context !== undefined ? { ...q, context } : q)),
    now: now.toISOString(),
    gone: goneSessions(snap.sessions),
    listening: snap.sessions.filter((s) => store.isListening(s.id, snap.problems)).map((s) => s.id),
    disk: diskWarnings(snap.sessions, snap.problems),
    planForecasts: planForecasts(store.planHistory(snap.problems), now),
    build: BUILD,
  };
}

/**
 * The services the page shows: each running session's listening ports (src/core/ports.ts), under the
 * name and path the session gave one with `agent-desk service`; a named one that was found listening
 * goes when its port closes, and one the desk cannot see stays until the session stops it.
 */
function liveServices(stored: Service[], sessions: Session[], problems: string[]): Service[] {
  const running = sessions.filter((s): s is Session & { process: NonNullable<Session["process"]> } => s.process !== undefined && !sessionFinished(s));
  let found: ReturnType<typeof sessionListeners>;
  try {
    found = sessionListeners(running.map((s) => s.process));
  } catch (error) {
    problems.push(`local servers of the sessions: ${(error as Error).message}`);
    return stored.filter((v) => !v.detected);
  }
  const listening = new Map(running.map((s, i) => [s.id, found[i] ?? []]));
  const named = stored.filter((v) => !v.detected || listening.get(v.sessionId)?.some((l) => l.port === urlPort(v.url)));
  const detected = [...listening].flatMap(([sessionId, listeners]) =>
    listeners
      .filter((l) => !stored.some((v) => v.sessionId === sessionId && urlPort(v.url) === l.port))
      .map((l) => readService({ id: `port-${l.port}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`, sessionId, name: l.name, url: l.url, startedAt: l.startedAt, detected: true }, `local server on port ${l.port}`)),
  );
  return [...named, ...detected];
}

/** Sessions still marked running whose process has disappeared (closed terminal, crash). */
function goneSessions(sessions: Session[]): string[] {
  return sessions.filter((s) => s.state !== "ended" && sessionFinished(s)).map((s) => s.id);
}

function diskWarnings(sessions: Session[], problems: string[]): DiskWarning[] {
  const byDevice = new Map<number, DiskWarning>();
  for (const s of sessions) {
    if (s.state === "ended") continue;
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
    const freeBytes = stat.bavail * stat.bsize;
    if (totalBytes === 0 || freeBytes / totalBytes >= LOW_DISK_RATIO) continue;
    const entry = byDevice.get(dev) ?? { dir: s.project.dir, projects: [], freeBytes, totalBytes };
    if (!entry.projects.includes(s.project.name)) entry.projects.push(s.project.name);
    byDevice.set(dev, entry);
  }
  return [...byDevice.values()];
}

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
    const action = oneOf(Object.keys(TMUX_ACTIONS) as TmuxAction[])(fields(body, "body").action, "action");
    const s = store.getSession(target);
    if (!s?.tmux || !s.process || sessionFinished(s)) {
      throw new InputError("this session does not run in a live tmux pane; use its terminal");
    }
    sendTmuxAction(s.tmux, [s.process.pid, ...s.process.ancestors], action);
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

export function createDeskServer(store: Store, port: number, remote: Access["remote"] = remoteFromEnv(process.env), feedOptions: Partial<FeedOptions> = {}): Server {
  const secret = store.secret();
  const access: Access = remote ? { port, remote } : { port };
  const unlock = new RemoteUnlock(store.paths.pin, secret);
  const feed = new StateFeed(() => stateVersion(store).etag, () => store.stateDirs(), feedOptions);
  return createServer((req, res) => {
    handle(store, access, secret, unlock, feed, req, res).catch((error: unknown) => {
      process.stderr.write(`agent-desk: ${req.method} ${req.url}: ${(error as Error).stack ?? String(error)}\n`);
      if (!res.headersSent) sendJson(res, 500, { error: (error as Error).message });
      else res.destroy();
    });
  });
}

async function handle(store: Store, access: Access, secret: string, unlock: RemoteUnlock, feed: StateFeed, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    if (route === "/api/state") return state(store, req, res);
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
      return sendJson(res, 200, store.reviewState(reviewState[1]));
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
  if (route === "/api/seen") return sendJson(res, 200, store.markAllSeen());
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
      return sendJson(res, 200, { line: store.sendReview(reviewId, oneOf(["session", "other"] as const)(f.to, "to"), int(f.rev, "rev")).line });
    }
    if (action === "opened") return sendJson(res, 200, store.markReviewOpened(reviewId));
    return sendJson(res, 200, store.closeReview(reviewId));
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

/** What the page shows but the clock, and its version: the ETag ignores the clock, so an unchanged store costs the page a 304. */
function stateVersion(store: Store): { stable: Omit<DeskState, "now">; etag: string } {
  const { now: _now, ...stable } = deskState(store);
  return { stable, etag: `"${createHash("sha256").update(JSON.stringify(stable)).digest("base64url").slice(0, 22)}"` };
}

function state(store: Store, req: IncomingMessage, res: ServerResponse): void {
  const { stable, etag } = stateVersion(store);
  const body = JSON.stringify({ ...stable, now: new Date().toISOString() });
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
    res.end();
    return;
  }
  // Fetched at every change, also from a phone over the tailnet: compressed when the browser takes it.
  const gzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
  send(res, 200, gzip ? gzipSync(body) : body, "application/json; charset=utf-8", { ETag: etag, "Cache-Control": "no-cache", Vary: "Accept-Encoding", ...(gzip ? { "Content-Encoding": "gzip" } : {}) });
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
  const counts = store.archiveOlderThan(new Date(Date.now() - ARCHIVE_AFTER_DAYS * 86_400_000));
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
    const held = store.heldQuestions();
    return store.openQuestions().filter((q) => !held.has(q.id));
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
  const latest = store.listMetrics().filter((m) => m.planWindows).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
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
  setInterval(() => {
    const failed = (what: string) => (error: unknown) => process.stderr.write(`agent-desk: ${what} failed: ${(error as Error).stack ?? String(error)}\n`);
    checkPush().catch(failed("push"));
    pushEndedUnlocks(push).catch(failed("push of the ended PIN"));
    try {
      recordPlanUsage(store);
    } catch (error) {
      failed("recording plan usage")(error);
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
