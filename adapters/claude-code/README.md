# Claude Code adapter

Reports every Claude Code session on this machine to agent-desk through hooks, at no token cost
except the instructions added once per session (`instructions.md`), and delivers
answers given on the page back to the session that asked.

## What each hook does

| Event | Effect on the desk |
| --- | --- |
| `SessionStart` | registers the session (project, the repository's main checkout when it starts in a linked git worktree, see `docs/protocol.md`; terminal program, process ancestry); adds `instructions.md` to the session's context, and, when it starts again compacted or resumed (`source`: `compact`, `resume`), the handoff its last `PreCompact` recorded, labelled as the desk's with its time. With `source` `compact` it ends the compaction `PreCompact` started (`compacting`), marking the conversation with it, and leaves a session that was working at work when the compaction was not the developer's `/compact` (an automatic one comes mid-turn, and the turn goes on); any other start, and `UserPromptSubmit`, `Stop` and `SessionEnd`, end a compaction under way without marking it (cancelled or failed). A sub-agent compacting its own context fires it with the session's id and `agent_id`: then it does nothing |
| `UserPromptSubmit` | closes the session's open items, dismissing those the latest end replaced (the developer wrote: that end stands); the typed prompt is recorded as their probable answer (`probable`: it may be about something else), also replacing an answer given on the page that had not been delivered yet; the first prompt names the session until Claude Code gives it a title; a prompt typed while the session works is kept until the turn that took it in ends (the instructions ask the session to say how it applied each one). A prompt Claude Code submits itself is not the developer's and closes nothing: a message from another session (`<cross-session-message>`, sender its `from-name`) or from an agent of the session (`<agent-message>`, a sub-agent's hand-back report, sender the agent's record) joins the conversation without its envelope, as theirs; a background notice (`<task-notification>`, `<system-reminder>`, a local command's output) is left out. At `SessionStart`, once per store, such messages an older adapter recorded as the developer's are given back to their senders |
| `Stop` (synchronous) | the turn ended (`turnEndedAt`): the last message is kept on the session, shown quietly, and what Claude wrote between its tool calls (read from the end of the session's transcript) joins the conversation, as it also does after the session's tool calls; only when its last paragraph asks something (`?` outside quotes and code) does it wait in "Needs you" (replacing a question still open from an earlier turn once this end stands, held from Needs you until then, see below; except one the session opened again with `agent-desk unanswered`, which stays until answered and is not asked twice; a turn that asks nothing leaves that one open), titled with the sentences of that paragraph that ask, the rest of the paragraph opening its context, and with the options a list right after or right before the question offers, when it reads unambiguously as a choice (see `docs/protocol.md`, What needs the developer; a list closing the message under a question counts as asking), unless the model already asked with `agent-desk ask`, whose question then gets the message as its context (without a last paragraph that only repeats it), and replaces the same way; a `waiting` item a failing check left is never replaced here. With `stop_hook_active`, the turn's refusals so far are counted on the session (`checkReopened`), and the previous end, refused, keeps what it replaced and loses the item it asked; without it, the previous end stood and what it replaced goes |
| `Stop` (synchronous, also) | the latest code block of the turn (its last message, then what it wrote between its tool calls) whose content starts with `/compact ` becomes the session's `compactInstructions`, the rest of the block as one line (`compact.ts`), with the time it was read; a turn without one keeps the earlier suggestion. It stays while the developer writes again or answers from the desk (a session offers it once, and the compaction may come turns later) and is removed by `SessionStart` with `source` `compact` (a compaction has been done). The Terminal section's `/compact` button and `PreCompact` use it |
| `Stop`, `SubagentStop` (synchronous, also) | starts `agent-desk scan <project>` detached, at low priority: branches, commits ahead and behind, uncommitted changes and what runs in each checkout at most every minute, sizes at most every hour |
| `PreCompact` | marks the session compacting (`compacting`, with `trigger` `manual` for `/compact`, else `auto`); records the session's handoff (`handoffs/<session>.json`): its branches read again from git (5 s per command), unfinished agents, open questions, local servers and its project's open reviews, at most 3000 characters (`agent-desk status` prints the same, live). When the compaction was given no instructions (`custom_instructions` null or empty: every automatic one, and a bare `/compact`), its stdout, which Claude Code takes as the summary's instructions, is the session's latest suggested instructions (see `Stop`; one written earlier in a turn an automatic compaction cuts counts too); with none it prints nothing, so the project's compact instructions apply, and a compaction given its own instructions keeps them. A failure prints nothing on stdout and exits 1, which never blocks the compaction. A sub-agent's own compaction (`agent_id` set) gets nothing: no instructions, no handoff |
| `Stop` and `SessionStart` (`asyncRewake`) | `agent-desk-claude wait`: while the session waits, an answer given on the page wakes it with exit code 2 and the answer on stderr, verbatim, followed by the files of the images attached to it; `SessionStart` (startup, resume, clear) covers a session that has not finished a turn yet. Started by `Stop`, it also reads from the transcript how that end's Stop hooks finished (see below) |
| `PermissionRequest` | a permission item with the tool and its command or path, and options Allow and Deny; the hook then waits (up to 590 s) for a choice on the desk and returns it as Claude Code's decision ("Allow" allows; any other text denies and is given to Claude as the reason). If the prompt is settled in the terminal first, it returns no decision |
| `PermissionRequest` (`AskUserQuestion`) | one question per question of the dialog, with its options, instead of a permission item; a question the model also asked with `agent-desk ask` under the same text is replaced. Their context is what the session wrote in its turn before asking (read from its transcript, the latest 8000 characters, on the first question, as the terminal shows it above the dialog), then the options' descriptions. Once every one is answered on the desk, the hook returns them as the call's `answers` (`updatedInput`) and the terminal dialog closes. Answered in the terminal instead, the `PostToolUse` of the call closes them with the answers it returned |
| `PostToolUse`, `PostToolUseFailure`, `PermissionDenied` | settle the session's permission items, and record what the session or the sub-agent that made the call is doing (for a sub-agent whose call ran in a linked worktree of the session's project, `cwd`, or, working from outside one, whose call names a folder inside one (the file it reads or writes, the `path` it searches, a command's leading `cd` to a literal path), that worktree and the branch checked out there, read from git's files, unless the session reported one with `agent-desk agent --branch`) ("Edit: src/app.ts", marked `activityIsCall`: a tool call, not the session's words; a workflow's agent returning its result through `StructuredOutput` shows "Handed back its result" instead) and when, when its latest calls failed in a row (a successful call ends the streak), and whether the call started or awaits a job of its own (`run_in_background`, `Monitor`, `TaskOutput`, `BashOutput`, `ScheduleWakeup`, a `sleep` or `wait` command). `PostToolUse` starts the adapter while `.permission-open` or `.failing` (some streak of failures is open) exists in the store, after a call whose input names one of those jobs, and otherwise at most once every 3 s across all sessions (`.activity` stamp), so ordinary tool calls cost no process; a failed call always starts it, so failures are all counted and the call that ends them is never skipped |
| `PostToolUse`, `PostToolUseFailure` (`Agent`, `Task`) | the call's result settles its launch: the sub-agent it names (`tool_response.agentId`) is the one paired with that launch; a failed call (`error`) leaves a launch no sub-agent started failed, with the error as its activity (done, "Interrupted before it started", when interrupted). A background launch (`status: async_launched`) stays working until its sub-agent stops |
| `PostToolUse` (`deliver`) | while `.inbox-pending` exists in the store, hands the session the messages written to it on the desk while it works, as context it reads before its next step; a sub-agent's tool call leaves them |
| `Notification` (`elicitation_dialog`, `agent_needs_input`) | a question with the notification's text |
| `PreToolUse` (`Agent`, `Task`), `SubagentStart`, `SubagentStop` | one agent per launch, named after the description given to the Agent tool (for agents launched otherwise, such as a workflow's, the label Claude Code notes in `<session>/subagents/…/agent-<id>.meta.json`), with the prompt's opening sentence as its summary when it reads as one (a sentence of its own line, 4 words to 160 characters, no code, path, link, markup, label or role), and the sub-agent that launched it when one did; done when it stops, or when a turn starts or ends and its transcript ends interrupted (an interrupted agent gets no `SubagentStop`). A workflow's agent hands its result to the workflow, not to the session: at its `SubagentStop`, the result of its last turn's `StructuredOutput` call, read from the end of its transcript (`agent_transcript_path`), joins the conversation as that agent's report, one `key: value` line per field and a list as its items, and its activity becomes "Handed back its result". The session never registers one: `agent-desk agent` only adds to these records |
| `PostToolUse`, `PostToolUseFailure` (a sub-agent's), `SubagentStop` | the sub-agent's `tokens` and `costUsd` so far, summed from its transcript (see Cost) |
| `PreToolUse` (`SendMessage`) | a message to one of the session's sub-agents (`to` its id) works its record again, its activity the message's `summary` (else its first line), whether it resumes a stopped agent or redirects a running one; its `SubagentStart` and `SubagentStop` follow under the same id. Recorded before the message goes, so a resumed agent's stop always comes after it |
| `PostToolUse` (`Bash`) | a local HTML page the call opens in a browser (`xdg-open`, `open`, `python -m webbrowser`, a browser with its path or `file:` URL, not headless) is published as a review titled after its `<title>`, as `agent-desk review --page` publishes one, unless it lies outside the project, its worktrees and the temporary folder or under a folder of generated pages (`node_modules`, coverage and test reports, build output), loads scripts or styles from beside it, was published this turn already, or is unchanged since its review's latest round (see `docs/protocol.md`, Reviews); `PostToolUse` always starts the adapter for a `Bash` call that names an `.htm…` file, a `file:` URL or `webbrowser` |
| `PostToolUse` (`TaskStop`) | stopping a sub-agent (`task_type: local_agent`) ends its record, done with "Stopped by the session"; `PostToolUse` always starts the adapter for it |
| `UserPromptSubmit`, `Stop` | a record still open (working, waiting, blocked, idle) with no sub-agent behind it is done, "Not seen running": one that never followed a sub-agent (made by an earlier `agent-desk agent`) at either; at `Stop`, which lists what still runs in the background (`background_tasks`), also a launch no sub-agent took and a sub-agent no longer listed. A background sub-agent still listed stays, so does one a workflow still running launched (Claude Code lists the workflow, not its agents), and one a listed sub-agent launched |
| `SessionEnd` | the session ends; what was still open is dismissed |
| `SessionStart`, `UserPromptSubmit`, `Stop`, `PostToolUse` (`Write` into the handoff folders) | records the pending handoffs the session can load as resume notes (`resumes/<project>.json`, `source` `claude-code-handoffs`, read and written under its lock, only when they changed; one that cannot be read is reported and replaced, or removed when no handoff is pending): the `ahorro` plugin's files `<XDG_CACHE_HOME or ~/.cache>/claude-handoffs/<folder>/*.md` younger than 48 h, newest first, as `/ahorro:handoff-load` numbers them (a loaded one is renamed `.md.usado`). `<folder>` is named as the plugin's loader names it from git (read from git's files, symlinks resolved as git resolves them): the main checkout when git's common dir is its `.git` folder (from a subfolder or a linked worktree too), else the checkout itself (a bare repository's worktree, a submodule), or the folder itself outside git. The record belongs to that folder (`name` its name, `dir` the main checkout or checkout it is named after), not to the session's project: sessions in a repository and in its subfolders share one list, numbered as now, and each session names it (`resumesId`), so the page's filter of a subfolder's project shows it. A record an earlier version kept under a session's own project instead (a subfolder, a path through a symlink) numbers its handoffs as before a later load, so its `/ahorro:handoff-load 1` would load another one: when a session starts, from whichever folder of the repository, the adapter removes every other record of its own (its `source`, or none, as before the field) whose `dir` is named after the same folder, and leaves another adapter's records alone; only then, since these are leftovers of a migration and the walk reads every record and each one's git files, which a hung network mount would make every hook wait on. A record whose folder cannot be named for certain (a git file there unreadable for a reason other than its absence) is kept, with `stale list <id> not removed: …` on stderr; records the walk cannot read are not repeated there, since the page reports them. A record of another adapter filed under the same id as this one's (one keyed by the project's folder) is never removed or overwritten: its handoffs go unrecorded, one line on stderr says so. A Write into another project's folder shows there at that project's next hook. A turn interrupted after `/ahorro:handoff-load` runs no `Stop`: the next prompt drops the loaded one. Each note carries the first line after the heading naming the objective (`## Objetivo`, accents and case aside; else the first line with text), at most 200 characters, its file's modification time, when it stops being offered (48 h later), and `/ahorro:handoff-load`, followed by its number when there are several. Only the first 16 KB of a handoff are read and nothing else of it leaves the file; the folder is never written. `PostToolUse` always starts the adapter for a `Write` whose input names `/claude-handoffs/` |

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
button in the session panel. They also carry what resuming costs once the prompt cache has expired
(`coldResume`): the context's tokens at the model's cache-write price for the cache's lifetime
(`prompt_cache.ttl`), and the command that starts afresh: `/ahorro:handoff` when the `ahorro` plugin
is on in `enabledPlugins` of Claude Code's user settings (`settings.json` in `CLAUDE_CONFIG_DIR`,
else in the home folder's `.claude`, read only), else `/compact`, also when that file cannot be read
or is not valid JSON (caught mid-write, say), which the status line reports on stderr while it still
records the rest of the metrics. The page suggests it once the cache has expired on a large context,
and a session in tmux gets a button that types it (see the desk's README, *Send keys to a session*).

## Cost

Prices live in one table, `prices.ts`: the Claude API's first-party list prices per million tokens
(input, 5-minute and 1-hour cache writes, cache reads, output) and per web search
(`server_tool_use.web_search_requests`, $10 per 1,000), with the date they were read and their
source. A model not in the table, fast mode, a service tier other than `standard` or a region
other than global or US (1.1x, Claude 4.6 and later) gets no cost, only tokens, and so does an agent
whose transcript has a reply line that cannot be read (not JSON, or a usage that is not a count of
tokens). Each sub-agent's
tokens and cost are summed from the usage of its own transcript's replies (one request per message
id), at its tool calls and its `SubagentStop`; each hook reads only the lines written since the
last one, from where the adapter's note on the session (`notes/<session>/usage-<agent>.json`) says.
A transcript that cannot be read at all (`EACCES`, `EISDIR`) leaves both as last counted, up to the
same line, the reason told once per hook.

## Limits

- `SubagentStart` does not name the Agent call that launched it, and Claude Code writes its notes on
  the sub-agent (`<session>/subagents/…/agent-<id>.meta.json`, with the launch's `description`) only
  after that hook. The adapter pairs each start with the oldest unpaired launch of the same type,
  and corrects the pairing from the notes at the agent's first recorded tool call or at its stop,
  and from the call's result once it returns. Until then, launches of one type started together may
  show each other's names (verified 2026-10-29 with three agents launched in one message), and an
  agent launched otherwise (a workflow's) is named after its type (`workflow-subagent-3`); with the
  notes it takes its label's name.
- A background Agent call returns (`async_launched`, naming its sub-agent) as that sub-agent
  starts, so those hooks, the sub-agent's first calls and `agent-desk agent` run at once. Every
  change to which record follows which sub-agent is made under the session's agents lock and ends
  with one record per sub-agent id. Two records an earlier adapter left on one id become one when a
  turn starts or ends, under the launch's name and with what the session reported.
- Claude Code fires neither `PostToolUse` nor `PostToolUseFailure` for an Agent call refused at its
  permission prompt, denied by auto mode or cancelled while it runs (as its hooks documentation
  states; not verified here), and `PostToolUse` starts the adapter at most every 3 s. Launches left
  waiting for a start are settled when a turn starts or ends, from the call's result in the last
  1 MB of the session's transcript (a `tool_result` entry, with the Agent tool's `toolUseResult`
  beside it); a launch whose result is not there yet stays working until a later turn finds it.
- Those notes, a workflow run's journal and the transcript's entries are Claude Code's internal
  files, not a documented interface: if they move or change shape, the corrections stop, agents
  launched outside the Agent tool lose their goal and a workflow's agent that died stays open.
- `Stop`'s `background_tasks` (`id`, `type`: `subagent`, `workflow`…, `description`) lists only the
  tasks running in the background (read from Claude Code 2.1.322, not documented). Without it, the
  turn's end closes only records that never followed a sub-agent. A workflow's agents are not listed
  one by one: they stay open while any workflow runs, except one its run's journal
  (`<session>/subagents/workflows/<run>/journal.jsonl`, a `failed` entry with its `agentId`) marks
  failed, an agent that died on an API error and gets no `SubagentStop`: it ends failed, under the
  label the journal started it with unless its notes name it, at the next start or stop of any
  sub-agent of the session or at a turn's start or end (verified 2026-11-12 with an agent given a
  model that does not exist). A sub-agent addressed by a name rather than its
  id (`SendMessage`) is marked working by its own `SubagentStart` only.
- Claude Code shows the AskUserQuestion dialog in the terminal while the `PermissionRequest` hook
  waits (verified 2026-10-29), so it can be answered in either place. For permission prompts this is
  not documented and not verified here.
- An answer on the page reaches the session only while its `wait` hook runs: from the start of the
  session or the end of a turn until the developer types in the terminal or the session ends (at
  most 23 h). The page shows the answer box only then.
- Checks at a turn's end are Stop hooks that refuse it (`decision: "block"`). Claude Code runs all
  Stop hooks at once and writes, in order, a `hook_blocking_error` attachment per refusal (verified
  2026-11-18 with Claude Code 2.1.327), a `hook_system_message` attachment per `systemMessage` (read
  from 2.1.327's code: no Stop hook on this machine has shown one yet), and, once every synchronous
  one has finished, one `stop_hook_summary` row; a refused end goes on in the same turn, with
  `stop_hook_active: true` at its next `Stop`. The `Stop` hook then counts the turn's refusals
  (`checkReopened`): the larger of the count already on the session and the refused rounds in the
  transcript's last 1 MB, or one when `stop_hook_active` is the only trace left. The `wait` it starts
  reads the first summary written after the waiter started, and only that round, adding the earlier
  refusals counted on the session, and records nothing once a newer end of the turn has been
  recorded (that end has counted this one's refusal), and reads none once a newer turn waiter listens
  (`turn` on its listener; a permission prompt's or a dialog's hook does not count; a prompt typed
  mid-turn cuts its own round from the turn, so a round it found then could be a newer end's): a
  refusal there marks the session working again, dismisses a waiting item that end asked and shows again what it was to replace; any other ending lets the end
  stand, and what it asked then replaces the items still open from before it (only what that end
  marked, not what a newer end marked since). Every end that asks is settled: when no waiter reads
  its round (no `transcript_path`, a transcript that cannot be read, a waiter not armed in time), by
  the developer's prompt in the terminal (the end stands) or by the next `Stop` (refused with
  `stop_hook_active`, else it stood), never by an answer on the desk, which the waiter delivers also
  before the round is read or while a refused end goes on (a prompt reads that end's round from the
  transcript when it is there; what an end replaced shows again after 10 minutes with that end
  unsettled and no prompt or finished tool call of the main thread, as after an interrupt, which
  fires no `Stop`: a sub-agent's calls do not renew that clock, nor does one call running longer, and
  a prompt typed after it ran out, even about the item shown again, may be taken as the probable
  answer of the newer question); while its waiter
  reads the round its listener says so (`checks`), and the page says the checks run again only then
  (a reading the store cannot record is recorded again, as first read, at each poll, 120 times at
  most, about a minute, then the waiter says on its stderr that it gave up and stops reading);
  a turn refused
  earlier that now ends with a Stop hook's message to the developer has a check still failing, and
  gets the `checkFailing` item; a turn refused earlier that now ends silently has passed and clears
  both; a turn no Stop hook refused clears only the count, since it may be one the check skipped (no
  edits), and a message a Stop hook showed at its end joins the open `checkFailing` item's context,
  its title kept. A check that gives up without a message cannot be
  told from one that passed. Nor can a message from the check that refused be told from another Stop
  hook's: a `hook_system_message` names no command, so a Stop hook that shows a routine message at
  every end makes any end after a refusal read as failing.
- Finding the session's process and its terminal reads `/proc`, so it works on Linux only.
- A session in a worktree of a bare repository, or of one whose git folder lives elsewhere
  (`--separate-git-dir`), stays a project of its own: there is no main checkout to group it under.
  A main checkout reached through a symlink is grouped under its real path, while sessions started
  in it keep the symlinked one: two projects.
