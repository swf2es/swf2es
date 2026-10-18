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
trace(${EI}.addCallback("h", self, 5));`,
    host,
  );
  const answer = callbacks.get("g")?.(
    '<invoke name="g" returntype="xml"><arguments><string>x</string><number>2</number></arguments></invoke>',
    null,
  );
  assert.deepEqual(lines, ["true", "false", "it x 2"]);
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
