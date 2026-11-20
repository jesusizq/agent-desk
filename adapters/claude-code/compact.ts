// What a session's reply suggests the developer type in its terminal: the instructions to compact its
// context with (a fenced code block starting with `/compact `, the form the developer's global
// instructions ask for), and a shell command to run (a one-line block starting with `! `).
import { compactInstructionsLine, shellSuggestionLine } from "../../src/core/model.ts";

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const COMMAND = /^\/compact\s/;

/**
 * The instructions of the last `/compact ` code block in `markdown`, as one line
 * (compactInstructionsLine); undefined when it has none, or only a bare `/compact`.
 */
export function compactSuggestionIn(markdown: string): string | undefined {
  let found: string | undefined;
  for (const content of fencedBlocks(markdown)) {
    const line = COMMAND.test(content) ? compactInstructionsLine(content.slice("/compact".length)) : "";
    if (line !== "") found = line;
  }
  return found;
}

/**
 * The shell command of the last code block in `markdown` that is one line starting with `! ` (the
 * terminal's shell prefix), exactly as written (shellSuggestionLine); undefined when it has none.
 */
export function shellSuggestionIn(markdown: string): string | undefined {
  let found: string | undefined;
  for (const content of fencedBlocks(markdown)) {
    const line = content.includes("\n") ? "" : shellSuggestionLine(content);
    if (line !== "") found = line;
  }
  return found;
}

/** The trimmed contents of the fenced code blocks of `markdown`, in order. */
function fencedBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let open: { char: string; size: number; body: string[] } | undefined;
  const close = () => {
    blocks.push(open?.body.join("\n").trim() ?? "");
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
  return blocks;
}

/** The latest suggestion among the session's texts, oldest first; undefined when none has one. */
export function latestCompactSuggestion(texts: readonly string[]): string | undefined {
  for (let i = texts.length - 1; i >= 0; i--) {
    const found = compactSuggestionIn(texts[i] ?? "");
    if (found !== undefined) return found;
  }
  return undefined;
}
