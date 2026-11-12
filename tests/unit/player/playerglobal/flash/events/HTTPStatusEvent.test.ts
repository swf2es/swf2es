// HTTPStatusEvent as an AIR application gets it, as adl (AIR 51.3) traced
// the same script against a server on 127.0.0.1: httpResponseStatus as a
// response's headers come, before the bytes, from a URLLoader, a URLStream
// and an upload, with the URL redirects led to and the headers as
// URLRequestHeaders; httpStatus after the bytes, with `redirected` alone;
// neither a file, a failed connection nor a Loader has the former, and
// Flash Player none at all.
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

    private function listen(d:IEventDispatcher, ends:Array = null):void {
      keep.push(d);
      for each (var type:String in ["open", "progress", "httpStatus", "httpResponseStatus", "complete", "ioError", "init", "uploadCompleteData", "select"]) {
        d.addEventListener(type, show);
      }

      // Each step's last event; a higher priority would run before it is shown.
      for each (var last:String in ends || ["complete", "ioError"]) {
        d.addEventListener(last, next, false, -1);
      }
    }

    private function urlLoader(url:String):void {
      var loader:URLLoader = new URLLoader();
      listen(loader);
      loader.addEventListener("httpResponseStatus", function(e:Event):void { trace("  target " + (e.target == loader)); });
      loader.load(new URLRequest(url));
    }

    private function urlStream(url:String):void {
      var stream:URLStream = new URLStream();
      listen(stream);
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

async function play(air: boolean): Promise<string[]> {
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
    fetch: async ({ url }: FetchRequest): Promise<FetchResult> => {
      switch (url) {
        case "http://example.test/ok":
          return { bytes: text("hello"), status: 200, headers };
        case "http://example.test/redirect":
          return { bytes: text("hello"), status: 200, headers, url: "http://example.test/ok" };
        case "http://example.test/redirectswf":
          return { bytes: child, status: 200, headers, url: "http://example.test/swf" };
        case "http://example.test/missing":
          return { bytes: null, status: 404, headers: [["X-Why", "gone"]] };
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
    status(200),
    "  complete",
    "== loader redirect",
    response(200, true, "http://example.test/ok"),
    "  target true",
    status(200, true),
    "  complete",
    // AIR goes on to complete with the response's body; the hosts give a failure's none.
    "== loader 404",
    response(404, false, "http://example.test/missing", "X-Why: gone"),
    "  target true",
    status(404),
    "  ioError",
    "== loader dead",
    status(0),
    "  ioError",
    "== loader file",
    // The hosts' status for a file they read; adl's is 0.
    status(200),
    "  complete",
    "== stream redirect",
    response(200, true, "http://example.test/ok"),
    status(200, true),
    "  complete",
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
});

test("Flash Player content gets httpStatus alone", { skip }, async () => {
  const lines = await play(false);
  assert.equal(lines.at(-1), "== done", lines.join("\n"));
  assert.equal(
    lines.some((line) => line.includes("httpResponseStatus")),
    false,
    lines.join("\n"),
  );
  assert.deepEqual(lines.slice(0, 4), [
    "== loader 200",
    "  httpStatus 200",
    "  complete",
    "== loader redirect",
  ]);
});
