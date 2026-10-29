import * as os from "node:os";
import * as path from "node:path";
import { id } from "../core/ids.ts";

export function storeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENT_DESK_HOME;
  if (override !== undefined && override !== "") {
    if (!path.isAbsolute(override)) throw new Error(`AGENT_DESK_HOME must be an absolute path, got ${JSON.stringify(override)}`);
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".cache", "agent-desk");
}

/** Every path the store uses; ids are validated before they become path segments. */
export class StorePaths {
  readonly home: string;
  constructor(home: string) {
    this.home = path.resolve(home);
  }
  get secret() { return path.join(this.home, "secret"); }
  /** scrypt hash of the PIN that unlocks remote access. */
  get pin() { return path.join(this.home, "pin.json"); }
  get seen() { return path.join(this.home, "seen.json"); }
  get sessionsDir() { return path.join(this.home, "sessions"); }
  get questionsDir() { return path.join(this.home, "questions"); }
  get resultsDir() { return path.join(this.home, "results"); }
  get servicesDir() { return path.join(this.home, "services"); }
  get metricsDir() { return path.join(this.home, "metrics"); }
  get agentsDir() { return path.join(this.home, "agents"); }
  get imagesDir() { return path.join(this.home, "images"); }
  get inboxDir() { return path.join(this.home, "inbox"); }
  /** Present while some inbox holds an entry: a cheap test for hooks that run on every tool call. */
  get inboxMarker() { return path.join(this.home, ".inbox-pending"); }
  get projectsDir() { return path.join(this.home, "projects"); }
  get messagesDir() { return path.join(this.home, "messages"); }
  messageDir(sessionId: string) { return this.inside(this.messagesDir, id(sessionId, "session id")); }
  message(sessionId: string, messageId: string) { return this.inside(this.messageDir(sessionId), `${id(messageId, "message id")}.json`); }
  project(projectId: string) { return this.inside(this.projectsDir, `${id(projectId, "project id")}.json`); }
  get archiveDir() { return path.join(this.home, "archive"); }
  /** Where a store file goes when archived: the same relative path under archive/. */
  archived(file: string) {
    const rel = path.relative(this.home, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`refusing to archive a path outside the store: ${file}`);
    return path.join(this.archiveDir, rel);
  }

  session(sessionId: string) { return this.inside(this.sessionsDir, `${id(sessionId, "session id")}.json`); }
  questionDir(where: "open" | "closed") { return path.join(this.questionsDir, where); }
  question(questionId: string, where: "open" | "closed") { return this.inside(this.questionDir(where), `${id(questionId, "question id")}.json`); }
  /** One lock per question, whichever folder it is in. */
  questionLock(questionId: string) { return this.inside(this.questionsDir, `${id(questionId, "question id")}.json`); }
  result(resultId: string) { return this.inside(this.resultsDir, `${id(resultId, "result id")}.json`); }
  service(serviceId: string) { return this.inside(this.servicesDir, `${id(serviceId, "service id")}.json`); }
  metrics(sessionId: string) { return this.inside(this.metricsDir, `${id(sessionId, "session id")}.json`); }
  agentDir(sessionId: string) { return this.inside(this.agentsDir, id(sessionId, "session id")); }
  agent(sessionId: string, name: string) { return this.inside(this.agentDir(sessionId), `${id(name, "agent name")}.json`); }
  sessionInbox(sessionId: string) { return this.inside(this.inboxDir, id(sessionId, "session id")); }
  inboxEntry(sessionId: string, questionId: string) {
    return this.inside(this.sessionInbox(sessionId), `${id(questionId, "question id")}.json`);
  }
  image(imageId: string, ext: string) { return this.inside(this.imagesDir, `${id(imageId, "image id")}.${ext}`); }

  private inside(dir: string, name: string): string {
    const full = path.resolve(dir, name);
    if (!full.startsWith(this.home + path.sep)) throw new Error(`refusing a path outside the store: ${full}`);
    return full;
  }
}
