# Claude Code adapter

Reports every Claude Code session on this machine to agent-desk through hooks, at no token cost
except the instructions added once per session (`instructions.md`, 1.4 kB, roughly 350 tokens), and delivers
answers given on the page back to the session that asked.

## What each hook does

| Event | Effect on the desk |
| --- | --- |
| `SessionStart` | registers the session (project, terminal program, process ancestry); adds `instructions.md` to the session's context |
| `UserPromptSubmit` | closes the session's open items; the typed prompt is recorded as the answer, also replacing an answer given on the page that had not been delivered yet; the first prompt names the session until Claude Code gives it a title; a prompt typed while the session works is kept until the turn that took it in ends (the instructions ask the session to say how it applied each one) |
| `Stop` (synchronous) | the turn ended: the last message is kept on the session, shown quietly; only when its last paragraph asks something (`?`) does it wait in "Needs you" (replacing the previous turn's), unless the model already asked with `agent-desk ask` |
| `Stop` (synchronous, also) | starts `agent-desk scan <project>` detached, at low priority: branches and merge state at most every 10 minutes, sizes at most every hour |
| `Stop` and `SessionStart` (`asyncRewake`) | `agent-desk-claude wait`: while the session waits, an answer given on the page wakes it with exit code 2 and the answer on stderr, verbatim; `SessionStart` (startup, resume, clear) covers a session that has not finished a turn yet |
| `PermissionRequest` | a permission item with the tool and its command or path, and options Allow and Deny; the hook then waits (up to 590 s) for a choice on the desk and returns it as Claude Code's decision ("Allow" allows; any other text denies and is given to Claude as the reason). If the prompt is settled in the terminal first, it returns no decision |
| `PostToolUse`, `PostToolUseFailure`, `PermissionDenied` | settle the session's permission items, and record what the session or the sub-agent that made the call is doing ("Edit: src/app.ts"). They start the adapter while `.permission-open` exists in the store and otherwise at most once every 3 s across all sessions (`.activity` stamp), so ordinary tool calls cost no process |
| `Notification` (`elicitation_dialog`, `agent_needs_input`) | a question with the notification's text |
| `PreToolUse` (`Agent`, `Task`), `SubagentStart`, `SubagentStop` | one agent per launch, whose goal is the description given to the Agent tool, done when it stops |
| `SessionEnd` | the session ends; what was still open is dismissed |

Every event also refreshes the session's permission mode in its metrics.

## Install

The hooks call `agent-desk-claude` from `PATH`; link the launchers first (see the root README).
Then, from the repository root:

```sh
claude plugin marketplace add ./adapters/claude-code
claude plugin install agent-desk@agent-desk
```

Claude Code installs a copy of the plugin, so a change to `hooks/hooks.json` reaches sessions only
after raising `version` in `.claude-plugin/plugin.json` and running
`claude plugin marketplace update agent-desk` and `claude plugin update agent-desk@agent-desk`. The
TypeScript the hooks run is read from this repository through `agent-desk-claude` and needs no update.

Installing writes the plugin into the user scope of Claude Code's settings. Sessions started
afterwards report to the desk; running sessions pick it up on their next start or resume.

## Status line

`agent-desk-claude statusline -- <program> [args…]` records the session's metrics (model, effort,
branch, context, plan windows, cost, prompt cache) and then runs the program with the same input, so
the terminal shows what it showed before. The program runs without a shell: a pipeline or shell
syntax goes in as `sh -c '…'`. It goes in the `statusLine.command` of Claude Code's user
settings, wrapping the current status-line command:

```json
{ "statusLine": { "type": "command", "command": "agent-desk-claude statusline -- <current command>" } }
```

The status line's session name, when Claude Code has one, becomes the session's title on the desk.
When the context passes 80 %, the metrics carry a suggestion to run `/compact`, shown with a copy
button in the session panel.

## Limits

- Claude Code does not link a `SubagentStart` to the Agent call that launched it. The adapter pairs
  each start with the oldest unpaired launch of the same agent type; two launches of one type at the
  same instant may swap names.
- Whether Claude Code shows the terminal's permission dialog while the `PermissionRequest` hook
  waits, or only after it returns, is not documented and not yet verified here. If it waits, the
  dialog appears only after an answer on the desk or the 590 s wait.
- An answer on the page reaches the session only while its `wait` hook runs: from the start of the
  session or the end of a turn until the developer types in the terminal or the session ends (at
  most 23 h). The page shows the answer box only then.
- Finding the session's process and its terminal reads `/proc`, so it works on Linux only.
