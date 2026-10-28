#!/usr/bin/env node
// agent-desk command line: what a session posts to the desk, and the desk server itself.
import * as os from "node:os";
import { createInterface } from "node:readline";
import * as path from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { InputError, localUrl, nonEmpty, oneOf } from "../core/check.ts";
import { id, slug } from "../core/ids.ts";
import { AGENT_STATES, type Agent } from "../core/model.ts";
import { ancestors, isAlive } from "../core/proc.ts";
import { storeHome } from "../store/paths.ts";
import { Store } from "../store/store.ts";

const USAGE = `agent-desk — a local desk for every AI coding session

Posting (from a session; the session is found from the calling process, or --session ID):
  agent-desk ask "<question>" [--option "<text>"]... [--context "<text>"]
  agent-desk result "<title>" [--summary "<text>"] [--image <path>[::caption]]... [--compare <i>,<j>]
                    [--url http://localhost:PORT/...] [--failed] [--assumption "<text>"]...
                    [--decision "<text>"]... [--check "<criterion> => <how it was verified>"]...
  agent-desk agent "<name or description>" [--summary "<what it must deliver>"] [--goal "<text>"] [--state ${AGENT_STATES.join("|")}]
                    [--activity "<text>"] [--branch <name>] [--commit <sha>] [--after "<name>"]...
  agent-desk service <name> <http://localhost:PORT/...>    agent-desk service <name> --stop
  agent-desk interpret "<how the latest answer was understood>"

Reading and serving:
  agent-desk needs            open questions, oldest first
  agent-desk pin               set the PIN that unlocks the desk from other devices (asked twice, not echoed)
  agent-desk scan <project dir> [--if-older-than SECONDS]
                              measure the project's worktrees (size, branch, merged into the main branch)
  agent-desk serve [--port N] the desk at http://127.0.0.1:N (default 7420, or AGENT_DESK_PORT)

Data lives in ~/.cache/agent-desk (override with AGENT_DESK_HOME).`;

type Command = (args: string[], store: Store) => void | Promise<void>;

const COMMANDS: Record<string, Command> = {
  ask(args, store) {
    const { values, positionals } = parse(args, { option: { type: "string", multiple: true }, context: { type: "string" } }, 1);
    const q = store.ask({
      sessionId: resolveSession(store, values.session),
      kind: "question",
      text: nonEmpty(positionals[0], "question"),
      ...(values.context === undefined ? {} : { context: values.context }),
      options: values.option ?? [],
    });
    print(`asked ${q.id}`);
  },

  result(args, store) {
    const { values, positionals } = parse(
      args,
      {
        summary: { type: "string" },
        image: { type: "string", multiple: true },
        compare: { type: "string" },
        url: { type: "string" },
        failed: { type: "boolean" },
        assumption: { type: "string", multiple: true },
        decision: { type: "string", multiple: true },
        check: { type: "string", multiple: true },
      },
      1,
    );
    const r = store.addResult({
      sessionId: resolveSession(store, values.session),
      title: nonEmpty(positionals[0], "title", 300),
      status: values.failed ? "failed" : "ok",
      ...(values.summary === undefined ? {} : { summary: values.summary }),
      ...(values.url === undefined ? {} : { url: localUrl(values.url, "--url") }),
      images: (values.image ?? []).map(splitCaption),
      ...(values.compare === undefined ? {} : { compare: parsePair(values.compare) }),
      assumptions: values.assumption ?? [],
      decisions: values.decision ?? [],
      checks: (values.check ?? []).map(parseCheck),
    });
    print(`posted ${r.id}${r.images.length ? ` with ${r.images.length} image(s)` : ""}`);
  },

  agent(args, store) {
    const { values, positionals } = parse(
      args,
      {
        goal: { type: "string" },
        summary: { type: "string" },
        state: { type: "string" },
        activity: { type: "string" },
        branch: { type: "string" },
        commit: { type: "string" },
        after: { type: "string", multiple: true },
      },
      1,
    );
    const name = slug(nonEmpty(positionals[0], "agent name"));
    const fields: Partial<Omit<Agent, "sessionId" | "name">> = {};
    if (values.goal !== undefined) fields.goal = values.goal;
    if (values.summary !== undefined) fields.summary = values.summary;
    if (values.state !== undefined) fields.state = oneOf(AGENT_STATES)(values.state, "--state");
    if (values.activity !== undefined) fields.activity = values.activity;
    if (values.branch !== undefined) fields.branch = values.branch;
    if (values.commit !== undefined) fields.commit = values.commit;
    if (values.after !== undefined) fields.after = values.after.map(slug);
    const agent = store.upsertAgent(resolveSession(store, values.session), name, fields);
    print(`agent ${agent.name}: ${agent.state}`);
  },

  service(args, store) {
    const { values, positionals } = parse(args, { stop: { type: "boolean" } }, 2);
    const sessionId = resolveSession(store, values.session);
    const name = nonEmpty(positionals[0], "service name", 200);
    if (values.stop) {
      if (!store.removeService(sessionId, name)) throw new InputError(`no service named ${JSON.stringify(name)} in this session`);
      print(`service ${name} removed`);
      return;
    }
    const s = store.addService({ sessionId, name, url: localUrl(positionals[1], "service url") });
    print(`service ${s.name}: ${s.url}`);
  },

  interpret(args, store) {
    const { values, positionals } = parse(args, {}, 1);
    const q = store.interpret(resolveSession(store, values.session), nonEmpty(positionals[0], "interpretation"));
    print(`interpretation recorded on ${q.id}`);
  },

  needs(args, store) {
    parse(args, {}, 0);
    const sessions = new Map(store.listSessions().map((s) => [s.id, s]));
    const open = store.openQuestions();
    if (open.length === 0) return print("Nothing needs you.");
    for (const q of open) {
      const s = sessions.get(q.sessionId);
      print(`${q.askedAt.slice(11, 16)}  ${s?.project.name ?? "?"} · ${s?.title ?? q.sessionId}\n  ${q.text.split("\n")[0]}`);
    }
  },

  async pin(args, store) {
    parse(args, {}, 0);
    const first = await askHidden("New PIN (6 digits or more): ");
    const again = await askHidden("Repeat it: ");
    if (first !== again) throw new InputError("the two PINs differ; nothing changed");
    const { setPin } = await import("../server/remote-unlock.ts");
    setPin(store.paths.pin, first);
    print("PIN saved. Devices reaching the desk through the tailnet must enter it; each unlock lasts 12 hours.");
  },

  async scan(args, store) {
    const { values, positionals } = parse(args, { "if-older-than": { type: "string" } }, 1);
    const dir = path.resolve(nonEmpty(positionals[0], "project dir", 4096));
    const { projectId, scanProject } = await import("../project/scan.ts");
    const previous = store.getProjectScan(projectId(dir));
    const maxAge = values["if-older-than"] === undefined ? 0 : Number(values["if-older-than"]);
    if (!Number.isFinite(maxAge) || maxAge < 0) throw new InputError(`--if-older-than: expected seconds, got ${values["if-older-than"]}`);
    if (previous && Date.now() - Date.parse(previous.measuredAt) < maxAge * 1000) return print(`${previous.name}: measured ${previous.measuredAt}, still fresh`);
    os.setPriority(19); // a background measurement must not slow the machine down
    const release = store.claimScan(projectId(dir));
    if (!release) return print(`${path.basename(dir)}: another scan is running`);
    try {
      const scan = store.putProjectScan(await scanProject(dir, previous));
      print(`${scan.name}: ${scan.worktrees.length} checkout(s), ${(scan.totalBytes / 1e9).toFixed(1)} GB`);
    } finally {
      release();
    }
  },

  async serve(args, store) {
    const { values } = parse(args, { port: { type: "string" } }, 0);
    const port = Number(values.port ?? process.env.AGENT_DESK_PORT ?? 7420);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new InputError(`--port: expected 1024-65535, got ${values.port}`);
    const { startServer } = await import("../server/server.ts");
    await startServer(store, port);
  },
};

const SESSION_OPTION = { session: { type: "string" } } as const;

function parse<O extends NonNullable<ParseArgsConfig["options"]>>(args: string[], options: O, maxPositionals: number) {
  const parsed = parseArgs({ args, options: { ...SESSION_OPTION, ...options }, allowPositionals: true, strict: true });
  if (parsed.positionals.length > maxPositionals) {
    throw new InputError(`unexpected argument ${JSON.stringify(parsed.positionals[maxPositionals])}; quote text that contains spaces`);
  }
  return parsed;
}

/**
 * The calling session: --session, AGENT_DESK_SESSION, or the registered live session whose
 * process is an ancestor of this one (a session's commands run as its descendants).
 */
function resolveSession(store: Store, flag: string | undefined): string {
  const explicit = flag ?? (process.env.AGENT_DESK_SESSION || undefined);
  if (explicit !== undefined) {
    const sessionId = id(explicit, "--session");
    if (!store.getSession(sessionId)) throw new InputError(`no session ${sessionId} in the store`);
    return sessionId;
  }
  const mine = new Set(ancestors(process.pid).map((p) => p.pid));
  const found = store
    .listSessions()
    .filter((s) => s.state !== "ended" && s.process && mine.has(s.process.pid) && isAlive(s.process.pid, s.process.start));
  if (found.length === 1 && found[0]) return found[0].id;
  if (found.length > 1) throw new InputError(`several sessions match this process (${found.map((s) => s.id).join(", ")}); pass --session ID`);
  throw new InputError("this command does not run inside a registered session; pass --session ID (the session registers when its first hook runs)");
}

/** Lines piped to stdin, read once and handed out in order (for scripts that set the PIN). */
let pipedLines: AsyncIterator<string> | undefined;

/** Reads one line without echoing it when typed at a terminal; from a pipe, reads the next line. */
async function askHidden(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const input = process.stdin;
  if (!input.isTTY) {
    pipedLines ??= createInterface({ input })[Symbol.asyncIterator]();
    const next = await pipedLines.next();
    process.stderr.write("\n");
    if (next.done) throw new InputError("no PIN given on stdin");
    return next.value;
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new InputError("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.setRawMode(true);
    input.on("data", onData);
    input.resume();
  });
}

function splitCaption(value: string): { path: string; caption?: string } {
  const at = value.indexOf("::");
  return at < 0 ? { path: value } : { path: value.slice(0, at), caption: value.slice(at + 2) };
}

function parsePair(value: string): { before: number; after: number } {
  const m = /^(\d+),(\d+)$/.exec(value);
  if (!m) throw new InputError(`--compare: expected two image indexes such as 0,1, got ${JSON.stringify(value)}`);
  return { before: Number(m[1]), after: Number(m[2]) };
}

function parseCheck(value: string): { criterion: string; verification: string } {
  const at = value.indexOf("=>");
  if (at < 0) throw new InputError(`--check: expected "<criterion> => <how it was verified>", got ${JSON.stringify(value)}`);
  return { criterion: value.slice(0, at).trim(), verification: value.slice(at + 2).trim() };
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

export async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    print(USAGE);
    return name === undefined ? 2 : 0;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    process.stderr.write(`agent-desk: unknown command ${JSON.stringify(name)}\n\n${USAGE}\n`);
    return 2;
  }
  try {
    await command(args, new Store(storeHome()));
    return 0;
  } catch (error) {
    const usage = error instanceof InputError || (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS"));
    process.stderr.write(`agent-desk ${name}: ${(error as Error).message}\n`);
    return usage ? 2 : 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
