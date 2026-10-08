// The desktop app in Electron, end to end: it opens a SWF named on its
// command line, with the libraries its settings name, and the SWF draws
// and traces to the terminal (--trace). A SWF in local-with-filesystem
// reads the file beside it and reaches no network and no socket; one in
// local-with-networking reads no file but talks to a TCP server, allowed
// in the settings, through the main process; neither reads outside its
// directory, so neither can send away what it read. A SWF opened by its
// http URL, from the command line or the URL dialog, plays in the remote
// sandbox: it reads its own origin and another whose crossdomain.xml
// grants it, not one without, no local file, and connects only the socket
// whose server answers with a socket policy. The page's policy refuses
// nothing it needs, and playing the SWF again leaves one canvas.
// Skipped, saying why, where Electron was not downloaded
// (pnpm --filter @swf2es/desktop fetch-electron).
//
//   node tests/desktop/smoke.ts
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronBinary, missing } from "../../apps/desktop/electron.ts";
import { DevTools } from "../player/chrome.ts";
import { decodePng } from "../player/image.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";
import * as w from "../swf-writer.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}out/`;
const appDir = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));
const TIMEOUT = 60_000;

const why = missing();
if (why) {
  console.log(`desktop smoke test: skipped. ${why}`);
  process.exit(0);
}

// The same code in two SWFs, one in each sandbox: it names its URL, reads
// a file beside it and one outside its directory, asks for the network,
// and connects a socket to the port its file name gives.
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
      trace("smoke: url " + loaderInfo.url);
      // No click or key asked for these: the app opens none of them.
      for (var i:int = 0; i < 3; i++) {
        navigateToURL(new URLRequest("https://example.invalid/smoke" + i), "_blank");
      }
      load("beside", "data.txt");
      load("outside", "../secret.txt");
      load("network", "https://example.invalid/network");
      var port:int = int(/-(\\d+)\\.swf$/.exec(loaderInfo.url)[1]);
      socket = new Socket();
      socket.addEventListener(Event.CONNECT, function (e:Event):void {
        socket.writeUTFBytes("ping");
        socket.flush();
      });
      socket.addEventListener(ProgressEvent.SOCKET_DATA, function (e:ProgressEvent):void {
        trace("smoke: socket " + socket.readUTFBytes(socket.bytesAvailable));
      });
      socket.addEventListener(IOErrorEvent.IO_ERROR, function (e:IOErrorEvent):void {
        trace("smoke: socket refused");
      });
      socket.connect("127.0.0.1", port);
    }
    private function load(label:String, url:String):void {
      var loader:URLLoader = new URLLoader();
      loader.addEventListener(Event.COMPLETE, function (e:Event):void {
        trace("smoke: " + label + " " + loader.data);
      });
      loader.addEventListener(IOErrorEvent.IO_ERROR, function (e:IOErrorEvent):void {
        trace("smoke: " + label + " refused");
      });
      loader.load(new URLRequest(url));
    }
  }
}`;

// A remote SWF: it names its URL and sandbox, reads its own origin, two
// others and two local files, as its query names them, and connects two
// sockets, one to a server with a socket policy and one without.
const remoteSource = `package {
  import flash.display.Sprite;
  import flash.events.*;
  import flash.net.*;
  import flash.system.Security;
  public class RemoteSmoke extends Sprite {
    private var sockets:Array = [];
    public function RemoteSmoke() {
      var p:Object = loaderInfo.parameters;
      trace("remote: url " + loaderInfo.url);
      trace("remote: sandbox " + Security.sandboxType);
      load("same", "data.txt");
      load("allowed", p.allowed);
      load("denied", p.denied);
      load("file", p.file);
      load("local", "file:///etc/hostname");
      connect("socket-ok", int(p.good));
      connect("socket-no", int(p.bad));
    }
    private function load(label:String, url:String):void {
      var loader:URLLoader = new URLLoader();
      loader.addEventListener(Event.COMPLETE, function (e:Event):void {
        trace("remote: " + label + " " + loader.data);
      });
      loader.addEventListener(IOErrorEvent.IO_ERROR, function (e:IOErrorEvent):void {
        trace("remote: " + label + " refused");
      });
      loader.load(new URLRequest(url));
    }
    private function connect(label:String, port:int):void {
      var socket:Socket = new Socket();
      sockets.push(socket);
      socket.addEventListener(Event.CONNECT, function (e:Event):void {
        socket.writeUTFBytes("ping");
        socket.flush();
      });
      socket.addEventListener(ProgressEvent.SOCKET_DATA, function (e:ProgressEvent):void {
        trace("remote: " + label + " " + socket.readUTFBytes(socket.bytesAvailable));
      });
      socket.addEventListener(IOErrorEvent.IO_ERROR, function (e:IOErrorEvent):void {
        trace("remote: " + label + " refused");
      });
      socket.connect("127.0.0.1", port);
    }
  }
}`;

const libraries = `${out}libraries/`;
libraryAbcs(libraries);
const abcs = compileScripts(
  [
    { name: "DesktopSmoke", source },
    { name: "RemoteSmoke", source: remoteSource },
  ],
  out,
);
const abc = abcs.get("DesktopSmoke");

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
const port = (server.address() as { port: number }).port;

const site = `${out}site/`;
rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });
writeFileSync(`${site}data.txt`, "beside");
writeFileSync(`${out}secret.txt`, "secret");

/** The SWF, its UseNetwork bit `network`, which picks its sandbox. */
function smokeSwf(name: string, network: boolean): string {
  const path = `${site}${name}-${port}.swf`;
  writeFileSync(
    path,
    w.swf({
      width: 100,
      height: 50,
      frameRate: 24,
      frameCount: 1,
      tags: [
        w.fileAttributes(true, network),
        w.backgroundColor(0xffffff),
        w.doAbc(abc as Uint8Array, "DesktopSmoke"),
        w.symbolClass([[0, "DesktopSmoke"]]),
        w.showFrame(),
        w.end(),
      ],
    }),
  );
  return path;
}

const local = smokeSwf("local", false);
const networked = smokeSwf("network", true);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An HTTP server on 127.0.0.1 answering each path with what `files` has for it, else a 404. */
async function httpSite(files: Record<string, [type: string, body: string | Uint8Array]>) {
  const http = createHttpServer((request, response) => {
    const file = files[new URL(request.url ?? "/", "http://x").pathname];
    if (file) {
      response.writeHead(200, { "content-type": file[0] }).end(file[1]);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  return { server: http, origin: `http://127.0.0.1:${(http.address() as { port: number }).port}` };
}

/**
 * A TCP server on 127.0.0.1 that answers "ping" with "pong", and a
 * policy request with `policy` (given its port), or by closing.
 */
async function socketSite(policy: ((port: number) => string) | null) {
  let port = 0;
  const tcp: Server = createServer((connection) => {
    connection.on("error", () => {});
    connection.on("data", (bytes) => {
      if (bytes.toString() === "<policy-file-request/>\0") {
        if (policy) {
          connection.end(`${policy(port)}\0`);
        } else {
          connection.end();
        }
      } else if (bytes.toString() === "ping") {
        connection.write("pong");
      }
    });
  });
  await new Promise<void>((done) => tcp.listen(0, "127.0.0.1", done));
  port = (tcp.address() as { port: number }).port;
  return { server: tcp, port };
}

/**
 * The remote sandbox: a SWF opened by its http URL, from the command line
 * and then from the URL dialog.
 */
async function remote(): Promise<void> {
  const xml = (rules: string) => `<cross-domain-policy>${rules}</cross-domain-policy>`;
  const swfBytes = w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true, false),
      w.backgroundColor(0xffffff),
      w.doAbc(abcs.get("RemoteSmoke") as Uint8Array, "RemoteSmoke"),
      w.symbolClass([[0, "RemoteSmoke"]]),
      w.showFrame(),
      w.end(),
    ],
  });
  const home = await httpSite({
    "/remote.swf": ["application/x-shockwave-flash", swfBytes],
    "/data.txt": ["text/plain", "same"],
  });
  const allowed = await httpSite({
    "/crossdomain.xml": [
      "text/x-cross-domain-policy",
      xml('<allow-access-from domain="127.0.0.1"/>'),
    ],
    "/data.txt": ["text/plain", "allowed"],
  });
  const denied = await httpSite({ "/data.txt": ["text/plain", "denied"] });
  const good = await socketSite((port) =>
    xml(`<allow-access-from domain="127.0.0.1" to-ports="${port}"/>`),
  );
  const bad = await socketSite(null);
  // The local SWF's own URL: its directory's token, a hash of its real path.
  const token = createHash("sha256").update(realpathSync(site)).digest("hex").slice(0, 16);
  const query = new URLSearchParams({
    allowed: `${allowed.origin}/data.txt`,
    denied: `${denied.origin}/data.txt`,
    file: `swf2es://file/${token}/data.txt`,
    good: String(good.port),
    bad: String(bad.port),
  });
  const url = new URL(`${home.origin}/remote.swf?${query}`).href;
  const again = `${url}&again=1`;
  // The user's word given for both sockets, from both URLs: the socket policy decides.
  const endpoints = [`127.0.0.1:${good.port}`, `127.0.0.1:${bad.port}`];
  const settings = { ...both, sockets: { [url]: endpoints, [again]: endpoints } };

  try {
    await withApp(settings, [url], async ({ stdout, stderr, until, evaluate, page, userData }) => {
      const traced = (line: string) => stdout.filter((l) => l === line).length;
      const settled = (n: number) => () =>
        ["same", "allowed", "denied", "file", "local", "socket-ok", "socket-no"].every(
          (what) => stdout.filter((l) => l.startsWith(`remote: ${what} `)).length >= n,
        );
      await until("the remote SWF", settled(1));
      assert.equal(traced(`remote: url ${url}`), 1);
      assert.equal(traced("remote: sandbox remote"), 1);
      assert.equal(traced("remote: same same"), 1);
      assert.equal(traced("remote: allowed allowed"), 1);
      assert.equal(traced("remote: denied refused"), 1);
      assert.equal(traced("remote: file refused"), 1);
      assert.equal(traced("remote: local refused"), 1);
      assert.equal(traced("remote: socket-ok pong"), 1);
      assert.equal(traced("remote: socket-no refused"), 1);
      assert.match(
        stderr(),
        new RegExp(
          `not loading ${denied.origin.replaceAll(".", "\\.")}/data\\.txt: ` +
            "no policy file on .* grants 127\\.0\\.0\\.1",
        ),
      );
      assert.match(
        stderr(),
        new RegExp(`no socket to 127\\.0\\.0\\.1:${bad.port}: no socket policy`),
      );
      // Nor may the page read the local SWF's files while a remote one plays.
      assert.equal(
        await evaluate<number>(`fetch("swf2es://file/${token}/data.txt").then((r) => r.status)`),
        404,
      );

      // The URL dialog, asked for by the page, answered by the user: the SWF plays again.
      await evaluate("window.swf2esDesktop.openUrlDialog()");
      const dialog = await page("swf2es://app/open-url.html");
      const run = async (expression: string) => {
        for (let tries = 0; ; tries++) {
          const { result } = await dialog.send<{ result: { value: unknown } }>("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
          if (result.value === true || tries > 100) {
            return result.value;
          }

          await sleep(100);
        }
      };
      // Its field starts with the URL playing, for the user to change.
      assert.equal(
        await run(`document.getElementById("url")?.value === ${JSON.stringify(url)}`),
        true,
      );
      await run(`(() => {
        document.getElementById("url").value = ${JSON.stringify(again)};
        // After this answer: the window closes as it submits, and its DevTools with it.
        setTimeout(() => document.getElementById("form").requestSubmit(), 100);
        return true;
      })()`);
      await until("the SWF from the dialog", settled(2));
      assert.equal(traced(`remote: url ${again}`), 1);
      assert.equal(traced("remote: allowed allowed"), 2);
      assert.equal(traced("remote: denied refused"), 2);
      assert.equal(traced("remote: socket-ok pong"), 2);
      assert.equal(traced("remote: socket-no refused"), 2);

      // Both URLs are in the recent list.
      const recent = JSON.parse(readFileSync(join(userData, "settings.json"), "utf8")).recent;
      assert.deepEqual(recent.slice(0, 2), [again, url]);
    });
  } finally {
    for (const server of [home.server, allowed.server, denied.server, good.server, bad.server]) {
      server.close();
    }
  }
}

/**
 * A display of the test's own. Electron's --headless still draws through
 * a Wayland or X display it finds, and a compositor whose screen is
 * locked or asleep sends it no frames, so the player never advanced; and
 * with no display at all GTK aborts it ("Can't create a GtkStyleContext
 * without a display connection"), as on a CI runner. So the test starts
 * an Xvfb where there is one, and draws there; elsewhere it leaves the
 * user's display out, which GTK still finds through XDG_RUNTIME_DIR.
 */
async function display(): Promise<{ env: NodeJS.ProcessEnv; stop(): void }> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name !== "DISPLAY" && name !== "WAYLAND_DISPLAY",
    ),
  );
  const xvfb = spawnSync("sh", ["-c", "command -v Xvfb"], { encoding: "utf8" }).stdout.trim();
  if (!xvfb) {
    return { env: base, stop() {} };
  }

  // Xvfb writes the display it chose to the descriptor -displayfd names.
  const x = spawn(xvfb, ["-displayfd", "3", "-screen", "0", "1280x1024x24", "-nolisten", "tcp"], {
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  const number = await new Promise<string>((done, fail) => {
    let text = "";
    x.stdio[3]?.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("\n")) {
        done(text.trim());
      }
    });
    x.on("exit", (code) => fail(new Error(`Xvfb exited with ${code}`)));
  });
  return {
    env: { ...base, DISPLAY: `:${number}`, GDK_BACKEND: "x11", XDG_SESSION_TYPE: "x11" },
    stop: () => x.kill(),
  };
}

const screen = await display();

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
  /** DevTools for another of its pages, once there is one whose URL starts with `prefix`. */
  page(prefix: string): Promise<DevTools>;
  userData: string;
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
  /** The other pages' DevTools connections. */
  const sockets: WebSocket[] = [];
  const start = (more: string[]) =>
    spawn(
      electronBinary() as string,
      [
        appDir,
        // Chromium's headless mode, which Electron keeps (its build has no
        // headless Ozone), on the test's own display (display()), and a GPU
        // of software: it draws alike anywhere.
        "--headless",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        ...more,
      ],
      {
        env: { ...screen.env, SWF2ES_DESKTOP_USER_DATA: userData },
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
    // The window's page, as DevTools lists it: a cold start on a CI runner
    // has taken more than 10 s to open it.
    let target: { webSocketDebuggerUrl: string } | undefined;
    let targets: { type: string; url: string; webSocketDebuggerUrl: string }[] = [];
    for (let waited = 0; !target; waited += 250) {
      try {
        targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as typeof targets;
      } catch {
        // Not listening yet.
      }

      target = targets.find((t) => t.type === "page" && t.url.startsWith("swf2es://app/"));
      if (!target) {
        if (exited || waited > TIMEOUT) {
          throw new Error(
            `the app's page on swf2es://app/: ${exited ?? "timed out"}, ` +
              `DevTools listing ${JSON.stringify(targets)}\nstderr:\n${stderr}`,
          );
        }

        await sleep(250);
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
    const pageOf = async (prefix: string): Promise<DevTools> => {
      let found: { webSocketDebuggerUrl: string } | undefined;
      for (let waited = 0; !found; waited += 250) {
        const listed = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
          type: string;
          url: string;
          webSocketDebuggerUrl: string;
        }[];
        found = listed.find((t) => t.type === "page" && t.url.startsWith(prefix));
        if (!found) {
          if (exited || waited > TIMEOUT) {
            throw new Error(`a page on ${prefix}: ${exited ?? "timed out"}\nstderr:\n${stderr}`);
          }

          await sleep(250);
        }
      }

      const other = new WebSocket(found.webSocketDebuggerUrl);
      sockets.push(other);
      await new Promise((done, fail) => {
        other.addEventListener("open", done);
        other.addEventListener("error", fail);
      });
      return new DevTools(other);
    };
    await run({
      stdout,
      stderr: () => stderr,
      until,
      evaluate,
      devtools,
      again,
      page: pageOf,
      userData,
    });
    // What the page's policy refused, as Chromium words it; Electron's own warning about 'unsafe-
    // eval' is not one.
    assert.doesNotMatch(stderr, /violates the following Content Security Policy/);
  } finally {
    socket?.close();
    for (const other of sockets) {
      other.close();
    }

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
  // Always allowed, as if the user had said so: a prompt cannot be answered here.
  sockets: { [realpathSync(networked)]: [`127.0.0.1:${port}`] },
};

try {
  // Opened through a link, in a directory of its own which the file it
  // links to is not under, the SWF plays from that file, and its sandbox
  // is that file's directory.
  const link = `${out}links/local.swf`;
  // Afresh: last run's link dangles, its SWF named for another port.
  rmSync(`${out}links`, { recursive: true, force: true });
  mkdirSync(`${out}links`);
  symlinkSync(local, link);

  await withApp(both, [link], async ({ stdout, stderr, until, evaluate, devtools, again }) => {
    const traced = (line: string) => stdout.filter((l) => l === line).length;
    const settled = (n: number) => () =>
      ["beside", "outside", "socket"].every(
        (what) => stdout.filter((l) => l.startsWith(`smoke: ${what} `)).length >= n,
      );
    await until("the local SWF", settled(1));
    assert.equal(traced("smoke: started"), 1);
    assert.equal(traced("smoke: beside beside"), 1);
    assert.equal(traced("smoke: outside refused"), 1);
    assert.equal(traced("smoke: socket refused"), 1);
    assert.match(
      stderr(),
      /not loading https:\/\/example\.invalid\/network: the SWF has no network/,
    );
    assert.match(
      stderr(),
      new RegExp(`no socket to 127\\.0\\.0\\.1:${port}: the SWF has no network`),
    );

    // Its URL names a token for its directory, not where it is.
    const url = stdout.find((l) => l.startsWith("smoke: url "))?.slice("smoke: url ".length) ?? "";
    assert.match(url, new RegExp(`^swf2es://file/[0-9a-f]{16}/local-${port}\\.swf$`));

    // The stage, red all over, fills the window as showAll places it.
    const { data } = await devtools.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    const image = decodePng(new Uint8Array(Buffer.from(data, "base64")));
    const centre = ((image.height >> 1) * image.width + (image.width >> 1)) * 4;
    assert.deepEqual([...image.data.subarray(centre, centre + 3)], [255, 0, 0]);

    // Played again, the last player let go of: one canvas, and the SWF starts anew.
    const canvases = await evaluate<number>(`(async () => {
      const player = document.getElementById("player");
      await player.load(${JSON.stringify(url)});
      return player.shadowRoot.querySelectorAll("canvas").length;
    })()`);
    assert.equal(canvases, 1);
    await until("the SWF played again", settled(2));

    // Dropped on the window, the SWF goes to the shell, which opens it: it plays a third time.
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await devtools.send("Input.dispatchDragEvent", {
        type,
        x: 100,
        y: 100,
        data: { items: [], files: [local], dragOperationsMask: 1 },
      });
    }

    await until("the dropped SWF", settled(3));
    assert.equal(traced("smoke: started"), 3);

    // Nine pages asked for, by three starts of a SWF with no network: none opened.
    const noNetwork = /not opening https:\/\/example\.invalid\/smoke\d: the SWF has no network/g;
    await until("the pages refused", () => (stderr().match(noNetwork)?.length ?? 0) >= 9);
    assert.equal(stderr().match(noNetwork)?.length, 9);

    // Malformed %-escapes are a bad request, not a crash.
    assert.equal(
      await evaluate<number>(`fetch("swf2es://file/%E0%A4%A").then((r) => r.status)`),
      400,
    );

    // Nor may the page read past the SWF's directory.
    const outside = new URL("../../smoke.ts", url).href;
    assert.equal(
      await evaluate<number>(`fetch(${JSON.stringify(outside)}).then((r) => r.status)`),
      404,
    );

    // Started again with the networked SWF after a switch's value and a .swf
    // that is not there, the second start hands it to the first and quits.
    // The local SWF's grant goes with it: the networked one reads no file,
    // beside it or not, and talks to its server.
    assert.equal(await again(["--lang", "value", `${site}missing.swf`, networked]), 0);
    await until("the networked SWF's socket", () => traced("smoke: socket pong") === 1);
    await until("the networked SWF's reads", settled(4));
    assert.equal(traced("smoke: beside refused"), 1);
    // The networked SWF may open pages, but not without a click or a key.
    const noGesture = /not opening https:\/\/example\.invalid\/smoke\d: no click or key/g;
    // Its stderr may come after its stdout: wait for the three.
    await until("the networked SWF's pages", () => (stderr().match(noGesture)?.length ?? 0) >= 3);
    assert.equal(stderr().match(noGesture)?.length, 3);
    assert.equal(traced("smoke: outside refused"), 4);
    // Its network load went to the main process, which found no such host, where the local
    // SWF's three were stopped for want of the network.
    assert.equal(
      stderr().match(/not loading https:\/\/example\.invalid\/network: the SWF has no network/g)
        ?.length,
      3,
    );
    await until("the networked SWF's load", () =>
      /not loading https:\/\/example\.invalid\/network: example\.invalid has no address/.test(
        stderr(),
      ),
    );
    assert.equal(
      await evaluate<number>(`fetch(${JSON.stringify(url)}).then((r) => r.status)`),
      404,
    );

    // A SWF whose header names 4 GB and whose LZMA stream would decode zeros
    // all the way: the main process reads its start alone, and the page
    // refuses it at once, saying so.
    const bomb = `${site}bomb.swf`;
    const bytes = new Uint8Array(30);
    bytes.set([
      0x5a, 0x57, 0x53, 10, 0xff, 0xff, 0xff, 0xff, 13, 0, 0, 0, 0x5d, 0xff, 0xff, 0xff, 0xff,
    ]);
    writeFileSync(bomb, bytes);
    const started = performance.now();
    assert.equal(await again([bomb]), 0);
    let failure = "";
    for (let tries = 0; !failure.includes("bomb.swf") && tries < 100; tries++) {
      failure = await evaluate<string>(`document.getElementById("failure").textContent`);
      await sleep(50);
    }

    assert.match(failure, /bomb\.swf did not play/);
    assert.ok(performance.now() - started < 5000, `${performance.now() - started} ms`);

    // After a click, the SWF with no network still opens no page: its sandbox
    // refuses what the gesture would allow.
    for (const type of ["mousePressed", "mouseReleased"]) {
      await devtools.send("Input.dispatchMouseEvent", {
        type,
        x: 10,
        y: 10,
        button: "left",
        clickCount: 1,
      });
    }

    assert.equal(await again([local]), 0);
    await until("the local SWF after a click", () => traced("smoke: started") === 5);
    await until("its pages refused", () => (stderr().match(noNetwork)?.length ?? 0) === 12);
    assert.equal(stderr().match(noGesture)?.length, 3);
  });

  // Without playerglobal.abc, the page says what is missing and why it is not there.
  await withApp({ recent: [] }, [local], async ({ evaluate }) => {
    let failure = "";
    for (let tries = 0; failure === "" && tries < 100; tries++) {
      // Null until the page has parsed, which may be after DevTools first finds it.
      failure = await evaluate<string>(
        `(() => {
          const f = document.getElementById("failure");
          return f && !f.hidden ? f.textContent : "";
        })()`,
      );
      if (failure === "") {
        await sleep(100);
      }
    }

    assert.match(failure, /local-\d+\.swf needs the libraries below/);
    const panel = await evaluate<{ hidden: boolean; playerglobal: string; text: string }>(`({
      hidden: document.getElementById("libraries").hidden,
      playerglobal: document.getElementById("playerglobal-path").textContent,
      text: document.getElementById("libraries").textContent,
    })`);
    assert.equal(panel.hidden, false);
    assert.equal(panel.playerglobal, "not found");
    assert.match(panel.text, /may not be redistributed/);
  });

  await remote();

  console.log("desktop smoke test: ok");
} finally {
  server.close();
  screen.stop();
}
