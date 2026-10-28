# agent-desk — Project brief

## 1. Purpose

agent-desk is a local desk for a developer who runs several AI coding sessions at once, often in
different projects and with different providers, each session orchestrating many sub-agents. It
gathers in one place everything those sessions need from the developer and everything they have to
show, and it takes the developer to the right terminal in one click.

## 2. Problems to solve

### Visibility and answering
- Questions and results from a session are lost in the terminal feed, between commands, sub-agent
  updates and notifications. Finding them means scrolling back or asking again.
- With several projects open, checking each one means switching terminals.
- Remote notifications (e.g. a chat bot) only inform: they cannot be answered and they are not a
  place to work from.
- A short answer can be misread by the session. The interpretation should be visible and
  confirmable.
- A click must lead to the session that asked, and an answer must never reach the wrong session;
  projects and sessions need an unambiguous identity (name, folder, provider, terminal).

### Coordinating many agents
- Sub-agents get blocked (permission refusals, sandbox guards, full disk) and the developer only
  learns it if the orchestrating session relays it.
- A working agent, a stuck one, an idle one and one waiting on its own background job look the same.
- Agents depend on each other (one waits for another's commit, one must rebase onto another's
  work); those chains are tracked by hand.
- Which branch or commit holds which change, what is already integrated, what awaits review and what
  reached the main branch is kept in hand-written state files.
- Messages sent while a session is working may change its plan; whether and how each was applied is
  not visible.

### Reviewing results
- Results are often visual: contact sheets, before/after pairs, variants, desktop and phone. They
  need inline images, side-by-side comparison and zoom, not a list of file paths.
- Running previews (local servers on several ports) are hard to keep track of: which are up, for
  which project, at which URL.

### Continuity and resources
- After an unattended period there is no single summary of what finished, what failed and what is
  waiting for a decision.
- Decisions made in conversation are scattered and get asked again the next day or in the next
  session. They should be kept with their date and reason, per project.
- Changes to rules files (CLAUDE.md, rules, skills) require explicit approval; they are decisions too.
- Temporary directories are wiped on reboot and context is compacted; the state needed to resume is
  kept in hand-written handoff files.
- Worktrees and build folders accumulate until the disk fills up and agents fail mid-run, without any
  early warning.
- Context size, plan usage and token cost per session and agent inform when to compact, stop, resume
  or start fresh, but are only visible inside each terminal.

## 3. Scope

- **Needs you.** Open questions and permission prompts from every session, oldest first, each with
  its project and session and a "Go to session" link that brings its terminal to the front.
  Pending approvals (rules files, deletions) are questions too. A waiting session can be answered on
  the desk (an option or free text, delivered at once), and a permission prompt allowed or denied
  there while the provider's permission hook waits for it.
- **Results.** Summary, inline screenshots with side-by-side comparison and zoom, and the local URL to
  see the result live.
- **Running.** Per session: agents, their goal, current activity, branch and commit, elapsed time,
  state (working, waiting, blocked, done, failed) and what each one waits for. A blocked agent says
  in one line which agent it waits for; the session view draws the dependencies as a small
  left-to-right flow, only when the session reported any.
- **Session header.** For each session, the same information its terminal status line shows: model
  and reasoning effort; project and branch; context used; plan usage windows with time to reset;
  agents running with their activity, elapsed time and tokens; prompt-cache time left; permission
  mode; background shells.
- **Live services.** Local servers and background jobs per project, with their URLs.
- **Decision log and history.** Every question with its answer, date and the session's
  interpretation; past results; searchable.
- **While you were away.** One view of what happened since the developer last looked.
- **Early warnings.** Disk and worktree growth per project, contexts close to full.
- **Session control.** Suggest the right terminal command at the right time (e.g. compact when the
  context is nearly full), ready to copy; direct control through tmux (see §4).

## 4. Architecture

- **Provider-independent core.** Protocol, store, server and page know nothing about any provider.
  Each provider gets a thin adapter under `adapters/<provider>/`.
- **Writers.** Only the orchestrating session posts, through a small CLI; sub-agents never carry the
  protocol. Whatever the provider can report by itself is recorded by the adapter through the
  provider's hooks, at no cost to the model: agent started or stopped, status-line data, and the
  session waiting for input or showing a permission prompt, with its text (for Claude Code, the
  `Stop` and `Notification` hooks), and the prompt the developer then types (`UserPromptSubmit`),
  which closes the question and records the answer in the history. Those hooks fill and empty
  "Needs you" on their own; the CLI adds what only the model knows, such as options, results,
  their screenshots and which agent waits for which (reported once, when the agent is launched).
- **Session metrics.** The adapter tees the data the provider already hands its status line (Claude
  Code passes a JSON document to the status-line command on every refresh) into the store. Fields are
  optional per provider. The developer wraps their own status-line command with the adapter's
  (`adapters/claude-code/README.md`); the desk never edits the provider's settings.
- **Going to the session.** The adapter records where each session runs: for VS Code, the
  workspace folder and the process of its integrated terminal. "Go to session" is a `vscode://`
  link handled by a small VS Code extension that brings that terminal to the front. The desk runs
  nothing itself: the browser hands the link to VS Code, which also works on GNOME under Wayland,
  where one program cannot raise another's window. This is the riskiest part and is proven first.
- **Answers back.** An answer is written to the asking session's inbox and delivered at once,
  verbatim. The adapter waits for it while the session waits for input and hands it over in the
  provider's own way: for Claude Code, a background hook (`asyncRewake`), started when the session
  starts and at the end of each turn, that wakes the model with the answer, at no token cost while
  waiting. The desk offers an answer box only while
  such a waiter runs.
- **Session control.** Terminal commands such as `/compact` are executed by the terminal, not by the
  model, so an answer cannot trigger them. Sessions that run inside `tmux` record their pane; the
  desk sends them keys from a fixed list (`/compact`, Escape, Enter, 1–5), after a confirming second
  click, only to a live registered session whose pane hosts its process. Elsewhere the desk suggests
  the command with a copy button. Launching sessions through a provider SDK is noted as an
  alternative and not pursued.
- **From a phone.** Tailscale Serve publishes the desk on the developer's tailnet (HTTPS, never
  Funnel) while the server stays on 127.0.0.1 and accepts that host only with the developer's
  Tailscale login. "Go to session" is hidden there; answering works.
- **Store.** `~/.cache/agent-desk/` (override with `AGENT_DESK_HOME`): sessions, questions, answers,
  results and copied images; atomic writes; never inside a project repository.
- **Adapters as product artifacts.** Their source lives in this repository (`adapters/claude-code/`:
  hooks and the instructions a session follows; `adapters/vscode/`: the extension that focuses a
  session's terminal). Installing them targets the developer's global configuration (`~/.claude/`,
  the user's VS Code extensions), never the projects being followed, and only with explicit approval.
- **Stack (proposal).** TypeScript on Node with the standard `http` module and a static HTML/CSS/JS
  page, no framework.

## 5. Security

The desk turns clicks into text delivered to AI sessions, so everything it shows is untrusted and
everything it sends is a command. Rules in `.claude/rules/security.md`: bound to 127.0.0.1, protected
against DNS rebinding and CSRF, no command execution beyond the allow-listed tmux keys, strict path
handling, sanitised rendering, no remote assets, minimal pinned dependencies. Links to sessions only
focus a registered session's terminal; they never type into it or run anything.

## 6. Plan

All steps are built (`README.md`, `docs/protocol.md`).

1. **Clickable mock** with realistic content (several decisions, results with screenshots, a dozen
   agents across two projects, session headers), reviewed before any real code.
2. **Spike: go to the session** with Claude Code in VS Code (desk link → VS Code extension → the
   asking session's terminal in front), in one VS Code window with several terminals, on GNOME
   under Wayland.
3. **Protocol, store and CLI** with tests (concurrency, partial writes, malformed input).
4. **Real page.**
5. **Claude Code adapter and VS Code extension** (hooks, status-line tee, session instructions,
   terminal focus), installed globally with approval.
6. **Answering from the desk** (page → inbox → session receives the answer at once).
7. **Session control through `tmux`**, with its own security review, and phone access over
   Tailscale.

## 7. Open questions

- Name (provisional: agent-desk).
- Browser only, or also a terminal view?
- A flow per project that also links sessions (one session waiting for another's commit).
