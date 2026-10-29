# agent-desk: Product & Technical Specification

## 1. What it is

A local desk where one developer follows every AI coding session running on their machine, across
projects and across AI providers, and reaches the session that needs them in one click. It replaces
scrolling through several terminals to find a question an agent asked, a result it reported, or the
state of the agents it launched.

### The user

One developer who runs several AI coding sessions at once, often in different
projects, each session orchestrating many parallel sub-agents (worktrees, test slots, long
background runs). Messages from those sessions get lost in terminal feeds full of commands and
agent updates, and answering means finding the right terminal and scrolling back.

### Core functionality

- **Decisions first.** Every open question a session needs answered, oldest first, each with its
  project, session and options; the oldest is shown large as the next thing to do. It is answered
  on the desk (an option or free text, delivered at once and verbatim to the session that asked,
  while that session is waiting; a permission prompt is allowed or denied with a reason) or in the
  terminal, which one click brings to the front; the provider's own dialogs are answered there. Once
  answered, the question leaves the list and goes to the history with the answer given. A session at
  work can be written to from the desk too: the message reaches it at its next step, as what the
  developer types in its terminal mid-turn does.
- **Results with pictures.** What finished, with its summary and its screenshots shown inline
  (not as links), and the place to see it live (a local URL) when there is one.
- **Work in progress.** Per session: the agents running, what each one does, its branch and commit,
  how long it has run, what it waits for, and when it stopped or failed.
- **History.** Past decisions with their answers, past results, searchable.
- **Every project in one place,** with the session that needs the user most at the top.

### Principles

- **Provider-independent.** The desk knows nothing about any one AI tool. Sessions talk to it
  through a plain protocol (files and a small CLI, optionally a local HTTP API). Each provider gets
  a thin adapter (e.g. Claude Code hooks and a file watcher; another tool's equivalent).
- **The orchestrating session writes, its sub-agents do not.** Posting to the desk must cost a
  session almost nothing; sub-agents never carry the protocol in their context. Whatever can be
  recorded automatically (agent started, agent stopped) is recorded by the provider's hooks, not
  by the model.
- **Local and private.** Runs on the user's machine only, bound to 127.0.0.1, no account, no
  network calls, no telemetry, no third-party CDN; the developer's own devices reach it through
  their Tailscale tailnet when they enable it. Its data lives outside every project repository.
- **Never writes into the projects it follows** (no state files, no rules files, no commits).
- **Calm.** Only what needs the user is loud; everything else is one glance away.
