// HTTPStatusEvent as an AIR application gets it, as adl (AIR 51.3) traced
// the same script against a server on 127.0.0.1: httpResponseStatus as a
// response's headers come, before the bytes, from a URLLoader, a URLStream
// and an upload, with the URL redirects led to and the headers as
// URLRequestHeaders; httpStatus after the bytes, with `redirected` alone;
// neither a file, a failed connection nor a Loader has the former, and
// Flash Player none at all. A response that tells an HTTP error has its
// body there, the loader's data and the stream's bytes, an empty one with
// no progress, and completes where httpResponseStatus was listened for as
// the load was asked for, else fails with the body still there; in Flash
// Player it fails, ioError and no data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../../../oracle/oracle.ts";
import type { FetchRequest, FetchResult } from "../../../../../../packages/player/dist/hosts.js";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { bare, innerSwf } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { compiler } from "../../../../../player/scripts.ts";

// This file's own out directory: the other test files compile at the same time.
const out = fileURLToPath(new URL("../../../../out/player-http-status/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  readFileSync(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

// Flash Player content sees neither the response's properties nor `redirected`: AIR's API.
const source = (name: string, air: boolean) => `package {
  import flash.display.Loader;
  import flash.display.Sprite;
  import flash.events.*;
  import flash.net.*;

  public class ${name} extends Sprite {
    private var steps:Array;
    private var keep:Array = [];

    public function ${name}() {
${
  air
    ? `      var made:HTTPStatusEvent = new HTTPStatusEvent("httpResponseStatus", false, false, 201, true);
      show(made);
      made.responseURL = "u";
      made.responseHeaders = [new URLRequestHeader("A", "b")];
      show(made.clone());
`
    : ""
}

      var file:FileReference = new FileReference();
      steps = [
        ["loader 200", function():void { urlLoader("http://example.test/ok"); }],
        ["loader redirect", function():void { urlLoader("http://example.test/redirect"); }],
        ["loader 404", function():void { urlLoader("http://example.test/missing"); }],
        ["loader 404 post", function():void { urlLoader("http://example.test/missing", "POST"); }],
        ["loader 404 binary", function():void { urlLoader("http://example.test/missing", "GET", "binary"); }],
        ["loader 500 empty", function():void { urlLoader("http://example.test/broken"); }],
        ["stream 404", function():void { urlStream("http://example.test/missing"); }],
        ["loader 404 unheard", function():void { urlLoader("http://example.test/missing", "GET", "text", "never"); }],
        ["loader 404 heard late", function():void { urlLoader("http://example.test/missing", "GET", "text", "after"); }],
        ["loader 404 heard once", function():void { urlLoader("http://example.test/missing", "GET", "text", "removed"); }],
        ["stream 404 unheard", function():void { urlStream("http://example.test/missing", false); }],
        ["loader dead", function():void { urlLoader("http://example.test/dead"); }],
        ["loader file", function():void { urlLoader("app:/data.txt"); }],
        ["stream redirect", function():void { urlStream("http://example.test/redirect"); }],
        ["Loader redirect", function():void { displayLoader("http://example.test/redirectswf"); }],
        ["browse", function():void { listen(file, ["select", "uploadCompleteData", "ioError"]); file.browse(); }],
        ["upload 200", function():void { file.upload(new URLRequest("http://example.test/ok")); }],
        ["upload 404", function():void { file.upload(new URLRequest("http://example.test/missing")); }]
      ];
      next();
    }

    private function next(e:Event = null):void {
      if (steps.length == 0) {
        trace("== done");
        return;
      }

      var step:Array = steps.shift();
      trace("== " + step[0]);
      step[1]();
    }

    private function show(e:Event):void {
      var line:String = e.type;
      if (e is HTTPStatusEvent) {
        var h:HTTPStatusEvent = HTTPStatusEvent(e);
${
  air
    ? `var parts:Array = [];
        for each (var header:URLRequestHeader in h.responseHeaders) {
          parts.push(header.name + ": " + header.value);
        }

        line += " " + h.status + " " + h.redirected + " " + h.responseURL + " [" + parts.join(" | ") + "] " + e;`
    : `line += " " + h.status;`
}
      }

      trace("  " + line);
    }

    private function listen(d:IEventDispatcher, ends:Array = null, response:Boolean = true):void {
      keep.push(d);
      for each (var type:String in ["open", "progress", "httpStatus", "httpResponseStatus", "complete", "ioError", "init", "uploadCompleteData", "select"]) {
        if (response || type != "httpResponseStatus") {
          d.addEventListener(type, show);
        }
      }

      // Each step's last event; a higher priority would run before it is shown.
      for each (var last:String in ends || ["complete", "ioError"]) {
        d.addEventListener(last, next, false, -1);
      }
    }

    // heard: when httpResponseStatus is listened for: "before" the load, "after" it, "never",
    // or "removed", before it and no longer.
    private function urlLoader(url:String, method:String = "GET", format:String = "text", heard:String = "before"):void {
      var loader:URLLoader = new URLLoader();
      loader.dataFormat = format;
      listen(loader, null, heard == "before");
      var target:Function = function(e:Event):void { trace("  target " + (e.target == loader)); };
      if (heard == "before" || heard == "removed") {
        loader.addEventListener("httpResponseStatus", target);
      }

      if (heard == "removed") {
        loader.removeEventListener("httpResponseStatus", target);
      }
      loader.addEventListener("progress", function(e:ProgressEvent):void { trace("  loaded " + e.bytesLoaded + " " + e.bytesTotal); });
      loader.addEventListener("complete", function(e:Event):void { trace("  data [" + loader.data + "] " + loader.bytesLoaded); });
      loader.addEventListener("ioError", function(e:Event):void { trace("  failed [" + loader.data + "] " + loader.bytesLoaded); });
      var request:URLRequest = new URLRequest(url);
      request.method = method;
      if (method == "POST") {
        request.data = "a=1";
      }

      loader.load(request);
      if (heard == "after") {
        loader.addEventListener("httpResponseStatus", target);
      }
    }

    private function urlStream(url:String, response:Boolean = true):void {
      var stream:URLStream = new URLStream();
      listen(stream, null, response);
      stream.addEventListener("complete", function(e:Event):void { trace("  bytes [" + stream.readUTFBytes(stream.bytesAvailable) + "]"); });
      stream.addEventListener("ioError", function(e:Event):void { trace("  failed [" + stream.readUTFBytes(stream.bytesAvailable) + "] " + stream.connected); });
      stream.load(new URLRequest(url));
    }

    private function displayLoader(url:String):void {
      var loader:Loader = new Loader();
      listen(loader.contentLoaderInfo);
      loader.load(new URLRequest(url));
    }
  }
}`;

const headers: [string, string][] = [
  ["Content-Type", "text/plain"],
  ["X-Zeta", "z"],
  ["x-alpha", "a"],
  ["X-Dup", "1"],
  ["X-Dup", "2"],
];

/** What the host was asked for, and whether an error's body with it. */
const asked: string[] = [];

async function play(air: boolean): Promise<string[]> {
  asked.length = 0;
  const compile = compiler(out);
  const child = innerSwf(
    compile(
      "Inner",
      "package { import flash.display.MovieClip; public class Inner extends MovieClip {} }",
    ),
    1,
  );
  const text = (s: string) => new TextEncoder().encode(s);
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    audio: null,
    air,
    url: air ? "app:/HttpStatusRoot.swf" : "http://example.test/HttpStatusPlugin.swf",
    fileHost: {
      browse: async () => [
        { name: "a.txt", size: 3, modificationDate: 123, read: async () => Uint8Array.of(1, 2, 3) },
      ],
      save: async () => null,
    },
    fetch: async ({ url, method, purpose, errorBody }: FetchRequest): Promise<FetchResult> => {
      asked.push(
        `${method} ${url.replace("http://example.test", "")} ${purpose} ${errorBody ?? false}`,
      );
      switch (url) {
        case "http://example.test/ok":
          return { bytes: text("hello"), status: 200, headers };
        case "http://example.test/redirect":
          return { bytes: text("hello"), status: 200, headers, url: "http://example.test/ok" };
        case "http://example.test/redirectswf":
          return { bytes: child, status: 200, headers, url: "http://example.test/swf" };
        case "http://example.test/missing":
          // As the hosts do: an error's body only where it was asked for.
          return {
            bytes: errorBody ? text("not found body") : null,
            status: 404,
            headers: [["X-Why", "gone"]],
          };
        case "http://example.test/broken":
          return { bytes: errorBody ? new Uint8Array(0) : null, status: 500, headers: [] };
        case "app:/data.txt":
          // As the hosts answer for an application's own file.
          return { bytes: text("beside"), status: 200, headers: [] };
        default:
          throw new Error("no connection");
      }
    },
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const name = air ? "HttpStatusRoot" : "HttpStatusPlugin";
  const player = new Player(bare(compile(name, source(name, air)), 1, name), scripting);
  try {
    await player.start();
    for (let frame = 0; frame < 100 && !lines.includes("== done"); frame++) {
      await scripting.settled();
      player.tick();
    }
  } finally {
    player.destroy();
  }

  // Progress and the rest are told elsewhere; the Loader's content traces nothing.
  return lines.filter((line) => !/^ {2}(progress|open|init|select)$/.test(line));
}

const event = (type: string, status: number, redirected: boolean, url: string | null) =>
  `[HTTPStatusEvent type="${type}" bubbles=false cancelable=false eventPhase=2 status=${status} redirected=${redirected} responseURL=${url === null ? "null" : `"${url}"`}]`;
const all = "Content-Type: text/plain | X-Zeta: z | x-alpha: a | X-Dup: 1 | X-Dup: 2";
const response = (status: number, redirected: boolean, url: string, list = all) =>
  `  httpResponseStatus ${status} ${redirected} ${url} [${list}] ${event("httpResponseStatus", status, redirected, url)}`;
const status = (code: number, redirected = false) =>
  `  httpStatus ${code} ${redirected} null [] ${event("httpStatus", code, redirected, null)}`;
const made = [
  `  httpResponseStatus 201 true null [] ${event("httpResponseStatus", 201, true, null)}`,
  `  httpResponseStatus 201 true u [A: b] ${event("httpResponseStatus", 201, true, "u")}`,
];

test("an AIR application gets httpResponseStatus before the bytes, as adl", { skip }, async () => {
  assert.deepEqual(await play(true), [
    ...made,
    "== loader 200",
    response(200, false, "http://example.test/ok"),
    "  target true",
    "  loaded 5 5",
    status(200),
    "  complete",
    "  data [hello] 5",
    "== loader redirect",
    response(200, true, "http://example.test/ok"),
    "  target true",
    "  loaded 5 5",
    status(200, true),
    "  complete",
    "  data [hello] 5",
    // An error completes for a loader that listened for the response before its load, its
    // body the data: adl's order, for 400, 403, 404, 500 and 503.
    "== loader 404",
    response(404, false, "http://example.test/missing", "X-Why: gone"),
    "  target true",
    "  loaded 14 14",
    status(404),
    "  complete",
    "  data [not found body] 14",
    "== loader 404 post",
    response(404, false, "http://example.test/missing", "X-Why: gone"),
    "  target true",
    "  loaded 14 14",
    status(404),
    "  complete",
    "  data [not found body] 14",
    "== loader 404 binary",
    response(404, false, "http://example.test/missing", "X-Why: gone"),
    "  target true",
    "  loaded 14 14",
    status(404),
    "  complete",
    "  data [not found body] 14",
    // No body, no progress.
    "== loader 500 empty",
    response(500, false, "http://example.test/broken", ""),
    "  target true",
    status(500),
    "  complete",
    "  data [] 0",
    "== stream 404",
    response(404, false, "http://example.test/missing", "X-Why: gone"),
    status(404),
    "  complete",
    "  bytes [not found body]",
    // With no such listener as the load is asked for it fails, the body there all the same.
    "== loader 404 unheard",
    "  loaded 14 14",
    status(404),
    "  ioError",
    "  failed [not found body] 14",
    // One added after hears the response, and the load fails as without it.
    "== loader 404 heard late",
    "  target true",
    "  loaded 14 14",
    status(404),
    "  ioError",
    "  failed [not found body] 14",
    // One added and removed again hears nothing, and the load completes.
    "== loader 404 heard once",
    "  loaded 14 14",
    status(404),
    "  complete",
    "  data [not found body] 14",
    "== stream 404 unheard",
    status(404),
    "  ioError",
    "  failed [not found body] true",
    "== loader dead",
    status(0),
    "  ioError",
    "  failed [] 0",
    "== loader file",
    // The hosts' status for a file they read; adl's is 0.
    "  loaded 6 6",
    status(200),
    "  complete",
    "  data [beside] 6",
    "== stream redirect",
    response(200, true, "http://example.test/ok"),
    status(200, true),
    "  complete",
    "  bytes [hello]",
    "== Loader redirect",
    status(200, true),
    "  complete",
    "== browse",
    "== upload 200",
    response(200, false, "http://example.test/ok"),
    "  complete",
    "  uploadCompleteData",
    "== upload 404",
    response(404, false, "http://example.test/missing", "X-Why: gone"),
    status(404),
    "  ioError",
    "== done",
  ]);
  // Its URLLoaders and URLStreams ask for an error's body; its Loader, which fails in AIR too, not.
  assert.deepEqual(asked.slice(0, 3), [
    "GET /ok data true",
    "GET /redirect data true",
    "GET /missing data true",
  ]);
  assert.ok(asked.includes("POST /missing data true"), asked.join("\n"));
  assert.ok(asked.includes("GET /redirectswf content false"), asked.join("\n"));
});

test("Flash Player content gets httpStatus alone", { skip }, async () => {
  const lines = await play(false);
  assert.equal(lines.at(-1), "== done", lines.join("\n"));
  assert.equal(
    lines.some((line) => line.includes("httpResponseStatus")),
    false,
    lines.join("\n"),
  );
  assert.deepEqual(lines.slice(0, 6), [
    "== loader 200",
    "  loaded 5 5",
    "  httpStatus 200",
    "  complete",
    "  data [hello] 5",
    "== loader redirect",
  ]);
  // An error fails, with no data, and no host is asked for its body.
  const from = (step: string) => lines.slice(lines.indexOf(step), lines.indexOf(step) + 4);
  assert.deepEqual(from("== loader 404"), [
    "== loader 404",
    "  httpStatus 404",
    "  ioError",
    "  failed [] 0",
  ]);
  assert.deepEqual(from("== loader 500 empty"), [
    "== loader 500 empty",
    "  httpStatus 500",
    "  ioError",
    "  failed [] 0",
  ]);
  assert.deepEqual(from("== loader 404 heard once"), [
    "== loader 404 heard once",
    "  httpStatus 404",
    "  ioError",
    "  failed [] 0",
  ]);
  assert.deepEqual(from("== stream 404 unheard"), [
    "== stream 404 unheard",
    "  httpStatus 404",
    "  ioError",
    "  failed [] false",
  ]);
  assert.deepEqual(from("== stream 404").slice(0, 3), [
    "== stream 404",
    "  httpStatus 404",
    "  ioError",
  ]);
  assert.ok(
    asked.every((line) => line.endsWith(" false")),
    asked.join("\n"),
  );
});
