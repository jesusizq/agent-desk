# Security

The desk shows text written by AI sessions and turns clicks into text typed into those sessions:
anything that reaches it can steer an agent. Treat every input as untrusted and every output as a
command.

## Server

- Bind 127.0.0.1 only (never 0.0.0.0). The developer's other devices reach the desk only through
  Tailscale Serve on their own tailnet (never Funnel): Serve proxies to 127.0.0.1 and adds the
  caller's `Tailscale-User-Login`.
- Reject requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding),
  except the configured tailnet host (`AGENT_DESK_REMOTE_HOST`) carrying the configured Tailscale
  login (`AGENT_DESK_REMOTE_USER`); writes from it need its `https://` origin and the secret.
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
- Ids used in paths are validated against a strict pattern; resolved paths must stay inside the
  store (no traversal through project, session or image names).
- Images are copied into the store and served from it by id; never served from the path a session
  reported.
- Writes are atomic (temp file + rename); readers survive partial and concurrent writes.

## UI

- Render session text as plain text or sanitised Markdown: no raw HTML, no scripts, no `javascript:`
  links; a strict Content-Security-Policy (`default-src 'self'`).
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
