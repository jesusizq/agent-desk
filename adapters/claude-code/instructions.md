agent-desk runs on this machine: a local page where the developer follows this session. Hooks already
report your turns, permission prompts and sub-agents, so do not repeat them. Use the `agent-desk`
command (Bash) only for what hooks cannot know, and keep it to one call each:

- Before asking the developer something that may have been decided before (a convention, a design or
  product choice, a scope question): run `agent-desk decisions --search "<topic>"` first; if a past
  decision answers it, follow it without asking and say which one you reused (its date and answer).
- Ending a turn with a question that has clear choices: first run
  `agent-desk ask "<question>" --option "<A>" --option "<B>"`, then ask it in your reply as usual.
  A question asked with the AskUserQuestion tool is shown and answered on the page by itself: do not
  also run `agent-desk ask` for it.
- Only when there is something finished to see or try that your reply cannot show: screenshots, a
  page to open, a change ready to run. Everything else goes in your reply only, however finished it
  is: a document, plan or definition you wrote (say where it is), a decision, a summary, progress, a
  run relaunched, counts so far. `agent-desk result "<title>" --summary "<1-2 sentences>"
  --image <png>::<caption> [--compare 0,1] [--url http://localhost:PORT/...] [--assumption "<text>"]
  [--decision "<taste decision>"] [--check "<criterion> => <how it was verified>"]` (add `--failed` if it failed).
  It is refused without an `--image` or `--url`, unless it failed.
- Right after launching each sub-agent, in one call: `agent-desk agent "<the description you gave
  the Agent tool, or the label of a workflow's agent>" --summary "<one plain sentence: what it must deliver>"`, adding
  `--after "<other agent's description>"` and `--branch <name>` when they apply;
  `--state blocked --activity "<why>"` when one is stuck.
- A local server worth opening: `agent-desk service <name> http://localhost:PORT` (`--stop` when it stops).
- When a short answer could be read more than one way: `agent-desk interpret "<how you understood it>"`.
- If the developer's reply does not answer the question you asked (they wrote about something else): run `agent-desk unanswered`, so the question stays open on the desk and is not kept as a decision.

If the developer wrote to you while you were working, say how you applied it within your usual
summary of the turn: no separate list of their messages, and nothing about messages when there were
none.

An answer given on the page reaches you as a message starting with "Answer from agent-desk": it is the
developer's reply to your last question. While you work, the developer may also write to you from the
page: it arrives after a tool call as context starting with "Message from agent-desk". Treat it as if
they had typed it in the terminal.
