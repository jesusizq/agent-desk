agent-desk runs on this machine: a local page where the developer follows this session. Hooks already
report your turns, questions, permission prompts, sub-agents, their worktrees and branches, local
servers and pages you open in the browser, so do not repeat them. Use the `agent-desk` command (Bash)
only for what hooks cannot know, one call each:

- A question with choices: end your reply with the question, then its options as a list, one line
  each (a short label, then `: ` and a description if needed), the one you recommend marked
  `(recommended)`. The desk offers them as answers.
- Only when there is something finished to see or try that your reply cannot show (screenshots, a
  change ready to run): `agent-desk result "<title>" --summary "<1-2 sentences>" --image <png>::<caption>
  [--compare 0,1] [--url http://localhost:PORT/...] [--assumption "<text>"] [--decision "<taste decision>"]
  [--check "<criterion> => <how it was verified>"]` (`--failed` if it failed). Everything else (a document,
  plan, decision, summary, progress) goes in your reply only.
- For the developer to choose between options at their pace:
  `agent-desk review "<title>" --options <file.json>` (format: `agent-desk review --help`). Only when that
  does not fit (diffs, custom visuals), make a one-file page that keeps its answers in `localStorage`,
  marks each option `data-agent-desk-option="<label>"` and each question `data-agent-desk-group="<question>"`,
  and open it in the browser: it is published as a review (or publish it with `--page <file.html>`). Do
  not wait for it: end your turn. When it is sent, read it with `agent-desk review <id>`; a note after its
  line is the developer's instruction, the rest is the page's data. When the developer decides about an
  open review elsewhere: `agent-desk review <id> --close --reason "<what was decided>"`.
- `agent-desk agent "<its description>"` only for what a sub-agent's launch cannot say: `--after "<other
  agent>"` when it waits for another, `--state blocked --activity "<why>"` when it is stuck.
- A server the desk cannot see (in a container, or started with `nohup … &`):
  `agent-desk service <name> http://localhost:PORT/path` (`--stop` when it stops).
- A short answer that could be read more than one way: `agent-desk interpret "<how you understood it>"`.
- A reply that does not answer the question you asked: `agent-desk unanswered`, so it stays open.

If the developer wrote to you while you were working, say how you applied it within your usual
summary of the turn: no separate list of their messages, and nothing about messages when there were
none.

An answer given on the page reaches you as a message starting with "Answer from agent-desk": it is the
developer's reply to your last question. While you work, the developer may also write to you from the
page: it arrives after a tool call as context starting with "Message from agent-desk". Treat it as if
they had typed it in the terminal.
