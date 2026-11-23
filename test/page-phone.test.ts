// The page in a real headless Chrome, over the demo store: phones, the strip, pictures and desktop windows.
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Store } from "../src/store/store.ts";
import { arrived, base, browser, fetchNow, LOW_DISK, open, openDialogs, openPhone, openResultOf, ownPhone, pages, planWindows, setupPage, sickMachine, SKIP, STILL, store, touch, touchPanel, underFinger, worktrees } from "./page-harness.ts";
import { serve, tempHome } from "./helpers.ts";
import { type Page } from "./browser.ts";

describe("page: phones, the strip, pictures and desktop windows", SKIP, () => {
  setupPage();


  it("on a phone, marks seen with a tap in sight on To review only what it lists: no failure, no other project's result", async () => {
    await ownPhone(async (page, own) => {
      await page.tap("#projects button", "web-shop");
      await page.tap(".tabbar button", "To review");
      await page.waitFor(`document.querySelectorAll('.col-review .rtile-wrap').length === 2 && ${STILL}`);
      const needs = "document.querySelector('.tabbar .tcount.accent')?.textContent";
      const waiting = await page.eval<string>(needs);
      const button = "[...document.querySelectorAll('.col-review .col-head button')].find((b) => b.textContent === 'Mark all as seen')";
      await page.waitFor(button);
      for (const [where, y] of [["its top", "r.y + 1"], ["its middle", undefined], ["its bottom", "r.bottom - 1"]] as const) {
        assert.equal(await page.eval<boolean>(underFinger(button, y)), true, `in sight, ${where} under the finger`);
      }
      assert.ok((await page.eval<number>(`${button}.getBoundingClientRect().height`)) >= 44, "a finger's height");
      await page.tap(".col-review .col-head button", "Mark all as seen");
      await page.waitFor("!document.querySelector('.col-review .rtile-wrap')");
      assert.equal(await page.eval<boolean>("!!document.querySelector('.col-review .rv-tile')"), true, "the reviews stay: only results are marked seen");
      assert.deepEqual(
        own.listResults().filter((r) => !r.seenAt).map((r) => r.title).sort(),
        ["Checkout e2e: failed, disk full", "Migration 0041 applied locally"],
        "the failure waits in Needs you, and invoices-api's result was not shown",
      );
      assert.equal(own.getSeen(), undefined, "nothing else is marked seen");
      assert.equal(await page.eval<string>(needs), waiting, "Needs you still counts the failure");
      await page.tap("#projects button", "All");
      await page.waitFor("[...document.querySelectorAll('.col-review .rtile-wrap')].map((t) => t.textContent).join(' ').includes('Migration 0041')");
    });
  });

  it("on a phone, draws the strip's chips one height, each whole in its border, each button a finger's reach, and fades the edge that hides more", async () => {
    await ownPhone(
      async (page) => {
        const chips = "[...document.querySelectorAll('#strip > .chip')]";
        await page.waitFor(`${chips}.length >= 3 && document.querySelector('#strip .alerts-chip') && document.getElementById('strip').textContent.includes('5 h limit')`);
        const shape = await page.eval<{ heights: number[]; spilled: string[]; kinds: string[]; down: boolean; cut: string | undefined }>(`(() => {
          const strip = document.getElementById('strip');
          return {
            heights: [...new Set(${chips}.map((c) => c.getBoundingClientRect().height))],
            spilled: ${chips}.filter((c) => c.scrollWidth > c.clientWidth).map((c) => c.textContent),
            kinds: [...new Set(${chips}.map((c) => c.tagName))].sort(),
            down: strip.scrollHeight > strip.clientHeight,
            cut: strip.dataset.cut,
          };
        })()`);
        assert.deepEqual(shape.kinds, ["BUTTON", "SPAN"], "warnings that open something and warnings that only inform");
        assert.equal(shape.heights.length, 1, `one height for every chip, not ${shape.heights.join(", ")}`);
        assert.deepEqual(shape.spilled, [], "no chip's text runs out of its border");
        assert.equal(shape.down, false, "the strip scrolls sideways only");
        assert.equal(shape.cut, "end", "its end fades, where more is hidden");
        const first = `${chips}.find((c) => c.tagName === 'BUTTON')`;
        await page.eval(`${first}.scrollIntoView({ inline: 'start', block: 'nearest' })`);
        // 32 px drawn, 44 px to a finger: its invisible margin takes a tap just above or below it.
        for (const [where, y] of [["on it", undefined], ["5 px above it", "r.y - 5"], ["5 px below it", "r.bottom + 5"]] as const) {
          assert.equal(await page.eval<boolean>(underFinger(first, y)), true, `a warning that opens something takes a tap ${where}`);
        }
      },
      (own) => {
        worktrees(own);
        planWindows(own);
      },
      sickMachine(),
    );
  });

  it("on a touch screen in two columns, gives the strip's chips that open something a finger's whole height, drawn", async () => {
    const page = await open(1024, 768);
    // Chrome emulates a coarse pointer only on a touch screen.
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });
    const chip = "document.querySelector('#strip > button.chip')";
    await page.waitFor(`${chip} && matchMedia('(pointer: coarse)').matches`);
    assert.ok((await page.eval<number>(`${chip}.getBoundingClientRect().height`)) >= 44, "the strip wraps here: no invisible margin, which would cover the row above or below");
    for (const [where, y] of [["its top", "r.y + 1"], ["its bottom", "r.bottom - 1"]] as const) {
      assert.equal(await page.eval<boolean>(underFinger(chip, y)), true, `a tap on ${where} is its own`);
    }
  });

  it("on a phone, keeps in the strip what wants a look now and gathers the other warnings behind one Alerts chip, which counts them and opens each", async () => {
    const machine = sickMachine();
    const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
    const resumes = { id: "web-shop-0badc0de", name: "web-shop", dir: "/home/demo/Projects/web-shop", source: "test-notes", at: iso(0), notes: [{ title: "Pick up the pay page", writtenAt: iso(-10 * 3600_000), expiresAt: iso(38 * 3600_000), command: "/load" }] };
    await ownPhone(
      async (page, own) => {
        await page.eval(LOW_DISK);
        await fetchNow(page);
        const strip = "document.getElementById('strip').textContent";
        await page.waitFor(`${strip}.includes('Disk: 12.0 GB free') && document.querySelector('#strip .alerts-chip')`);
        const shown = await page.eval<string[]>("[...document.querySelectorAll('#strip > *')].map((c) => c.textContent)");
        assert.equal(shown.length, 4, shown.join(" | "));
        assert.equal(shown[0], "5 alerts", "the unreadable file, load, memory, the handoff and the worktrees, counted, first so it is in sight");
        assert.equal(shown[1], "Disk: 12.0 GB free (web-shop)");
        assert.equal(shown[2], "invoices-api › VAT rounding: Context 86%");
        assert.match(shown[3] ?? "", /^5 h limit: at this pace, out around /, "a window running out before its reset");
        assert.equal(await page.eval<boolean>("document.querySelector('#strip .alerts-chip').classList.contains('warn')"), true, "loud: warnings among them");
        assert.doesNotMatch(await page.eval<string>(strip), /7 d limit/, "how full a window gets by its reset only informs: not on a phone");
        assert.doesNotMatch(await page.eval<string>(strip), /Not reviewed|Mark all as seen/, "To review counts what is new, and marks it seen");
        const openAlerts = async () => {
          assert.equal(await page.eval<boolean>(underFinger("document.querySelector('#strip .alerts-chip')")), true, "in sight without scrolling the strip");
          await page.tap("#strip .alerts-chip");
          await page.waitFor(arrived("strip-alerts"));
        };
        await openAlerts();
        const rows = await page.eval<string[]>("[...document.querySelectorAll('#strip-alerts .alert-row')].map((r) => r.textContent)");
        assert.equal(rows.length, 5, rows.join(" | "));
        assert.match(rows[0] ?? "", /^1 unreadable file.*broken\.json/, "with the file and why, which a finger cannot hover for");
        assert.deepEqual(rows.slice(1), ["Load: 21.4, above its 12 cores", "Memory: 2.0 GB free, under 3.3 GB", "web-shop: 1 handoff to resume", "a-checkout-project-with-a-long-name: 9.0 GB in worktrees · 2 merged (8.0 GB)"]);
        assert.ok((await page.eval<number>("Math.min(...[...document.querySelectorAll('#strip-alerts button.alert-row')].map((r) => r.getBoundingClientRect().height))")) >= 44, "each a finger's height");
        // Each row does what its chip does, in place of the sheet.
        await page.tap("#strip-alerts .alert-row", "in worktrees");
        await page.waitFor(`!document.getElementById('strip-alerts').open && ${arrived("session")} && document.querySelector('#session h3')?.textContent === 'Worktrees'`);
        await page.press("Escape");
        await page.waitFor("!document.getElementById('session').open");
        await openAlerts();
        await page.tap("#strip-alerts .alert-row", "handoff to resume");
        await page.waitFor(`!document.getElementById('strip-alerts').open && ${arrived("session")} && document.querySelector('#session .resume')?.textContent.includes('/load')`);
        await page.press("Escape");
        await page.waitFor("!document.getElementById('session').open");
        // Beside the columns the strip shows every warning itself, with the line on what is new and its Mark all as seen.
        await page.resize(1400, 900);
        await page.waitFor("!document.querySelector('#strip .alerts-chip') && document.querySelector('#strip > .muted')");
        const wide = await page.eval<string>(strip);
        for (const part of ["Not reviewed: 3 finished, 1 failure.", "Mark all as seen", "1 unreadable file", "Disk: 12.0 GB free", "Load: 21.4", "Memory: 2.0 GB", "Context 86%", "5 h limit: at this pace", "7 d limit: at its pace so far, about 90% by its reset", "web-shop: 1 handoff to resume", "9.0 GB in worktrees"]) {
          assert.ok(wide.includes(part), `${part} in ${wide}`);
        }
        // Back on a phone, with only the handoff left: one alert, quiet, since a handoff only informs; then none, and no chip.
        await page.resize(390, 844);
        await page.waitFor("document.querySelector('#strip .alerts-chip')?.textContent === '5 alerts'");
        fs.writeFileSync(path.join(machine.proc, "loadavg"), "0.50 0.50 0.50 1/900 1234\n");
        fs.writeFileSync(path.join(machine.proc, "meminfo"), "MemTotal:       32000000 kB\nMemAvailable:   30000000 kB\n");
        fs.rmSync(path.join(own.paths.metricsDir, "broken.json"));
        worktrees(own, false);
        await fetchNow(page);
        await page.waitFor("document.querySelector('#strip .alerts-chip')?.textContent === '1 alert'");
        assert.equal(await page.eval<boolean>("document.querySelector('#strip .alerts-chip').classList.contains('warn')"), false, "quiet: a handoff to resume is no warning");
        own.putResumes({ ...resumes, notes: [] });
        await fetchNow(page);
        await page.waitFor("!document.querySelector('#strip .alerts-chip')");
      },
      (own) => {
        worktrees(own);
        planWindows(own);
        own.putResumes(resumes);
        fs.writeFileSync(path.join(own.paths.metricsDir, "broken.json"), "{ not json");
      },
      machine,
    );
  });

  it("on a phone, keeps the Alerts sheet's rows clear of a new question and a toast, follows its warnings while open, and closes on Escape, its backdrop or when they all go", async () => {
    const machine = sickMachine();
    await ownPhone(
      async (page, own) => {
        const sheet = "document.getElementById('strip-alerts')";
        const openAlerts = async () => {
          await page.tap("#strip .alerts-chip");
          await page.waitFor(arrived("strip-alerts"));
        };
        await page.waitFor("document.querySelector('#strip .alerts-chip')?.textContent === '2 alerts'");
        await openAlerts();
        // What comes in over the sheet comes in at the screen's top, not under the sheet's head, over its rows.
        const asked = own.ask({ sessionId: "demo-pagos", kind: "question", text: "Over the alerts?" });
        const bubble = "document.getElementById('arrival')";
        await page.waitFor(`${bubble}.matches(':popover-open') && !${bubble}.inert && !${bubble}.getAnimations().length`);
        await page.eval("import('/pieces.js').then((m) => m.toast('Copied'))");
        await page.waitFor("document.querySelector('.toast') && !document.querySelector('.toast').getAnimations().length");
        const clear = await page.eval<Record<string, boolean>>(`(() => {
          const rows = document.querySelector('#strip-alerts .alert-list').getBoundingClientRect();
          const above = (el) => el.getBoundingClientRect().bottom <= rows.top;
          return { bubble: above(${bubble}), toast: above(document.querySelector('.toast')) };
        })()`);
        assert.deepEqual(clear, { bubble: true, toast: true }, "neither covers the rows about to be tapped");
        own.dismiss(asked.id);
        await page.waitFor(`!${bubble}.matches(':popover-open') && !document.querySelector('.toast')`);
        await page.press("Escape");
        await page.waitFor(`!${sheet}.open`);
        await openAlerts();
        const top = await page.eval<number>(`${sheet}.getBoundingClientRect().top`);
        await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: top / 2 }] });
        await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitFor(`!${sheet}.open`);
        // Open, it follows its warnings: the memory back, one row left; the load too, and it closes by itself.
        await openAlerts();
        fs.writeFileSync(path.join(machine.proc, "meminfo"), "MemTotal:       32000000 kB\nMemAvailable:   30000000 kB\n");
        await fetchNow(page);
        await page.waitFor(`${sheet}.open && document.querySelectorAll('#strip-alerts .alert-row').length === 1`);
        assert.match(await page.eval<string>("document.querySelector('#strip-alerts .alert-row').textContent"), /^Load: 21\.4/);
        assert.equal(await page.eval<string>("document.querySelector('#strip .alerts-chip').textContent"), "1 alert");
        fs.writeFileSync(path.join(machine.proc, "loadavg"), "0.50 0.50 0.50 1/900 1234\n");
        await fetchNow(page);
        await page.waitFor(`!${sheet}.open && !document.querySelector('#strip .alerts-chip')`);
      },
      undefined,
      machine,
    );
  });

  it("on a phone, gives the strip's room to the board before the first data and with nothing that wants a look, and still shows Offline", async () => {
    const desk = await serve(new Store(path.join(tempHome(), "store")));
    const page = await browser.newPage(390, 844);
    try {
      // The first state waits for the test, as over a slow network; later the desk can stop answering.
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `(() => {
          const realFetch = window.fetch;
          let release;
          const gate = new Promise((resolve) => (release = resolve));
          window.releaseState = () => release();
          window.fetch = (url, init) => String(url) !== "/api/state" ? realFetch(url, init) : window.cut ? Promise.reject(new TypeError("Failed to fetch")) : gate.then(() => realFetch(url, init));
        })()`,
      });
      await page.goto(desk.base + "/");
      await page.waitFor("document.querySelector('.board[aria-busy]')");
      const strip = "({ room: document.getElementById('strip').getBoundingClientRect().height, placeholder: !!document.querySelector('#strip .skel') })";
      assert.deepEqual(await page.eval(strip), { room: 0, placeholder: false }, "no placeholder for a line a phone does not show, which its strip would give back once loaded");
      await page.eval("releaseState()");
      await page.waitFor("!document.querySelector('.board[aria-busy]')");
      assert.deepEqual(await page.eval(strip), { room: 0, placeholder: false }, "nothing wants a look: still no strip");
      await page.eval("window.cut = true");
      await fetchNow(page);
      await page.waitFor("document.querySelector('#strip .offline')");
      assert.deepEqual(
        await page.eval("(() => { const strip = document.getElementById('strip'); const r = strip.querySelector('.offline').getBoundingClientRect(); return [getComputedStyle(strip).display !== 'none', strip.childElementCount, r.height > 0 && r.top >= 0 && r.bottom <= innerHeight]; })()"),
        [true, 1, true],
        "Offline alone in the strip, in sight",
      );
    } finally {
      await page.close();
      await desk.close();
    }
    assert.deepEqual(page.errors, [], "the page reports no errors");
  });

  it("on a phone, Mark all as seen on To review marks in one request, says how many it could not mark, and takes a result gone meanwhile as done", async () => {
    await ownPhone(async (page, own) => {
      await page.tap(".tabbar button", "To review");
      await page.waitFor(`document.querySelectorAll('.col-review .rtile-wrap').length === 3 && ${STILL}`);
      const id = (title: string) => own.listResults().find((r) => r.title === title)?.id ?? assert.fail(`no result ${title}`);
      const refused = id("Three pay button variants");
      const gone = id("Migration 0041 applied locally");
      // The desk's state waits, so the page still lists the result removed below when it is tapped; the desk refuses one mark.
      await page.eval(`(() => {
        const real = window.fetch;
        const held = [];
        window.marks = [];
        window.releaseState = () => { window.fetch = real; held.splice(0).forEach((go) => go()); };
        window.fetch = (url, init) => {
          const route = String(url);
          if (route === "/api/state") return new Promise((r) => held.push(() => r(real(url, init))));
          if (!route.endsWith("/seen")) return real(url, init);
          const ids = JSON.parse(init.body).ids;
          window.marks.push({ route, ids: ids.length });
          return real(url, { ...init, body: JSON.stringify({ ids: ids.filter((i) => i !== "${refused}") }) }).then(async (res) => {
            const reply = await res.json();
            reply.failed.push({ id: "${refused}", error: "disk full" });
            return new Response(JSON.stringify(reply), { status: res.status, headers: { "Content-Type": "application/json" } });
          });
        };
      })()`);
      fs.rmSync(own.paths.result(gone));
      await page.tap(".col-review .col-head button", "Mark all as seen");
      await page.waitFor("window.marks.length === 1");
      await page.eval("releaseState()");
      await page.waitFor("document.querySelector('.toast')");
      assert.deepEqual(await page.eval("window.marks"), [{ route: "/api/results/seen", ids: 3 }], "one request for what the tab lists");
      assert.equal(await page.eval<string>("document.querySelector('.toast').textContent"), "1 of 3 results could not be marked seen: disk full", "the one refused, counted; the one gone has nothing left to mark");
      await page.waitFor("[...document.querySelectorAll('.col-review .rtile-wrap .rt')].map((t) => t.textContent).join() === 'Three pay button variants'"); // only the refused one left to mark
      assert.deepEqual(
        own.listResults().filter((r) => !r.seenAt && r.status !== "failed").map((r) => r.title),
        ["Three pay button variants"],
      );
    });
  });

  it("marks seen in requests of at most 5000 ids, takes ids gone as done, and says it cannot tell what was marked when the desk does not say", async () => {
    const page = await open();
    // Every write answered here: what the page sends and makes of each answer, not the desk's own marking.
    const tried = (answer: string) =>
      page.eval<{ sizes: number[]; error: string | null }>(`(async () => {
        const real = window.fetch;
        const sizes = [];
        window.fetch = (url, init) => {
          if (String(url) !== "/api/results/seen") return real(url, init);
          const ids = JSON.parse(init.body).ids;
          sizes.push(ids.length);
          return Promise.resolve(new Response(JSON.stringify(${answer}), { status: 200, headers: { "Content-Type": "application/json" } }));
        };
        try {
          const { markResultsSeen } = await import("/result.js");
          await markResultsSeen(Array.from({ length: 10001 }, (_, i) => ({ id: "r-" + i })));
          return { sizes, error: null };
        } catch (error) {
          return { sizes, error: error.message };
        } finally {
          window.fetch = real;
        }
      })()`);
    assert.deepEqual(await tried(`{ seen: ids.length - 1, missing: [ids[0]], failed: [] }`), { sizes: [5000, 5000, 1], error: null }, "the desk takes 5000 at most; one gone in each is nothing left to mark");
    assert.deepEqual(await tried(`{ seen: ids.length - 1, missing: [], failed: [{ id: ids[0], error: "disk full" }] }`), { sizes: [5000, 5000, 1], error: "3 of 10001 results could not be marked seen: disk full" });
    assert.deepEqual(await tried(`{ seen: ids.length }`), { sizes: [5000, 5000, 1], error: "The desk did not say which of 10001 results it marked seen; what is still new stays listed." }, "not a claim that all failed");
  });

  it("opens and closes a header menu from its button or Escape, keeping the focus on each choice", async () => {
    const page = await open();
    await page.click("#theme");
    assert.equal(await page.eval<string>("document.getElementById('theme').getAttribute('aria-expanded')"), "true", "the button shows its menu open");
    await page.eval("document.querySelector('#display-menu button[data-value=dark]').focus()");
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await page.waitFor("document.documentElement.dataset.theme === 'dark'");
    assert.equal(await page.eval<string>("document.activeElement.dataset.value"), "dark", "the focus stays on the choice made");
    assert.equal(await page.eval<string>("document.querySelector('#display-menu button[data-value=dark]').getAttribute('aria-pressed')"), "true");
    await page.press("Escape");
    await page.waitFor("document.getElementById('display-menu').hidden && getComputedStyle(document.getElementById('display-menu')).display === 'none'");
    assert.equal(await page.eval<string>("document.activeElement.id"), "theme", "Escape gives the focus back to the button");
    assert.equal(await page.eval<string>("document.getElementById('theme').getAttribute('aria-expanded')"), "false");

    await page.click("#alerts");
    await page.eval("document.querySelectorAll('#alerts-menu input')[2].focus()");
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    await page.waitFor("localStorage.getItem('agent-desk:failures') === 'on'");
    assert.equal(await page.eval<boolean>("document.activeElement === document.querySelectorAll('#alerts-menu input')[2] && document.activeElement.checked"), true, "a switch keeps the focus");
    await page.click(".col-head", "Needs you");
    await page.waitFor("document.getElementById('alerts-menu').hidden");
    await page.eval("localStorage.clear()");
  });

  it("switches the theme in one frame, its native controls and accent included", async () => {
    const page = await open();
    const scheme = "getComputedStyle(document.documentElement).colorScheme";
    assert.equal(await page.eval<string>(scheme), "light");
    assert.equal(await page.eval<string>("getComputedStyle(document.querySelector('#alerts-menu')).accentColor"), "rgb(81, 70, 220)", "checkboxes take the desk's accent");
    await page.click("#theme");
    await page.waitFor(STILL);
    await page.click("#display-menu button", "Dark");
    assert.deepEqual(await page.eval<string[]>("document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.transitionProperty)"), [], "no control fades on its own from the old colours");
    assert.equal(await page.eval<string>(scheme), "dark", "scrollbars and checkboxes follow the theme chosen, not the system's");
    await page.eval("localStorage.clear()");
  });

  it("keeps a dialog open when text selected in it is released over the backdrop", async () => {
    const page = await open();
    await page.click(".scard", "checkout redesign");
    await page.waitFor(`${arrived("session")} && document.querySelector('#session .msg.from-session')`);
    const [x, y] = await page.eval<[number, number]>("(() => { const r = document.querySelector('#session .msg.from-session').getBoundingClientRect(); return [r.x + 5, r.y + 8]; })()");
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    for (let at = x; at > 20; at -= 40) await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at, y: y + 20, button: "left", buttons: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 20, y: y + 20, button: "left", clickCount: 1 });
    assert.ok((await page.eval<string>("String(getSelection())")).length > 0, "the text is selected");
    assert.deepEqual(await openDialogs(page), ["session"], "the selection does not close the panel");
    for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: 20, y: y + 20, button: "left", clickCount: 1 });
    await page.waitFor("!document.getElementById('session').open");
  });

  it("zooms either side of a before and after, and moves its divider by a drag on the picture or its handle", async () => {
    const page = await open();
    await openResultOf(page, "Checkout: before and after");
    const box = await page.eval<{ x: number; y: number; w: number; h: number }>("(() => { const r = document.querySelector('#result .compare').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()");
    const y = box.y + box.h * 0.75;
    const divider = "Number(document.querySelector('#result .compare .handle').getAttribute('aria-valuenow'))";
    for (const [at, side] of [[0.8, "After"], [0.2, "Before"]] as const) {
      const x = box.x + box.w * at;
      for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      await page.waitFor("document.getElementById('zoom').open");
      assert.match(await page.eval<string>("document.querySelector('#zoom .zcaption').textContent"), new RegExp(`· ${side}$`), `a click on the ${side} side zooms it`);
      await page.press("Escape");
      await page.waitFor("!document.getElementById('zoom').open");
    }
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x + box.w * 0.5, y, button: "left", clickCount: 1 });
    for (let i = 10; i >= 5; i--) await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + (box.w * i) / 20, y, button: "left", buttons: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + box.w * 0.25, y, button: "left", clickCount: 1 });
    assert.ok(Math.abs((await page.eval<number>(divider)) - 25) <= 2, "a drag on the picture moves the divider");
    assert.equal(await page.eval<boolean>("document.getElementById('zoom').open"), false, "and does not zoom");
    await page.eval("document.querySelector('#result .compare .handle').focus()");
    await page.press("ArrowRight");
    assert.ok(Math.abs((await page.eval<number>(divider)) - 27) <= 2, "the handle moves with the arrow keys");
    await page.press("Escape");
    await page.waitFor("!document.getElementById('result').open");
  });

  it("opens a small picture at its own size, zooms in on a double click and slides to the next one", async () => {
    const page = await open();
    await openResultOf(page, "Three pay button variants");
    await page.click("#result .vimgs img");
    await page.waitFor(`${arrived("zoom")} && document.querySelector('#zoom img.cur').complete`);
    const pct = "document.querySelector('#zoom .zbar .num.zfine').textContent";
    await page.waitFor(`${pct} === "100 %"`);
    const cur = "document.querySelector('#zoom img.cur')";
    const centre = await page.eval<[number, number]>(`(() => { const r = ${cur}.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    for (let i = 0; i < 2; i++) for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: centre[0], y: centre[1], button: "left", clickCount: 1 });
    await page.waitFor(`${pct} === "250 %"`);
    await page.press("ArrowRight");
    await page.waitFor("document.querySelector('#zoom .zcount').textContent === '2 / 3'");
    await page.waitFor(`${pct} === "100 %" && ${cur}.getBoundingClientRect().x > 0`);
    assert.match(await page.eval<string>(`${cur}.alt`), / · B$/, "the next picture is the one shown");
    await page.press("Escape");
    await page.press("Escape");
    await page.waitFor("!document.querySelector('dialog[open]')");
  });

  it("on a phone, pinching a picture out of its fit size springs it back", async () => {
    const page = await openPhone();
    await openResultOf(page, "Checkout: before and after");
    await page.eval("document.querySelector('#result .seg button:last-child').click()");
    await page.eval("document.querySelector('#result .vimgs img').click()");
    await page.waitFor(`${arrived("zoom")} && document.querySelector('#zoom img.cur').complete`);
    const width = "Math.round(document.querySelector('#zoom img.cur').getBoundingClientRect().width)";
    const fit = await page.eval<number>(width);
    assert.ok(fit <= 390, "it opens inside the screen");
    await touch(page, "touchStart", [[95, 420], [295, 420]]);
    for (let s = 100; s >= 20; s -= 20) await touch(page, "touchMove", [[195 - s, 420], [195 + s, 420]]);
    assert.ok((await page.eval<number>(width)) < fit, "the fingers shrink it");
    await touch(page, "touchEnd", []);
    await page.waitFor(`${width} === ${fit}`);
    await page.press("Escape");
    await page.press("Escape");
  });

  it("on a phone, slides a session in from the right, opaque, and takes it back with a swipe from the left edge", async () => {
    const page = await openPhone();
    await page.click(".tabbar button", "Sessions");
    await page.eval(`(() => {
      window.frames = [];
      const d = document.getElementById("session");
      const tick = () => { frames.push([d.getBoundingClientRect().x, Number(getComputedStyle(d).opacity)]); if (frames.length < 30) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      [...document.querySelectorAll(".scard")].find((c) => c.textContent.includes("checkout redesign")).click();
    })()`);
    await page.waitFor(`${arrived("session")} && window.frames.length >= 30`);
    const frames = await page.eval<[number, number][]>("window.frames");
    assert.ok(frames.some(([x]) => x > 50), "it moves in from the side");
    assert.ok(frames.every(([, o]) => o === 1), "never see-through over the list");
    await touch(page, "touchStart", [[6, 500]]);
    for (let x = 6; x <= 70; x += 16) await touch(page, "touchMove", [[x, 502]]);
    assert.ok((await page.eval<number>("document.getElementById('session').getBoundingClientRect().x")) > 30, "it follows the finger");
    await touch(page, "touchEnd", []);
    await page.waitFor(`${arrived("session")} && document.getElementById('session').getBoundingClientRect().x === 0`);
    await touch(page, "touchStart", [[6, 500]]);
    for (let x = 6; x <= 246; x += 30) await touch(page, "touchMove", [[x, 502]]);
    await touch(page, "touchEnd", []);
    await page.waitFor("!document.getElementById('session').open");
  });

  it("keeps a session's and a result's window whole while it slides or fades out", async () => {
    /** Closes a window and measures it in the first frame of its way out: its body as wide as it is, under its head. */
    const closing = (page: Page, id: string) =>
      page.eval<Record<string, boolean>>(`(async () => {
        const d = document.getElementById('${id}');
        d.close();
        await new Promise(requestAnimationFrame);
        // Layout sizes, which its transform on the way out does not scale.
        const [head, body] = [d.querySelector('.dhead'), d.querySelector('.dbody')];
        return { leaving: getComputedStyle(d).display !== 'none', bodyFull: Math.abs(body.offsetWidth - d.clientWidth) <= 1, bodyUnderHead: body.offsetTop >= head.offsetTop + head.offsetHeight - 1, headOnTop: head.offsetTop <= 1 };
      })()`);
    const whole = { leaving: true, bodyFull: true, bodyUnderHead: true, headOnTop: true };
    for (const [width, height] of [[1400, 900], [390, 844]] as const) {
      const page = await open(width, height);
      if (width < 700) await page.click(".tabbar button", "Sessions");
      await page.click(".scard", "checkout redesign");
      await page.waitFor(arrived("session"));
      assert.deepEqual(await closing(page, "session"), whole, `the session's window at ${width} px`);
      await page.waitFor(`!document.querySelector('dialog[open]') && ${STILL}`);
      await openResultOf(page, "Checkout: before and after");
      assert.deepEqual(await closing(page, "result"), whole, `the result's window at ${width} px`);
      await page.waitFor("!document.querySelector('dialog[open]')");
    }
  });

  it("on a phone, shows no header search before the desk's first data", async () => {
    const page = await browser.newPage(390, 844);
    pages.push(page);
    // The first state waits for the test, as over a slow network.
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const realFetch = window.fetch;
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        window.releaseState = () => release();
        window.fetch = (url, init) => String(url) === "/api/state" ? gate.then(() => realFetch(url, init)) : realFetch(url, init);
      })()`,
    });
    await page.goto(base + "/");
    await page.waitFor("document.querySelector('.board[aria-busy]')");
    assert.equal(await page.eval<string>("getComputedStyle(document.querySelector('header .search')).display"), "none", "nothing to search yet, and the projects' place stays free");
    await page.eval("releaseState()");
    await page.waitFor("document.querySelector('.next') && !document.getElementById('projects').hidden");
    assert.equal(await page.eval<string>("getComputedStyle(document.querySelector('header .search')).display"), "none", "the projects take the row");
  });

  it("keeps a result's window and the button under the pointer still when its comparison changes mode", async () => {
    const page = await open(1400, 900);
    await openResultOf(page, "Checkout: before and after");
    await page.waitFor("[...document.querySelectorAll('#result img')].every((i) => i.complete)");
    const place = () => page.eval<number[]>("[document.getElementById('result'), document.querySelector('#result .seg')].map((el) => Math.round(el.getBoundingClientRect().top))");
    const height = () => page.eval<number>("Math.round(document.getElementById('result').getBoundingClientRect().height)");
    const first = await place();
    const tall = await height();
    for (const mode of ["Side by side", "Slider"]) {
      await page.click("#result .seg button", mode);
      await page.waitFor(`document.querySelector('#result .seg button[aria-pressed=true]')?.textContent.includes(${JSON.stringify(mode)}) && [...document.querySelectorAll('#result img')].every((i) => i.complete)`);
      if (mode === "Side by side") assert.notEqual(await height(), tall, "the comparison changes the window's height");
      assert.deepEqual(await place(), first, `in ${mode}, the window's top and its buttons stay where they were`);
    }
    await page.press("Escape");
  });

  it("on a phone, each tab keeps its scroll, and a tap on the tab shown goes back to its top", async () => {
    const page = await open(390, 600);
    await page.click(".tabbar button", "Sessions");
    const room = await page.eval<number>("document.documentElement.scrollHeight - innerHeight");
    assert.ok(room > 120, `the sessions scroll (${room} px)`);
    await page.eval("window.scrollTo(0, 120)");
    await page.eval(`[...document.querySelectorAll(".tabbar button")].find((b) => b.textContent.includes("Needs you")).click()`);
    await page.eval(`[...document.querySelectorAll(".tabbar button")].find((b) => b.textContent.includes("Sessions")).click()`);
    assert.equal(await page.eval<number>("Math.round(scrollY)"), 120, "back on Sessions, where it was left");
    await page.eval(`[...document.querySelectorAll(".tabbar button")].find((b) => b.textContent.includes("Sessions")).click()`);
    await page.waitFor("scrollY === 0");
  });

  it("shows keyboard focus on a session card and the search box, and no grey flash on a tap", async () => {
    const page = await open();
    await page.eval("document.querySelector('.scard').focus({ focusVisible: true })");
    assert.equal(await page.eval<string>("getComputedStyle(document.querySelector('.scard')).outlineOffset"), "-2px", "a ring inside the card, which the list's rounded box would clip");
    await page.eval("document.getElementById('q').focus()");
    assert.notEqual(await page.eval<string>("getComputedStyle(document.querySelector('header .search')).boxShadow"), "none", "the search box shows it has the focus");
    assert.equal(await page.eval<string>("getComputedStyle(document.querySelector('.scard')).webkitTapHighlightColor"), "rgba(0, 0, 0, 0)");
  });

  describe("on a desktop window", () => {
    const LONG = "The current session cookies are stored in Redis with a 30 day expiry, and the refresh logic lives in three different services that each re-implement the same validation; moving to short-lived JWT means we need a token service with rotation and a revocation list so that a user can revoke a single device from the account page. Which storage should the token service use for the revocation list, Postgres or Redis?";
    let long: string;
    before(() => {
      store.upsertSession({ id: "far-project", provider: "Test", project: { name: "customer-portal-monorepo-infrastructure", dir: "/home/demo/Projects/customer-portal-monorepo-infrastructure" }, title: "Migrate the authentication flow from session cookies to short-lived JWT access tokens", state: "waiting" });
      long = store.ask({ sessionId: "far-project", kind: "question", text: LONG, options: ["Postgres, with a nightly cleanup job", "Redis, with the same TTL as the refresh token"] }).id;
    });
    after(() => {
      store.dismiss(long);
      store.updateSession("far-project", (s) => ({ ...s, state: "ended" }));
    });
    const rect = (sel: string) => `JSON.parse(JSON.stringify(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect()))`;

    it("keeps every header control on screen with three projects, from 900 to 1450 px", async () => {
      const page = await open(1024, 768);
      await page.waitFor("document.querySelectorAll('#projects button').length === 4");
      for (const width of [900, 1024, 1180, 1280, 1450]) {
        await page.resize(width, 768);
        const m = await page.eval<{ over: number; right: number; search: number; pill: boolean }>(`(() => {
          const hd = document.querySelector('header.top'), pill = document.getElementById('needs-pill');
          return { over: hd.scrollWidth - hd.clientWidth, right: document.getElementById('theme').getBoundingClientRect().right, search: document.querySelector('header .search').getBoundingClientRect().width, pill: pill.scrollWidth <= pill.clientWidth };
        })()`);
        assert.equal(m.over, 0, `the header does not overflow at ${width} px`);
        assert.ok(m.right <= width, `Display stays on screen at ${width} px`);
        assert.ok(m.search >= 150, `the search keeps a usable width at ${width} px (${m.search})`);
        assert.ok(m.pill, `the needs pill is whole at ${width} px`);
        if (width === 1024) assert.ok(await page.eval<boolean>("document.getElementById('projects').scrollWidth > document.getElementById('projects').clientWidth"), "the projects scroll instead");
      }
    });

    it("keeps the header's controls in place when a view or project is picked", async () => {
      const page = await open(1440, 900);
      const at = () => page.eval<number[]>("['#alerts', '#needs-pill', '#projects button:last-child'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().right))");
      const before = await at();
      await page.click("#projects button", "invoices-api");
      await page.click("#views button", "History");
      await page.waitFor("document.querySelector('.wrap')");
      const [alerts, , lastProject] = await at();
      assert.deepEqual([alerts, lastProject], [before[0], before[2]], "nothing moves sideways");
      assert.equal(Math.round(await page.eval<number>(`${rect("#needs-pill")}.right`)), before[1], "the needs pill stays where it was");
      await page.click("#views button", "Desk");
      await page.click("#projects button", "All");
    });

    it("cuts a long session name before the age in the large card", async () => {
      const page = await open(1024, 768);
      await page.click(".qrow", "token service");
      await page.waitFor("document.querySelector('.next')?.textContent.includes('Postgres or Redis?')");
      const m = await page.eval<{ where: number; age: number; card: number }>(`(() => {
        const meta = document.querySelector('.next .meta');
        return { where: meta.querySelector('.where').getBoundingClientRect().right, age: meta.querySelector('.age').getBoundingClientRect().left, card: document.querySelector('.next').getBoundingClientRect().right };
      })()`);
      assert.ok(m.where <= m.age, "the session's name ends before the age");
      assert.ok(m.age < m.card, "the age stays inside the card");
    });

    it("shows a long question whole in its session's panel", async () => {
      const page = await open(1280, 800);
      await page.click(".scard", "Migrate the authentication");
      await page.waitFor(arrived("session"));
      assert.match(await page.eval<string>("document.querySelector('#session .panel-question').textContent"), /Postgres or Redis\?/);
      await page.press("Escape");
    });

    it("lines up the inbox rows' times whatever the kind of row", async () => {
      const page = await open(1280, 800);
      const rows = await page.eval<{ time: number; text: number }[]>("[...document.querySelectorAll('.qrow')].map((r) => ({ time: Math.round(r.querySelector('.qwhen').getBoundingClientRect().right), text: Math.round(r.querySelector('.qbody').getBoundingClientRect().left) }))");
      assert.ok(rows.length >= 3, "questions and a failure in the list");
      assert.equal(new Set(rows.map((r) => r.time)).size, 1, `one column of times: ${JSON.stringify(rows)}`);
      assert.equal(new Set(rows.map((r) => r.text)).size, 1, "one left edge for the text");
    });

    it("grows the right column with the window, keeps a dragged width, and caps the inbox", async () => {
      const page = await open(1920, 1080);
      const side = () => page.eval<number>(`Math.round(${rect(".col-sessions")}.width)`);
      assert.equal(await side(), 560, "a wide window gives the sessions more room");
      assert.ok((await page.eval<number>(`${rect(".next")}.width`)) <= 880, "the inbox keeps a reading width");
      await page.resize(1280, 800);
      assert.equal(await side(), 384);
      await page.eval("document.querySelector('.split').focus()");
      await page.press("ArrowLeft");
      assert.equal(await side(), 400, "the splitter still sets the width");
      await page.resize(1920, 1080);
      assert.equal(await side(), 400, "and a set width stays set");
      await page.eval("document.querySelector('.split').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
      assert.equal(await side(), 560, "a double click goes back to the window's width");
    });

    it("fades a list where its scroll area cuts it, and only there", async () => {
      const page = await open(1280, 600);
      const cut = () => page.eval<string | null>("document.querySelector('.col-sessions .col-body').dataset.cut ?? null");
      assert.equal(await cut(), "end", "cut at the bottom only");
      await page.eval("(() => { const b = document.querySelector('.col-sessions .col-body'); b.scrollTop = b.scrollHeight; })()");
      await page.waitFor("document.querySelector('.col-sessions .col-body').dataset.cut === 'start'");
      assert.notEqual(await page.eval<string>("getComputedStyle(document.querySelector('.col-sessions .col-body')).maskImage"), "none");
    });
  });

  it("on a phone, sets the tab bar on the bottom edge, over the home indicator, and the credit in the display menu", async () => {
    const page = await open(390, 844);
    await page.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
    const bar = "document.querySelector('.tabbar')";
    await page.waitFor(`getComputedStyle(${bar}).paddingBottom === "34px"`);
    assert.equal(await page.eval<number>(`Math.round(${bar}.getBoundingClientRect().bottom)`), 844, "the tab bar reaches the bottom edge");
    assert.equal(await page.eval<number>("document.querySelector('.credits').getClientRects().length"), 0, "no credits band under it");
    assert.equal(await page.eval<number>("document.getElementById('needs-pill').getClientRects().length"), 0, "the Inbox tab counts the questions, not a header pill");
    await page.click("#theme");
    const link = "document.querySelector('#display-menu .menu-credit a')";
    await page.waitFor(`${link}?.getClientRects().length && ${STILL}`); // measured once the menu has opened
    assert.equal(await page.eval<string>(`${link}.href`), "https://github.com/jesusizq");
    assert.match(await page.eval<string>(`${link}.textContent`), /© 2026 Jesús Izquierdo/);
    assert.ok((await page.eval<number>(`${link}.getBoundingClientRect().height`)) >= 44, "a finger's target");
    await page.press("Escape");
  });

  it("keeps the credit in the footer beside the columns, not in the display menu", async () => {
    const page = await open();
    assert.equal(await page.eval<number>("document.querySelector('.credits a').getClientRects().length"), 1);
    await page.click("#theme");
    await page.waitFor("!document.getElementById('display-menu').hidden");
    assert.equal(await page.eval<number>("document.querySelector('#display-menu .menu-credit').getClientRects().length"), 0);
    await page.press("Escape");
  });

  it("on a portrait phone, puts the projects on the first header row when they fit there whole", async () => {
    const page = await open(520, 900);
    const up = "(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const p = document.getElementById('projects'); return r('#projects').top < r('#theme').bottom && p.scrollWidth <= p.clientWidth; })()";
    await page.waitFor(up);
    await page.resize(390, 844);
    await page.waitFor(`!${up}`);
    assert.ok(await page.eval<boolean>("document.getElementById('projects').getBoundingClientRect().top >= document.getElementById('theme').getBoundingClientRect().bottom"), "too wide: a row of their own");
  });

  it("on a phone, keeps a table's words whole", async () => {
    const page = await open(390, 844);
    const split = await page.eval<string[]>(`(() => {
      const md = document.createElement('div');
      md.className = 'md';
      md.innerHTML = '<div class="md-table"><table><tr><th>Agente</th><th>Qué hace</th><th>Toca</th></tr>'
        + '<tr><td>feat:calm-arrivals</td><td>Globo de pregunta nueva, una marca en la burbuja al enviar, imágenes una debajo de otra en el móvil</td><td>la página</td></tr>'
        + '<tr><td>fix:agent-lifecycle</td><td>Que los agentes de workflow tomen su nombre real y no se queden trabajando para siempre</td><td>el adaptador</td></tr></table></div>';
      document.getElementById('view').prepend(md);
      const split = [];
      for (const cell of md.querySelectorAll('th, td')) {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          for (const m of n.data.matchAll(/[^\\s:-]+/g)) {
            const r = document.createRange();
            r.setStart(n, m.index);
            r.setEnd(n, m.index + m[0].length);
            if (new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size > 1) split.push(m[0]);
          }
        }
      }
      md.remove();
      return split;
    })()`);
    assert.deepEqual(split, [], "no word is split across lines");
  });


  it("on a touch phone, keeps the session panel's chips one height, each button a finger's reach", async () => {
    const page = await touchPanel();
    const heights = await page.eval<number[]>("[...document.querySelectorAll('#session .pchips > .chip')].map((c) => Math.round(c.getBoundingClientRect().height))");
    assert.equal(new Set(heights).size, 1, `one height: ${heights}`);
    // The chips scroll sideways: the first button may start past the screen's edge, behind the metrics.
    await page.eval("document.querySelector('#session .pchips button.chip').scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })");
    assert.ok(
      await page.eval<boolean>("(() => { const b = document.querySelector('#session .pchips button.chip'); const r = b.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.top - 5)?.closest('button.chip') === b; })()"),
      "a button chip still takes a tap just outside its pill",
    );
    await page.press("Escape");
  });

  it("on a phone, shows a session's failed agents first among its chips, in view without scrolling", async () => {
    const page = await touchPanel();
    const [first, right, edge] = await page.eval<[string, number, number]>(`(() => {
      const chip = document.querySelector('#session .pchips > .chip');
      return [chip.textContent, chip.getBoundingClientRect().right, document.querySelector('#session .pchips').getBoundingClientRect().right];
    })()`);
    assert.match(first, /failed/);
    assert.ok(right <= edge, `the failed agents chip ends inside the row: ${right} <= ${edge}`);
    await page.press("Escape");
  });

  it("on a touch phone, opens a part of the session panel from its top, right under the way back", async () => {
    const page = await touchPanel();
    await page.click("#session .pchips button.chip", "agents");
    await page.waitFor("document.querySelector('#session .ppart .alist')");
    const [above, below] = await page.eval<[number, number]>(`(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#session .ppart .back'));
      const back = range.getBoundingClientRect();
      const first = Math.min(...[...document.querySelectorAll('#session .ppart > .rsec')].map((s) => s.getBoundingClientRect().top));
      return [back.top - document.querySelector('#session .pchips').getBoundingClientRect().bottom, first - back.bottom];
    })()`);
    assert.ok(above > 0, `the way back is in view, under the chips: ${above}`);
    assert.ok(Math.abs(above - below) <= 4, `as much room under the way back as above it: ${above} above, ${below} below`);
    await page.press("Escape");
  });

});
