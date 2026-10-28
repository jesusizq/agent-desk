# Error handling

Loaded on every session: silent failure is the defect that survives longest, because nothing
reports it.

- Never swallow an error. An empty catch, a discarded return value or a bare "continue on failure"
  hides the defect and moves the symptom somewhere unrelated.
- Fail loudly and early at the edges: protocol files, CLI arguments, HTTP bodies, hook input,
  anything crossing a process boundary. Validate there, not three layers in.
- An error message states what failed, with which input, and what to do about it.
- Do not catch an error just to rethrow it unchanged. Either add context or let it travel.
- Suppressing an error is allowed only when it is the intended behaviour, and then the reason goes
  in a comment on that line.
- Never leave a partial mutation behind on failure: the operation undoes what it started or is safe
  to run again.
