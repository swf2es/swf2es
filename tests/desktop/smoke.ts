// The desktop app in Electron, end to end: it opens a SWF named on its
// command line, with the libraries its settings name, and the SWF draws,
// traces to the terminal (--trace), loads a file beside it through
// swf2es://file and talks to a TCP server through the main process's
// socket bridge. The page's own policy refuses nothing it needs, and
// playing the SWF again leaves one canvas. Skipped, saying why, where
// Electron was not downloaded (pnpm --filter @swf2es/desktop fetch-electron).
//
//   node tests/desktop/smoke.ts
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { electronBinary, missing } from "../../apps/desktop/electron.ts";
import { bare } from "../player/cases.ts";
import { DevTools } from "../player/chrome.ts";
import { decodePng } from "../player/image.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}out/`;
const appDir = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));
const TIMEOUT = 60_000;

const why = missing();
if (why) {
  console.log(`desktop smoke test: skipped. ${why}`);
  process.exit(0);
}

const source = `package {
  import flash.display.Sprite;
  import flash.events.*;
  import flash.net.*;
  public class DesktopSmoke extends Sprite {
    private var socket:Socket;
    public function DesktopSmoke() {
      graphics.beginFill(0xff0000);
      graphics.drawRect(0, 0, 100, 50);
      trace("smoke: started");
      // No click or key asked for these: the app opens none of them.
      for (var i:int = 0; i < 3; i++) {
        navigateToURL(new URLRequest("https://example.invalid/smoke" + i), "_blank");
      }
      var loader:URLLoader = new URLLoader();
      loader.addEventListener(Event.COMPLETE, loaded);
      loader.addEventListener(IOErrorEvent.IO_ERROR, function (e:IOErrorEvent):void {
        trace("smoke: load failed " + e.text);
      });
      loader.load(new URLRequest("port.txt"));
    }
    private function loaded(e:Event):void {
      var port:int = int(URLLoader(e.target).data);
      socket = new Socket();
      socket.addEventListener(Event.CONNECT, function (e:Event):void {
        socket.writeUTFBytes("ping");
        socket.flush();
      });
      socket.addEventListener(ProgressEvent.SOCKET_DATA, function (e:ProgressEvent):void {
        trace("smoke: socket " + socket.readUTFBytes(socket.bytesAvailable));
      });
      socket.addEventListener(IOErrorEvent.IO_ERROR, function (e:IOErrorEvent):void {
        trace("smoke: socket failed " + e.text);
      });
      socket.connect("127.0.0.1", port);
    }
  }
}`;

const libraries = `${out}libraries/`;
libraryAbcs(libraries);
const abc = compileScripts([{ name: "DesktopSmoke", source }], out).get("DesktopSmoke");
const site = `${out}site/`;
mkdirSync(site, { recursive: true });
const swf = `${site}smoke.swf`;
writeFileSync(swf, bare(abc as Uint8Array, 1, "DesktopSmoke"));

/** A server that answers each "ping" with "pong". */
const server: Server = createServer((connection) => {
  connection.on("data", (bytes) => {
    if (bytes.toString() === "ping") {
      connection.write("pong");
    }
  });
  connection.on("error", () => {});
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
writeFileSync(`${site}port.txt`, String((server.address() as { port: number }).port));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The app running in Electron with these settings and arguments, its terminal and its page. */
interface App {
  /** What it printed to stdout, a line each: the SWF's traces. */
  stdout: string[];
  stderr(): string;
  /** Wait until `done`, failing with what the app printed if it exits or a minute passes. */
  until(what: string, done: () => boolean): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  devtools: DevTools;
  /** Start the app again on the same user data, with `args`; its exit code. */
  again(args: string[]): Promise<number | null>;
}

async function withApp(
  settings: object,
  args: string[],
  run: (app: App) => Promise<void>,
): Promise<void> {
  const userData = mkdtempSync(join(tmpdir(), "swf2es-desktop-"));
  writeFileSync(join(userData, "settings.json"), JSON.stringify(settings));
  const stdout: string[] = [];
  let stderr = "";
  let exited: string | null = null;
  let electron: ChildProcess | null = null;
  let socket: WebSocket | null = null;
  const start = (more: string[]) =>
    spawn(
      electronBinary() as string,
      [
        appDir,
        // Chromium's headless mode, which Electron keeps (its build has no
        // headless Ozone), and a GPU of software: no display needed, and it
        // draws alike anywhere.
        "--headless",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        ...more,
      ],
      {
        env: { ...process.env, SWF2ES_DESKTOP_USER_DATA: userData },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  try {
    electron = start(["--trace", "--remote-debugging-port=0", ...args]);
    electron.on("exit", (code, signal) => {
      exited = `exit ${code ?? signal}`;
    });
    let partial = "";
    electron.stdout?.on("data", (chunk: Buffer) => {
      const lines = (partial + chunk.toString()).split("\n");
      partial = lines.pop() ?? "";
      stdout.push(...lines);
    });
    electron.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const until = async (what: string, done: () => boolean) => {
      for (let waited = 0; !done(); waited += 100) {
        if (exited || waited > TIMEOUT) {
          throw new Error(
            `${what}: ${exited ?? "timed out"}\nstdout:\n${stdout.join("\n")}\nstderr:\n${stderr}`,
          );
        }

        await sleep(100);
      }
    };

    // Electron writes the port it chose into its user data, as Chrome into its profile.
    let port = "";
    await until("the DevTools port", () => {
      try {
        port = readFileSync(join(userData, "DevToolsActivePort"), "utf8").split("\n")[0];
      } catch {
        // Not yet.
      }

      return port !== "";
    });
    let target: { webSocketDebuggerUrl: string } | undefined;
    for (let tries = 0; !target; tries++) {
      let targets: { type: string; url: string; webSocketDebuggerUrl: string }[] = [];
      try {
        targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      } catch {
        // Not listening yet.
      }

      target = targets.find((t) => t.type === "page" && t.url.startsWith("swf2es://app/"));
      if (!target) {
        assert.ok(tries < 100, JSON.stringify(targets));
        await sleep(100);
      }
    }

    const connected = new WebSocket(target.webSocketDebuggerUrl);
    socket = connected;
    await new Promise((done, fail) => {
      connected.addEventListener("open", done);
      connected.addEventListener("error", fail);
    });
    const devtools = new DevTools(connected);
    const evaluate = async <T>(expression: string): Promise<T> => {
      const { result, exceptionDetails } = await devtools.send<{
        result: { value: T };
        exceptionDetails?: { exception?: { description?: string } };
      }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      assert.equal(exceptionDetails, undefined, exceptionDetails?.exception?.description);
      return result.value;
    };

    const again = (more: string[]) =>
      new Promise<number | null>((done) => start(more).on("exit", (code) => done(code)));
    await run({ stdout, stderr: () => stderr, until, evaluate, devtools, again });
    // What the page's policy refused, as Chromium words it; Electron's own warning about 'unsafe-eval' is not one.
    assert.doesNotMatch(stderr, /violates the following Content Security Policy/);
  } finally {
    socket?.close();
    // Gone before its user data is: it writes there as it quits.
    const running = electron;
    if (running && running.exitCode === null && running.signalCode === null) {
      const gone = new Promise((done) => running.once("exit", done));
      running.kill();
      await gone;
    }

    rmSync(userData, { recursive: true, force: true });
  }
}

const both = {
  builtin: `${libraries}builtin.abc`,
  playerglobal: `${libraries}playerglobal.abc`,
  recent: [],
};

try {
  // Opened through a link, the SWF plays from the file it links to, and loads beside that.
  // In a directory of its own, which the file it links to is not under.
  const link = `${out}links/smoke.swf`;
  mkdirSync(`${out}links`, { recursive: true });
  rmSync(link, { force: true });
  symlinkSync(swf, link);

  await withApp(both, [link], async ({ stdout, stderr, until, evaluate, devtools, again }) => {
    const traced = (line: string) => stdout.filter((l) => l === line).length;
    await until("the SWF's socket", () => traced("smoke: socket pong") > 0);
    assert.equal(traced("smoke: started"), 1);

    // The stage, red all over, fills the window as showAll places it.
    const { data } = await devtools.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    const image = decodePng(new Uint8Array(Buffer.from(data, "base64")));
    const centre = ((image.height >> 1) * image.width + (image.width >> 1)) * 4;
    assert.deepEqual([...image.data.subarray(centre, centre + 3)], [255, 0, 0]);

    // Played again, the last player let go of: one canvas, and the SWF starts anew.
    const url = `swf2es://file${pathToFileURL(swf).pathname}`;
    const canvases = await evaluate<number>(`(async () => {
      const player = document.getElementById("player");
      await player.load(${JSON.stringify(url)});
      return player.shadowRoot.querySelectorAll("canvas").length;
    })()`);
    assert.equal(canvases, 1);
    await until("the SWF played again", () => traced("smoke: started") === 2);

    // Dropped on the window, the SWF goes to the shell, which opens it: it plays a third time.
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await devtools.send("Input.dispatchDragEvent", {
        type,
        x: 100,
        y: 100,
        data: { items: [], files: [swf], dragOperationsMask: 1 },
      });
    }

    await until("the dropped SWF", () => traced("smoke: started") === 3);

    // Nine pages asked for, by three starts, none after a gesture: none opened.
    assert.equal(stderr().match(/not opening https:\/\/example\.invalid\/smoke\d/g)?.length, 9);

    // Malformed %-escapes are a bad request, not a crash.
    assert.equal(
      await evaluate<number>(`fetch("swf2es://file/%E0%A4%A").then((r) => r.status)`),
      400,
    );

    // Started again with the SWF after a switch's value and a .swf that is not
    // there, the second start hands the SWF to the first and quits.
    assert.equal(await again(["--lang", "value", `${site}missing.swf`, swf]), 0);
    await until("the SWF from a second start", () => traced("smoke: started") === 4);

    // A file outside the SWF's directory is not the page's to read.
    const outside = `swf2es://file${pathToFileURL(fileURLToPath(new URL("smoke.ts", import.meta.url))).pathname}`;
    assert.equal(
      await evaluate<number>(`fetch(${JSON.stringify(outside)}).then((r) => r.status)`),
      404,
    );
  });

  // Without playerglobal.abc, the page says what is missing and why it is not there.
  await withApp({ recent: [] }, [swf], async ({ evaluate }) => {
    let failure = "";
    for (let tries = 0; failure === "" && tries < 100; tries++) {
      // Null until the page has parsed, which may be after DevTools first finds it.
      failure = await evaluate<string>(
        `(() => { const f = document.getElementById("failure"); return f && !f.hidden ? f.textContent : ""; })()`,
      );
      if (failure === "") {
        await sleep(100);
      }
    }

    assert.match(failure, /smoke\.swf needs the libraries below/);
    const panel = await evaluate<{ hidden: boolean; playerglobal: string; text: string }>(`({
      hidden: document.getElementById("libraries").hidden,
      playerglobal: document.getElementById("playerglobal-path").textContent,
      text: document.getElementById("libraries").textContent,
    })`);
    assert.equal(panel.hidden, false);
    assert.equal(panel.playerglobal, "not found");
    assert.match(panel.text, /may not be redistributed/);
  });

  console.log("desktop smoke test: ok");
} finally {
  server.close();
}
