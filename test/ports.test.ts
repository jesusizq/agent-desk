import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandName, localHost, notAServer, sessionListeners, urlPort } from "../src/core/ports.ts";
import { procInfo } from "../src/core/proc.ts";
import { shellListener } from "./helpers.ts";

const self = () => ({ pid: process.pid, start: procInfo(process.pid)?.start ?? "" });
const mine = () => sessionListeners([self()])[0] ?? [];

describe("local servers of a session", () => {
  it("finds a port a process the session started through a shell listens on, and drops it when that process stops", async () => {
    const server = await shellListener();
    try {
      const found = mine().find((l) => l.port === server.port);
      assert.deepEqual([found?.url, found?.pid, found?.name], [`http://127.0.0.1:${server.port}/`, server.pid, "serve"]);
      assert.ok(Math.abs(Date.parse(found?.startedAt ?? "") - Date.now()) < 60_000, "started about now, from its process's start time");
    } finally {
      await server.stop();
    }
    assert.equal(mine().some((l) => l.port === server.port), false);
  });

  it("reaches a server listening on every address through localhost", async () => {
    const server = await shellListener("::");
    try {
      assert.equal(mine().find((l) => l.port === server.port)?.url, `http://localhost:${server.port}/`);
    } finally {
      await server.stop();
    }
  });

  it("leaves out a process the session did not start through a shell, and a process that is no longer the session's", async () => {
    const direct = await shellListener("127.0.0.1", false);
    try {
      assert.equal(mine().some((l) => l.port === direct.port), false, "a tool server run directly by the session's program");
      const other = await shellListener();
      try {
        assert.deepEqual(sessionListeners([{ pid: process.pid, start: "1" }]), [[]], "another process under a reused pid");
        assert.deepEqual(sessionListeners([{ pid: 2 ** 22 + 1 }]), [[]], "a process that is gone");
      } finally {
        await other.stop();
      }
    } finally {
      await direct.stop();
    }
  });

  it("reads addresses as /proc/net/tcp writes them, keeping only those a local URL reaches", () => {
    assert.equal(localHost("0100007F"), "127.0.0.1");
    assert.equal(localHost("00000000"), "localhost");
    assert.equal(localHost("0200007F"), undefined, "127.0.0.2: not a local URL's host");
    assert.equal(localHost("0710A8C0"), undefined, "192.168.16.7");
    assert.equal(localHost("00000000000000000000000000000000"), "localhost");
    assert.equal(localHost("00000000000000000000000001000000"), "localhost");
    assert.equal(localHost("0000000000000000FFFF00000100007F"), "127.0.0.1");
    assert.equal(localHost("0000000000000000FFFF00000710A8C0"), undefined);
    assert.equal(localHost("zz"), undefined);
    assert.equal(urlPort("http://localhost:5173/x"), 5173);
    assert.equal(urlPort("http://localhost/"), 80);
  });

  it("names a server after its command, not its interpreter", () => {
    assert.equal(commandName(["/usr/bin/python3", "-m", "http.server", "8772", "--bind", "127.0.0.1"]), "python3 -m http.server");
    assert.equal(commandName(["node", "/app/node_modules/.bin/vite"]), "vite");
    assert.equal(commandName(["node", "/app/node_modules/vite/bin/vite.js", "--port", "5173"]), "vite");
    assert.equal(commandName(["node", "/app/node_modules/.bin/next", "dev"]), "next dev");
    assert.equal(commandName(["node", "/app/node_modules/@storybook/cli/bin/index.js", "dev", "-p", "6006"]), "@storybook/cli dev");
    assert.equal(commandName(["node", "--watch", "src/server.ts"]), "server");
    assert.equal(commandName(["/usr/local/bin/hugo", "server", "-D"]), "hugo server");
    assert.equal(commandName([]), "");
  });
});

describe("what is not a server to open", () => {
  it("leaves out browsers a test drives and debugger ports, keeps dev servers", () => {
    for (const args of [["/opt/google/chrome/chrome", "--headless"], ["/home/u/.cache/ms-playwright/chromium-1/chrome-linux/headless_shell"], ["firefox"], ["node", "--inspect=9229", "server.js"], ["/usr/bin/x", "--remote-debugging-port=0"]]) {
      assert.equal(notAServer(args), true, args.join(" "));
    }
    for (const args of [["node", "node_modules/.bin/vite"], ["python3", "-m", "http.server", "8771"], ["next", "dev"]]) assert.equal(notAServer(args), false, args.join(" "));
  });
});

