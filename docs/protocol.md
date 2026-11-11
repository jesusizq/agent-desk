# Protocol

How sessions, adapters, the server and the page share state. Types are in `src/core/protocol.ts`;
every record read from disk or received over HTTP goes through a validator in `src/core/model.ts`
first, and a file that fails is reported on the page ("N unreadable files"), never skipped silently.

## Store

`~/.cache/agent-desk/` (or `AGENT_DESK_HOME`, which must be absolute). Directories 0700, files 0600.

| Path | Record | Written by |
| --- | --- | --- |
| `sessions/<session>.json` | `Session`: provider label, project (`name`, `dir`, and `worktree` when the session works in a linked git worktree of it; see below), title, state (`working`, `waiting`, `ended`), process ancestry, terminal program, current activity and when it was recorded (`activityIsCall` when that activity is the tool call its adapter recorded, "Bash: npm test", rather than words the session or the adapter wrote: the page leaves calls off its session cards), when its latest tool calls failed in a row and the latest of them (`failedAt`, `failedWhat`: a successful call or the end of the turn empties them; the page warns at three), whether its latest call started or awaits a job of its own (`waitsForJob`: a background command or agent, a monitor, a wait; the page then shows it waiting on its job, never quiet), when its latest turn ended (`turnEndedAt`: an answer given after it belongs to the turn now running), last message of the turn, how many messages its conversation has received (`messageCount`, counted by the store as each is added, so a page showing the conversation sees one added mid-turn), whether its adapter delivers messages while it works (`takesMessagesWhileWorking`) | adapter hooks |
| `questions/open/<question>.json`, `questions/closed/<question>.json` | `Question`: kind (`question`, `permission`, `waiting`), text, context, options, status (`open`, `answered`, `dismissed`), answer, how it was given (`via`: `terminal`, `desk`) and whether it is only `probable` (see below), interpretation, `setAside`: the replies that closed it without answering it (see below), `dialog` when it is a provider dialog whose answer only the hook waiting for it takes, `several` when more than one option can be picked (the answer names them, separated by `, `), `group` (`id`, `index` from 0, `size` from 2 to 10) shared by questions asked together, which the session waits for all of | hooks, `agent-desk ask`, the page |
| `agents/<session>/<agent>.json` | `Agent`: state, goal (short title), summary (what it must deliver), activity and when it was recorded (`activityIsCall` as on `Session`; the store drops the mark whenever an activity is written without it, so `agent-desk agent --activity` always reads as the session's words), when its latest tool calls failed in a row and the latest of them, and whether its latest call started or awaits a job of its own (as on `Session`), branch, commit, `after` (agents it builds on), times, `ref`, the provider's id of the agent an adapter follows (none on a record only the session reported), and `launch`, the provider's id of the call that launched it, when the adapter follows launches. An adapter that learns an agent's name late renames its record (`Store.renameAgent`); a record already under that name without `ref` is merged into it, keeping its goal, summary, branch, commit and `after` | hooks, `agent-desk agent` |
| `results/<result>.json` | `Result`: title, summary, status, local URL, image ids, before/after pair, assumptions, taste decisions, checks, when it was seen (`seenAt`) | `agent-desk result` |
| `images/<image>.<png\|jpg\|webp\|gif>` | a copy of each reported image, and each image the developer attaches to an answer or message on the page; type checked by its first bytes, 20 MB at most. One that no live result, answer or message shows is archived with the rest | `agent-desk result`, the page |
| `services/<service>.json` | a local server of a session and its URL | `agent-desk service` |
| `metrics/<session>.json` | what the session's status line shows; every field optional | status-line wrapper, hooks |
| `inbox/<session>/<question>.json` | an answer given on the page, waiting for the session; an unreadable one is set aside as `.<name>.rejected` | the page |
| `inbox/<session>/.listener.<pid>.json` | a process waiting for that session's answers | the adapter's waiter |
| `.inbox-pending` | present while any inbox holds an entry, so a hook that runs on every tool call tests one file | the store |
| `messages/<session>/<message>.json` | `ConversationEntry`: each turn's last message, what the session wrote between its tool calls (marked `step`, when its adapter can tell), and each answer of the developer (typed or from the desk), the latest 500 per session | hooks, the page |
| `projects/<project>.json` | `ProjectScan`: the project's checkouts (main and git worktrees) with branch, size on disk, whether merged into the main branch and commits ahead; total and the day's starting total | `agent-desk scan`, started by adapters at the end of a turn |
| `reviews/<review>/review.json` | `Review`: title, project, the session that published the latest round, every round (`n`, `at`, `sessionId`, `bytes`), progress parsed from the page's counter, when its saved state last changed and from where (`local`, `remote`), whether the page has handed over the text it copies (`hasSummary`), each send, the last read through the CLI (`collected`), `openedAt`, `closedAt` | `agent-desk review`, the page |
| `reviews/<review>/round-<n>.html` | the page of that round, its images inlined; the last 5 rounds are kept | `agent-desk review` |
| `reviews/<review>/state.json` | `ReviewState`: the page's `localStorage` (`data`, string to string), the text it copied (`summary`) and `rev`, one more at each accepted write; never in `DeskState` | the page |
| `seen.json` | when the developer last marked everything as seen | the page |
| `plan.json` | per plan window label (`5 h`, `7 d`, as the provider names it), its windows oldest first, the last the current one: `resetsAt` and a sample (`at`, `percent`) each time the percentage rose a point or more. A new reset time starts a window; the last four finished windows are kept, none that reset more than 35 days earlier. A label holding one window object instead of a list (the format of earlier installs) is read as its current window | the server, from the freshest metrics |
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
- Which agent record follows which agent (`ref`) is decided under one lock per session,
  `agents/.<session>.json.lock` (`Store.withAgentsLocked`), with record locks taken inside it,
  never the other way round. Two records found on the same `ref` become one
  (`Store.mergeAgent`): goal, summary, branch, commit, `after`, `launch` and type from the record
  kept, else from the other; state, activity and failures from the one updated last; the earlier
  start.
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
once. A turn that ends with a question in plain text is titled with the sentences of its last
paragraph that ask (ending in `?` or `？`); the rest of that paragraph opens its context, followed by
the rest of the message. A last paragraph that is a list whose items ask, or that only asks, is the
title whole. A turn that ends with a report is kept as the session's last message and shown quietly
on its card ("Finished · waiting for your next instruction"); the session panel always shows it in full, also after its item was dismissed, and can
reply to it while the session takes messages (see below).

### How sure an answer is

| The answer came from | `via` | `probable` |
| --- | --- | --- |
| the desk, given to that very question (an option, its own box, Allow or Deny) | `desk` | absent |
| the provider's dialog, answered in the terminal (Claude Code's AskUserQuestion) | `terminal` | absent |
| the developer's next message in the terminal, which closes every open question of the session | `terminal` | `true` |
| a message typed in the terminal over a desk answer still in the inbox | `terminal` | `true` |

A probable answer may be about something else. A session that sees its question was not answered
runs `agent-desk unanswered`: the question opens again, keeps its `askedAt` (so its place among the
open ones, oldest first), loses its `answer`, `closedAt` and `interpretation`, and the reply goes to
`setAside` (the last 20). The reply stays in the conversation as the developer's message, never as an
answer, so `decisions` leaves the question out until it is answered again.

- **Which question:** without `--question`, every question the session's latest answer closed (one
  reply closes them all at one `at`). When that answer is certain (no `probable`), it is refused,
  naming the question; `--question <id>` opens that one whatever its answer. A permission prompt, a
  question closed without an answer and another session's question are refused.
- **Running it again** changes nothing: a question already open is left as it is, and its set-aside
  reply still counts as the session's latest, so an older answer is never taken instead.
- **Concurrent writers:** each question changes under its lock, only while its answer is still the
  one read; if it was answered or dismissed meanwhile, nothing changes and the command says so. A
  prompt typed at the same moment either closes the reopened question as its new probable answer or
  arrives first and leaves it open.
- **Through the next turn's end:** Claude Code's adapter keeps a reopened question open when the turn
  ends asking something else, and asks no second one when the turn asks it again.

`agent-desk interpret` records the interpretation on the latest answer given after the session's
previous turn ended (`turnEndedAt`; for a record without it, its last message's time, then its start):
the answer the prompt that started the turn gave, or one given on the desk since. With none, it exits
2 with "no question was answered this turn" and records nothing.

## Reviews

A session publishes an HTML page it made for the developer to review or choose from
(`agent-desk review "<title>" --page <file.html>`) and ends its turn. The page is shown in To
review, never in Needs you; nothing sounds or is pushed.

- **Rounds.** Publishing again with the same title (compared trimmed, ignoring case) in the same
  project (`project.dir`), while that review is not closed, is its next round: the saved state
  carries over, so the page shows the earlier answers under the same keys. A closed review's title
  starts a new review. Publishing holds `reviews/.publish.lock`, so two at once make one review.
- **The page as kept.** Copied into the store with the images it names by a relative path inlined as
  `data:` URIs: `<img src>`, `srcset` (on `<img>` and `<source>`), CSS `url()` in `<style>` and in
  `style=""`, outside scripts and comments. Only a file whose real path (symlinks resolved) is inside
  the page's own folder, and whose bytes say PNG, JPEG, GIF, WebP or AVIF (an SVG: named `.svg` and
  opening with its `<svg>` element). Anything else (remote, absolute, outside the folder, missing) is
  left as is, where the CSP blocks it, and listed on stderr. 25 MB at most after inlining.
- **Served** only as `GET /review/<id>` and `/review/<id>/raw`, with `Content-Security-Policy:
  sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
  img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none';
  frame-ancestors 'self'` (`REVIEW_CSP`, `src/server/security.ts`), `nosniff` and `no-referrer`:
  the page runs with no origin, reaches no network and nothing of the desk, and only the desk may
  frame it. It is never put inside the desk's own page.
- **The shim.** `/review/<id>` is the page with, right after its `<head…>` tag (or at its very start
  without one), `<script>window.__agentDeskReview=<state JSON, "<" as \u003c>;</script><script>`
  + `src/web/review-shim.js` + `</script>` (`reviewDocument`, `src/server/server.ts`; the service
  worker builds the same offline from `/raw` and the last state). The shim replaces `localStorage`
  with the saved state and `sessionStorage` with memory, posts `{ agentDesk: 1, type }` messages to
  its parent: `set`/`remove`/`clear` on each change, `copy` with what the page copies (clipboard,
  `execCommand("copy")`, `prompt(msg, text)`), `progress` with the text of
  `[data-agent-desk-progress]`, `scroll` (0..1), `notice` for an `alert` (one within 1.5 s of a copy
  is dropped) or a `confirm` (which returns false); `window.open` returns null. On `{ type:
  "collect" }` from its parent it clicks `[data-agent-desk-answers]`, or posts an empty copy. It
  scrolls to `#at=<0..1>` of its URL once loaded.
- **Saved state.** `POST /api/reviews/<id>/state` applies the page's operations in order under the
  review's lock, so two devices merge per key, the later write winning on a key both set; every
  accepted write adds 1 to `rev`. `data` ≤ 2 MB as UTF-8 JSON, a key ≤ 200 characters, `summary`
  ≤ 200 KB (an empty one clears it), the counter's text ≤ 200 characters, read as `12/97`, `12 of
  97` or `12 de 97` (any other text leaves the progress as it was).
- **Send.** `POST /api/reviews/<id>/send` builds its line itself, from the review's validated title,
  id, latest round and progress, never from the page's text:
  `Review «<title>» sent from agent-desk (round <n>, <d> of <t> reviewed). Read the answers with:
  agent-desk review <id>` for `session`, `Pick up the review «<title>» from agent-desk (round <n>,
  <d> of <t> reviewed): agent-desk review <id>` for `other` (without the count when there is no
  progress). `session` delivers it to the session that published the latest round as a message from
  the desk (its inbox and conversation), only while it takes messages; otherwise 409 with the
  reason (it ended, it is gone, or nothing takes messages now). Both record the send and a closed
  question of that session holding the developer's answers (`review: { id, round }`, text `Review
  «<title>», round <n>`, answer the text the page copied, cut at 20 000 characters, else the count):
  `decisions` and History show it, `unanswered` never opens it again, and a prompt typed over an
  undelivered line leaves it as it is.
- **Read.** `agent-desk review <id>` prints the review, its sends, the text the page copied and the
  saved state as JSON, and records `collected` when it runs in a registered session. Any session
  may read any review. A review is "sent, not read" while its latest send is newer than `collected`;
  Claude Code's adapter names those of the project, in three lines at most, in the context it gives
  a starting session.

## Plan limits

`planForecasts` (`src/core/limits.ts`) names a plan window only when it is a real risk: it runs out
before it resets (`fullAt`), or, for a long window, it ends at 85% or more (`atReset`). Windows have
no length in the protocol; a window's length is the shortest gap between the reset times of the
windows kept.

| Window | Pace (`pace`) |
| --- | --- |
| Short: under a day left and a length of a day or less, or unknown | `recent`: the rise over the last `max(30 min, time left / 5)` |
| Long, with finished windows covering two days or more | `usual`: (use so far + usual pace × length) / (time elapsed + length), where the usual pace is the finished windows' final percentages over their time, nights and pauses included; this window counts more as it goes on |
| Long, without them | `window`: the window's own average since it started (or since its first sample when its length is unknown), only once that covers two days |

Two hours of work right after a weekly reset therefore move the forecast a little, not to "full
tomorrow".

## Answers from the page

The page shows an answer box for a session only while it takes messages, and the server refuses
one otherwise, so a message never waits in an inbox for a later, unrelated turn. A session takes
them while a live listener exists for it (it waits), or while it works if its record says
`takesMessagesWhileWorking` and its process is alive. A permission prompt gets Allow and Deny while
the adapter's permission hook waits for it; its entry in the inbox is taken only by that hook. Its
two options are the answer that allows it and the one that denies it, in that order: the page sends
one of them, or, for a denial with a reason, the reason itself, which the hook takes as a denial (a
reason that reads as the allowing answer is sent as the plain denial). Any other question's option is
sent the moment it is clicked, verbatim, through the same route as typed text; a question that takes
several options sends the ticked ones, joined by `, `, with Send. A digit key only picks an option;
Enter sends it.

If the developer types in the terminal while the session waits, before the waiter has taken an
answer, the adapter withdraws it from the inbox and records the typed text as its probable answer;
typed while it works, both reach the session. When the session ends, the question is dismissed.

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
| `interpret "<text>"` | how the session understood the answer of the turn now running (see below) |
| `unanswered [--question <id>]` | the developer's reply did not answer the question: it opens again (see below) |
| `scan <project dir> [--if-older-than S]` | measures the project's checkouts with read-only git and a file walk; sizes are re-measured at most hourly |
| `review "<title>" --page <file.html>` | a review, or its next round (see Reviews); its images inlined |

What a session reads: `review <id>`, a review's answers and saved state (records it as read);
`reviews`, its project's reviews with id, title, round, progress and `open`, `sent, not read`,
`read` or `closed`; and `decisions [--search "<words>"] [--project <folder or name>] [--limit N]
[--permissions] [--dismissed] [--json]`, what its project already decided, newest first, so it does
not ask the developer again. It writes nothing.

- **A decision** is a closed question with an answer (`question` and `waiting` kinds), with its
  interpretation, or the `--decision` lines a session reported with a result, marked as decided by
  the session. A question opened again with `unanswered` is none until it is answered again.
  Permission prompts come with `--permissions`; questions closed without an answer (dismissed, or the
  session moved on) with `--dismissed`.
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
  headline, options, the answer verbatim (cut at 1000 characters, with the count of the rest; a
  probable one as `Answer (next message in the terminal):`) and the interpretation; then how many
  were left out. `--json` gives `{ decisions, total, projects, problems }` with the whole records
  (`answer.probable`).

Exit code 2 means the input was wrong (the message says which part and why); 1 means anything else.

## HTTP

The server binds 127.0.0.1 and refuses any request whose `Host` is not `127.0.0.1:<port>` or
`localhost:<port>`, that comes from an address other than loopback, or that carries a proxy's
headers (`Tailscale-*`, `X-Forwarded-*`, `Forwarded`, `Via`, `X-Real-IP`), except the configured
Tailscale host and login (`SECURITY.md`).

| Request | Purpose |
| --- | --- |
| `GET /` and `/app.js` with the modules it imports (`src/web/*.js`, each listed in `STATIC`), `/theme.js`, `/style.css`, `/favicon.svg` | the page; the secret is in a `<meta>` of `/` |
| `GET /api/state` | `DeskState`: every record (a closed question without its context; reviews without their saved state), plus `gone`, `listening`, `disk`, `planForecasts` (see Plan limits) and `problems`; gzip-compressed when the browser accepts it; answers 304 while nothing changed |
| `GET /api/events` | server-sent events: `changed` with the state's version (the ETag of `/api/state`) on opening and at each change, never the state itself; a `: ping` comment every 20 s; 32 streams at most (503 past them); a remote device's stream ends when its unlock does |
| `GET /api/sessions/<id>/messages` | the session's conversation, oldest first |
| `POST /api/sessions/<id>/read` | the developer read the session's conversation; its last message stops being new on every device |
| `POST /api/sessions/<id>/keys` `{ "action": "compact" \| "interrupt" \| "enter" \| "option-1"…"option-5" }` | sends those keys to the session's tmux pane (see `.claude/rules/security.md`) |
| `POST /api/sessions/<id>/unread` | its last message is new again on every device, until the session is opened |
| `POST /api/sessions/<id>/end` | sends SIGTERM to the session's own process, only while its pid still has the start time the session recorded (see `.claude/rules/security.md`) |
| `POST /api/sessions/<id>/forget` | takes a session that ended, or whose process is gone, off the desk at once: it is marked ended and read, what it still asked is dismissed (an answer waiting in its inbox too) and its results not seen yet are marked seen; its record, decisions and results stay in History until the archive moves them. Refused (400) while the session runs. Returns `{ session, dismissed, seen }` |
| `GET /api/push/key` | this install's VAPID public key, which the phone subscribes with |
| `POST /api/push/subscribe` (a `PushSubscription` as JSON), `POST /api/push/unsubscribe` `{ "endpoint": "…" }` | the phone that gets "N need you" when a question opens; only `https://*.push.apple.com`, `https://fcm.googleapis.com` and `https://updates.push.services.mozilla.com` endpoints are accepted |
| `GET /images/<id>` | a stored image, served with `Content-Security-Policy: default-src 'none'; sandbox` |
| `POST /api/images` (the image itself, `Content-Type: image/*`, 20 MB at most) | keeps an image pasted or picked on the page; returns `{ "id": "…" }` |
| `POST /api/questions/<id>/answer` `{ "text": "…", "images"?: ["<id>"] }` | answer from the page, with up to 10 attached images |
| `POST /api/questions/<id>/dismiss` | close without answering |
| `POST /api/sessions/<id>/message` `{ "text": "…", "images"?: ["<id>"] }` | message to a session that asked nothing: a reply while it waits, or a message while it works; kept in the history against its last message |
| `POST /api/results/<id>/seen`, `POST /api/seen` | mark one result, or everything, as seen |
| `GET /review/<id>`, `GET /review/<id>/raw` | a review's latest page, with the shim or without, only with `REVIEW_CSP` (see Reviews) |
| `GET /api/reviews/<id>/state` | `{ data, summary?, rev }` |
| `POST /api/reviews/<id>/state` `{ "ops": [{ "op": "set", "key", "value" } \| { "op": "remove", "key" } \| { "op": "clear" }], "progress"?: "12/97", "summary"?: "…" }` | applies the page's changes; returns `{ rev }`; 5 MB body at most |
| `POST /api/reviews/<id>/send` `{ "to": "session" \| "other" }` | returns `{ line }`; 409 `{ error }` when the session takes no message now |
| `POST /api/reviews/<id>/opened`, `POST /api/reviews/<id>/close` | first opened on the desk; leaves To review (stays in History) |

Every `POST` needs `Origin: http://127.0.0.1:<port>` (or `localhost`) exactly and the header
`X-Agent-Desk-Secret`; bodies are JSON, 64 KB at most, except an image and a review's state.

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
- **Saved copy on a device behind the PIN.** Every answer to an unlocked remote device carries
  `X-Agent-Desk-Unlock-Ends` (the unlock's end, ms since the epoch), and each saved copy keeps it.
  The worker deletes every copy when the desk answers locked (the PIN page, or 401 with
  `X-Agent-Desk-Locked`), when the push saying the PIN ended arrives, and when it finds a copy whose
  end has passed, which it never serves, offline or not. The page reloads at that end, so a device
  offline then is left with nothing to read. Images on that device carry `max-age` up to the end
  instead of a year, so the browser's own cache does not outlast the unlock either. This computer's
  answers carry no end, and its copy is kept.
