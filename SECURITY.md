# Security

The desk turns clicks into text delivered to AI coding sessions, so a flaw in it can steer an
agent. Its rules are in [`.claude/rules/security.md`](.claude/rules/security.md).

## Reporting a vulnerability

Report it privately through
[GitHub's private vulnerability reporting](https://github.com/jesusizq/agent-desk/security/advisories/new),
not in a public issue. Include what an attacker can do, the steps to reproduce it and the version
(commit) affected.

Fixes go to the latest commit of `main`; there are no maintained older releases.

## In scope

- Reaching the desk from anything other than this machine or the developer's tailnet (DNS
  rebinding, a missing Host, Origin or secret check, Tailscale Funnel exposure).
- Text from a session that runs script in the page or produces a link the desk should not offer.
- An answer or a key press delivered to a session other than the one shown, or rewritten.
- Paths that escape the store (`~/.cache/agent-desk/` or `AGENT_DESK_HOME`), or files written into a followed project.
- The VS Code extension doing anything beyond focusing a registered session's terminal.
