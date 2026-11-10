# Protocol

How sessions, adapters, the server and the page share state. Types are in `src/core/protocol.ts`;
every record read from disk or received over HTTP goes through a validator in `src/core/model.ts`
first, and a file that fails is reported on the page ("N unreadable files"), never skipped silently.

## Store

`~/.cache/agent-desk/` (or `AGENT_DESK_HOME`, which must be absolute). Directories 0700, files 0600.

| Path | Record | Written by |
| --- | --- | --- |
| `sessions/<session>.json` | `Session`: provider label, project (`name`, `dir`, and `worktree` when the session works in a linked git worktree of it; see below), title, state (`working`, `waiting`, `ended`), process ancestry, terminal program, current activity and when it was recorded, when its latest tool calls failed and the latest of them, last message of the turn, how many messages its conversation has received (`messageCount`, counted by the store as each is added, so a page showing the conversation sees one added mid-turn), whether its adapter delivers messages while it works (`takesMessagesWhileWorking`) | adapter hooks |
| `questions/open/<question>.json`, `questions/closed/<question>.json` | `Question`: kind (`question`, `permission`, `waiting`), text, context, options, status (`open`, `answered`, `dismissed`), answer and how it was given (`terminal`, `desk`), interpretation, `dialog` when it is a provider dialog whose answer only the hook waiting for it takes, `several` when more than one option can be picked (the answer names them, separated by `, `), `group` (`id`, `index` from 0, `size` from 2 to 10) shared by questions asked together, which the session waits for all of | hooks, `agent-desk ask`, the page |
| `agents/<session>/<agent>.json` | `Agent`: state, goal (short title), summary (what it must deliver), activity and when it was recorded, when its latest tool calls failed and the latest of them, branch, commit, `after` (agents it builds on), times, `ref`, the provider's id of the agent an adapter follows (none on a record only the session reported), and `launch`, the provider's id of the call that launched it, when the adapter follows launches. An adapter that learns an agent's name late renames its record (`Store.renameAgent`); a record already under that name without `ref` is merged into it, keeping its goal, summary, branch, commit and `after` | hooks, `agent-desk agent` |
| `results/<result>.json` | `Result`: title, summary, status, local URL, image ids, before/after pair, assumptions, taste decisions, checks | `agent-desk result` |
| `images/<image>.<png\|jpg\|webp\|gif>` | a copy of each reported image, and each image the developer attaches to an answer or message on the page; type checked by its first bytes, 20 MB at most. One that no live result, answer or message shows is archived with the rest | `agent-desk result`, the page |
| `services/<service>.json` | a local server of a session and its URL | `agent-desk service` |
| `metrics/<session>.json` | what the session's status line shows; every field optional | status-line wrapper, hooks |
| `inbox/<session>/<question>.json` | an answer given on the page, waiting for the session; an unreadable one is set aside as `.<name>.rejected` | the page |
| `inbox/<session>/.listener.<pid>.json` | a process waiting for that session's answers | the adapter's waiter |
| `.inbox-pending` | present while any inbox holds an entry, so a hook that runs on every tool call tests one file | the store |
| `messages/<session>/<message>.json` | `ConversationEntry`: each turn's last message, what the session wrote between its tool calls (marked `step`, when its adapter can tell), and each answer of the developer (typed or from the desk), the latest 500 per session | hooks, the page |
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

## Projects

A session's project is the folder it was started in, as given, with one exception
(`src/project/locate.ts`, used by adapters and `agent-desk scan`): a folder inside a linked git
worktree belongs to the repository's main checkout, so `~/shop/.claude/worktrees/x` and
`~/shop-feature` are both `~/shop` (`project.dir`, and so the same `ProjectScan` id), with the folder
the session works in kept as `project.worktree`. A subfolder maps to the same subfolder of the main
checkout. The rule reads git's files and runs no git command:

- the nearest `.git` above the folder is a file `gitdir: <common>/worktrees/<name>`, that folder
  holds `commondir` (naming `<common>`) and a `gitdir` file pointing back at this `.git`;
- `<common>` is a folder named `.git` whose parent's `.git` is that same folder: the parent is the
  main checkout (symlinks resolved).

Anything else keeps the folder as its own project: a main checkout, a submodule (its gitdir, under
`.git/modules/`, has no `commondir`), a worktree of a bare repository or of a repository whose git
folder lives elsewhere (`--separate-git-dir`), and git files that are missing, unreadable or
inconsistent.

## What needs the developer

"Needs you" holds open questions: asked by the model (`agent-desk ask`), permission prompts, the
provider's own dialogs, and turns that end with a question. A question asked with `agent-desk ask`
during a turn is held (`writing`) until the turn ends and adds its message to it, or for 5 minutes at
most, so it never shows half written; permission prompts and dialogs stop the session and show at
once. A turn that ends with a report is kept
as the session's last message and shown quietly on its card ("Finished · waiting for your next
instruction"); the session panel always shows it in full, also after its item was dismissed, and can
reply to it while the session takes messages (see below).

## Answers from the page

The page shows an answer box for a session only while it takes messages, and the server refuses
one otherwise, so a message never waits in an inbox for a later, unrelated turn. A session takes
them while a live listener exists for it (it waits), or while it works if its record says
`takesMessagesWhileWorking` and its process is alive. A permission prompt gets Allow and Deny while
the adapter's permission hook waits for it; its entry in the inbox is taken only by that hook. Its
two options are the answer that allows it and the one that denies it, in that order: the page sends
one of them, or, for a denial with a reason, the reason itself, which the hook takes as a denial (a
reason that reads as the allowing answer is sent as the plain denial).

If the developer types in the terminal while the session waits, before the waiter has taken an
answer, the adapter withdraws it from the inbox and records the typed text as the answer; typed while
it works, both reach the session. When the session ends, the question is dismissed.

1. The page posts the text, with the ids of the images attached (`POST /api/images` first; not for
   a permission prompt or a dialog, which take text only); the server closes the question with
   `via: "desk"` and writes `inbox/<session>/<question>.json` with the question, the answer
   unchanged and the image ids.
2. The waiter claims it and hands it to the session in the provider's own way (Claude Code: exit
   code 2 of an `asyncRewake` hook started at the end of each turn and when the session starts,
   which wakes the model with the text). While the session works, Claude Code's adapter claims it
   after the session's next tool call instead (`agent-desk-claude deliver`, a `PostToolUse` hook that
   runs only while `.inbox-pending` exists) and returns it as `additionalContext`; a message left
   when the turn ends goes to the waiter. The files of the attached images follow the text, for the
   session to open.

## CLI

`agent-desk help` lists every command. What a session posts:

| Command | Record |
| --- | --- |
| `ask "<question>" --option A --option B [--context T]` | an open question with options |
| `result "<title>" --summary S --image <path>[::caption] [--compare 0,1] [--url U] [--failed] [--assumption A] [--decision D] [--check "<criterion> => <verification>"]` | a result; images are copied; refused without `--image` or `--url`, unless `--failed` |
| `agent "<description>" [--summary] [--goal] [--state] [--activity] [--branch] [--commit] [--after "<description>"]` | creates or updates the agent named after the description (the same name the hooks give it) |
| `service <name> <url>` / `service <name> --stop` | a local server of the session |
| `interpret "<text>"` | how the session understood its latest answer |
| `scan <project dir> [--if-older-than S]` | measures the project's checkouts with read-only git and a file walk; sizes are re-measured at most hourly |

What a session reads: `decisions [--search "<words>"] [--project <folder or name>] [--limit N]
[--permissions] [--dismissed] [--json]`, what its project already decided, newest first, so it does
not ask the developer again. It writes nothing.

- **A decision** is a closed question with an answer (`question` and `waiting` kinds), with its
  interpretation, or the `--decision` lines a session reported with a result, marked as decided by
  the session. Permission prompts come with `--permissions`; questions closed without an answer
  (dismissed, or the session moved on) with `--dismissed`.
- **The project** is `--project`, where a value with a `/` (or `.`, `..`) is a folder and any other
  a project name; without it, the calling session's project folder, or, outside a session, the
  current folder. A folder stands for the deepest recorded project folder holding it, with the
  sessions of every project folder inside that (its worktrees); a name, every project of that name.
  No matching session is an input error.
- **Search** keeps the decisions holding every word, ignoring case and accents, in the question, its
  context, options, answer, interpretation, the session's title, or the result's title, summary and
  decisions.
- **Sources:** `questions/closed/`, `results/` and `sessions/`, then the same folders under
  `archive/`, so decisions older than 60 days still count; a record archived between the two reads
  is found in the second. A file that fails to read is skipped and named on stderr (in `problems`
  with `--json`).
- **Output:** 20 decisions by default (`--limit` 1–500), each with its date (UTC), session, question
  headline, options, the answer verbatim (cut at 1000 characters, with the count of the rest) and the
  interpretation; then how many were left out. `--json` gives `{ decisions, total, projects,
  problems }` with the whole records.

Exit code 2 means the input was wrong (the message says which part and why); 1 means anything else.

## HTTP

The server binds 127.0.0.1 and refuses any request whose `Host` is not `127.0.0.1:<port>` or
`localhost:<port>`, that comes from an address other than loopback, or that carries a proxy's
headers (`Tailscale-*`, `X-Forwarded-*`, `Forwarded`, `Via`, `X-Real-IP`), except the configured
Tailscale host and login (`SECURITY.md`).

| Request | Purpose |
| --- | --- |
| `GET /` and `/app.js` with the modules it imports (`src/web/*.js`, each listed in `STATIC`), `/theme.js`, `/style.css`, `/favicon.svg` | the page; the secret is in a `<meta>` of `/` |
| `GET /api/state` | `DeskState`: every record (a closed question without its context), plus `gone`, `listening`, `disk` and `problems`; gzip-compressed when the browser accepts it; answers 304 while nothing changed |
| `GET /api/events` | server-sent events: `changed` with the state's version (the ETag of `/api/state`) on opening and at each change, never the state itself; a `: ping` comment every 20 s; 32 streams at most (503 past them); a remote device's stream ends when its unlock does |
| `GET /api/sessions/<id>/messages` | the session's conversation, oldest first |
| `POST /api/sessions/<id>/read` | the developer read the session's conversation; its last message stops being new on every device |
| `POST /api/sessions/<id>/keys` `{ "action": "compact" \| "interrupt" \| "enter" \| "option-1"…"option-5" }` | sends those keys to the session's tmux pane (see `.claude/rules/security.md`) |
| `POST /api/sessions/<id>/unread` | its last message is new again on every device, until the session is opened |
| `POST /api/sessions/<id>/end` | sends SIGTERM to the session's own process, only while its pid still has the start time the session recorded (see `.claude/rules/security.md`) |
| `GET /api/push/key` | this install's VAPID public key, which the phone subscribes with |
| `POST /api/push/subscribe` (a `PushSubscription` as JSON), `POST /api/push/unsubscribe` `{ "endpoint": "…" }` | the phone that gets "N need you" when a question opens; only `https://*.push.apple.com`, `https://fcm.googleapis.com` and `https://updates.push.services.mozilla.com` endpoints are accepted |
| `GET /images/<id>` | a stored image, served with `Content-Security-Policy: default-src 'none'; sandbox` |
| `POST /api/images` (the image itself, `Content-Type: image/*`, 20 MB at most) | keeps an image pasted or picked on the page; returns `{ "id": "…" }` |
| `POST /api/questions/<id>/answer` `{ "text": "…", "images"?: ["<id>"] }` | answer from the page, with up to 10 attached images |
| `POST /api/questions/<id>/dismiss` | close without answering |
| `POST /api/sessions/<id>/message` `{ "text": "…", "images"?: ["<id>"] }` | message to a session that asked nothing: a reply while it waits, or a message while it works; kept in the history against its last message |
| `POST /api/results/<id>/seen`, `POST /api/seen` | mark one result, or everything, as seen |

Every `POST` needs `Origin: http://127.0.0.1:<port>` (or `localhost`) exactly and the header
`X-Agent-Desk-Secret`; bodies are JSON, 64 KB at most, except an image.

### How the page follows the store

- **Changes.** While a stream is open, the server watches the store's folders (`Store.stateDirs`)
  and computes the state's version 100 ms after a change, and again every 1.5 s for what no file
  says: a session's process that died, a listener that died, a held question shown after 5 minutes.
  A `changed` event goes out only when the version differs. With no stream open it does neither.
- **One stream per browser.** The tab holding the Web Lock `agent-desk:events` opens the stream and
  passes each version to the other tabs over a `BroadcastChannel`; when it closes, another tab takes
  the lock and opens its own. A browser keeps six connections per host over HTTP/1.1, so a stream
  per tab would leave the seventh tab's requests waiting.
- **Polling behind it.** The page fetches `/api/state` at each version it does not show, and every
  15 s anyway, which also notices a stream gone quiet (a computer asleep). Without a working stream
  (no EventSource, 3 failures in a row, no first event within 10 s) it polls every 1.5 s and tries
  the stream again after 30 s, doubling up to 5 minutes, or at once when the desk answers again.
  `<html data-live="stream|poll">` says which.
- **Offline.** When `/api/state` fails or hangs 8 s, the page keeps the last state with "Offline ·
  last update HH:MM" and why, every answer box turns inert with its draft kept, and it polls every
  1.5 s until the desk answers. The service worker keeps the page and the last `/api/state` on the
  device and serves them only when the network fails, hangs 5 s, or Tailscale Serve answers 502–504;
  the page shows that copy as offline and read only. It never keeps a locked answer, and leaves the
  event stream to the network.
