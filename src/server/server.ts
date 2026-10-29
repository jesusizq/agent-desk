// The desk's HTTP server: the page, a read-only view of the store, and the few actions the page takes.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as path from "node:path";
import { fields, InputError, nonEmpty, oneOf } from "../core/check.ts";
import { sendTmuxAction, TMUX_ACTIONS, type TmuxAction } from "../core/tmux.ts";
import { ID_PATTERN } from "../core/ids.ts";
import type { DeskState, DiskWarning, Session } from "../core/model.ts";
import { isAlive } from "../core/proc.ts";
import { isCode } from "../store/fsx.ts";
import { IMAGE_TYPES, type Store } from "../store/store.ts";
import { RemoteUnlock } from "./remote-unlock.ts";
import { type Access, hostAllowed, IMAGE_HEADERS, isRemote, originAllowed, remoteFromEnv, send, sendJson, writeAllowed } from "./security.ts";

const WEB_DIR = path.join(import.meta.dirname, "..", "web");
const STATIC: Record<string, string> = {
  "/app.js": "text/javascript; charset=utf-8",
  "/dom.js": "text/javascript; charset=utf-8",
  "/theme.js": "text/javascript; charset=utf-8",
  "/text.js": "text/javascript; charset=utf-8",
  "/style.css": "text/css; charset=utf-8",
  "/favicon.svg": "image/svg+xml",
  "/unlock.js": "text/javascript; charset=utf-8",
  "/sw.js": "text/javascript; charset=utf-8",
  "/manifest.webmanifest": "application/manifest+json",
  "/apple-touch-icon.png": "image/png",
  "/icon-192.png": "image/png",
  "/icon-512.png": "image/png",
};
const BODY_LIMIT = 64 * 1024;
/** What the PIN page may load before the device is unlocked. */
const UNLOCK_ASSETS = new Set(["/unlock.js", "/dom.js", "/text.js", "/theme.js", "/style.css", "/favicon.svg", "/manifest.webmanifest", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png"]);
/** Marks what a locked device gets, so the device never keeps the PIN page as the desk (sw.js). */
const LOCKED = { "X-Agent-Desk-Locked": "1" };
const LOW_DISK_RATIO = 0.1;

const BUILD = new Date().toISOString();

export function deskState(store: Store, now = new Date()): DeskState {
  const snap = store.snapshot();
  return {
    ...snap,
    now: now.toISOString(),
    gone: goneSessions(snap.sessions),
    listening: snap.sessions.filter((s) => store.isListening(s.id, snap.problems)).map((s) => s.id),
    disk: diskWarnings(snap.sessions, snap.problems),
    build: BUILD,
  };
}

/** Sessions still marked running whose process has disappeared (closed terminal, crash). */
function goneSessions(sessions: Session[]): string[] {
  return sessions.filter((s) => s.state !== "ended" && s.process && !isAlive(s.process.pid, s.process.start)).map((s) => s.id);
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

const ACTIONS: Record<string, Action> = {
  "questions/answer": (store, target, body) => store.answerFromDesk(target, nonEmpty(fields(body, "body").text, "text")),
  "questions/dismiss": (store, target) => store.dismiss(target),
  "results/seen": (store, target) => store.markResultSeen(target),
  "sessions/read": (store, target) => store.markSessionRead(target),
  "sessions/message": (store, target, body) => store.messageFromDesk(target, nonEmpty(fields(body, "body").text, "text")),
  "sessions/keys": (store, target, body) => {
    const action = oneOf(Object.keys(TMUX_ACTIONS) as TmuxAction[])(fields(body, "body").action, "action");
    const s = store.getSession(target);
    if (!s?.tmux || !s.process || s.state === "ended" || !isAlive(s.process.pid, s.process.start)) {
      throw new InputError("this session does not run in a live tmux pane; use its terminal");
    }
    sendTmuxAction(s.tmux, [s.process.pid, ...s.process.ancestors], action);
    return { sent: action };
  },
};

export function createDeskServer(store: Store, port: number, remote: Access["remote"] = remoteFromEnv(process.env)): Server {
  const secret = store.secret();
  const access: Access = remote ? { port, remote } : { port };
  const unlock = new RemoteUnlock(store.paths.pin, secret);
  return createServer((req, res) => {
    handle(store, access, secret, unlock, req, res).catch((error: unknown) => {
      process.stderr.write(`agent-desk: ${req.method} ${req.url}: ${(error as Error).stack ?? String(error)}\n`);
      if (!res.headersSent) sendJson(res, 500, { error: (error as Error).message });
      else res.destroy();
    });
  });
}

async function handle(store: Store, access: Access, secret: string, unlock: RemoteUnlock, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hostAllowed(req, access)) return sendJson(res, 421, { error: "unknown Host or Tailscale user" });
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${access.port}`);
  const route = url.pathname;
  if (isRemote(req, access) && !unlock.unlocked(req)) return locked(route, access, unlock, req, res);

  if (req.method === "GET" || req.method === "HEAD") {
    if (route === "/") return page(res, secret);
    const type = STATIC[route];
    if (type) return send(res, 200, fs.readFileSync(path.join(WEB_DIR, route.slice(1))), type);
    if (route === "/api/state") return state(store, req, res);
    const conversation = /^\/api\/sessions\/([^/]+)\/messages$/.exec(route);
    if (conversation?.[1]) {
      if (!ID_PATTERN.test(conversation[1])) return sendJson(res, 400, { error: "invalid id" });
      return sendJson(res, 200, store.listMessages(conversation[1]));
    }
    const image = /^\/images\/([^/]+)$/.exec(route);
    if (image?.[1]) return imageFile(store, image[1], res);
    return sendJson(res, 404, { error: "not found" });
  }

  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
  // A device already unlocked may still show an old PIN page (a phone restoring a tab): nothing to do.
  if (route === "/api/unlock" && isRemote(req, access)) return sendJson(res, 200, { unlocked: true });
  if (!writeAllowed(req, access, secret)) return sendJson(res, 403, { error: "forbidden: this request lacks the page's secret or comes from another origin; reload the page" });
  if (route === "/api/seen") return sendJson(res, 200, store.markAllSeen());
  const m = /^\/api\/(questions|results|sessions)\/([^/]+)\/(answer|dismiss|seen|message|keys|read)$/.exec(route);
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
    if (error instanceof InputError) return sendJson(res, 400, { error: error.message });
    throw error;
  }
}

function page(res: ServerResponse, secret: string): void {
  const html = fs.readFileSync(path.join(WEB_DIR, "index.html"), "utf8").replace("{{SECRET}}", secret);
  send(res, 200, html, "text/html; charset=utf-8");
}

function state(store: Store, req: IncomingMessage, res: ServerResponse): void {
  const { now: _now, ...stable } = deskState(store);
  const body = JSON.stringify({ ...stable, now: new Date().toISOString() });
  // The ETag ignores the clock, so an unchanged store costs the page a 304.
  const etag = `"${createHash("sha256").update(JSON.stringify(stable)).digest("base64url").slice(0, 22)}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
    res.end();
    return;
  }
  send(res, 200, body, "application/json; charset=utf-8", { ETag: etag, "Cache-Control": "no-cache" });
}

function imageFile(store: Store, imageId: string, res: ServerResponse): void {
  if (!ID_PATTERN.test(imageId)) return sendJson(res, 400, { error: "invalid id" });
  const found = store.imageFile(imageId);
  if (!found) return sendJson(res, 404, { error: "not found" });
  res.writeHead(200, { ...IMAGE_HEADERS, "Content-Type": IMAGE_TYPES[found.ext], "Cache-Control": "private, max-age=31536000, immutable" });
  res.end(fs.readFileSync(found.file));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const type = req.headers["content-type"] ?? "";
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BODY_LIMIT) chunks.push(chunk); // past the limit the rest is drained, then refused
    });
    req.on("error", reject);
    req.on("close", () => {
      if (!req.complete) reject(new InputError("the request was aborted before its body arrived"));
    });
    req.on("end", () => {
      if (size > BODY_LIMIT) return reject(new InputError(`request body larger than ${BODY_LIMIT} bytes`));
      if (size === 0) return resolve({});
      if (!type.startsWith("application/json")) return reject(new InputError("expected Content-Type: application/json"));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new InputError("request body is not valid JSON"));
      }
    });
  });
}

const ARCHIVE_AFTER_DAYS = 60;
const ARCHIVE_EVERY_MS = 6 * 3600_000;

/** Keeps the live store small: what is older than 60 days moves to archive/. */
function archiveOld(store: Store): void {
  const counts = store.archiveOlderThan(new Date(Date.now() - ARCHIVE_AFTER_DAYS * 86_400_000));
  if (counts.questions + counts.results + counts.sessions > 0) {
    process.stdout.write(`agent-desk: archived ${counts.questions} questions, ${counts.results} results, ${counts.sessions} sessions older than ${ARCHIVE_AFTER_DAYS} days\n`);
  }
}

export function startServer(store: Store, port: number): Promise<Server> {
  const server = createDeskServer(store, port);
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
