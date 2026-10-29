// ShaderJob as adl runs it: once a job, its targets, what it refuses, and
// an asynchronous job's result and COMPLETE after the frame's EXIT_FRAME.
// adl's asynchronous jobs share a thread, and one that another job starts
// beside may never complete, so this one runs alone.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { PbjAssembler } from "../../../../../pbj-assembler.ts";
import { bare } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { compileScripts } from "../../../../../player/scripts.ts";

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);
const out = fileURLToPath(new URL("../../../../../out/shader-job/", import.meta.url));

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const fill = hex(
  new PbjAssembler()
    .version(1)
    .param("out", "float4", "f0.rgba", "dst")
    .ld("f0.r", 0.25)
    .ld("f0.g", 0.5)
    .ld("f0.b", 0.75)
    .ld("f0.a", 1)
    .bytes(),
);
const sample = hex(
  new PbjAssembler()
    .version(1)
    .param("in", "float2", "f1.rg", "_OutCoord")
    .input(0, 4, "src")
    .param("out", "float4", "f0.rgba", "dst")
    .sample(false, "f0.rgba", "f1.rg", 0)
    .bytes(),
);

const source = `package {
  import flash.display.*;
  import flash.events.*;
  import flash.utils.*;
  public class Jobs extends Sprite {
    private var frame:int = 0;
    private function bytes(s:String):ByteArray {
      var b:ByteArray = new ByteArray();
      for (var i:int = 0; i < s.length; i += 2) b.writeByte(parseInt(s.substr(i, 2), 16));
      return b;
    }
    private function refused(f:Function):void {
      try { f(); trace("ran"); } catch (e:Error) { trace(e.errorID); }
    }
    // Started and cancelled, apart from the other jobs: adl's next job may lose its result to it.
    private function cancelled():void {
      var c:BitmapData = new BitmapData(1, 1, true, 0);
      var job:ShaderJob = new ShaderJob(new Shader(bytes("${fill}")), c);
      job.addEventListener(ShaderEvent.COMPLETE, function(e:Event):void { trace("cancelled job completed"); });
      job.start();
      job.cancel();
      refused(function():void { job.start(); });
    }
    public function Jobs() {
      var b:BitmapData = new BitmapData(2, 2, true, 0);
      var once:ShaderJob = new ShaderJob(new Shader(bytes("${fill}")), b);
      trace("progress " + once.progress + " " + once.width);
      once.start(true);
      trace("sync " + b.getPixel32(1, 1).toString(16) + " " + once.progress + " " + once.width);
      refused(function():void { once.start(true); });

      var v:Vector.<Number> = new Vector.<Number>();
      v.push(9, 9, 9, 9, 9, 9);
      new ShaderJob(new Shader(bytes("${fill}")), v, 1, 1).start(true);
      trace("vector " + v);
      var ba:ByteArray = new ByteArray();
      ba.writeUTFBytes("12345678901234567890");
      new ShaderJob(new Shader(bytes("${fill}")), ba, 1, 1).start(true);
      trace("bytes " + ba.length + " " + ba.position);
      ba.position = 0;
      trace("floats " + ba.readFloat() + " " + ba.readFloat());

      refused(function():void { new ShaderJob(new Shader(bytes("${fill}")), new Sprite(), 1, 1).start(true); });
      refused(function():void { new ShaderJob(new Shader(bytes("${fill}")), new Vector.<Number>(), 0, 1).start(true); });
      refused(function():void { new ShaderJob(null, b).start(true); });
      refused(function():void { new ShaderJob(new Shader(), b).start(true); });
      var s:Shader = new Shader(bytes("${sample}"));
      refused(function():void { new ShaderJob(s, b).start(true); });
      s.data.src.input = new Vector.<Number>();
      refused(function():void { new ShaderJob(s, b).start(true); });
      s.data.src.width = 1;
      s.data.src.height = 1;
      refused(function():void { new ShaderJob(s, b).start(true); });

      var target:BitmapData = new BitmapData(2, 2, true, 0);
      var job:ShaderJob = new ShaderJob(new Shader(bytes("${fill}")), target);
      job.addEventListener(ShaderEvent.COMPLETE, function(e:ShaderEvent):void {
        trace("complete " + frame + " " + (e.target == job) + " " + (e.bitmapData == target) + " " + target.getPixel32(0, 0).toString(16));
      });
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        trace("enterFrame " + ++frame);
        if (frame == 1) cancelled();
      });
      addEventListener(Event.EXIT_FRAME, function(e:Event):void { trace("exitFrame " + frame + " " + target.getPixel32(0, 0).toString(16)); });
      job.start();
      trace("started " + target.getPixel32(0, 0).toString(16));
    }
  }
}`;

test("a ShaderJob runs once, writes each kind of target, and completes after EXIT_FRAME", async () => {
  const abc = compileScripts([{ name: "Jobs", source }], out).get("Jobs") as Uint8Array;
  const lines: string[] = [];
  const errors: unknown[] = [];
  const s = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    onUncaught: (error) => errors.push(error),
    audio: null,
    realTime: null,
  });
  await s.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(abc, 2, "Jobs"), s);
  await player.start();
  player.tick();
  assert.deepEqual(errors, []);
  assert.deepEqual(lines, [
    "progress NaN 0",
    // A BitmapData is written whole, whatever the job's size.
    "sync ff4080bf 1 0",
    "2172",
    "vector 0.25,0.5,0.75,1",
    "bytes 16 16",
    "floats 0.25 0.5",
    "2004",
    "2004",
    "2007",
    "2171",
    "2164",
    "2166",
    "2165",
    "started 0",
    "exitFrame 0 0",
    "complete 0 true true ff4080bf",
    "enterFrame 1",
    "2172",
    "exitFrame 1 ff4080bf",
  ]);
  player.destroy();
});
