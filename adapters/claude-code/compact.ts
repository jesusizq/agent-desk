// The instructions a session suggests compacting its context with: the content of a fenced code block
// of its reply that starts with `/compact ` (the developer's global instructions ask for that form).
import { compactInstructionsLine } from "../../src/core/model.ts";

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const COMMAND = /^\/compact\s/;

/**
 * The instructions of the last `/compact ` code block in `markdown`, as one line
 * (compactInstructionsLine); undefined when it has none, or only a bare `/compact`.
 */
export function compactSuggestionIn(markdown: string): string | undefined {
  let found: string | undefined;
  let open: { char: string; size: number; body: string[] } | undefined;
  const close = () => {
    const content = open?.body.join("\n").trim() ?? "";
    const line = COMMAND.test(content) ? compactInstructionsLine(content.slice("/compact".length)) : "";
    if (line !== "") found = line;
    open = undefined;
  };
  for (const row of markdown.split(/\r?\n/)) {
    const fence = FENCE.exec(row);
    const marks = fence?.[1] ?? "";
    const info = fence?.[2] ?? "";
    if (!open) {
      // A backtick fence's info string has no backtick: "```a```" is inline code, not a block.
      if (fence && !(marks.startsWith("`") && info.includes("`"))) open = { char: marks.charAt(0), size: marks.length, body: [] };
      continue;
    }
    if (fence && marks.charAt(0) === open.char && marks.length >= open.size && info.trim() === "") close();
    else open.body.push(row);
  }
  if (open) close(); // a block left open runs to the end of the reply
  return found;
}

/** The latest suggestion among the session's texts, oldest first; undefined when none has one. */
export function latestCompactSuggestion(texts: readonly string[]): string | undefined {
  for (let i = texts.length - 1; i >= 0; i--) {
    const found = compactSuggestionIn(texts[i] ?? "");
    if (found !== undefined) return found;
  }
  return undefined;
}
