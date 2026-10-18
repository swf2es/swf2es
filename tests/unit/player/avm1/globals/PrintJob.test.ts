// PrintJob's AS2 face in node: its methods from SWF 7, its measures added
// to the prototype by the first job, and a prototype that inherits nothing
// up to SWF 6 (the corpus's printjob_props_* tests, adl).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { Avm1 } from "../../../../../packages/player/dist/avm1/avm1.js";
import { Player } from "../../../../../packages/player/dist/player.js";
import { flashAssembler, script } from "../../../../avm1-script.ts";
import * as w from "../../../../swf-writer.ts";

const codegen = await createCodegen(
  await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  ),
);

/** What `source` traces in a SWF of `version`. */
async function play(source: string, version: number): Promise<string[]> {
  const swf = w.swf({
    version,
    width: 100,
    height: 100,
    frameCount: 1,
    tags: [
      w.doAction([...script(source, version)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
  const lines: string[] = [];
  const avm1 = new Avm1(codegen, { print: (line) => lines.push(line), realTime: null });
  await new Player(swf, null, avm1).start();
  return lines;
}

const source = `var p = PrintJob.prototype; var before = 0; for (var k in p) { before++; }
var o = new PrintJob(); var names = []; for (var k in o) { names.push(k); }
trace(before + " " + names.join(",") + " " + p.hasOwnProperty("paperWidth") + " " + o.hasOwnProperty("paperWidth"));
o.pageWidth = 5; delete o.pageWidth; trace(o.pageWidth + " " + typeof o.start + " " + o);
trace(o.start() + " " + o.addPage(_root) + " " + o.send());`;

test("a job's measures are 0 on the prototype the first job adds them to, its methods do nothing", async () => {
  assert.deepEqual(await play(source, 7), [
    "0 orientation,pageWidth,pageHeight,paperWidth,paperHeight true false",
    "0 function [object Object]",
    "false false undefined",
  ]);
});

test("up to SWF 6 the prototype has no methods and inherits nothing, not even toString", async () => {
  assert.deepEqual(await play(`trace(PrintJob.prototype); trace(new PrintJob().start);`, 6), [
    "[type Object]",
    "undefined",
  ]);
});
