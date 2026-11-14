// The frame's advance walk (display/advance.ts): it lists only the clips
// whose advance does something; a clip it left out that a script among the
// advances makes advance has the tick find every clip again, and advance
// those after the one advancing as the walk of every clip would have. The
// checked build (SWF2ES_CHECKED) runs each of these against that walk too.
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

/** Characters the tests place: 2 a clip of 3 empty frames, 3 one of one. */
const THREE = w.sprite(2, 3, [w.showFrame(), w.showFrame(), w.showFrame(), w.end()]);
const ONE = w.sprite(3, 1, [w.showFrame(), w.end()]);
/** 4, p: a clip of 2 frames whose second takes off its two children, both clips of one frame. */
const TAKES_OFF = w.sprite(4, 2, [
  w.place({ depth: 1, character: 3 }),
  w.place({ depth: 2, character: 3 }),
  w.showFrame(),
  w.remove(1),
  w.remove(2),
  w.showFrame(),
  w.end(),
]);
/** a, p and b on the root. */
const ABP = [
  w.place({ depth: 1, character: 2 }),
  w.place({ depth: 2, character: 4 }),
  w.place({ depth: 3, character: 2 }),
];

interface Played {
  player: Player;
  lines: string[];
  /** The clip at `depth` on the root. */
  at: (depth: number) => MovieClip;
  /** The clip of the root's public property `name`. */
  clip: (name: string) => MovieClip;
  /** Call the root's public method `name`. */
  call: (name: string) => void;
}

/**
 * Play a SWF whose root is `main`, of `source`, with `characters` defined
 * and `places` on its one frame; `more`, more tags after its own ABC.
 */
async function play(
  main: string,
  source: string,
  characters: Uint8Array[],
  places: Uint8Array[],
  options: { version?: number; symbols?: [number, string][]; more?: Uint8Array[] } = {},
): Promise<Played> {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (l) => lines.push(l) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const swf = w.swf({
    version: options.version ?? 10,
    width: 20,
    height: 20,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      ...characters,
      w.doAbc(compiler(out)(main, source)),
      ...(options.more ?? []),
      w.symbolClass([[0, main], ...(options.symbols ?? [])]),
      ...places,
      w.showFrame(),
      w.end(),
    ],
  });
  const player = new Player(swf, scripting);
  await player.start();
  const object = player.root.object as avm2.AsObject;
  const property = (name: string) =>
    scripting.rt.getProperty(object, avm2.qname(avm2.publicNs, name)) as avm2.AsObject;
  return {
    player,
    lines,
    at: (depth) => player.root.depths.get(depth) as MovieClip,
    clip: (name) => property(name).$display as MovieClip,
    call: (name) => {
      scripting.rt.call(property(name), object);
    },
  };
}

/**
 * The root of a, p and b, stopped but p, whose second frame takes off its
 * two children; the second's REMOVED_FROM_STAGE listener runs `then`.
 */
const listened = (then: string) => `package {
  import flash.display.MovieClip;
  import flash.events.Event;
  public dynamic class Adv extends MovieClip {
    public function Adv() {
      const a:MovieClip = MovieClip(getChildAt(0));
      const p:MovieClip = MovieClip(getChildAt(1));
      const b:MovieClip = MovieClip(getChildAt(2));
      a.stop();
      b.stop();
      // Unnamed, so that no parent's property of it runs a script.
      p.getChildAt(1).addEventListener(Event.REMOVED_FROM_STAGE, function(e:Event):void {
        trace("removed", a.currentFrame, b.currentFrame);
        ${then}
      });
    }
  }
}`;

test("a clip a listener among the advances plays after the one advancing advances in that frame", {
  skip,
}, async () => {
  // The walk of every clip found b before any advanced: so the frame that
  // plays p's second advances b too. The walk listed p alone.
  const { player, lines, at } = await play(
    "Adv",
    listened("b.play();"),
    [THREE, ONE, TAKES_OFF],
    ABP,
  );
  const refound = walkChecks.refound;
  player.tick();
  assert.deepEqual(lines, ["removed 1 1"]);
  assert.equal(at(2).currentFrame, 2);
  assert.equal(at(3).currentFrame, 2);
  assert.equal(walkChecks.refound, refound + 1);

  player.tick();
  assert.equal(at(3).currentFrame, 3);
});

test("a clip a listener among the advances plays before the one advancing waits for the next frame", {
  skip,
}, async () => {
  const { player, lines, at } = await play(
    "Adv",
    listened("a.play();"),
    [THREE, ONE, TAKES_OFF],
    ABP,
  );
  player.tick();
  assert.deepEqual(lines, ["removed 1 1"]);
  assert.equal(at(1).currentFrame, 1);

  player.tick();
  assert.equal(at(1).currentFrame, 2);
});

test("a listener among the advances that makes no clip left out advance has none found again", {
  skip,
}, async () => {
  // b sent to a frame but stopped does not advance: nothing to find again.
  const { player, lines, at } = await play(
    "Adv",
    listened("b.gotoAndStop(2); a.stop();"),
    [THREE, ONE, TAKES_OFF],
    ABP,
  );
  const refound = walkChecks.refound;
  player.tick();
  assert.deepEqual(lines, ["removed 1 1"]);
  assert.equal(at(3).currentFrame, 2);
  assert.equal(walkChecks.refound, refound);

  player.tick();
  assert.equal(at(3).currentFrame, 2);
});

test("a named child's property on its parent, set to null among the advances, may play a clip", {
  skip,
}, async () => {
  // p's class has a setter of its child c's name, which the timeline's
  // removal sets to null: it plays b.
  const source = `package {
    import flash.display.MovieClip;
    public dynamic class AdvNamed extends MovieClip {
      public static var b:MovieClip;
      public function AdvNamed() {
        b = MovieClip(getChildAt(2));
        b.stop();
        MovieClip(getChildAt(0)).stop();
      }
    }
  }`;
  const holder = `package {
    import flash.display.MovieClip;
    import flash.utils.getDefinitionByName;
    public class AdvHolder extends MovieClip {
      private var _c:MovieClip;
      public function get c():MovieClip { return _c; }
      public function set c(v:MovieClip):void {
        _c = v;
        if (v == null) {
          trace("unset");
          Object(getDefinitionByName("AdvNamed")).b.play();
        }
      }
    }
  }`;
  const named = w.sprite(4, 2, [
    w.place({ depth: 1, character: 3, name: "c" }),
    w.showFrame(),
    w.remove(1),
    w.showFrame(),
    w.end(),
  ]);
  const { player, lines, at } = await play("AdvNamed", source, [THREE, ONE, named], ABP, {
    symbols: [[4, "AdvHolder"]],
    more: [w.doAbc(compiler(out)("AdvHolder", holder))],
  });
  player.tick();
  assert.deepEqual(lines, ["unset"]);
  assert.equal(at(3).currentFrame, 2);
});

test("a class's first script, run as the timeline places its symbol among the advances, may play a clip", {
  skip,
}, async () => {
  // AdvLate's ABC is lazy: its script runs as p's second frame places its symbol.
  const source = `package {
    import flash.display.MovieClip;
    public dynamic class AdvMain extends MovieClip {
      public static var b:MovieClip;
      public function AdvMain() {
        b = MovieClip(getChildAt(2));
        b.stop();
        MovieClip(getChildAt(0)).stop();
      }
    }
  }`;
  const late = `package {
    import flash.display.MovieClip;
    import flash.utils.getDefinitionByName;
    public class AdvLate extends MovieClip {
      public static var played:Boolean = playB();
      private static function playB():Boolean {
        trace("late");
        Object(getDefinitionByName("AdvMain")).b.play();
        return true;
      }
    }
  }`;
  const places = w.sprite(4, 2, [
    w.showFrame(),
    w.place({ depth: 1, character: 5 }),
    w.showFrame(),
    w.end(),
  ]);
  const { player, lines, at } = await play(
    "AdvMain",
    source,
    [THREE, ONE, w.sprite(5, 1, [w.showFrame(), w.end()]), places],
    ABP,
    {
      symbols: [[5, "AdvLate"]],
      more: [w.doAbc(compiler(out)("AdvLate", late), "AdvLate", true)],
    },
  );
  player.tick();
  assert.deepEqual(lines, ["late"]);
  assert.equal(at(3).currentFrame, 2);
});

test("clips found again are those of the display list as the walk found it, whatever a script moved", {
  skip,
}, async () => {
  // Under the root: a, p, b, then m and n, which play. The listener takes m
  // off, an orphan now, swaps a and n, moves b under n, and plays b: each
  // of a (stopped), b, m and n advances once, in the walk's order, and m
  // not again as an orphan.
  const source = `package {
    import flash.display.MovieClip;
    import flash.events.Event;
    public dynamic class AdvMoves extends MovieClip {
      public function AdvMoves() {
        const a:MovieClip = MovieClip(getChildAt(0));
        const p:MovieClip = MovieClip(getChildAt(1));
        const b:MovieClip = MovieClip(getChildAt(2));
        const m:MovieClip = MovieClip(getChildAt(3));
        const n:MovieClip = MovieClip(getChildAt(4));
        a.stop();
        b.stop();
        p.getChildAt(1).addEventListener(Event.REMOVED_FROM_STAGE, function(e:Event):void {
          removeChild(m);
          swapChildren(a, n);
          n.addChildAt(b, 0);
          b.play();
          trace("moved");
        });
      }
    }
  }`;
  const { player, lines, at } = await play(
    "AdvMoves",
    source,
    [THREE, ONE, TAKES_OFF],
    [...ABP, w.place({ depth: 4, character: 2 }), w.place({ depth: 5, character: 2 })],
  );
  const clips = [at(1), at(3), at(4), at(5)];
  const refound = walkChecks.refound;
  player.tick();
  assert.deepEqual(lines, ["moved"]);
  assert.deepEqual(
    clips.map((c) => c.currentFrame),
    [1, 2, 2, 2],
  );
  assert.equal(walkChecks.refound, refound + 1);
});

test("a button's state a listener among the advances plays advances in that frame", {
  skip,
}, async () => {
  // The state, made with new, sits the first frame out; p plays from then.
  const source = `package {
    import flash.display.MovieClip;
    import flash.display.SimpleButton;
    import flash.events.Event;
    public dynamic class AdvButton extends MovieClip {
      public var state:MovieClip;
      public function AdvButton() {
        MovieClip(getChildAt(0)).stop();
        MovieClip(getChildAt(1)).stop();
        MovieClip(getChildAt(2)).stop();
        state = new AdvState();
        state.stop();
        addChild(new SimpleButton(state));
      }
      public function go():void {
        const p:MovieClip = MovieClip(getChildAt(1));
        p.getChildAt(1).addEventListener(Event.REMOVED_FROM_STAGE, function(e:Event):void {
          state.play();
        });
        p.play();
      }
    }
    public class AdvState extends MovieClip {}
  }`;
  const { player, at, clip, call } = await play("AdvButton", source, [THREE, ONE, TAKES_OFF], ABP, {
    symbols: [[2, "AdvState"]],
  });
  player.tick();
  call("go");
  player.tick();
  assert.equal(at(2).currentFrame, 2);
  assert.equal(clip("state").currentFrame, 2);
});

test("a clip of version 9 a listener among the advances sends to a frame advances from it", {
  skip,
}, async () => {
  // Its goto stamps it to sit a frame out (skipsAfter) after the walk: the
  // walk of all found it, so it advances from the frame it was sent to.
  const { player, at } = await play(
    "Adv",
    listened("b.gotoAndPlay(2);"),
    [THREE, ONE, TAKES_OFF],
    ABP,
    { version: 9 },
  );
  player.tick();
  assert.equal(at(3).currentFrame, 3);
});

test("a clip walked twice, a state of two buttons, has the clips after its second found again", {
  skip,
}, async () => {
  // s, of 5 frames, places c on its second, which its loop takes off; c's
  // REMOVED listener plays b. s is the state of two buttons, so it advances
  // twice a frame: the loop comes in its second advance of a frame, after
  // which only b is left.
  const source = `package {
    import flash.display.MovieClip;
    import flash.display.SimpleButton;
    public dynamic class AdvTwice extends MovieClip {
      public static var b:MovieClip;
      public var s:MovieClip;
      public function AdvTwice() {
        s = new AdvShared();
        addChild(new SimpleButton(s));
        addChild(new SimpleButton(s));
        b = MovieClip(getChildAt(0));
        b.stop();
        setChildIndex(b, numChildren - 1);
      }
    }
  }`;
  const parts = `package {
    import flash.display.MovieClip;
    import flash.events.Event;
    import flash.utils.getDefinitionByName;
    public class AdvC extends MovieClip {
      public function AdvC() {
        addEventListener(Event.REMOVED, function(e:Event):void {
          if (e.target == e.currentTarget) {
            trace("removed");
            Object(getDefinitionByName("AdvTwice")).b.play();
          }
        });
      }
    }
  }`;
  const shared = `package {
    import flash.display.MovieClip;
    public class AdvShared extends MovieClip {}
  }`;
  const five = w.sprite(4, 5, [
    w.showFrame(),
    w.place({ depth: 1, character: 3 }),
    w.showFrame(),
    w.showFrame(),
    w.showFrame(),
    w.showFrame(),
    w.end(),
  ]);
  const { player, lines, clip } = await play(
    "AdvTwice",
    source,
    [THREE, ONE, five],
    [w.place({ depth: 1, character: 2 })],
    {
      symbols: [
        [4, "AdvShared"],
        [3, "AdvC"],
      ],
      more: [w.doAbc(compiler(out)("AdvC", parts)), w.doAbc(compiler(out)("AdvShared", shared))],
    },
  );
  const s = clip("s");
  const b = player.root.children.at(-1) as MovieClip;
  assert.equal(b.currentFrame, 1);
  for (let i = 0; i < 8 && lines.length === 0; i++) {
    const from = s.currentFrame;
    player.tick();
    if (lines.length > 0) {
      // Twice on round its 5 frames, and b once.
      assert.equal(s.currentFrame, ((from + 1) % 5) + 1);
      assert.equal(b.currentFrame, 2);
    }
  }

  assert.deepEqual(lines, ["removed"]);
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
        MovieClip(getChildAt(0)).stop();
      }
      public function playS():void { MovieClip(getChildAt(0)).play(); }
      public function stopL():void { MovieClip(getChildAt(2)).stop(); }
      public function make():void { made = new AdvPart(); addChild(made); }
    }
    public dynamic class AdvPart extends MovieClip {}
  }`;
  const { player, at, clip, call } = await play(
    "AdvList",
    source,
    [THREE, ONE],
    [
      w.place({ depth: 1, character: 2 }),
      w.place({ depth: 2, character: 3 }),
      w.place({ depth: 3, character: 2 }),
    ],
  );
  const s = at(1);
  const l = at(3);
  player.tick();
  assert.equal(s.currentFrame, 1);
  assert.equal(l.currentFrame, 2);
  assert.equal(s.advanceDue, false);
  assert.equal(l.advanceDue, true);
  assert.equal(at(2).advanceDue, false);

  call("playS");
  call("stopL");
  player.tick();
  assert.equal(s.currentFrame, 2);
  assert.equal(l.currentFrame, 2);

  // Made with new, it sits the next frame out, then plays its one frame: nothing.
  call("make");
  const made = clip("made");
  assert.equal(made.fresh, true);
  player.tick();
  assert.equal(made.fresh, false);
  player.tick();
  assert.equal(made.advanceDue, false);
  assert.equal(s.currentFrame, 1);
});
