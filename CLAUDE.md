# agent-desk

A local, provider-independent desk to follow and answer every AI coding session on this machine.
See @AGENTS.md for the product specification and @BRIEF.md for where the work starts.

## Hard constraints

- Provider-independent: no provider name or SDK in the core (protocol, store, server, UI). Provider
  specifics live only in `adapters/<provider>/`.
- Local only: the server binds 127.0.0.1, makes no outbound network calls, loads no remote assets.
  Full rules in `.claude/rules/security.md`.
- Data outside every repository: `~/.cache/agent-desk/` (override with `AGENT_DESK_HOME`). The desk
  never writes into the projects it follows.
- Few dependencies: prefer the platform's standard library; every dependency needs a reason in the
  commit that adds it.

## Code quality

- Follow SOLID principles, avoid duplication (DRY).
- Refactor only for a concrete benefit (a bug, a duplication that already costs, a feature it unblocks).
- Strict TypeScript: no `any`; validate every external input at runtime (protocol files, CLI
  arguments, HTTP bodies) before use.
- Prefer `as const` objects over `enum`.
- Check the existing utilities before writing a new helper.

## Workflow

- Design before building: a clickable mock is reviewed before the real UI.
- Tests for the protocol and the store (concurrency, partial writes, malformed input) before the UI
  relies on them.
- Commit messages, code and comments in English; comments only for non-obvious technical
  constraints, 1-2 lines.
- Root cause always, never a workaround; no test is weakened to pass.
- Rules files (this file, AGENTS.md, `.claude/rules`, skills) change only with the owner's explicit approval.
- Nothing is pushed or published without the owner's approval.
