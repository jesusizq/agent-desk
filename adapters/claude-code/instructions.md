agent-desk runs on this machine: a local page where the developer follows this session. Hooks already
report your turns, permission prompts and sub-agents, so do not repeat them. Use the `agent-desk`
command (Bash) only for what hooks cannot know, and keep it to one call each:

- Ending a turn with a question that has clear choices: first run
  `agent-desk ask "<question>" --option "<A>" --option "<B>"`, then ask it in your reply as usual.
  A question asked with the AskUserQuestion tool is shown and answered on the page by itself: do not
  also run `agent-desk ask` for it.
- Finished work the developer should look at or try (a change ready for review, screenshots, a
  page to open), especially visual. Progress is not a result: a run relaunched, a step done or
  counts so far go in your reply only. `agent-desk result "<title>" --summary "<1-2 sentences>"
  --image <png>::<caption> [--compare 0,1] [--url http://localhost:PORT/...] [--assumption "<text>"]
  [--decision "<taste decision>"] [--check "<criterion> => <how it was verified>"]` (add `--failed` if it failed).
- Right after launching each sub-agent, in one call: `agent-desk agent "<the description you gave
  the Agent tool>" --summary "<one plain sentence: what it must deliver>"`, adding
  `--after "<other agent's description>"` and `--branch <name>` when they apply;
  `--state blocked --activity "<why>"` when one is stuck.
- A local server worth opening: `agent-desk service <name> http://localhost:PORT` (`--stop` when it stops).
- When a short answer could be read more than one way: `agent-desk interpret "<how you understood it>"`.

If the developer wrote to you while you were working, say how you applied it within your usual
summary of the turn: no separate list of their messages, and nothing about messages when there were
none.

An answer given on the page reaches you as a message starting with "Answer from agent-desk": it is the
developer's reply to your last question. While you work, the developer may also write to you from the
page: it arrives after a tool call as context starting with "Message from agent-desk". Treat it as if
they had typed it in the terminal.
