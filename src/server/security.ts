// Request guards: DNS rebinding (Host), cross-site writes (Origin + per-install secret), response headers.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const PAGE_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

/** Images are data, never documents: nothing in them may run even if opened directly. */
export const IMAGE_HEADERS = {
  ...PAGE_HEADERS,
  "Content-Security-Policy": "default-src 'none'; sandbox",
} as const;

/**
 * Who may reach the desk: this machine on its port, and, when configured, the developer's other
 * devices through Tailscale Serve, which proxies from the tailnet name to 127.0.0.1 and adds the
 * caller's Tailscale login in `Tailscale-User-Login`.
 */
export type Access = { port: number; remote?: { host: string; user: string } };

/** The remote access configured in the environment, if both parts are set. */
export function remoteFromEnv(env: NodeJS.ProcessEnv): Access["remote"] {
  const host = env.AGENT_DESK_REMOTE_HOST?.trim().toLowerCase();
  const user = env.AGENT_DESK_REMOTE_USER?.trim();
  if (!host && !user) return undefined;
  if (!host || !user) throw new Error("remote access needs both AGENT_DESK_REMOTE_HOST (tailnet name:port) and AGENT_DESK_REMOTE_USER (Tailscale login)");
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) throw new Error(`AGENT_DESK_REMOTE_HOST: expected a host name and optional port, got ${JSON.stringify(host)}`);
  return { host, user };
}

function localHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/** Where a request comes from: this machine, the configured Tailscale user, or refused with the reason. */
export type Reach = { from: "local" | "remote" } | { refused: string };

/** Headers only a proxy adds; a browser on this machine never sends them. */
function proxied(req: IncomingMessage): boolean {
  return Object.keys(req.headers).some((name) => name.startsWith("tailscale-") || name.startsWith("x-forwarded-") || name === "forwarded" || name === "via" || name === "x-real-ip");
}

function loopback(address: string | undefined): boolean {
  return address !== undefined && (address === "::1" || /^(::ffff:)?127\./.test(address));
}

/**
 * Local means a loopback socket, a local Host and no proxy header: a proxy (port forward,
 * portproxy, reverse proxy) can send a local Host for a request from anywhere. A proxied request
 * is let in only as the configured Tailscale host and login, which Tailscale Serve sets.
 */
export function reachOf(req: IncomingMessage, access: Access): Reach {
  const host = req.headers.host?.toLowerCase();
  if (host === undefined) return { refused: "no Host header" };
  if (!loopback(req.socket.remoteAddress)) return { refused: `connection from ${req.socket.remoteAddress ?? "an unknown address"}, not from this machine` };
  if (access.remote !== undefined && host === access.remote.host) {
    return req.headers["tailscale-user-login"] === access.remote.user ? { from: "remote" } : { refused: "unknown Tailscale user" };
  }
  if (!localHosts(access.port).includes(host)) return { refused: "unknown Host" };
  if (proxied(req)) return { refused: "a request through a proxy is never local; reach the desk from another device only through Tailscale Serve (AGENT_DESK_REMOTE_HOST)" };
  return { from: "local" };
}

/** Exact Origin only: for the one write a remote device makes before it has the secret (unlocking). */
export function originAllowed(req: IncomingMessage, access: Access): boolean {
  return access.remote !== undefined && req.headers.origin === `https://${access.remote.host}`;
}

/** A state-changing request must come from the desk's own page: the exact Origin of where it comes from, and the secret. */
export function writeAllowed(req: IncomingMessage, access: Access, from: "local" | "remote", secret: string): boolean {
  const origin = req.headers.origin;
  const origins = from === "local" ? localHosts(access.port).map((h) => `http://${h}`) : access.remote ? [`https://${access.remote.host}`] : [];
  if (origin === undefined || !origins.includes(origin)) return false;
  const given = req.headers["x-agent-desk-secret"];
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function send(res: ServerResponse, status: number, body: string | Buffer, type: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...PAGE_HEADERS, "Content-Type": type, "Cache-Control": "no-store", ...headers });
  res.end(body);
}

export function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8", headers);
}
