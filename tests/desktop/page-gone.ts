// The desktop app after its page's renderer process goes, as a crash or
// running out of memory takes it, while the window lives on: a SWF kept
// connected overnight must not keep its server talking to no one. Its
// sockets and WebSockets close at once, stderr says so once, with no word
// for each packet that came after, the app stays up, and the reload the
// app offers, or View › Reload Movie, brings the movie back. The renderer
// is crashed, the offer answered and the menu clicked through the main
// process's test-only inspector (--inspect=0). Skipped, saying why, where
// Electron was not downloaded (pnpm --filter @swf2es/desktop fetch-electron).
//
//   node tests/desktop/page-gone.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { missing } from "../../apps/desktop/src/launch/electron.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";
import * as w from "../swf-writer.ts";
import { type App, display, withApp } from "./app.ts";
import { webSocketServer } from "./websocket-server.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const desktopPackage = fileURLToPath(new URL("../../apps/desktop/package.json", import.meta.url));
// Its own: the test packages' scripts may run at once (tests/desktop runs them one by one).
const out = `${here}out/page-gone/`;

const why = missing();
if (why) {
  console.log(`desktop page-gone test: skipped. ${why}`);
  process.exit(0);
}

/**
 * How soon a server must see its connection closed once render-process-gone
 * has come: the app's part. The process itself goes only once the system has
 * written its dump, a core dump or crashpad's, which takes a second here and
 * may take far longer on a busy runner; GONE_WITHIN_MS bounds that.
 */
const CLOSED_WITHIN_MS = 2000;
const GONE_WITHIN_MS = 60_000;
/** How often the servers send to a connected SWF, unasked. */
const TICK_MS = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const libraries = `${out}libraries/`;
libraryAbcs(libraries);
const abcs = compileScripts(
  [
    { name: "DesktopSmoke", source: readFileSync(`${here}DesktopSmoke.as`, "utf8") },
    { name: "AirSmoke", source: readFileSync(`${here}AirSmoke.as`, "utf8") },
  ],
  out,
);

/** A connection a server holds: when it closed, by the clock, once it has. */
interface Held {
  closedAt: number | null;
}

/**
 * A TCP server that answers "ping" with "pong" and then sends "tick" to
 * the connection until it closes.
 */
function tickingServer(): { server: Server; held: Held[] } {
  const held: Held[] = [];
  const server = createServer((connection: Socket) => {
    const one: Held = { closedAt: null };
    held.push(one);
    let timer: ReturnType<typeof setInterval> | null = null;
    connection.on("data", (bytes) => {
      if (bytes.toString() === "ping" && !timer) {
        connection.write("pong");
        timer = setInterval(() => connection.write("tick"), TICK_MS);
      }
    });
    connection.on("error", () => {});
    connection.on("close", () => {
      one.closedAt = Date.now();
      if (timer) {
        clearInterval(timer);
      }
    });
  });
  return { server, held };
}

const tcp = tickingServer();
await new Promise<void>((done) => tcp.server.listen(0, "127.0.0.1", done));
const port = (tcp.server.address() as { port: number }).port;

const site = `${out}site/`;
rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });
writeFileSync(`${site}data.txt`, "beside");
// DesktopSmoke connects to the port its name gives; networked, it reaches it.
const movie = `${site}network-${port}.swf`;
writeFileSync(
  movie,
  w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true, true),
      w.backgroundColor(0xffffff),
      w.doAbc(abcs.get("DesktopSmoke") as Uint8Array, "DesktopSmoke"),
      w.symbolClass([[0, "DesktopSmoke"]]),
      w.showFrame(),
      w.end(),
    ],
  }),
);

// Another movie, opened while the page is gone.
const other = `${site}other-${port}.swf`;
writeFileSync(other, readFileSync(movie));

const settings = {
  ...(process.env.SWF2ES_PLAYERGLOBAL === "adobe"
    ? { playerglobal: `${libraries}playerglobal-adobe.abc` }
    : {}),
  recent: [],
  // Allowed, as if the user had said so: a prompt cannot be answered here.
  sockets: {
    [realpathSync(movie)]: [`127.0.0.1:${port}`],
    [realpathSync(other)]: [`127.0.0.1:${port}`],
  },
};

const electron = `process.getBuiltinModule("module").createRequire(${JSON.stringify(desktopPackage)})("electron")`;

/**
 * From now on the app's message boxes are answered with the button at
 * `answer` as they show, or, for null, left open until the app closes
 * them, each one's options kept in `globalThis.offered`: the box itself
 * would wait for a click no test can give it.
 */
async function answerBoxes(main: App["main"], answer: number | null): Promise<void> {
  await main(`(() => {
    const { dialog } = ${electron};
    globalThis.offered ??= [];
    dialog.showMessageBox = (_window, options) => new Promise((done) => {
      const shown = { message: options.message, buttons: options.buttons, closed: false };
      globalThis.offered.push(shown);
      options.signal?.addEventListener("abort", () => {
        shown.closed = true;
        done({ response: options.cancelId, checkboxChecked: false });
      });
      if (${answer} !== null) {
        done({ response: ${answer}, checkboxChecked: false });
      }
    });
    return true;
  })()`);
}

/** Click the menu item `id` through the main process, failing if it is not there or disabled. */
async function click(main: App["main"], id: string): Promise<void> {
  await main(`(() => {
    const item = ${electron}.Menu.getApplicationMenu().getMenuItemById(${JSON.stringify(id)});
    if (!item || !item.enabled) throw new Error(${JSON.stringify(`${id} unavailable`)});
    item.click();
    return true;
  })()`);
}

/** Whether the window shows a page that lives and has loaded, as the main process sees it. */
const pageLives = (main: App["main"]) =>
  main<boolean>(`(async () => {
    const page = ${electron}.BrowserWindow.getAllWindows()[0].webContents;
    if (page.isCrashed() || page.isLoading()) {
      return false;
    }

    const state = page.executeJavaScript("document.readyState");
    return (await Promise.race([state, new Promise((r) => setTimeout(r, 500))])) === "complete";
  })()`);

/**
 * A crash the test made: when, by the clock, the renderer's pid, and how
 * many render-process-gone had come before it.
 */
interface Crash {
  at: number;
  pid: number;
  index: number;
}

/** A render-process-gone, as the main process kept it. */
interface Gone {
  at: number;
  reason: string;
  exitCode: number;
}

/**
 * The window's renderer process crashed, as Chromium crashes one. The main
 * process keeps when each render-process-gone came, by the clock, for a
 * failure to say.
 */
async function crash(main: App["main"]): Promise<Crash> {
  const at = Date.now();
  const { pid, index } = await main<{ pid: number; index: number }>(`(() => {
    const page = ${electron}.BrowserWindow.getAllWindows()[0].webContents;
    if (!globalThis.goneWatched) {
      globalThis.goneWatched = true;
      globalThis.gone = [];
      page.on("render-process-gone", (_event, details) => {
        globalThis.gone.push({ at: Date.now(), reason: details.reason, exitCode: details.exitCode });
      });
    }

    const pid = page.getOSProcessId();
    page.forcefullyCrashRenderer();
    return { pid, index: globalThis.gone.length };
  })()`);
  return { at, pid, index };
}

/** What a failure to close says: the process's state, render-process-gone, and the app's stderr. */
async function whyOpen(app: App, crashed: Crash): Promise<string> {
  let status = "gone";
  let tracer = "0";
  try {
    const lines = readFileSync(`/proc/${crashed.pid}/status`, "utf8").split("\n");
    status = lines.filter((l) => /^(State|TracerPid|PPid):/.test(l)).join(", ");
    tracer = /^TracerPid:\s*(\d+)/m.exec(lines.join("\n"))?.[1] ?? "0";
  } catch {
    // No such process: it has gone.
  }

  const processes = spawnSync("ps", ["-eo", "pid,ppid,stat,wchan:24,etimes,args"], {
    encoding: "utf8",
  })
    .stdout.split("\n")
    // The app's own alone: its processes name its user data, or are the renderer and its tracer.
    .filter(
      (l) => l.includes(app.userData) || new RegExp(`^\\s*(${crashed.pid}|${tracer})\\s`).test(l),
    )
    .map((l) => l.slice(0, 240));
  const gone = await app
    .main<Gone[]>("globalThis.gone")
    .then((events) =>
      events
        .slice(crashed.index)
        .map((e) => `${e.reason} (exit ${e.exitCode}) +${e.at - crashed.at} ms`),
    )
    .catch((error: Error) => [`unknown: ${error.message}`]);
  return [
    `renderer ${crashed.pid}: ${status}`,
    `render-process-gone: ${gone.join("; ") || "none"}`,
    `processes:\n${processes.join("\n")}`,
    `stderr:\n${app.stderr().split("\n").slice(-40).join("\n")}`,
  ].join("\n");
}

/**
 * Wait for the page's process to go, then for `one` to close, failing,
 * saying why, if either takes longer than it may.
 */
async function closedSoon(app: App, what: string, one: Held, crashed: Crash): Promise<void> {
  let gone: Gone | undefined;
  while (!gone) {
    gone = (await app.main<Gone[]>("globalThis.gone"))[crashed.index];
    if (!gone && Date.now() - crashed.at > GONE_WITHIN_MS) {
      assert.fail(
        `${what}: no render-process-gone ${GONE_WITHIN_MS} ms after the crash\n${await whyOpen(app, crashed)}`,
      );
    }

    if (!gone) {
      await sleep(50);
    }
  }

  const goneAt = gone.at;
  await app.until(what, () => one.closedAt !== null || Date.now() - goneAt > CLOSED_WITHIN_MS);
  if (one.closedAt === null || one.closedAt - goneAt > CLOSED_WITHIN_MS) {
    assert.fail(
      `${what}: still open ${CLOSED_WITHIN_MS} ms after render-process-gone\n${await whyOpen(app, crashed)}`,
    );
  }

  console.log(
    `desktop page-gone test: ${what}: the process went ${goneAt - crashed.at} ms after the crash, ` +
      `the connection closed ${one.closedAt - goneAt} ms after that`,
  );
}

const stopped =
  /swf2es: the page stopped: (\S+) \(exit -?\d+\); a crash report, where one was written, is in (.+)\n/g;
const stoppedLines = (stderr: string) => [...stderr.matchAll(stopped)];

const screen = await display();
try {
  await withApp(screen.env, settings, ["--inspect=0", movie], async (app) => {
    const { stdout, stderr, until, main } = app;
    const count = (prefix: string) => stdout.filter((l) => l.startsWith(prefix)).length;
    const name = movie.slice(site.length);

    await until("the SWF's socket", () => count("smoke: socket pong") === 1);
    await until("the server's ticks", () => count("smoke: socket tick") >= 3);

    // Closed, the offer reloads nothing, and the socket is closed all the same; View › Reload
    // Movie brings the movie back.
    await answerBoxes(main, 1);
    const first = await crash(main);
    await closedSoon(app, "the first socket closed", tcp.held[0], first);
    await until("the page stopped", () => stoppedLines(stderr()).length === 1);
    const [line] = stoppedLines(stderr());
    assert.notEqual(line[1], "clean-exit");
    assert.ok(line[2].startsWith(app.userData), `crash reports outside the user data: ${line[2]}`);
    // Whatever the server sent meanwhile, for half a second, went nowhere, unsaid.
    await sleep(500);
    assert.equal(count("smoke: started"), 1, "the page reloaded unasked");
    assert.equal(tcp.held.length, 1);
    assert.deepEqual(await main("globalThis.offered"), [
      { message: `${name} stopped.`, buttons: ["Reload Movie", "Close"], closed: false },
    ]);
    await click(main, "reload-movie");
    await until("the movie reloaded by the menu", () => count("smoke: started") === 2);
    await until("its socket again", () => count("smoke: socket pong") === 2);

    // Answered with Reload Movie, the offer brings it back.
    await answerBoxes(main, 0);
    const second = await crash(main);
    await closedSoon(app, "the second socket closed", tcp.held[1], second);
    await until("the page stopped again", () => stoppedLines(stderr()).length === 2);
    await until("the movie reloaded by the offer", () => count("smoke: started") === 3);
    await until("its socket a third time", () => count("smoke: socket pong") === 3);
    assert.equal(tcp.held.length, 3);
    assert.equal(await main("globalThis.offered.length"), 2);

    // Left open, the offer closes as another movie, opened by a second start, brings the page back.
    await answerBoxes(main, null);
    const third = await crash(main);
    await closedSoon(app, "the third socket closed", tcp.held[2], third);
    await until("the page stopped a third time", () => stoppedLines(stderr()).length === 3);
    assert.equal(await app.again([other]), 0);
    await until("the other movie", () => count("smoke: started") === 4);
    await until("its socket", () => count("smoke: socket pong") === 4);
    assert.ok(
      stdout
        .filter((l) => l.startsWith("smoke: url "))
        .at(-1)
        ?.endsWith(`/other-${port}.swf`),
    );
    assert.deepEqual(await main("globalThis.offered.map((shown) => shown.closed)"), [
      false,
      false,
      true,
    ]);

    // Closing the movie brings a gone page back, empty, rather than leave the window white.
    await answerBoxes(main, 1);
    const fourth = await crash(main);
    await closedSoon(app, "the fourth socket closed", tcp.held[3], fourth);
    await until("the page stopped a fourth time", () => stoppedLines(stderr()).length === 4);
    await click(main, "close-movie");
    let lives = false;
    for (let tries = 0; !lives && tries < 100; tries++) {
      lives = await pageLives(main);
      await sleep(100);
    }

    assert.ok(lives, "the page did not come back after Close Movie");
    assert.equal(count("smoke: started"), 4, "a movie played after Close Movie");
    assert.equal(tcp.held.length, 4);

    assert.equal(await main("1 + 1"), 2, "the main process");
    assert.equal(stoppedLines(stderr()).length, 4);
    assert.doesNotMatch(stderr(), /Error sending from webContents/);
  });

  // An AIR application's WebSocket, and its socket, the same way.
  const ws = { held: [] as Held[] };
  const webSockets = await webSocketServer({
    message: (peer, data) => {
      if (data === "ping") {
        peer.send("pong");
        const one: Held = { closedAt: null };
        ws.held.push(one);
        const timer = setInterval(() => peer.send("tick"), TICK_MS);
        peer.request.socket.once("close", () => {
          one.closedAt = Date.now();
          clearInterval(timer);
        });
      }
    },
  });
  const air = `${out}air-app/`;
  rmSync(air, { recursive: true, force: true });
  mkdirSync(air, { recursive: true });
  writeFileSync(`${air}data.txt`, "beside");
  mkdirSync(`${air}maps/meadow`, { recursive: true });
  writeFileSync(`${air}maps/meadow/level.txt`, "level");
  writeFileSync(
    `${air}AirSmoke-app.xml`,
    `<?xml version="1.0" encoding="utf-8" ?>
<application xmlns="http://ns.adobe.com/air/application/51.3">
  <id>org.swf2es.pagegone</id>
  <filename>AirSmoke</filename>
  <versionNumber>1.0</versionNumber>
  <initialWindow><content>AirSmoke.swf</content><title>Air Smoke</title><width>320</width><height>200</height></initialWindow>
</application>`,
  );
  writeFileSync(
    `${air}AirSmoke.swf`,
    w.swf({
      width: 100,
      height: 50,
      frameRate: 24,
      frameCount: 1,
      tags: [
        w.fileAttributes(true),
        w.doAbc(abcs.get("AirSmoke") as Uint8Array, "AirSmoke"),
        w.symbolClass([[0, "AirSmoke"]]),
        w.showFrame(),
        w.end(),
      ],
    }),
  );
  const heldBefore = tcp.held.length;
  try {
    await withApp(
      screen.env,
      { ...settings, sockets: {} },
      [
        "--inspect=0",
        `${air}AirSmoke-app.xml`,
        "--",
        String(port),
        "page gone",
        // A load refused, which the test does not need.
        "http://127.0.0.1:1/none",
        String(webSockets.port),
      ],
      async (app) => {
        const { stdout, stderr, until, main } = app;
        try {
          await until("the application's socket and WebSocket", () =>
            ["air: socket pong", "air: websocket text tick"].every((l) =>
              stdout.some((s) => s.startsWith(l)),
            ),
          );
          await answerBoxes(main, 1);
          const at = await crash(main);
          await closedSoon(app, "the application's socket closed", tcp.held[heldBefore], at);
          await closedSoon(app, "the application's WebSocket closed", ws.held[0], at);
          await until("the page stopped", () => stoppedLines(stderr()).length === 1);
          await sleep(500);
          assert.equal(await main("1 + 1"), 2, "the main process");
          assert.equal(stoppedLines(stderr()).length, 1);
          assert.doesNotMatch(stderr(), /Error sending from webContents/);
        } finally {
          // The launch with arguments makes a temporary file and directory, the test's to remove.
          const temp = stdout.find((l) => l.startsWith("air: temp paths "));
          for (const path of temp?.slice("air: temp paths ".length).split("|") ?? []) {
            rmSync(path, { recursive: true, force: true });
          }
        }
      },
    );
  } finally {
    await webSockets.close();
  }

  console.log("desktop page-gone test: ok");
} finally {
  tcp.server.close();
  screen.stop();
}
