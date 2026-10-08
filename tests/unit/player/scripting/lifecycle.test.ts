// What happens to display objects as they come and go through a SWF's
// scripts: an orphan's life off the display list.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { avm2 } from "@swf2es/runtime";
import { containerEngine } from "../../../../oracle/oracle.ts";
import type { Container, MovieClip } from "../../../../packages/player/dist/display/display.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { boundClip } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";

// This file's own out directory: the other test files compile at the same time.
const out = fileURLToPath(new URL("../../out/player-lifecycle/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

test("an orphan plays for a while, then stops where it is until put back", { skip }, async () => {
  // One held stops too, as the player cannot see what holds it, and carries
  // on when put back; one that listens for ENTER_FRAME, held by it in Flash
  // too, plays on.
  const source = `package {
    import flash.display.MovieClip;
    import flash.events.Event;
    public class Bound extends MovieClip {
      public var runs:int = 0;
      public function Bound() {
        addFrameScript(0, function():void { runs++; }, 1, function():void { runs++; });
      }
    }
    public class Main extends MovieClip {
      public var bound:Bound;
      public var kept:Bound;
      public var listening:Bound;
      public function Main() {
        kept = bound;
        removeChild(bound);
        listening = new Bound();
        listening.addEventListener(Event.ENTER_FRAME, function(e:Event):void {});
      }
    }
  }`;
  const scripting = new Scripting(await createCodegen(wasm), { print: () => {} });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(boundClip(compiler(out)("OrphanAge", source), 10, 2), scripting);
  await player.start();
  const kept = scripting.rt.getProperty(
    player.root.object as avm2.AsObject,
    avm2.qname(avm2.publicNs, "kept"),
  ) as avm2.AsObject;
  const clip = kept.$display as MovieClip;
  // Its own count: the root's loop places a new Bound each time round.
  const runsOf = (o: avm2.AsObject) =>
    scripting.rt.getProperty(o, avm2.qname(avm2.publicNs, "runs")) as number;
  const runs = () => runsOf(kept);
  const listening = scripting.rt.getProperty(
    player.root.object as avm2.AsObject,
    avm2.qname(avm2.publicNs, "listening"),
  ) as avm2.AsObject;
  for (let i = 0; i < 100; i++) {
    player.tick();
  }

  const playing = runs() as number;
  assert.ok(playing > 90, `an orphan held plays on: ${playing} runs`);
  for (let i = 0; i < 100; i++) {
    player.tick();
  }

  const stopped = runs() as number;
  assert.ok(stopped < 130, `it stops after 120 frames: ${stopped} runs`);
  const frame = clip.currentFrame;
  for (let i = 0; i < 10; i++) {
    player.tick();
  }

  assert.deepEqual([runs(), clip.currentFrame], [stopped, frame]);
  // Stopped after its frame's script ran, not between an advance and the script.
  assert.equal(clip.scriptedFrame, clip.currentFrame);
  assert.ok(runsOf(listening) > 200, `one that listens plays on: ${runsOf(listening)} runs`);

  // Put back, it plays on from the frame it stopped on.
  (player.root as unknown as Container).addChildAt(clip, 0);
  scripting.lifecycle.added(clip);
  for (let i = 0; i < 4; i++) {
    player.tick();
  }

  assert.ok((runs() as number) >= stopped + 3, `put back, it plays: ${runs()} runs`);
});
