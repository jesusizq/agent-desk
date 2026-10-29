// Drives a headless Chrome through the DevTools protocol with Node's own WebSocket, so the page is
// tested in a real browser without a test dependency. Chrome comes from AGENT_DESK_CHROME or PATH.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CANDIDATES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
const WAIT_MS = 5000;
// A runner's first Chrome start, with a cold disk, takes several seconds.
const LAUNCH_MS = 30_000;

/** The Chrome to run, or null when this machine has none (the page tests are then skipped, never in CI). */
export function findChrome(): string | null {
  const chosen = process.env.AGENT_DESK_CHROME;
  if (chosen) return chosen;
  return CANDIDATES.find((name) => spawnSync("which", [name]).status === 0) ?? null;
}

type Message = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } };

export class Browser {
  private next = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
  private readonly listeners = new Map<string, (m: Message) => void>();

  private readonly proc: ChildProcess;
  private readonly ws: WebSocket;
  private readonly profile: string;

  private constructor(proc: ChildProcess, ws: WebSocket, profile: string) {
    this.proc = proc;
    this.ws = ws;
    this.profile = profile;
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data)) as Message;
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(new Error(`${p.method}: ${m.error.message}`));
        else p?.resolve(m.result);
      } else if (m.sessionId) this.listeners.get(m.sessionId)?.(m);
    });
  }

  static async launch(chrome: string): Promise<Browser> {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "agent-desk-chrome-"));
    // CI runners forbid the user namespaces Chrome's sandbox needs; the page under test is our own.
    const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--mute-audio"];
    if (process.env.CI) args.push("--no-sandbox");
    const proc = spawn(chrome, [...args, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString()));
    try {
      // Chrome writes its port and path to DevToolsActivePort in the profile once it listens.
      const portFile = path.join(profile, "DevToolsActivePort");
      const end = Date.now() + LAUNCH_MS;
      while (!fs.existsSync(portFile) || fs.readFileSync(portFile, "utf8").split("\n").length < 2) {
        if (proc.exitCode !== null) throw new Error(`${chrome} exited with ${proc.exitCode}:\n${err}`);
        if (Date.now() > end) throw new Error(`${chrome} did not open its DevTools port in ${LAUNCH_MS} ms:\n${err}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      const [port, wsPath] = fs.readFileSync(portFile, "utf8").split("\n");
      const url = `ws://127.0.0.1:${port}${wsPath}`;
      const ws = new WebSocket(url);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
      });
      return new Browser(proc, ws, profile);
    } catch (error) {
      // A Chrome left running would keep the test process alive.
      proc.kill("SIGKILL");
      throw error;
    }
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.next;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method }));
  }

  async newPage(width: number, height: number): Promise<Page> {
    const { targetId } = await this.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this, sessionId);
    this.listeners.set(sessionId, (m) => page.onEvent(m));
    await Promise.all(["Page.enable", "Runtime.enable", "Log.enable"].map((m) => page.send(m)));
    await page.resize(width, height);
    return page;
  }

  async close(): Promise<void> {
    // A graceful close, so Chrome's helper processes are done with the profile before it is removed.
    const exited = new Promise((resolve) => this.proc.once("exit", resolve));
    await Promise.race([this.send("Browser.close"), exited]).catch(() => {}); // the socket may close before the reply
    const killer = setTimeout(() => this.proc.kill("SIGKILL"), WAIT_MS);
    await exited;
    clearTimeout(killer);
    this.ws.close();
    fs.rmSync(this.profile, { recursive: true, force: true });
  }
}

export class Page {
  /** Uncaught exceptions, console errors and browser errors (CSP, failed loads), in order. */
  readonly errors: string[] = [];

  private readonly browser: Browser;
  private readonly sessionId: string;

  constructor(browser: Browser, sessionId: string) {
    this.browser = browser;
    this.sessionId = sessionId;
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.browser.send<T>(method, params, this.sessionId);
  }

  onEvent(m: Message): void {
    const p = m.params ?? {};
    if (m.method === "Runtime.exceptionThrown") {
      const d = p.exceptionDetails as { text: string; exception?: { description?: string } };
      this.errors.push(d.exception?.description ?? d.text);
    } else if (m.method === "Log.entryAdded") {
      const entry = p.entry as { level: string; text: string; url?: string };
      if (entry.level === "error") this.errors.push(`${entry.text} ${entry.url ?? ""}`.trim());
    } else if (m.method === "Runtime.consoleAPICalled" && p.type === "error") {
      this.errors.push((p.args as { value?: unknown; description?: string }[]).map((a) => String(a.value ?? a.description)).join(" "));
    }
  }

  resize(width: number, height: number): Promise<unknown> {
    return this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  }

  async goto(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
    await this.waitFor("document.readyState === 'complete'");
  }

  /** The value of an expression run in the page (awaited when it is a promise). */
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${expression}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  /** Waits until an expression is truthy in the page. */
  async waitFor(expression: string, ms = WAIT_MS): Promise<void> {
    const end = Date.now() + ms;
    while (!(await this.eval<boolean>(`!!(${expression})`))) {
      if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${expression}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** A real mouse click on the element's centre (the first match containing `text`, when given): it gives the page a user activation, as a person would. */
  async click(selector: string, text = ""): Promise<void> {
    const find = `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.getBoundingClientRect().width && el.getBoundingClientRect().height && el.textContent.includes(${JSON.stringify(text)}))`;
    await this.waitFor(find);
    const [x, y] = await this.eval<[number, number]>(`(() => {
      const el = ${find};
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    })()`);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const type of ["mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }

  /** A real key press. */
  async press(key: "Escape" | "Enter" | "ArrowLeft" | "ArrowRight"): Promise<void> {
    const code = { Escape: 27, Enter: 13, ArrowLeft: 37, ArrowRight: 39 }[key];
    for (const type of ["rawKeyDown", "keyUp"]) await this.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: code });
  }
}
