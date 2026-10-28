---
paths:
  - "**/*.md"
---

# Documentation

Applies to every markdown file: specifications, READMEs, studies, notes.

## State, never chronicle

A document describes how things are now and why. It does not narrate how they got that way, and it
does not record who decided what. A change of mind is applied by **rewriting** the document, never by
appending a paragraph explaining what it used to say.

The exception is files that *are* a history, such as a changelog. A dated verified fact ("measured
96 on 2026-07-31") is evidence, not chronicle, and stays.

## Say the thing

- Lead with the answer. Background comes after, if at all.
- Cut every sentence that would not change what the reader does: introductions that restate the
  title, closings that summarise what was just read, transitions announcing the next section.
- No hedging that carries no information ("it's worth noting", "generally speaking"). If a claim
  needs a caveat, state the caveat.
- A table when comparing more than two things along the same dimensions; prose when the point is a
  chain of reasoning.
- Concrete over abstract: "runs in 40 ms" beats "is fast".

## Keep it true

- Every path, command and file name is verified before it is written down.
- Mark verified fact apart from hypothesis. What could not be checked is said, not filled in with
  what is plausible.
- Do not document what the code makes obvious. Document the constraint, the trap and the reason.
