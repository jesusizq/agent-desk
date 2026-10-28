# Protocol

How sessions, adapters, the server and the page share state. Types are in `src/core/protocol.ts`;
every record read from disk or received over HTTP goes through a validator in `src/core/model.ts`
first, and a file that fails is reported on the page ("N unreadable files"), never skipped silently.

## Store

`~/.cache/agent-desk/` (or `AGENT_DESK_HOME`, which must be absolute). Directories 0700, files 0600.

| Path | Record | Written by |
| --- | --- | --- |
| `sessions/<session>.json` | `Session`: provider label, project, title, state (`working`, `waiting`, `ended`), process ancestry, terminal program, current activity, last message of the turn | adapter hooks |
| `questions/open/<question>.json`, `questions/closed/<question>.json` | `Question`: kind (`question`, `permission`, `waiting`), text, context, options, status (`open`, `answered`, `dismissed`), answer and how it was given (`terminal`, `desk`), interpretation | hooks, `agent-desk ask`, the page |
| `agents/<session>/<agent>.json` | `Agent`: state, goal (short title), summary (what it must deliver), activity, branch, commit, `after` (agents it builds on), times | hooks, `agent-desk agent` |
| `results/<result>.json` | `Result`: title, summary, status, local URL, image ids, before/after pair, assumptions, taste decisions, checks | `agent-desk result` |
| `images/<image>.<png\|jpg\|webp\|gif>` | a copy of each reported image, type checked by its first bytes, 20 MB at most | `agent-desk result` |
| `services/<service>.json` | a local server of a session and its URL | `agent-desk service` |
| `metrics/<session>.json` | what the session's status line shows; every field optional | status-line wrapper, hooks |
| `inbox/<session>/<question>.json` | an answer given on the page, waiting for the session; an unreadable one is set aside as `.<name>.rejected` | the page |
| `inbox/<session>/.listener.<pid>.json` | a process waiting for that session's answers | the adapter's waiter |
| `messages/<session>/<message>.json` | `ConversationEntry`: each turn's last message and each answer of the developer (typed or from the desk), the latest 200 per session | hooks, the page |
| `projects/<project>.json` | `ProjectScan`: the project's checkouts (main and git worktrees) with branch, size on disk, whether merged into the main branch and commits ahead; total and the day's starting total | `agent-desk scan`, started by adapters at the end of a turn |
| `seen.json` | when the developer last marked everything as seen | the page |
| `secret` | per-install secret for the page's writes | the server, on first start |

Ids match `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` before they become a path segment, and every resolved
path is checked to stay inside the store.

### Concurrent writers

Hooks, the CLI and the server write the same files from different processes.

- Every write goes to a temp file in the same directory, is fsynced, then renamed over the record:
  a reader sees the old record or the new one, never a partial one. Temp and lock files start with
  `.` and are ignored by listings.
- Read-modify-write cycles hold `.<record>.lock`, created exclusively and holding a random token.
  A lock older than 15 s is taken as abandoned and taken over by renaming it away, which only one
  process can do; a lock is released only by the holder of its token.
- Open questions and closed ones are kept in separate folders, so the hooks that run on every turn
  read only what is open.
- An answer in an inbox is claimed by renaming it before it is read, so each answer reaches exactly
  one waiter.
- Answering from the page closes the question first and writes the inbox entry second; if the
  second step fails, the question is reopened.

## Sessions and their terminal

The adapter records the session's own process (`process.pid` with its start time) and its ancestors.

- **The CLI finds its session** by walking its own ancestors to a registered, live session process,
  so a session never passes its id. `--session ID` or `AGENT_DESK_SESSION` override it.
- **"Go to session"** is `vscode://agent-desk.agent-desk/focus?session=<id>`, built by the page from
  the validated session id when the session's terminal program is `vscode`. The extension shows the
  terminal whose shell process is one of the session's ancestors.
- **Liveness:** a session still marked running whose process is gone (or whose pid now belongs to
  another process, by start time) is shown as such.

## What needs the developer

"Needs you" holds open questions: asked by the model (`agent-desk ask`), permission prompts, the
provider's own dialogs, and turns that end with a question. A turn that ends with a report is kept
as the session's last message and shown quietly on its card ("Finished · waiting for your next
instruction"); the session panel always shows it in full, also after its item was dismissed, and can
reply to it while the session listens.

## Answers from the page

The page shows an answer box for a question only while a live listener exists for its session, and
the server refuses an answer otherwise, so an answer never waits in an inbox for a later, unrelated
turn. A permission prompt gets one while the adapter's permission hook waits for it; its entry in
the inbox is taken only by that hook.

If the developer types in the terminal before the waiter has taken an answer, the adapter withdraws
it from the inbox and records the typed text as the answer; when the session ends, the question is
dismissed.

1. The page posts the text; the server closes the question with `via: "desk"` and writes
   `inbox/<session>/<question>.json` with the question and the answer, unchanged.
2. The waiter claims it and hands it to the session in the provider's own way (Claude Code: exit
   code 2 of an `asyncRewake` hook started at the end of each turn and when the session starts,
   which wakes the model with the text).

## CLI

`agent-desk help` lists every command. What a session posts:

| Command | Record |
| --- | --- |
| `ask "<question>" --option A --option B [--context T]` | an open question with options |
| `result "<title>" --summary S --image <path>[::caption] [--compare 0,1] [--url U] [--failed] [--assumption A] [--decision D] [--check "<criterion> => <verification>"]` | a result; images are copied |
| `agent "<description>" [--summary] [--goal] [--state] [--activity] [--branch] [--commit] [--after "<description>"]` | creates or updates the agent named after the description (the same name the hooks give it) |
| `service <name> <url>` / `service <name> --stop` | a local server of the session |
| `interpret "<text>"` | how the session understood its latest answer |
| `scan <project dir> [--if-older-than S]` | measures the project's checkouts with read-only git and a file walk; sizes are re-measured at most hourly |

Exit code 2 means the input was wrong (the message says which part and why); 1 means anything else.

## HTTP

The server binds 127.0.0.1 and refuses any request whose `Host` is not `127.0.0.1:<port>` or
`localhost:<port>`.

| Request | Purpose |
| --- | --- |
| `GET /` and `/app.js`, `/dom.js`, `/text.js`, `/theme.js`, `/style.css`, `/favicon.svg` | the page; the secret is in a `<meta>` of `/` |
| `GET /api/state` | `DeskState`: every record, plus `gone`, `listening`, `disk` and `problems`; answers 304 while nothing changed |
| `GET /api/sessions/<id>/messages` | the session's conversation, oldest first |
| `POST /api/sessions/<id>/read` | the developer read the session's conversation; its last message stops being new on every device |
| `POST /api/sessions/<id>/keys` `{ "action": "compact" \| "interrupt" \| "enter" \| "option-1"…"option-5" }` | sends those keys to the session's tmux pane (see `.claude/rules/security.md`) |
| `GET /images/<id>` | a stored image, served with `Content-Security-Policy: default-src 'none'; sandbox` |
| `POST /api/questions/<id>/answer` `{ "text": "…" }` | answer from the page |
| `POST /api/questions/<id>/dismiss` | close without answering |
| `POST /api/sessions/<id>/message` `{ "text": "…" }` | reply to a waiting session that asked nothing; kept in the history against its last message |
| `POST /api/results/<id>/seen`, `POST /api/seen` | mark one result, or everything, as seen |

Every `POST` needs `Origin: http://127.0.0.1:<port>` (or `localhost`) exactly and the header
`X-Agent-Desk-Secret`; bodies are JSON, 64 KB at most.
