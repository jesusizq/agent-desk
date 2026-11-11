# Security

The desk shows text written by AI sessions and turns clicks into text typed into those sessions:
anything that reaches it can steer an agent. Treat every input as untrusted and every output as a
command.

## Server

- Bind 127.0.0.1 only (never 0.0.0.0). The developer's other devices reach the desk only through
  Tailscale Serve on their own tailnet (never Funnel): Serve proxies to 127.0.0.1 and adds the
  caller's `Tailscale-User-Login`.
- No outbound network calls, with one opt-in exception: Web Push to the phones the developer
  subscribed from the page (`src/server/push.ts`). Only `https://*.push.apple.com`,
  `https://fcm.googleapis.com` and `https://updates.push.services.mozilla.com` endpoints are
  accepted, checked when subscribing and again before each send; a device gets pushes only while
  its PIN is in; the payload is a count of open questions, or a fixed notice that the PIN ended, never
  a session's text, encrypted for the phone (RFC 8291) and signed with this install's
  VAPID key, kept in the store with 0600 permissions.
- Reject requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding),
  except the configured tailnet host (`AGENT_DESK_REMOTE_HOST`) carrying the configured Tailscale
  login (`AGENT_DESK_REMOTE_USER`); writes from it need its `https://` origin and the secret.
- A request is local only from a loopback socket, with a local `Host` and none of the headers a proxy
  adds (`Tailscale-*`, `X-Forwarded-*`, `Forwarded`, `Via`, `X-Real-IP`); any proxied request is let
  in only as the configured tailnet host and login, behind the PIN, and remote access is never set
  up through a port forward, portproxy, socat, a reverse proxy or a 0.0.0.0 bind.
- Every state-changing request needs a per-install secret (random, stored with 0600 permissions)
  and an exact `Origin` match; no CORS for any other origin (CSRF from other local pages).
- No endpoint executes commands, spawns processes or reads arbitrary paths, with two exceptions,
  each only after the developer confirms on the page:
  - the keys endpoint runs `tmux send-keys` (argument list, no shell) with keys from a fixed
    allow-list (`src/core/tmux.ts`: /compact, Escape, Enter, 1–5), only to the pane of a registered,
    live session, after checking that the pane's process is that session's process or one of its
    ancestors;
  - the end endpoint sends SIGTERM to a registered, live session's own process, only after checking
    in /proc that the pid still has the start time the session recorded (`src/core/proc.ts`); no
    other signal, and no process the session did not register as its own.

## Data

- Store files 0600, directories 0700, under `~/.cache/agent-desk/` only.
- A device that reached the desk through the tailnet keeps what it saved of the desk (the service
  worker's copy, images in its browser cache, review pages and their progress, drafts and unsent
  messages) only while its PIN unlock lasts: every answer to it carries the unlock's end
  (`X-Agent-Desk-Unlock-Ends`), and the device
  deletes all of it at a locked answer, at the push saying the PIN ended, or once that end has
  passed, never showing it after, even offline; only this computer keeps its copy without an end.
- Ids used in paths are validated against a strict pattern; resolved paths must stay inside the
  store (no traversal through project, session or image names).
- Images and review pages are copied into the store and served from it by id; never served from the
  path a session reported (a review page's own images, only from its folder, are inlined when it is
  copied).
- Writes are atomic (temp file + rename); readers survive partial and concurrent writes.

## UI

- Render session text as plain text or sanitised Markdown: no raw HTML, no scripts, no `javascript:`
  links; a strict Content-Security-Policy (`default-src 'self'`).
- A review page a session published (one HTML file, its images inlined when published) is the one
  exception: it is served only under the `sandbox allow-scripts` Content-Security-Policy, so it has
  no origin of its own and reaches none of the desk's data, requests or secret; it has no network
  (`default-src 'none'`; inline scripts and styles, `data:` images and fonts), shows only inside a
  frame of the desk, and talks to the desk only through messages the desk checks: saving its progress
  and handing over the text it copies. What it hands over reaches a session only as the line the
  developer sees and sends.
- An answer is delivered exactly as shown to the user, never rewritten, and only to the session that
  asked.
- A permission prompt is allowed or denied from the desk only while the provider's permission hook
  of that session waits for that very prompt; the desk sends the developer's choice, never a
  command, and the provider's own deny rules still apply.
- Links out of the desk are local preview URLs, session links and the fixed credits written in
  `index.html`. A session link is built by the desk from a validated session id, never from text a
  session wrote.

## Editor extension

- The VS Code extension accepts only a session id matching the strict pattern, looks it up in the
  store, and focuses an existing terminal of that registered session. It never types into a
  terminal, runs commands, opens files or makes network calls.

## Supply chain

- Few dependencies, pinned with a lockfile; no install scripts; no remote assets at runtime.
