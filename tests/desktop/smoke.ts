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
// nothing it needs, the page is cross-origin isolated, and playing the SWF
// again leaves one canvas. A SWF's workers share a Mutex and memory there.
// Skipped, saying why, where Electron was not downloaded
// (pnpm --filter @swf2es/desktop fetch-electron).
//
//   node tests/desktop/smoke.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { missing } from "../../apps/desktop/src/launch/electron.ts";
import { cases } from "../player/cases.ts";
import { decodePng } from "../player/image.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";
import * as w from "../swf-writer.ts";
import { type App, display, withApp as runApp } from "./app.ts";
import { webSocketServer } from "./websocket-server.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const desktopPackage = fileURLToPath(new URL("../../apps/desktop/package.json", import.meta.url));
const out = `${here}out/`;

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

// An AIR application's SWF, run adl's way by its descriptor: it names its
// URL and sandbox, its launch's arguments and directory, what File finds
// in its directory and outside it, reads a file by an app: URL, by a
// FileStream, and one outside by its file: URL, connects a socket to the
// port its argument names, unasked, names its window's title, and, given
// a third argument, opens an air.net.WebSocket to that port: a text
// message and a binary one each way, until the server closes it; and,
// given a fourth, two more to that port over TLS, by address and by name.
const airSource = `package {
  import flash.desktop.NativeApplication;
  import flash.display.Screen;
  import flash.display.Sprite;
  import flash.events.*;
  import flash.filesystem.File;
  import flash.filesystem.FileMode;
  import flash.filesystem.FileStream;
  import flash.geom.Rectangle;
  import flash.net.*;
  import flash.system.Security;
  import flash.utils.ByteArray;
  import flash.utils.getDefinitionByName;
  public class AirSmoke extends Sprite {
    private var socket:Socket;
    private var webSockets:Array = [];
    public function AirSmoke() {
      trace("air: url " + loaderInfo.url);
      trace("air: sandbox " + Security.sandboxType);
      trace("air: title " + stage.nativeWindow.title);
      // The system's displays: the main one among them, and the one the window is on.
      var main:Screen = Screen.mainScreen;
      trace("air: screen " + (main.bounds.width > 0 && main.visibleBounds.height > 0) + " " + (main.colorDepth >= 8) + " " + (Screen.screens.length >= 1) + " " + Screen.getScreensForRectangle(stage.nativeWindow.bounds).length);
      NativeApplication.nativeApplication.addEventListener(InvokeEvent.INVOKE, function (e:InvokeEvent):void {
        trace("air: invoke " + e.arguments.join("|") + " " + e.currentDirectory.exists);
        // app:/ has no parent, as adl's: up from its native path, under file:.
        var outside:File = new File(File.applicationDirectory.nativePath).parent.resolvePath("air-outside.txt");
        trace("air: files " + File.applicationDirectory.resolvePath("data.txt").exists + " " + outside.exists + " " + outside.url.indexOf("file:///"));
        var stream:FileStream = new FileStream();
        stream.open(File.applicationDirectory.resolvePath("data.txt"), FileMode.READ);
        trace("air: stream " + stream.readUTFBytes(stream.bytesAvailable));
        stream.close();
        load("app", "data.txt");
        load("file", outside.url);
        if (e.arguments.length > 2) {
          load("http", e.arguments[2]);
        }
        socket = new Socket();
        socket.addEventListener(Event.CONNECT, function (e:Event):void {
          socket.writeUTFBytes("ping");
          socket.flush();
        });
        socket.addEventListener(ProgressEvent.SOCKET_DATA, function (e:ProgressEvent):void {
          trace("air: socket " + socket.readUTFBytes(socket.bytesAvailable));
        });
        socket.addEventListener(IOErrorEvent.IO_ERROR, function (e:IOErrorEvent):void {
          trace("air: socket refused");
        });
        socket.connect("127.0.0.1", int(e.arguments[0]));
        if (e.arguments.length > 3) {
          connectWebSocket("websocket", "ws://127.0.0.1:" + e.arguments[3] + "/smoke?q=1");
        }
        if (e.arguments.length > 4) {
          connectWebSocket("wss-address", "wss://127.0.0.1:" + e.arguments[4] + "/");
          connectWebSocket("wss-name", "wss://localhost:" + e.arguments[4] + "/");
        }
        // Full screen as an application asks for it: from no click or key, over a part of its stage.
        if (e.arguments.length > 1) {
          stage.addEventListener(FullScreenEvent.FULL_SCREEN, function (f:FullScreenEvent):void {
            trace("air: fullScreen " + f.fullScreen + " " + f.interactive + " " + stage.displayState);
          });
          stage.fullScreenSourceRect = new Rectangle(0, 0, 50, 50);
          stage.displayState = "fullScreenInteractive";
          trace("air: displayState " + stage.displayState + " " + stage.stageWidth + "x" + stage.stageHeight);
        }
      });
    }
    private function connectWebSocket(label:String, url:String):void {
      // By name, and its event untyped: the playerglobal ASC compiles against has no AIR 51.
      var WebSocket:Class = getDefinitionByName("air.net.WebSocket") as Class;
      var webSocket:Object = new WebSocket();
      webSockets.push(webSocket);
      webSocket.addEventListener(Event.CONNECT, function (e:Event):void {
        trace("air: " + label + " open " + webSocket.protocol);
        webSocket.sendMessage(WebSocket.fmtTEXT, "ping");
      });
      webSocket.addEventListener("websocketData", function (event:Event):void {
        var e:Object = event;
        if (e.format == WebSocket.fmtTEXT) {
          trace("air: " + label + " text " + e.stringData);
          var bytes:ByteArray = new ByteArray();
          bytes.writeByte(1);
          bytes.writeByte(2);
          bytes.writeByte(255);
          webSocket.sendMessage(WebSocket.fmtBINARY, bytes);
        } else {
          trace("air: " + label + " binary " + e.data.length + " " + e.data[0] + "," + e.data[1] + "," + e.data[2]);
        }
      });
      webSocket.addEventListener(Event.CLOSE, function (e:Event):void {
        trace("air: " + label + " close " + webSocket.closeReason);
      });
      webSocket.addEventListener(IOErrorEvent.IO_ERROR, function (e:IOErrorEvent):void {
        trace("air: " + label + " refused");
      });
      webSocket.connect(url, new <String>["other", "smoke"]);
    }
    private function load(label:String, url:String):void {
      var loader:URLLoader = new URLLoader();
      loader.addEventListener(Event.COMPLETE, function (e:Event):void {
        trace("air: " + label + " " + loader.data);
      });
      // AIR's alone, as the response's headers come: a file has none.
      loader.addEventListener(HTTPStatusEvent.HTTP_RESPONSE_STATUS, function (e:HTTPStatusEvent):void {
        var type:String = "";
        for each (var header:URLRequestHeader in e.responseHeaders) {
          if (header.name.toLowerCase() == "content-type") {
            type = header.value;
          }
        }
        trace("air: " + label + " status " + e.status + " " + e.redirected + " " + e.responseURL.split("/").pop() + " " + type);
      });
      loader.addEventListener(IOErrorEvent.IO_ERROR, function (e:IOErrorEvent):void {
        trace("air: " + label + " refused");
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
    { name: "AirSmoke", source: airSource },
    "WorkerMutex",
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
// The player tests' worker-mutex case: two workers and the primordial share a Mutex and memory.
const workerMutex = `${site}worker-mutex.swf`;
writeFileSync(
  workerMutex,
  (
    (cases.find((c) => c.name === "worker-mutex") as (typeof cases)[number]).swf as (
      abc: Uint8Array,
    ) => Uint8Array
  )(abcs.get("WorkerMutex") as Uint8Array),
);
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
    const args = ["--log-sockets", url];
    await withApp(settings, args, async ({ stdout, stderr, until, evaluate, page, userData }) => {
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
      // --log-network: the SWF's own load, a request it made, and its sockets, as the
      // page's DevTools show none of them.
      const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(stderr(), new RegExp(`swf2es: net GET ${escaped} 200 [\\d.]+ k?B \\d+ ms`));
      assert.match(stderr(), /swf2es: net GET \S+\/data\.txt 200 \d+ B \d+ ms/);
      assert.match(
        stderr(),
        new RegExp(`swf2es: socket #\\d+ connecting to 127\\.0\\.0\\.1:${good.port}`),
      );
      assert.match(stderr(), /swf2es: socket #\d+ open/);
      // --log-sockets: what the socket sent and what came back.
      assert.match(stderr(), /swf2es: socket #\d+ > 4 B {2}ping/);
      assert.match(stderr(), /swf2es: socket #\d+ < 4 B {2}pong/);
      // air.net.WebSocket is an AIR application's: the shell opens none for a SWF, whatever
      // its page asks.
      await evaluate(
        `(window.swf2esDesktop.webSockets.connect("ws://127.0.0.1:${good.port}/", []), 0)`,
      );
      await until("the WebSocket refused", () =>
        stderr().includes(
          `swf2es: no WebSocket to ws://127.0.0.1:${good.port}/: only an AIR application has one`,
        ),
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

const screen = await display();
const withApp = (settings: object, args: string[], run: Parameters<typeof runApp>[3]) =>
  runApp(screen.env, settings, args, run);

/**
 * The AIR application's full screen: the window's own, as the main
 * process has it, and its source rect of 50 by 50 alone drawn, fitted and
 * centred; then Esc, which leaves, as the stage hears. The headless
 * window has no window manager to resize it, so its size stays.
 */
async function fullScreen({ until, evaluate, main, devtools, stdout }: App): Promise<void> {
  let shown: { full: boolean; window: number[]; canvas: number[] } | null = null;
  const look = async () => {
    const full = await main<boolean>(`(() => {
      const electron = process.getBuiltinModule("module").createRequire(${JSON.stringify(desktopPackage)})("electron");
      return electron.BrowserWindow.getAllWindows()[0].isFullScreen();
    })()`);
    const page = await evaluate<{ window: number[]; canvas: number[] }>(`(() => {
      const r = document.getElementById("player").shadowRoot.querySelector("canvas").getBoundingClientRect();
      return { window: [innerWidth, innerHeight], canvas: [r.x, r.y, r.width, r.height].map(Math.round) };
    })()`);
    shown = { full, ...page };
  };
  const sized = (full: boolean) => () => {
    void look().catch(() => {});
    if (!shown) {
      return false;
    }

    // In full screen the source rect, a square; out of it the canvas is the window.
    const [width, height] = shown.window;
    const side = Math.min(width, height);
    const canvas = full
      ? [Math.round((width - side) / 2), Math.round((height - side) / 2), side, side]
      : [0, 0, width, height];
    return shown.full === full && shown.canvas.join() === canvas.join();
  };
  await until("the window in full screen, the source rect drawn", sized(true));

  for (const type of ["keyDown", "keyUp"]) {
    await devtools.send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
  }

  await until("Esc out of full screen", () =>
    stdout.includes("air: fullScreen false false normal"),
  );
  shown = null;
  await until("the window as it was", sized(false));
}

/**
 * An AIR application, its descriptor and content SWF in a directory of
 * their own, run adl's way with the socket server's port after "--": it
 * reads what Flash's local sandboxes refuse, and connects unasked, its
 * socket and its WebSocket, which the main process opens for the page,
 * whose own would be refused by its policy.
 */
async function air(): Promise<void> {
  const app = `${out}air-app/`;
  rmSync(app, { recursive: true, force: true });
  mkdirSync(app, { recursive: true });
  writeFileSync(`${app}data.txt`, "beside");
  writeFileSync(`${out}air-outside.txt`, "outside");
  writeFileSync(
    `${app}AirSmoke-app.xml`,
    `<?xml version="1.0" encoding="utf-8" ?>
<application xmlns="http://ns.adobe.com/air/application/51.3">
  <id>org.swf2es.smoke</id>
  <filename>AirSmoke</filename>
  <versionNumber>1.0</versionNumber>
  <initialWindow><content>AirSmoke.swf</content><title>Air Smoke</title><width>320</width><height>200</height></initialWindow>
</application>`,
  );
  writeFileSync(
    `${app}AirSmoke.swf`,
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

  // A WebSocket server that answers "ping" with "pong", and a binary message
  // with its bytes turned around, and then closes with a code of its own.
  const heard: string[] = [];
  const handlers: Parameters<typeof webSocketServer>[0] = {
    protocol: (offered) => {
      heard.push(`offered ${offered.join(",")}`);
      return "smoke";
    },
    open: (peer) => heard.push(`path ${peer.request.url}`),
    message: (peer, data) => {
      if (typeof data === "string") {
        heard.push(`text ${data}`);
        peer.send(data === "ping" ? "pong" : "?");
      } else {
        heard.push(`binary ${[...data].join(",")}`);
        peer.send(Uint8Array.from(data).reverse());
        peer.close(4001);
      }
    },
    close: (_peer, code) => heard.push(`close ${code}`),
  };
  const webSockets = await webSocketServer(handlers);
  // The same over TLS, with a certificate it signed itself, where openssl makes one:
  // --ignore-certificate-errors names its address, and not its name.
  const made = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      `${out}air-key.pem`,
      "-out",
      `${out}air-cert.pem`,
    ],
    { encoding: "utf8" },
  );
  const secure =
    made.status === 0
      ? await webSocketServer(
          { ...handlers, protocol: () => "smoke", open: undefined, close: undefined },
          { key: readFileSync(`${out}air-key.pem`), cert: readFileSync(`${out}air-cert.pem`) },
        )
      : null;
  if (!secure) {
    console.warn("desktop smoke test: no openssl to make a certificate: wss: is not tested");
  }

  // No socket allowed in the settings: an application asks no one. What it loads over HTTP
  // tells its response as AIR does, which its files do not.
  const served = await httpSite({ "/data.txt": ["text/plain", "served"] });
  await withApp(
    { ...both, sockets: {} },
    [
      "--log-sockets",
      "--ignore-certificate-errors=127.0.0.1",
      // The inspector, for the window as the main process has it.
      "--inspect=0",
      `${app}AirSmoke-app.xml`,
      "--",
      String(port),
      "two words",
      `${served.origin}/data.txt`,
      String(webSockets.port),
      ...(secure ? [String(secure.port)] : []),
    ],
    async (running) => {
      const { stdout, stderr, until } = running;
      const settled = () =>
        [
          "app",
          "file",
          "socket",
          "http served",
          "websocket close",
          ...(secure ? ["wss-address close", "wss-name"] : []),
        ].every((what) => stdout.some((l) => l.startsWith(`air: ${what}`)));
      await until("the AIR application", settled);
      for (const line of [
        "air: websocket open smoke",
        "air: websocket text pong",
        "air: websocket binary 3 255,2,1",
        "air: websocket close 4001",
      ]) {
        assert.ok(stdout.includes(line), `${line}\n${stdout.join("\n")}`);
      }

      assert.ok(!stdout.includes("air: websocket refused"), stdout.join("\n"));
      assert.deepEqual(
        heard.filter((line) => !line.startsWith("text") && !line.startsWith("binary")),
        ["offered other,smoke", "path /smoke?q=1", "close 4001"],
      );
      assert.equal(heard.filter((line) => line === "text ping").length, secure ? 2 : 1);
      assert.equal(heard.filter((line) => line === "binary 1,2,255").length, secure ? 2 : 1);
      // Over TLS: the address the switch names goes unverified, the name it does not is refused.
      if (secure) {
        for (const line of [
          "air: wss-address open smoke",
          "air: wss-address text pong",
          "air: wss-address binary 3 255,2,1",
          "air: wss-address close 4001",
          "air: wss-name refused",
        ]) {
          assert.ok(stdout.includes(line), `${line}\n${stdout.join("\n")}`);
        }

        assert.ok(!stdout.some((l) => l.startsWith("air: wss-name open")), stdout.join("\n"));
      }

      // --log-network: the connection, as a socket's; --log-sockets: its messages, a text
      // one as its text.
      const logged = stderr();
      assert.ok(
        logged.includes(
          `swf2es: websocket #1 connecting to ws://127.0.0.1:${webSockets.port}/smoke?q=1`,
        ),
        logged,
      );
      for (const line of [
        "swf2es: websocket #1 open smoke",
        "swf2es: websocket #1 > text 4 B  ping",
        "swf2es: websocket #1 < text 4 B  pong",
        "swf2es: websocket #1 > binary 3 B  01 02 ff",
        "swf2es: websocket #1 < binary 3 B  ff 02 01",
        "swf2es: websocket #1 close 4001",
      ]) {
        assert.ok(logged.includes(line), `${line}\n${logged}`);
      }

      for (const line of [
        "air: url app:/AirSmoke.swf",
        "air: sandbox application",
        "air: title Air Smoke",
        "air: screen true true true 1",
        `air: invoke ${[port, "two words", `${served.origin}/data.txt`, webSockets.port, ...(secure ? [secure.port] : [])].join("|")} true`,
        "air: files true true 0",
        "air: stream beside",
        "air: app beside",
        "air: file outside",
        "air: http status 200 false data.txt text/plain",
        "air: http served",
        "air: socket pong",
        // In full screen as its setter returns, the event before it, as in adl.
        "air: fullScreen true false fullScreenInteractive",
        "air: displayState fullScreenInteractive 100x50",
      ]) {
        assert.ok(stdout.includes(line), `${line}\n${stdout.join("\n")}`);
      }

      assert.ok(
        !stdout.some((l) => /^air: (app|file) status/.test(l)),
        `a file's response status\n${stdout.join("\n")}`,
      );
      assert.ok(
        stdout.indexOf("air: http status 200 false data.txt text/plain") <
          stdout.indexOf("air: http served"),
        stdout.join("\n"),
      );

      await fullScreen(running);
    },
  );
  served.server.close();
  await webSockets.close();
  await secure?.close();

  // Its descriptor dropped on the window runs it too, with no arguments, from its own
  // directory. One that has run before, as the recent list has it, is not asked about again:
  // a prompt cannot be answered here.
  const descriptor = `${app}AirSmoke-app.xml`;
  await withApp(
    { ...both, recent: [descriptor], sockets: {} },
    [],
    async ({ stdout, until, evaluate, devtools }) => {
      // Nothing plays yet to say the page listens for a drop.
      let ready = false;
      const poll = setInterval(() => {
        void evaluate<boolean>(`document.readyState === "complete"`).then(
          (complete) => {
            ready = complete;
          },
          () => {},
        );
      }, 100);
      try {
        await until("the app's page", () => ready);
      } finally {
        clearInterval(poll);
      }

      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await devtools.send("Input.dispatchDragEvent", {
          type,
          x: 100,
          y: 100,
          data: { items: [], files: [descriptor], dragOperationsMask: 1 },
        });
      }

      await until("the dropped AIR application", () =>
        ["app", "file"].every((what) => stdout.some((l) => l.startsWith(`air: ${what} `))),
      );
      for (const line of [
        "air: url app:/AirSmoke.swf",
        "air: sandbox application",
        "air: title Air Smoke",
        "air: screen true true true 1",
        "air: invoke  true",
        "air: stream beside",
        "air: app beside",
        "air: file outside",
      ]) {
        assert.ok(stdout.includes(line), `${line}\n${stdout.join("\n")}`);
      }
    },
  );
}

// The playerglobal the tests play on: the app's own, or
// Flash Player's under SWF2ES_PLAYERGLOBAL=adobe.
const both = {
  ...(process.env.SWF2ES_PLAYERGLOBAL === "adobe"
    ? { playerglobal: `${libraries}playerglobal-adobe.abc` }
    : {}),
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

    // Cross-origin isolated, as a shareable ByteArray's shared memory needs.
    assert.equal(await evaluate<boolean>("crossOriginIsolated"), true);
    // Native bitmap kernels are on by default: playback loaded them. The page loads
    // more modules than resource timing keeps, so the frame's resources tell.
    const { frameTree } = await devtools.send<{ frameTree: { resources: { url: string }[] } }>(
      "Page.getResourceTree",
    );
    assert.ok(
      frameTree.resources.some((r) => r.url.endsWith("/modules/native/render/index.js")),
      "playback did not load the native bitmap kernels",
    );

    // Played again, the last player let go of: one canvas, and the SWF starts anew.
    const reloaded = await evaluate<{ canvases: number; nativeInstances: number }>(`(async () => {
      const player = document.getElementById("player");
      const Instance = WebAssembly.Instance;
      let nativeInstances = 0;
      WebAssembly.Instance = new Proxy(Instance, {
        construct(target, args) {
          const instance = Reflect.construct(target, args);
          if (typeof instance.exports.vertexCount === "function") {
            nativeInstances++;
          }
          return instance;
        }
      });
      try {
        await player.load(${JSON.stringify(url)});
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
        return { canvases: player.shadowRoot.querySelectorAll("canvas").length, nativeInstances };
      } finally {
        WebAssembly.Instance = Instance;
      }
    })()`);
    assert.equal(reloaded.canvases, 1);
    assert.ok(reloaded.nativeInstances > 0, "playback did not use the native tessellator");
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

  // With no library chosen, the builtin.abc and playerglobal swf2es ships
  // play an ActionScript 3 SWF.
  await withApp({ recent: [] }, [local], async ({ stdout, until }) => {
    await until("the local SWF on the app's own libraries", () =>
      stdout.includes("smoke: started"),
    );
  });

  // A SWF's workers run on Web Workers whose script the app's protocol serves, sharing a Mutex
  // and memory on its isolated page.
  await withApp(both, [workerMutex], async ({ stdout, until }) => {
    await until("the workers' SWF", () => stdout.includes("free true"));
    const expected = readFileSync(`${here}../player/references/worker-mutex/trace.txt`, "utf8")
      .trim()
      .split("\n");
    assert.deepEqual(
      stdout.filter((l) => expected.includes(l)),
      expected,
    );
  });

  await remote();
  await air();

  console.log("desktop smoke test: ok");
} finally {
  server.close();
  screen.stop();
}
