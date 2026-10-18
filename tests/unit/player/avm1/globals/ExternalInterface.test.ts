// ExternalInterface's AS2 face in node: calls out through a host's bridge
// in Flash's XML, the page's calls in, and the helpers Flash's AS2 class
// is built of, which content may call (expected lines from Ruffle's
// corpus, Flash's traces, where it has them).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { Avm1 } from "../../../../../packages/player/dist/avm1/avm1.js";
import type { ExternalInterfaceHost } from "../../../../../packages/player/dist/hosts.js";
import { Player } from "../../../../../packages/player/dist/player.js";
import { flashAssembler, script } from "../../../../avm1-script.ts";
import * as w from "../../../../swf-writer.ts";
import { files, movie, play as playNet, take } from "../network.ts";
import { traces } from "../text-fields.ts";

const codegen = await createCodegen(
  await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  ),
);

/** A page that declines JavaScript, answers callOut with `answer`, and keeps the SWF's callbacks. */
function page(answer: string | null) {
  const requests: string[] = [];
  const callbacks = new Map<string, (request: string, args: null) => unknown>();
  const host: ExternalInterfaceHost = {
    objectID: "movie",
    evalJS: () => null,
    callOut(request) {
      requests.push(request);
      return answer;
    },
    addCallback(name, callback) {
      if (callback === null) {
        callbacks.delete(name);
      } else {
        callbacks.set(name, callback as (request: string, args: null) => unknown);
      }
    },
  };
  return { host, requests, callbacks };
}

/** What the one-frame SWF of `source` traces, played with `host` as its page's bridge. */
async function play(source: string, host?: ExternalInterfaceHost): Promise<string[]> {
  const swf = w.swf({
    version: 8,
    width: 20,
    height: 20,
    frameCount: 1,
    tags: [
      w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
  const lines: string[] = [];
  const avm1 = new Avm1(codegen, {
    print: (line) => lines.push(line),
    realTime: null,
    externalInterface: host,
  });
  await new Player(swf, null, avm1).start();
  return lines;
}

const EI = "flash.external.ExternalInterface";

test("without a page, available is false, call gives null and addCallback false", async () => {
  assert.deepEqual(
    await play(
      `trace(${EI}.available); trace(${EI}.call("f", 1)); trace(${EI}.addCallback("g", null, function() {}));`,
    ),
    ["false", "null", "false"],
  );
});

test("call sends an XML invocation and reads the page's answer back", async () => {
  const { host, requests } = page("<string>a &amp; b</string>");
  assert.deepEqual(
    await play(
      `trace(${EI}.available); var o = {}; o.x = null;
trace(${EI}.call("f", 1.5, "a<b", [true], o, undefined));`,
      host,
    ),
    ["true", "a & b"],
  );
  assert.deepEqual(requests, [
    '<invoke name="f" returntype="xml"><arguments><number>1.5</number><string>a&lt;b</string>' +
      '<array><property id="0"><true/></property></array>' +
      '<object><property id="x"><null/></property></object><undefined/></arguments></invoke>',
  ]);
});

test("call reads arrays and objects in the answer", async () => {
  const { host } = page(
    '<array><property id="0"><number>4</number></property><property id="1"><object><property id="k"><false/></property></object></property></array>',
  );
  assert.deepEqual(
    await play(`var a = ${EI}.call("f"); trace(a.length + " " + a[0] + " " + a[1].k);`, host),
    ["2 4 false"],
  );
});

test("the page's calls in run the callback on its object and answer in XML", async () => {
  const { host, callbacks } = page(null);
  const lines = await play(
    `var self = {name: "it"};
trace(${EI}.addCallback("g", self, function(a, b) { trace(this.name + " " + a + " " + b); return [a, b]; }));
trace(${EI}.addCallback("h", self, 5)); trace(${EI}.addCallback("h", self, {}));`,
    host,
  );
  const answer = callbacks.get("g")?.(
    '<invoke name="g" returntype="xml"><arguments><string>x</string><number>2</number></arguments></invoke>',
    null,
  );
  assert.deepEqual(lines, ["true", "false", "false", "it x 2"]);
  assert.equal(
    answer,
    '<array><property id="0"><string>x</string></property><property id="1"><number>2</number></property></array>',
  );
  assert.equal(callbacks.has("h"), false);
});

test("the helpers escape and convert as Flash's do", async () => {
  assert.deepEqual(
    await traces([
      `trace(${EI}._escapeXML()); trace(${EI}._escapeXML("")); trace(${EI}._escapeXML("<&'\\">"));
trace(${EI}._unescapeXML("&amp;lt;")); trace(${EI}._jsQuoteString('a"b'));
trace(${EI}._toXML("")); trace(${EI}._toXML(function() {}));
trace(${EI}._arrayToXML("ab")); trace(${EI}._argumentsToXML([1, 2]));
var o = {nodeName: new String("number"), firstChild: " -2.1"}; trace(${EI}._toAS(o));
o.firstChild = "-2.1 "; trace(${EI}._toAS(o));
trace(${EI}._toAS({nodeName: {toString: function() { return "true"; }}}));`,
    ]),
    [
      "null",
      "null",
      "&lt;&amp;&apos;&quot;&gt;",
      "&lt;",
      'a\\"b',
      "<string>null</string>",
      "<null/>",
      '<array><property id="0"><undefined/></property><property id="1"><undefined/></property></array>',
      "<arguments><number>2</number></arguments>",
      "-2.1",
      "NaN",
      "undefined",
    ],
  );
});

/** The function names of the page's requests. */
const names = (requests: string[]) => requests.map((r) => /name="([^"]*)"/.exec(r)?.[1]);

test("a page that refuses the SWF leaves it no ExternalInterface", async () => {
  const { host, requests } = page("<null/>");
  host.allows = () => false;
  assert.deepEqual(
    await play(
      `trace(${EI}.available); trace(${EI}.call("f")); trace(${EI}.addCallback("g", null, function() {}));
trace(${EI}._callOut("<invoke/>"));`,
      host,
    ),
    ["false", "null", "false", "null"],
  );
  assert.deepEqual(requests, []);
});

test("a child from an origin the page refuses cannot call it, by its code or by a timer or callback calling straight", async () => {
  const { host, requests } = page("<null/>");
  host.allows = (url) => url.startsWith("http://a.test/");
  const played = await playNet(
    `createEmptyMovieClip("evil", 1).loadMovie("http://b.test/evil.swf");
createEmptyMovieClip("good", 2).loadMovie("http://a.test/good.swf");
${EI}.call("main");
var frames = 0;
this.onEnterFrame = function() {
  frames++;
  if (_global.f) { _global.f(); _global.f = undefined; }
  if (frames == 4) { ${EI}.call("mainLater"); }
};`,
    {
      url: "http://a.test/main.swf",
      externalInterface: host,
      fetch: files({
        "evil.swf": movie(`${EI}.call("evilDirect");
trace("evil " + ${EI}.available + " " + ${EI}.addCallback("evilCallback", null, function() {}));
setInterval(${EI}.call, 1, "evilTimer");
var holder = {call: ${EI}.call}; setInterval(holder, "call", 1, "evilMethodTimer");
var x = new XML(); x.onData = ${EI}.call; x.load("http://b.test/name.txt");
_global.f = function() { ${EI}.call("evilFunction"); };`),
        "good.swf": movie(`${EI}.call("good");`),
        "name.txt": new TextEncoder().encode("evilData"),
      }),
    },
  );
  for (let i = 0; i < 5; i++) {
    await played.deliver();
    played.player.tick();
  }

  assert.deepEqual(take(played), ["evil false false"]);
  assert.deepEqual(names(requests), ["main", "good", "mainLater"]);
});

test("call sends the function's name as it is, as AS3's does, and a callback's answer reads its getters as AVM1 code", async () => {
  const { host, requests, callbacks } = page("<null/>");
  const lines = await play(
    `${EI}.call("function(a) { return a + '!' && a; }");
var o = {}; o.addProperty("g", function() { return "got"; }, null);
trace(${EI}.addCallback("h", null, function() { return o; }));`,
    host,
  );
  assert.deepEqual(lines, ["true"]);
  assert.deepEqual(names(requests), ["function(a) { return a + '!' && a; }"]);
  assert.equal(
    callbacks.get("h")?.(
      '<invoke name="h" returntype="xml"><arguments></arguments></invoke>',
      null,
    ),
    '<object><property id="g"><string>got</string></property></object>',
  );
});

test("the converters read at most 2^16 values, the array itself among them, and stop at an object inside itself", async () => {
  assert.deepEqual(
    await traces([
      `var s = ${EI}._toXML({length: 2147483647}); trace(s.split("<property").length - 1);
var o = {}; o.me = o; trace(${EI}._toXML(o)); trace(${EI}._toJS(o));`,
    ]),
    ["65535", '<object><property id="me"><null/></property></object>', '({"me":null})'],
  );
});

test("a load redirected to a refused origin is that origin's: its _url and its calls", async () => {
  const { host, requests } = page("<null/>");
  host.allows = (url) => url.startsWith("http://a.test/");
  const evil = movie(`trace("child " + _url); ${EI}.call("evil");`);
  const played = await playNet(
    `createEmptyMovieClip("child", 1).loadMovie("http://a.test/go.swf?u=http://b.test/x.swf");`,
    {
      url: "http://a.test/main.swf",
      externalInterface: host,
      fetch: async (request) =>
        request.url.startsWith("http://a.test/go.swf")
          ? { bytes: evil, status: 200, headers: [], url: "http://b.test/x.swf" }
          : { bytes: null, status: 404, headers: [] },
    },
  );
  await played.deliver();
  played.player.tick();
  assert.deepEqual(take(played), ["child http://b.test/x.swf"]);
  assert.deepEqual(requests, []);
});

test("one call's conversions stop past 2^16 values, however an object is shared down a tree", async () => {
  const started = performance.now();
  const lines = await traces([
    `var o = [1, 2];
for (var i = 0; i < 40; i++) { o = [o, o]; }
var s = ${EI}._toXML(o); trace(s.split("<number>").length - 1 <= 65536);
trace(${EI}._toJS(o).length > 0);`,
  ]);
  assert.deepEqual(lines, ["true", "true"]);
  assert.ok(performance.now() - started < 20000);
});
