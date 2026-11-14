// The frame's advance walk (display/advance.ts): it lists only the clips
// whose advance does something, and a script that runs among the advances
// leaves the rest of them as the walk of every clip would have them.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { avm2 } from "@swf2es/runtime";
import { containerEngine } from "../../../../oracle/oracle.ts";
import { walkChecks } from "../../../../packages/player/dist/display/advance.js";
import type { MovieClip } from "../../../../packages/player/dist/display/display.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";
import * as w from "../../../swf-writer.ts";

const out = fileURLToPath(new URL("../../out/player-advance/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

async function play(source: string, className: string, tags: Uint8Array[]) {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (l) => lines.push(l) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const swf = w.swf({
    version: 10,
    width: 20,
    height: 20,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      ...tags.slice(0, -2),
      w.doAbc(compiler(out)(className, source)),
      w.symbolClass([[0, className]]),
      ...tags.slice(-2),
    ],
  });
  const player = new Player(swf, scripting);
  await player.start();
  return { player, lines };
}

test("a clip a listener plays among the advances advances that frame if the walk reaches it after", {
  skip,
}, async () => {
  // a, p and b on the root, stopped but p, whose second frame takes off its
  // two children, x and then c: c's listener plays a and b. b comes after p, so the frame
  // that plays p's second advances b too, as the walk of every clip found
  // b before any advanced; a came before p, and waits for the next frame.
  // The walk had listed p alone, so it finds the rest again for the script.
  const source = `package {
    import flash.display.MovieClip;
    import flash.events.Event;
    public dynamic class AdvMain extends MovieClip {
      public function AdvMain() {
        const a:MovieClip = MovieClip(getChildByName("a"));
        const b:MovieClip = MovieClip(getChildByName("b"));
        a.stop();
        b.stop();
        const p:MovieClip = MovieClip(getChildByName("p"));
        // Unnamed, as a named child's removal tells the walk of a script anyway.
        p.getChildAt(1).addEventListener(Event.REMOVED_FROM_STAGE, function(e:Event):void {
          trace("removed", a.currentFrame, b.currentFrame);
          a.play();
          b.play();
        });
      }
    }
  }`;
  const { player, lines } = await play(source, "AdvMain", [
    w.sprite(2, 3, [w.showFrame(), w.showFrame(), w.showFrame(), w.end()]),
    w.sprite(3, 1, [w.showFrame(), w.end()]),
    w.sprite(4, 2, [
      w.place({ depth: 1, character: 3 }),
      w.place({ depth: 2, character: 3 }),
      w.showFrame(),
      w.remove(1),
      w.remove(2),
      w.showFrame(),
      w.end(),
    ]),
    w.place({ depth: 1, character: 2, name: "a" }),
    w.place({ depth: 2, character: 4, name: "p" }),
    w.place({ depth: 3, character: 2, name: "b" }),
    w.showFrame(),
    w.end(),
  ]);
  const root = player.root;
  const a = root.depths.get(1) as MovieClip;
  const p = root.depths.get(2) as MovieClip;
  const b = root.depths.get(3) as MovieClip;
  assert.equal(p.currentFrame, 1);

  const refound = walkChecks.refound;
  player.tick();
  assert.deepEqual(lines, ["removed 1 1"]);
  assert.equal(p.currentFrame, 2);
  assert.equal(a.currentFrame, 1);
  assert.equal(b.currentFrame, 2);
  assert.equal(walkChecks.refound, refound + 1);

  player.tick();
  assert.equal(a.currentFrame, 2);
  assert.equal(b.currentFrame, 3);
});

test("a frame's advances leave out the clips that stop or have one frame, and play the rest", {
  skip,
}, async () => {
  // Stopped, of one frame, playing; then played by a script, stopped again,
  // made with new and added: each advances when it should, the walk listing
  // only those whose advance does something.
  const source = `package {
    import flash.display.MovieClip;
    public dynamic class AdvList extends MovieClip {
      public var made:MovieClip;
      public function AdvList() {
        MovieClip(getChildByName("s")).stop();
      }
      public function playS():void { MovieClip(getChildByName("s")).play(); }
      public function stopL():void { MovieClip(getChildByName("l")).stop(); }
      public function make():void { made = new AdvPart(); addChild(made); }
    }
    public dynamic class AdvPart extends MovieClip {}
  }`;
  const { player } = await play(source, "AdvList", [
    w.sprite(2, 3, [w.showFrame(), w.showFrame(), w.showFrame(), w.end()]),
    w.sprite(3, 1, [w.showFrame(), w.end()]),
    w.place({ depth: 1, character: 2, name: "s" }),
    w.place({ depth: 2, character: 3, name: "one" }),
    w.place({ depth: 3, character: 2, name: "l" }),
    w.showFrame(),
    w.end(),
  ]);
  const scripting = player.scripting as Scripting;
  const main = player.root.object as avm2.AsObject;
  const call = (name: string) =>
    scripting.rt.call(scripting.rt.getProperty(main, avm2.qname(avm2.publicNs, name)), main);
  const root = player.root;
  const s = root.depths.get(1) as MovieClip;
  const l = root.depths.get(3) as MovieClip;

  player.tick();
  assert.equal(s.currentFrame, 1);
  assert.equal(l.currentFrame, 2);
  assert.equal(s.advanceDue, false);
  assert.equal(l.advanceDue, true);
  assert.equal((root.depths.get(2) as MovieClip).advanceDue, false);

  call("playS");
  call("stopL");
  player.tick();
  assert.equal(s.currentFrame, 2);
  assert.equal(l.currentFrame, 2);

  // Made with new, it sits the next frame out, then plays its one frame: nothing.
  call("make");
  const made = (scripting.rt.getProperty(main, avm2.qname(avm2.publicNs, "made")) as avm2.AsObject)
    .$display as MovieClip;
  assert.equal(made.fresh, true);
  player.tick();
  assert.equal(made.fresh, false);
  player.tick();
  assert.equal(made.advanceDue, false);
  assert.equal(s.currentFrame, 1);
});
