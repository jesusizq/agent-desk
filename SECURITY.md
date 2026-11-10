# Security

The desk turns clicks into text delivered to AI coding sessions, so a flaw in it can steer an
agent. Its rules are in [`.claude/rules/security.md`](.claude/rules/security.md).

## Reporting a vulnerability

Report it privately through
[GitHub's private vulnerability reporting](https://github.com/jesusizq/agent-desk/security/advisories/new),
not in a public issue. Include what an attacker can do, the steps to reproduce it and the version
(commit) affected.

Fixes go to the latest commit of `main`; there are no maintained older releases.

## Remote access

The desk is reached from another device only through Tailscale Serve on the developer's tailnet
(never Funnel), with `AGENT_DESK_REMOTE_HOST` and `AGENT_DESK_REMOTE_USER` set and a PIN. Never
through a port forward, a WSL portproxy, socat, a reverse proxy or binding 0.0.0.0: they make a
remote request look local, and a local request needs no PIN and gets the per-install secret that
sends tmux keys and SIGTERM.

The server counts a request as local only when it comes from a loopback address, with a
`127.0.0.1:<port>` or `localhost:<port>` Host and none of the headers a proxy adds (`Tailscale-*`,
`X-Forwarded-*`, `Forwarded`, `Via`, `X-Real-IP`). A proxied request is let in only as the
configured Tailscale host and login, behind the PIN; anything else gets 421. A TCP forward running on
the same machine adds no header and connects from loopback, so it cannot be detected: not using one
is the defence.

## In scope

- Reaching the desk from anything other than this machine or the developer's tailnet (DNS
  rebinding, a missing Host, Origin or secret check, Tailscale Funnel exposure, a proxied request
  treated as local).
- Text from a session that runs script in the page or produces a link the desk should not offer.
- An answer or a key press delivered to a session other than the one shown, or rewritten.
- Paths that escape the store (`~/.cache/agent-desk/` or `AGENT_DESK_HOME`), or files written into a followed project.
- The VS Code extension doing anything beyond focusing a registered session's terminal.
