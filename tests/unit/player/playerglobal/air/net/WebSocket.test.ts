// air.net.WebSocket through a SWF's script, against a WebSocket server in
// this process, over node's global WebSocket as the player's default host.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine, runOracle } from "../../../../../../oracle/oracle.ts";
import type { WebSocketHost } from "../../../../../../packages/player/dist/hosts.js";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { airLibrary } from "../../../../../../packages/player/dist/playerglobal/air-library.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { bare } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { startEchoServer } from "./echo-server.ts";

// Its own: node runs test files at once, and a compile writes its job list into `out`.
const out = fileURLToPath(new URL("../../../../out/player-websocket/", import.meta.url));
const root = fileURLToPath(new URL("../../../../../../", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/** A script here, or a source of the test's own, compiled against the player's AIR library as well. */
function compile(name: string, text?: string): Uint8Array {
  mkdirSync(`${out}sources`, { recursive: true });
  writeFileSync(`${out}air-library.abc`, airLibrary);
  let source = fileURLToPath(new URL(`${name}.as`, import.meta.url));
  if (text !== undefined) {
    source = `${out}sources/${name}.as`;
    writeFileSync(source, text);
  }

  const [result] = runOracle(
    [{ source, ascArgs: ["-import", relative(root, `${out}air-library.abc`)] }],
    out,
    { imports: ["builtin", "playerglobal"], run: false },
  );
  if (!result.compiled) {
    throw new Error(`${name}.as did not compile:\n${result.compileLog}`);
  }

  return new Uint8Array(readFileSync(`${out}${name}.abc`));
}

/** The traces of `abc` played, with `options` for its Scripting, until it traces "done". */
async function play(
  abc: Uint8Array,
  name: string,
  options: ConstructorParameters<typeof Scripting>[1] = {},
): Promise<string[]> {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    // Whose messages adl traces.
    debugger: true,
    realTime: null,
    ...options,
  });
  await scripting.loadLibraries([...libraryAbcs(`${out}libraries/`), airLibrary]);
  const player = new Player(bare(abc, 1, name), scripting);
  await player.start();
  for (let i = 0; i < 2000 && !lines.includes("done"); i++) {
    player.tick();
    await sleep(2);
  }

  return lines;
}

test("air.net.WebSocket connects, sends, receives and closes as adl does", { skip }, async () => {
  const echo = await startEchoServer();
  try {
    const lines = await play(compile("WebSockets"), "WebSockets", {
      parameters: { port: String(echo.port) },
    });

    // What adl traces for WebSockets.as, but where marked: what a browser
    // cannot do as AIR does, and AIR's faults, which the player leaves out.
    assert.deepEqual(lines, [
      "1,2,8,9,10 websocketData",
      "closeReason -1 protocol null",
      // adl crashes.
      "send before connect: flash.errors::IOError 2002 Error #2002: Operation attempted on invalid socket.",
      "close before connect: flash.errors::IOError 2002 Error #2002: Operation attempted on invalid socket.",
      "startServer null: TypeError 2007 Error #2007: Parameter socket must be non-null.",
      // adl starts a server, which connect then refuses with #2082.
      "startServer: flash.errors::IllegalOperationError 0 This method is not supported in this profile.",
      "connect a server: ArgumentError 2147 Error #2147: Forbidden protocol in URL http://127.0.0.1/.",
      "connect null: TypeError 2007 Error #2007: Parameter url must be non-null.",
      "connect http: ArgumentError 2147 Error #2147: Forbidden protocol in URL http://127.0.0.1/.",
      "connect WS: ArgumentError 2147 Error #2147: Forbidden protocol in URL WS://127.0.0.1/.",
      "set protocol: ok chat",
      "connect: ok",
      "protocol while connecting: ok chat",
      "connect while connecting: flash.errors::IllegalOperationError 2082 Error #2082: Connect failed because the object is already connected.",
      'a [Event type="connect" bubbles=false cancelable=false eventPhase=2] closeReason=-1',
      "set protocol when open: ArgumentError 2014 Error #2014: Feature is not available at this time.",
      "connect when open: flash.errors::IllegalOperationError 2082 Error #2082: Connect failed because the object is already connected.",
      "text: ok",
      "binary: ok 2",
      "text of bytes: ok",
      "binary of a string: ok",
      "number: ArgumentError 1508 Error #1508: The value specified for argument data is invalid.",
      "null: ArgumentError 1508 Error #1508: The value specified for argument data is invalid.",
      "ping: ok",
      "pong: ok",
      "reserved: ok",
      "text in high bits: ok",
      "split: ok",
      "ask a close: ok",
      ...[
        "format=1 length=6 string=h\u00e9llo",
        "format=2 length=5 string=null",
        "format=1 length=5 string=bin\u00e9",
        "format=2 length=3 string=null",
        "format=1 length=4 string=high",
        "format=1 length=5 string=split",
      ].map(
        (data) =>
          `a [Event type="websocketData" bubbles=false cancelable=false eventPhase=2] ${data} position=0 closeReason=-1`,
      ),
      'a [Event type="close" bubbles=false cancelable=false eventPhase=2] closeReason=4001',
      "send when closed: flash.errors::IOError 2002 Error #2002: Operation attempted on invalid socket.",
      "close when closed: flash.errors::IOError 2002 Error #2002: Operation attempted on invalid socket.",
      "set protocol when closed: ArgumentError 2014 Error #2014: Feature is not available at this time.",
      "connect when closed: flash.errors::IllegalOperationError 2082 Error #2082: Connect failed because the object is already connected.",
      "protocol one",
      'b [Event type="connect" bubbles=false cancelable=false eventPhase=2] closeReason=-1',
      "close 3001: ok",
      "closeReason -1",
      "send when closing: ok",
      "close when closing: ok",
      // adl dispatches a close here at times, as a send while closing races its reply.
      "closeReason 3001",
      'c [IOErrorEvent type="ioError" bubbles=false cancelable=false eventPhase=2 text="Error #2031: Socket Error. URL: 127.0.0.1" errorID=2031] closeReason=-1',
      "connect when failed: flash.errors::IllegalOperationError 2082 Error #2082: Connect failed because the object is already connected.",
      "send when failed: ok",
      "close when failed: ok",
      "send while connecting: ok",
      `d [IOErrorEvent type="ioError" bubbles=false cancelable=false eventPhase=2 text="Error #2031: Socket Error. URL: ws://127.0.0.1:${echo.port}/d" errorID=2031] closeReason=-1`,
      'd [Event type="close" bubbles=false cancelable=false eventPhase=2] closeReason=-1',
      // adl's send still goes, in the close's own listener.
      "send when closed: flash.errors::IOError 2002 Error #2002: Operation attempted on invalid socket.",
      'e [Event type="connect" bubbles=false cancelable=false eventPhase=2] closeReason=-1',
      "close frame: ok",
      'e [Event type="close" bubbles=false cancelable=false eventPhase=2] closeReason=4002',
      'f999 [Event type="connect" bubbles=false cancelable=false eventPhase=2] closeReason=-1',
      "close 999: ok",
      // adl sends 999, which the server sends back; a browser sends no code, and none comes back.
      "closeReason -1",
      'f68538 [Event type="connect" bubbles=false cancelable=false eventPhase=2] closeReason=-1',
      "close 68538: ok",
      "closeReason 3002",
      'g [Event type="connect" bubbles=false cancelable=false eventPhase=2] closeReason=-1',
      // adl stops reading at an empty message.
      'g [Event type="websocketData" bubbles=false cancelable=false eventPhase=2] format=1 length=0 string= position=0 closeReason=-1',
      'g [Event type="websocketData" bubbles=false cancelable=false eventPhase=2] format=2 length=0 string=null position=0 closeReason=-1',
      'g [Event type="close" bubbles=false cancelable=false eventPhase=2] closeReason=-1',
      "done",
    ]);

    // What the server got; adl's pings, pongs and reserved frames go too, and
    // its 999, and its close frame's reason.
    const text = (s: string) => [1, new TextEncoder().encode(s)];
    assert.deepEqual(
      echo.clients.map((c) => [c.path, c.protocols, c.closed]),
      [
        ["/a", ["one", "two"], { code: 4001, reason: "" }],
        ["/b", [], { code: 3001, reason: "" }],
        ["/e", [], { code: 4002, reason: "" }],
        ["/code999", [], { code: 1005, reason: "" }],
        ["/code68538", [], { code: 3002, reason: "" }],
        ["/g", [], null],
      ],
    );
    assert.deepEqual(echo.clients[0].messages, [
      text("h\u00e9llo"),
      [2, new TextEncoder().encode("bin\u00e9")],
      text("bin\u00e9"),
      [2, new TextEncoder().encode("str")],
      text("high"),
      text("split"),
      text("close 4001 bye"),
    ]);
  } finally {
    await echo.stop();
  }
});

const refusals = `package {
  import air.net.WebSocket;
  import flash.display.Sprite;
  import flash.events.Event;
  public class Refusals extends Sprite {
    private var left:int = 2;
    public function Refusals() {
      for each (var url:String in ["ws://blocked.test:81/a", "ws://refused.test/b"]) {
        var w:WebSocket = new WebSocket();
        w.addEventListener("ioError", heard);
        w.addEventListener("securityError", heard);
        w.addEventListener("close", heard);
        w.connect(url);
      }
    }
    private function heard(e:Event):void {
      trace(e);
      if (--left == 0) {
        trace("done");
      }
    }
  }
}`;

test("a connection the host refuses is a securityError or an ioError, without a host an ioError", {
  skip,
}, async () => {
  const abc = compile("Refusals", refusals);
  const refused: string[] = [];
  const host: WebSocketHost = {
    connect(url, protocols) {
      refused.push(`${url} ${protocols.length}`);
      // As a browser's constructor throws for a blocked port, and for a bad URL.
      throw new DOMException("refused", url.includes("blocked") ? "SecurityError" : "SyntaxError");
    },
  };
  const security =
    '[SecurityErrorEvent type="securityError" bubbles=false cancelable=false eventPhase=2 text="Error #2048: Security sandbox violation: http://example.test/main.swf cannot load data from ws://blocked.test:81/a." errorID=2048]';
  const io = (host: string) =>
    `[IOErrorEvent type="ioError" bubbles=false cancelable=false eventPhase=2 text="Error #2031: Socket Error. URL: ${host}" errorID=2031]`;

  const url = "http://example.test/main.swf";
  assert.deepEqual(await play(abc, "Refusals", { webSocket: host, url }), [
    security,
    io("refused.test"),
    "done",
  ]);
  assert.deepEqual(refused, ["ws://blocked.test:81/a 0", "ws://refused.test/b 0"]);

  assert.deepEqual(await play(abc, "Refusals", { webSocket: null, url }), [
    io("blocked.test"),
    io("refused.test"),
    "done",
  ]);
});
