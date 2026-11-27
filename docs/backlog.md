# Backlog

Work noticed and parked, with what is known so far. An item leaves this file when it is done or dropped.

## Autocorrect sometimes off in a session's reply box (iPhone)

- Seen by the owner in a session's view: "sometimes it does not correct". In a review of four static
  boxes (rv-mwyxhq0u-000546fc124) all four corrected well.
- The owner types with Microsoft SwiftKey (EN ES), which sometimes fails to load and Apple's keyboard
  shows instead; Apple's corrects only in the language it has on. Waiting for the owner to note which
  keyboard (and language) shows the next time it fails.
- If only Apple's: not the desk (add Apple's Spanish keyboard in Ajustes › General › Teclado).
- If SwiftKey too: suspect a redraw resetting the keyboard's context. Candidates: `move()` in
  src/web/dom.js falling back to insertBefore + focus + setSelectionRange without `moveBefore` (iOS
  Safari), the `live.value` write in onKept (src/web/answer.js), fitBox, attribute writes during a
  patch. Plan: a one-file review page with one box per operation on a timer plus a control, the owner
  marks which breaks, then fix that one with a page test.

## Server rules copied into the page

The page keeps its own copies of rules the server also holds, against the no-duplication rule; each
should move into a module both import, as `src/web/image-rules.js` does for images:
`answeredInTerminal` (src/web/state.js), the saved-replies limits (src/web/replies.js), `SEEN_IDS_MAX`
(src/web/result.js), the `REVIEW_*_MAX` limits, `REVIEW_NOTE_MAX`, `localUrl` and `reviewLine`
(src/web/review.js), and the dictation prompt's character rule (src/web/dictate.js).

## Page tests that fail under heavy load

page-arrivals "goes back into the needs pill by itself…" and dictation "stops a transcription that
does not answer in time…" fail now and then at a load average above ~20 and pass alone.

## A restored review tab counts as opened

- Any opening of a review marks it opened (`openedAt`), also a browser restoring a `#rv=` tab, so a
  terminal prompt after that answers it. Accepted for now.

## archive/ only grows

- `Store.archiveOlderThan` moves records and images to `archive/` in the store and nothing ever
  empties it, so it grows with every 60 days of use.
- The owner's store had no `archive/` folder on 2026-11-27 (its `images/`: 199 files, 68 MB).
- When it matters: a cap on its size or an age limit, deleting the oldest first. History and the
  past decisions read archived questions and sessions too (`Store.everyRecord`), so a limit on those
  shortens what they find.
