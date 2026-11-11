// The options a review page marks (data-agent-desk-option, grouped by data-agent-desk-group) and what
// the developer did with each on the desk's controls (src/web/review-shim.js), kept in the review's
// saved state under one reserved key. Written inside the page's frame, so the page could forge them:
// they are the page's data, never the developer's own words.
import { CONTROL, fields, InputError, list, oneOf, optional, text } from "./check.ts";

/** The saved-state key the shim keeps the marks under. */
export const OPTIONS_KEY = "agent-desk:options";
export const OPTION_PICKS = ["choose", "iterate", "discard"] as const;
export const OPTION_GROUPS_MAX = 100;
export const OPTIONS_PER_GROUP_MAX = 100;
export const OPTION_LABEL_MAX = 200;
export const OPTION_NOTE_MAX = 2000;
/** What the marks read as, at most: it travels with a send and is shown whole before it. */
export const OPTIONS_TEXT_MAX = 32 * 1024;

export type OptionMark = { label: string; pick: (typeof OPTION_PICKS)[number]; note?: string };
/** `name`: the group's question, "" for the options marked outside any group; `none`: set (with its why, maybe "") when none of them fits. */
export type OptionGroup = { name: string; none?: string; options: OptionMark[] };
export type OptionMarks = { groups: OptionGroup[] };

/** A group's question or an option's label, as the page wrote it: one line. */
function oneLine(value: unknown, where: string, empty: boolean): string {
  const t = text(value, where, OPTION_LABEL_MAX);
  if (!empty && t.trim() === "") throw new InputError(`${where}: must not be empty`);
  if (CONTROL.test(t)) throw new InputError(`${where}: one line without control characters`);
  return t;
}

const note = (value: unknown, where: string) => text(value, where, OPTION_NOTE_MAX);

/** The marks as kept under OPTIONS_KEY: JSON, within its limits, each group and label once. */
export function readOptionMarks(raw: string, where = OPTIONS_KEY): OptionMarks {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new InputError(`${where}: not valid JSON (${(error as Error).message})`);
  }
  const f = fields(value, where);
  const groups = list(
    f.groups,
    `${where}.groups`,
    (g, w): OptionGroup => {
      const gf = fields(g, w);
      const options = list(
        gf.options ?? [],
        `${w}.options`,
        (o, ow): OptionMark => {
          const of = fields(o, ow);
          const mark: OptionMark = { label: oneLine(of.label, `${ow}.label`, false), pick: oneOf(OPTION_PICKS)(of.pick, `${ow}.pick`) };
          const n = optional(of.note, `${ow}.note`, note);
          return n === undefined || n.trim() === "" ? mark : { ...mark, note: n };
        },
        OPTIONS_PER_GROUP_MAX,
      );
      unique(options.map((o) => o.label), `${w}.options`);
      const none = optional(gf.none, `${w}.none`, note);
      return none === undefined ? { name: oneLine(gf.name, `${w}.name`, true), options } : { name: oneLine(gf.name, `${w}.name`, true), none, options };
    },
    OPTION_GROUPS_MAX,
  );
  unique(groups.map((g) => g.name), `${where}.groups`);
  const marks = { groups };
  const composed = describeMarks(marks);
  if (composed !== undefined && composed.length > OPTIONS_TEXT_MAX) throw new InputError(`${where}: the marks read longer than ${OPTIONS_TEXT_MAX} characters; shorten the notes`);
  return marks;
}

function unique(names: string[], where: string): void {
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) throw new InputError(`${where}: ${JSON.stringify(n)} twice`);
    seen.add(n);
  }
}

/**
 * What the developer did with the page's options, one line per mark, each saying its group, so a line
 * stands on its own: undefined when nothing is marked. Labels are quoted; a note's further lines are indented.
 */
function describeMarks(marks: OptionMarks): string | undefined {
  const lines: string[] = [];
  const said = (n: string) => n.trim().replace(/\r?\n/g, "\n    ");
  for (const g of marks.groups) {
    const at = g.name === "" ? "" : `[${g.name}] `;
    for (const o of g.options) {
      const label = JSON.stringify(o.label);
      if (o.pick === "choose") lines.push(`${at}Chosen: ${label}${o.note ? `: ${said(o.note)}` : ""}`);
      else if (o.pick === "iterate") lines.push(`${at}Iterate ${label}${o.note ? `: ${said(o.note)}` : ""}`);
      else lines.push(`${at}Discarded ${label}${o.note ? `: ${said(o.note)}` : ""}`);
    }
    if (g.none !== undefined) lines.push(`${at}None of these${g.none.trim() ? `: ${said(g.none)}` : ""}`);
  }
  return lines.length === 0 ? undefined : ["Options marked in the page:", ...lines].join("\n");
}

/** What a review's saved state says of its options, as a session reads it and the Send sheet shows it; undefined when nothing is marked. */
export function optionsText(data: Readonly<Record<string, string>>): string | undefined {
  const raw = data[OPTIONS_KEY];
  return raw === undefined ? undefined : describeMarks(readOptionMarks(raw));
}
