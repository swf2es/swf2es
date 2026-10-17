// The player's AVM1 in node, without a renderer: an AVM1 SWF's blocks,
// assembled here, compiled by the release codegen.wasm and run with the
// root timeline.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { createCodegen } from "@swf2es/codegen";
import { Avm1, type Avm1Options } from "../../../../packages/player/dist/avm1/avm1.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Avm1Assembler, constant, type PushValue, register } from "../../../avm1-assembler.ts";
import { flashAssembler, script } from "../../../avm1-script.ts";
import * as w from "../../../swf-writer.ts";

const codegen = await createCodegen(
  await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  ),
);

/** A DoAction of what `write` assembles, and End. */
function doAction(write: (a: Avm1Assembler) => Avm1Assembler): Uint8Array {
  return w.doAction([...write(new Avm1Assembler()).end().bytes()]);
}

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

const traced = (...values: PushValue[]) =>
  doAction((a) => values.reduce<Avm1Assembler>((b, v) => b.push(v).trace(), a));

function movie(version: number, frames: Uint8Array[][], as3 = false): Uint8Array {
  return w.swf({
    version,
    width: 10,
    height: 10,
    frameCount: frames.length,
    tags: [
      ...(as3 || version >= 8 ? [w.fileAttributes(as3)] : []),
      ...frames.flatMap((tags) => [...tags, w.showFrame()]),
      w.end(),
    ],
  });
}

/** The lines a SWF traces in `frames` frames, and the errors its blocks threw. */
async function play(swf: Uint8Array, frames: number, options: Avm1Options = {}) {
  const lines: string[] = [];
  const errors: unknown[] = [];
  const avm1 = new Avm1(codegen, {
    print: (line) => lines.push(line),
    onUncaught: (error) => errors.push(error),
    ...options,
  });
  const player = new Player(swf, null, avm1);
  await player.start();
  for (let i = 1; i < frames; i++) {
    player.tick();
  }

  return { lines, errors, player, avm1 };
}

test("each frame's blocks run in order as the root enters it, and the root loops", async () => {
  const swf = movie(6, [[traced("1a"), traced("1b")], [], [traced("3")]]);
  const { lines, errors } = await play(swf, 5);

  assert.deepEqual(lines, ["1a", "1b", "3", "1a", "1b"]);
  assert.deepEqual(errors, []);
});

test("actions after the last ShowFrame run with the last frame where it loops, and once after it where it stops", async () => {
  const swf = (header: number, end: boolean) =>
    w.swf({
      version: 6,
      width: 10,
      height: 10,
      frameCount: header,
      tags: [
        traced("1"),
        w.showFrame(),
        traced("2"),
        w.showFrame(),
        traced("tail"),
        ...(end ? [w.end()] : []),
      ],
    });

  for (const header of [1, 2, 5]) {
    assert.deepEqual((await play(swf(header, true), 4)).lines, [
      "1",
      "2",
      "tail",
      "1",
      "2",
      "tail",
    ]);
  }

  const { lines, player } = await play(swf(2, false), 5);
  assert.deepEqual(lines, ["1", "2", "tail"]);
  assert.equal(player.root.currentFrame, 2);

  // A root of one frame stops on it, End or not, and runs its tail as the next frame comes.
  for (const end of [true, false]) {
    const one = w.swf({
      version: 6,
      width: 10,
      height: 10,
      frameCount: 1,
      tags: [traced("1"), w.showFrame(), traced("tail"), ...(end ? [w.end()] : [])],
    });
    assert.deepEqual((await play(one, 1)).lines, ["1"]);
    assert.deepEqual((await play(one, 4)).lines, ["1", "tail"]);
  }
});

test("stop holds the root on its frame, whose actions do not run again", async () => {
  const swf = movie(6, [[traced("1")], [doAction((a) => a.push("2").trace().stop())]]);
  const { lines, player } = await play(swf, 5);

  assert.deepEqual(lines, ["1", "2"]);
  assert.equal(player.root.currentFrame, 2);
  assert.equal(player.root.playing, false);
});

test("a frame's blocks share the operand stack, which the next frame finds empty", async () => {
  const swf = movie(7, [[doAction((a) => a.push("left")), doAction((a) => a.trace())]]);
  const second = movie(7, [[doAction((a) => a.push("left"))], [doAction((a) => a.trace().stop())]]);

  assert.deepEqual((await play(swf, 1)).lines, ["left"]);
  assert.deepEqual((await play(second, 3)).lines, ["undefined"]);
});

test("a frame's blocks share the constant pool the last one set; the next frame's start without", async () => {
  const swf = movie(6, [
    [doAction((a) => a.constantPool("one")), doAction((a) => a.push(constant(0)).trace())],
    [doAction((a) => a.push(constant(0)).trace().stop())],
  ]);

  assert.deepEqual((await play(swf, 3)).lines, ["one", "undefined"]);
});

test("a DoInitAction runs before its frame's DoActions, once a sprite, its pool its own", async () => {
  const init = (text: string) =>
    w.doInitAction(1, [...new Avm1Assembler().constantPool(text).push(text).trace().end().bytes()]);
  const swf = movie(6, [
    [
      w.sprite(1, 1, [w.showFrame(), w.end()]),
      doAction((a) => a.push(constant(0)).trace()),
      init("init"),
      init("again"),
    ],
    [],
  ]);

  assert.deepEqual((await play(swf, 3)).lines, ["init", "undefined", "undefined"]);
});

test("values trace as AVM1 writes them, by version", async () => {
  const values = [undefined, null, true, false, 0.1, "a\rb"];

  assert.deepEqual((await play(movie(4, [[traced(...values)]]), 1)).lines, [
    "undefined",
    "null",
    "1",
    "0",
    "0.1",
    "a\rb",
  ]);
  assert.deepEqual((await play(movie(6, [[traced(...values)]]), 1)).lines, [
    "undefined",
    "null",
    "true",
    "false",
    "0.1",
    "a\rb",
  ]);
});

test("an AS3 SWF's blocks never run", async () => {
  const { lines } = await play(movie(9, [[traced("no")]], true), 2);

  assert.deepEqual(lines, []);
});

test("an error a block throws is reported, and the frame's next block runs", async () => {
  const swf = movie(6, [
    [doAction((a) => a.getUrl("http://a.example/", "_blank")), traced("next")],
  ]);
  const failure = new Error("the host failed");
  const { lines, errors } = await play(swf, 1, {
    navigate: () => {
      throw failure;
    },
  });

  assert.deepEqual(lines, ["next"]);
  assert.deepEqual(errors, [failure]);
});

test("an action Flash cannot read stops the SWF there, every frame after", async () => {
  // A Push of value type 10, which Flash does not know.
  const swf = movie(6, [
    [doAction((a) => a.push("1").trace().raw([0x96, 2, 0, 10, 0])), traced("after")],
    [traced("2")],
  ]);
  const { lines, errors, player, avm1 } = await play(swf, 3);

  assert.deepEqual(lines, ["1"]);
  assert.deepEqual(errors, []);
  assert.ok(avm1.halted);
  assert.equal(player.root.currentFrame, 1);
});

test("a place whose clip actions run past its tag stops the SWF as the first of its events comes", async () => {
  /** Frame 2: an init, an action, a place of `events` whose record runs past it, an init. */
  const stopped = async (events: number) => {
    const past = new w.BitWriter().u16(0).u32(events).u32(events).u32(100).raw([0x07, 0x00]);
    const place = w.tag(26, new w.BitWriter().u8(0x80).u16(1).raw(past.done()).done());
    const init = (id: number, text: string) =>
      w.doInitAction(id, [...new Avm1Assembler().push(text).trace().end().bytes()]);
    const swf = movie(7, [
      [w.sprite(1, 1, [w.showFrame(), w.end()]), w.sprite(2, 1, [w.showFrame(), w.end()])],
      [init(1, "init"), traced("2"), place, init(2, "init after")],
      [traced("3")],
    ]);
    const { lines, avm1 } = await play(swf, 5);
    return { lines, halted: avm1.halted };
  };

  // load and initialize as the clip is placed, before the frame's actions.
  assert.deepEqual(await stopped(1 << 0), { lines: [], halted: true });
  assert.deepEqual(await stopped(1 << 9), { lines: [], halted: true });
  // construct after the frame's DoInitActions.
  assert.deepEqual(await stopped(1 << 18), { lines: ["init", "init after"], halted: true });
  // enterFrame at the next frame, whether or not the root moves on.
  assert.deepEqual(await stopped(1 << 1), {
    lines: ["init", "init after", "2"],
    halted: true,
  });
  // keyDown not until a key comes.
  assert.deepEqual(await stopped(1 << 6), {
    lines: ["init", "init after", "2", "3", "2"],
    halted: false,
  });
});

/** `function deep() { trace(++depth); deep(); }`, called, then a trace that never comes. */
const recursing = () =>
  doAction((a) =>
    a
      .defineFunction(
        "deep",
        [],
        new Avm1Assembler()
          .push("depth", "depth")
          .op("GetVariable")
          .op("Increment")
          .op("SetVariable")
          .push("depth")
          .op("GetVariable")
          .trace()
          .push(0, "deep")
          .op("CallFunction"),
      )
      .push("depth", 0)
      .op("SetVariable")
      .push(0, "deep")
      .op("CallFunction")
      .push("unreached")
      .trace(),
  );

test("past the recursion limit, a SWF's ScriptLimits, every action is disabled and the timeline plays on", async () => {
  const limits = w.tag(65, Uint8Array.from([4, 0, 15, 0]));
  const swf = movie(6, [[limits, recursing(), traced("next block")], [traced("2")], []]);
  const { lines, errors, player, avm1 } = await play(swf, 3);

  assert.deepEqual(lines, ["1", "2", "3"]);
  assert.deepEqual(errors, []);
  assert.ok(avm1.rt.disabled);
  assert.ok(!avm1.halted);
  assert.equal(player.root.currentFrame, 3);
});

/** `depth = 0; function deep(n) { trace(++depth); if (depth < n) deep(n); } deep(n); trace("back")`. */
const recursingTo = (n: number) =>
  doAction((a) =>
    a
      .defineFunction(
        "deep",
        ["n"],
        new Avm1Assembler()
          .push("depth", "depth")
          .op("GetVariable")
          .op("Increment")
          .op("SetVariable")
          .push("depth")
          .op("GetVariable")
          .trace()
          .push("depth")
          .op("GetVariable")
          .push("n")
          .op("GetVariable")
          .op("Less2")
          .op("Not")
          .if("done")
          .push("n")
          .op("GetVariable")
          .push(1, "deep")
          .op("CallFunction")
          .pop()
          .label("done"),
      )
      .push("depth", 0)
      .op("SetVariable")
      .push(n, 1, "deep")
      .op("CallFunction")
      .pop()
      .push("back")
      .trace(),
  );

test("a ScriptLimits takes effect as its frame comes, the frame's last of two", async () => {
  const limits = (depth: number) => w.tag(65, Uint8Array.from([depth, 0, 10, 0]));
  const swf = movie(6, [[recursingTo(50)], [limits(9), limits(3), recursingTo(5)], [traced("3")]]);
  const { lines, avm1 } = await play(swf, 3);

  // Frame 1 recurses 50 deep under the default limit, frame 2 two deep under its own.
  assert.equal(lines.length, 50 + 1 + 2);
  assert.deepEqual(lines.slice(-4), ["50", "back", "1", "2"]);
  assert.ok(avm1.rt.disabled);
  assert.equal(avm1.rt.maxRecursion, 3);
  assert.equal(avm1.rt.scriptTimeout, 10);
});

test("a ScriptLimits depth of 1 or 0 runs no action at all", async () => {
  for (const depth of [0, 1]) {
    const limits = w.tag(65, Uint8Array.from([depth, 0, 15, 0]));
    const { lines, avm1 } = await play(movie(6, [[limits, traced("1")], [traced("2")]]), 2);

    assert.deepEqual(lines, []);
    assert.ok(avm1.rt.disabled);
  }
});

test("a RangeError other than the stack's is an error, which disables nothing", async () => {
  // A string doubled past the engine's longest.
  const doubling = doAction((a) =>
    a
      .push("s", "s")
      .op("SetVariable")
      .push(0)
      .storeRegister(0)
      .pop()
      .label("top")
      .push("s", "s")
      .op("GetVariable")
      .push("s")
      .op("GetVariable")
      .op("Add2")
      .op("SetVariable")
      .push(register(0))
      .op("Increment")
      .storeRegister(0)
      .push(40)
      .op("Less2")
      .if("top"),
  );
  const { lines, errors, avm1 } = await play(movie(6, [[doubling], [traced("2")]]), 2);

  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof RangeError);
  assert.ok(!avm1.rt.disabled);
  assert.deepEqual(lines, ["2"]);
});

test("the global registers are the frame's, kept from block to block", async () => {
  const swf = movie(6, [
    [doAction((a) => a.push("r").storeRegister(1)), doAction((a) => a.push(register(1)).trace())],
    [doAction((a) => a.push(register(1)).trace().stop())],
  ]);

  assert.deepEqual((await play(swf, 3)).lines, ["r", "undefined"]);
});

/** A DoAction of AS1 source, as Flash's compiler writes it. */
const as1 = (source: string, version: number) =>
  w.doAction([...script(source, version)(flashAssembler()).end().bytes()]);

/** A DefineSprite of the frames' tags. */
const sprite = (id: number, frames: Uint8Array[][]) =>
  w.sprite(id, frames.length, [...frames.flatMap((f) => [...f, w.showFrame()]), w.end()]);

/** A clip of `frames` frames that traces "<name> <frame>" on each. */
const counting = (id: number, frames: number, version = 6) =>
  sprite(
    id,
    Array.from({ length: frames }, () => [as1(`trace(_name + " " + _currentframe);`, version)]),
  );

test("clips play the newest first, each frame's actions in tag order, a child's first frame as it is placed", async () => {
  const swf = movie(6, [
    [
      counting(1, 2),
      w.place({ depth: 1, character: 1, name: "a" }),
      as1(`trace("root 1");`, 6),
      w.place({ depth: 2, character: 1, name: "b" }),
    ],
    [as1(`trace("root 2"); stop();`, 6)],
  ]);
  const { lines, errors } = await play(swf, 3);

  assert.deepEqual(lines, ["a 1", "root 1", "b 1", "b 2", "a 2", "root 2", "b 1", "a 1"]);
  assert.deepEqual(errors, []);
});

test("a clip is a movieclip, which converts to its path, and the root is _level0", async () => {
  const swf = movie(7, [
    [
      sprite(2, [[]]),
      sprite(1, [[w.place({ depth: 1, character: 2, name: "b" })]]),
      w.place({ depth: 1, character: 1, name: "a" }),
      w.place({ depth: 2, character: 1 }),
      as1(
        `trace(typeof a); trace(a); trace(a.b); trace(this); trace(_root._name == ""); trace(instance1._name); trace(a.b._target); trace(_level0 == this); trace(a.b._parent == a); trace(Number(a)); trace(a < 1);`,
        7,
      ),
    ],
  ]);

  assert.deepEqual((await play(swf, 1)).lines, [
    "movieclip",
    "_level0.a",
    "_level0.a.b",
    "_level0",
    "true",
    "instance1",
    "/a/b",
    "true",
    "true",
    "NaN",
    "undefined",
  ]);
});

test("instance names are found whatever their case up to SWF 6, a shape's not at all", async () => {
  const shape = w.shape({
    id: 3,
    bounds: [0, 20, 0, 20],
    fills: [0xff0000],
    paths: [{ fill1: 1, commands: [{ move: [0, 0] }, { line: [20, 0] }, { line: [0, 20] }] }],
  });
  const swf = (version: number) =>
    movie(version, [
      [
        shape,
        sprite(1, [[]]),
        w.place({ depth: 1, character: 1, name: "Ball" }),
        w.place({ depth: 2, character: 3, name: "shape" }),
        as1(`trace(typeof ball); trace(typeof Ball); trace(shape == this);`, version),
      ],
    ]);

  assert.deepEqual((await play(swf(6), 1)).lines, ["movieclip", "movieclip", "true"]);
  assert.deepEqual((await play(swf(7), 1)).lines, ["undefined", "movieclip", "true"]);
});

test("a goto queues the frame it enters, the children it places before the frame's actions or after by their tags", async () => {
  const clip = sprite(1, [
    [as1(`stop();`, 6)],
    [
      w.place({ depth: 1, character: 2, name: "before" }),
      as1(`trace("clip 2");`, 6),
      w.place({ depth: 2, character: 2, name: "after" }),
    ],
  ]);
  const swf = movie(6, [
    [
      counting(2, 1),
      clip,
      w.place({ depth: 1, character: 1, name: "a" }),
      as1(`a.gotoAndStop(2); trace("goto " + a._currentframe); a.gotoAndStop(99);`, 6),
    ],
  ]);

  assert.deepEqual((await play(swf, 1)).lines, ["goto 2", "before 1", "clip 2", "after 1"]);
});

test("tellTarget targets a clip from the code's own, its names resolving on it, and none where it finds none", async () => {
  const swf = movie(6, [
    [
      counting(2, 1),
      sprite(1, [[w.place({ depth: 1, character: 2, name: "b" }), as1(`var v = "a's";`, 6)]]),
      w.place({ depth: 1, character: 1, name: "a" }),
      as1(
        `tellTarget ("a") { trace(_target + " " + v); tellTarget ("b") { trace(_target); } }
tellTarget ("/a/b") { trace(_name); }
tellTarget ("nowhere") { trace(_target); }
trace(_target);`,
        6,
      ),
    ],
  ]);

  assert.deepEqual((await play(swf, 1)).lines, ["b 1", "/a a's", "/", "b", "/", "/"]);
});

test("GetProperty and SetProperty take a property by index, a twip's precision, an alpha's 256ths", async () => {
  const swf = movie(6, [
    [
      sprite(1, [[]]),
      w.place({ depth: 1, character: 1, name: "a" }),
      as1(
        `setProperty("a", 0, 12.34); trace(getProperty("a", 0)); setProperty("/a", 6, 33); trace(a._alpha);
trace(getProperty("a", 13)); trace(getProperty("a", 21.5) == a._ymouse); trace(getProperty("a", 22)); trace(getProperty("nothing", 0));
a._rotation = 270; trace(a._rotation); a._x = Infinity; trace(a._x); a._x = NaN; trace(a._x);`,
        6,
      ),
    ],
  ]);

  assert.deepEqual((await play(swf, 1)).lines, [
    "12.3",
    "32.8125",
    "a",
    "true",
    "undefined",
    "undefined",
    "-90",
    "-107374182.4",
    "-107374182.4",
  ]);
});

test("a place at a taken depth tells Flash's log", async () => {
  const swf = movie(6, [
    [sprite(1, [[]]), w.place({ depth: 1, character: 1 }), w.place({ depth: 1, character: 1 })],
  ]);

  assert.deepEqual((await play(swf, 1)).lines, ["Warning: Failed to place object at depth 1."]);
});

test("a removed clip's reference finds what is at its path since", async () => {
  const swf = movie(6, [
    [sprite(1, [[as1(`var n = "first";`, 6)]]), w.place({ depth: 1, character: 1, name: "a" })],
    [as1(`saved = a; trace(saved.n);`, 6)],
    [w.remove(1), as1(`trace(typeof saved); trace(saved.n); trace(saved);`, 6)],
    [
      sprite(2, [[as1(`var n = "second";`, 6)]]),
      w.place({ depth: 1, character: 2, name: "a" }),
      as1(`trace(saved.n); trace(saved); stop();`, 6),
    ],
  ]);

  assert.deepEqual((await play(swf, 4)).lines, [
    "first",
    "movieclip",
    "undefined",
    "",
    "second",
    "_level0.a",
  ]);
});

test("gotos that go back and forth in a frame keep no more than a few thousand of what they queued and made", async () => {
  const swf = movie(6, [
    [
      sprite(1, [[]]),
      w.place({ depth: 1, character: 1, name: "k" }),
      as1(`n += 1; if (n < 20000) { gotoAndPlay(2); } else { trace(n); stop(); }`, 6),
    ],
    [w.remove(1), w.place({ depth: 2, character: 1, name: "j" }), as1(`gotoAndPlay(1);`, 6)],
  ]);
  const { lines, avm1 } = await play(swf, 1);

  assert.deepEqual(lines, ["20000"]);
  assert.ok((avm1 as unknown as { clips: unknown[] }).clips.length < 10000);
});

test("a clip the timeline removes, and its AVM1 object, are collected where no script keeps them", async () => {
  const swf = movie(6, [
    [
      sprite(1, [[as1(`x = 1;`, 6)], [as1(`x = 2;`, 6)]]),
      w.place({ depth: 1, character: 1, name: "k" }),
      as1(`trace(k._x);`, 6),
    ],
    [w.remove(1), as1(`trace(typeof k);`, 6)],
  ]);
  const { player, avm1 } = await play(swf, 1);
  const refs = (() => {
    const first = avm1.root.children.find((c) => c.name === "k");
    return [new WeakRef(first as object), new WeakRef(first?.avm1 as object)];
  })();
  for (let i = 0; i < 20; i++) {
    player.tick();
  }

  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(
    refs.map((r) => r.deref() === undefined),
    [true, true],
  );
});

test("code whose clip a call removes returns after the call, a function of the clip's too (adl)", async () => {
  const cases: [string, string[]][] = [
    [`trace("before"); _parent.gotoAndStop(1); trace("after");`, ["before"]],
    [`trace("before"); _root.f(); trace("after f");`, ["before", "f before", "f after"]],
    [
      `function g() { trace("g before"); _parent.gotoAndStop(1); trace("g after"); } g(); trace("after g");`,
      ["g before"],
    ],
    [
      `function C() { _parent.gotoAndStop(1); trace("C after"); } var c = new C(); trace("after new");`,
      [],
    ],
    [`tellTarget ("_parent") { gotoAndStop(1); } trace("after tellTarget");`, ["after tellTarget"]],
    // A method of nothing calls nothing, and returns not; a function call does (the corpus's removed_clip_halts_script).
    [
      `tellTarget ("_parent") { gotoAndStop(1); } nothing.f(); trace("a"); bogus(); trace("b");`,
      ["a"],
    ],
  ];
  for (const [code, lines] of cases) {
    const swf = movie(6, [
      [
        sprite(1, [[], [as1(code, 6)]]),
        sprite(2, [
          [as1(`stop();`, 6)],
          [w.place({ depth: 1, character: 1, name: "kid" }), as1(`stop();`, 6)],
        ]),
        w.place({ depth: 1, character: 2, name: "m" }),
        as1(
          `function f() { trace("f before"); m.gotoAndStop(1); trace("f after"); } stop(); m.gotoAndPlay(2);`,
          6,
        ),
      ],
    ]);

    assert.deepEqual((await play(swf, 3)).lines, lines, code);
  }
});

test("clip references are equal where they reach the same clip now (adl)", async () => {
  const swf = movie(6, [
    [
      sprite(1, [[]]),
      w.place({ depth: 1, character: 1, name: "a" }),
      as1(`r = a; trace((r == a) + " " + (r === a));`, 6),
    ],
    [w.remove(1), as1(`trace((r == a) + " " + (r == undefined) + " " + (r == r));`, 6)],
    [
      w.place({ depth: 2, character: 1, name: "a" }),
      as1(`trace((r == a) + " " + (r === a) + " " + (r != a) + " " + (r !== a)); stop();`, 6),
    ],
  ]);

  assert.deepEqual((await play(swf, 3)).lines, [
    "true true",
    "false false true",
    "true true false false",
  ]);
});

test("scripts that run past the script timeout disable the movie's actions, and the timeline plays on", async () => {
  // A ScriptLimits of 1 second; and the player's own timeout, a loop of gotos in a frame's queue.
  const limits = w.tag(65, Uint8Array.from([0, 1, 1, 0]));
  const loop = movie(6, [
    [limits, as1(`trace("before"); while (true) {} trace("after");`, 6)],
    [as1(`trace("frame 2");`, 6)],
  ]);
  const looped = await play(loop, 2);

  assert.deepEqual(looped.lines, ["before"]);
  assert.ok(looped.avm1.rt.timedOut);
  assert.equal(looped.player.root.currentFrame, 2);

  const gotos = movie(6, [
    [as1(`trace("one"); gotoAndPlay(2);`, 6)],
    [as1(`gotoAndPlay(1);`, 6)],
    [as1(`trace("three");`, 6)],
  ]);
  const ponged = await play(gotos, 2, { scriptTimeout: 0.2 });

  assert.equal(ponged.lines[0], "one");
  assert.ok(ponged.avm1.rt.timedOut);
});

test("a goto loop through a frame with a ScriptLimits times out, its timeout counted from the scripts' start", {
  timeout: 20000,
}, async () => {
  // Entering the limits' frame again must not give the loop a fresh second.
  const limits = w.tag(65, Uint8Array.from([0, 1, 1, 0]));
  const swf = movie(6, [
    [limits, as1(`gotoAndPlay(2);`, 6)],
    [as1(`gotoAndPlay(1);`, 6)],
    [as1(`trace("three");`, 6)],
  ]);
  const looped = await play(swf, 1);

  assert.ok(looped.avm1.rt.timedOut);
  assert.ok(!looped.lines.includes("three"));
});

test("the timers fire between frames by the frame clock, the earliest first, getTimer counting frames", async () => {
  const swf = w.swf({
    version: 6,
    width: 10,
    height: 10,
    frameRate: 10,
    frameCount: 4,
    tags: [
      as1(
        `trace("ids " + setTimeout(function (s) { trace("timeout " + s + " " + getTimer()); }, 150, "a") + " " + setInterval(this, "tick", 100, "b"));
n = 0; function tick(s) { n++; trace("tick " + s + n + " " + getTimer()); if (n == 3) { clearInterval(2); } }
trace("frame 1 " + getTimer());`,
        6,
      ),
      w.showFrame(),
      as1(`trace("frame 2 " + getTimer());`, 6),
      w.showFrame(),
      as1(`trace("frame 3 " + getTimer());`, 6),
      w.showFrame(),
      as1(`trace("frame 4 " + getTimer()); stop();`, 6),
      w.showFrame(),
      w.end(),
    ],
  });
  const { lines } = await play(swf, 5, { realTime: null });

  assert.deepEqual(lines, [
    "ids 1 2",
    "frame 1 0",
    "tick b1 100",
    "frame 2 100",
    "timeout a 150",
    "tick b2 200",
    "frame 3 200",
    "tick b3 300",
    "frame 4 300",
  ]);
});

test("a frame clock that stands still moves for a script waiting on getTimer", async () => {
  const swf = movie(6, [
    [as1(`var t = getTimer(); var i = 0; while (getTimer() - t < 5) { i++; } trace(i > 0);`, 6)],
  ]);
  const { lines } = await play(swf, 1, { realTime: null });

  assert.deepEqual(lines, ["true"]);
});

test("a key goes to the clips' keyDown as drawn, then Key's listeners, then the first keyPress, and Key keeps its state", async () => {
  const keyDown = 1 << 6;
  const keyPress = 1 << 17;
  const traced = (source: string) => [...script(source, 6)(flashAssembler()).end().bytes()];
  const swf = movie(6, [
    [
      sprite(1, [[]]),
      w.place({
        depth: 1,
        character: 1,
        name: "a",
        clipActions: w.clipActions(6, [
          { events: keyDown, actions: traced(`trace("keyDown a " + Key.getCode());`) },
          { events: keyPress, key: 65, actions: traced(`trace("keyPress a");`) },
        ]),
      }),
      w.place({
        depth: 2,
        character: 1,
        name: "b",
        clipActions: w.clipActions(6, [
          { events: keyPress, key: 65, actions: traced(`trace("keyPress b");`) },
        ]),
      }),
      as1(
        `Key.addListener({ onKeyDown: function () { trace("listener " + Key.isDown(65) + " " + Key.getAscii()); }, onKeyUp: function () { trace("up " + Key.isDown(65) + " " + Key.isToggled(65)); } }); stop();`,
        6,
      ),
    ],
  ]);
  const { lines, player } = await play(swf, 1);
  const keyboard = player.keyboard;
  assert.ok(keyboard);

  // Its press toggles A on once: a held key's repeated press does not again.
  keyboard.handle("down", { keyCode: 65, charCode: 65 });
  keyboard.handle("down", { keyCode: 65, charCode: 65 });
  keyboard.handle("up", { keyCode: 65, charCode: 65 });

  assert.deepEqual(lines, [
    "keyDown a 65",
    "listener true 65",
    "keyPress a",
    "keyDown a 65",
    "listener true 65",
    "keyPress a",
    "up false true",
  ]);
});

test("a focus loss lets go of the keys and mouse buttons held, with no onKeyUp, and keeps what is toggled", async () => {
  const swf = movie(6, [
    [
      as1(
        `Key.addListener({ onKeyDown: function () { trace("down " + Key.getCode() + " " + Key.isDown(65) + " " + Key.isToggled(65) + " " + Key.isDown(16) + " " + Key.isDown(1)); }, onKeyUp: function () { trace("up " + Key.getCode()); } }); stop();`,
        6,
      ),
    ],
  ]);
  const { lines, player } = await play(swf, 1);
  const keyboard = player.keyboard;
  assert.ok(keyboard);

  player.pointer?.handle("down", { x: 1, y: 1, button: 0, buttons: 1 });
  keyboard.handle("down", { keyCode: 16, charCode: 0, shiftKey: true });
  keyboard.handle("down", { keyCode: 65, charCode: 65, shiftKey: true });
  player.setActive(false);
  player.setActive(true);
  // Neither A nor Shift is down after; A's press is a new one, which toggles it off.
  keyboard.handle("down", { keyCode: 66, charCode: 98 });
  keyboard.handle("down", { keyCode: 65, charCode: 97 });

  assert.deepEqual(lines, [
    "down 16 false false true true",
    "down 65 true true true true",
    "down 66 false true false false",
    "down 65 true false false false",
  ]);
});

test("Selection focuses a clip, its kill, set and listeners' events at once, and Tab moves the focus by place", async () => {
  const swf = movie(6, [
    [
      sprite(1, [[]]),
      w.place({ depth: 1, character: 1, name: "a", matrix: { tx: 0, ty: 0 } }),
      w.place({ depth: 2, character: 1, name: "b", matrix: { tx: 1000, ty: 0 } }),
      as1(
        `a.focusEnabled = true; a.tabEnabled = true; b.tabEnabled = true;
        a.onSetFocus = function (o) { trace("a.onSetFocus " + o); };
        a.onKillFocus = function (n) { trace("a.onKillFocus " + n); };
        b.onSetFocus = function (o) { trace("b.onSetFocus " + o); };
        Selection.addListener({ onSetFocus: function (o, n) { trace("Selection " + o + " -> " + n); } });
        trace(Selection.setFocus(a)); trace(Selection.getFocus()); trace(Selection.setFocus(a));
        trace(Selection.setFocus(_root)); trace(Selection.setFocus()); stop();`,
        6,
      ),
    ],
  ]);
  const { lines, player } = await play(swf, 1);

  assert.deepEqual(lines, [
    "a.onSetFocus null",
    "Selection null -> _level0.a",
    "true",
    "_level0.a",
    "true",
    "false",
    "false",
  ]);

  // Tab: the next by place, round to the first past the last.
  lines.length = 0;
  player.keyboard?.handle("down", { keyCode: 9, charCode: 9 });
  player.keyboard?.handle("down", { keyCode: 9, charCode: 9 });
  assert.deepEqual(lines, [
    "a.onKillFocus _level0.b",
    "b.onSetFocus _level0.a",
    "Selection _level0.a -> _level0.b",
    "a.onSetFocus _level0.b",
    "Selection _level0.b -> _level0.a",
  ]);
});

test("Tab is the page's where nothing in the movie takes the focus", async () => {
  const swf = movie(6, [
    [sprite(1, [[]]), w.place({ depth: 1, character: 1, name: "a" }), as1("stop();", 6)],
  ]);
  const { player } = await play(swf, 1);

  assert.equal(player.keyboard?.handle("down", { keyCode: 9, charCode: 9 }), false);
});

test("the pointer's events reach every clip's clip actions, the newest first, and stop the SWF at clip actions Flash cannot read", async () => {
  const mouseDown = 1 << 4;
  const events = (name: string) =>
    w.clipActions(6, [
      {
        events: mouseDown,
        actions: [...script(`trace("down ${name}");`, 6)(flashAssembler()).end().bytes()],
      },
    ]);
  const swf = movie(6, [
    [
      sprite(1, [[]]),
      w.place({ depth: 1, character: 1, name: "a", clipActions: events("a") }),
      w.place({ depth: 2, character: 1, name: "b", clipActions: events("b") }),
      as1(`b.onMouseDown = function () { trace("onMouseDown b"); }; stop();`, 6),
    ],
  ]);
  const { lines, avm1 } = await play(swf, 1);
  avm1.clipEvent(mouseDown);

  assert.deepEqual(lines, ["down b", "onMouseDown b", "down a"]);

  // A place whose clip actions run past its tag, of a mouseDown: the SWF stops as one comes.
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
  const bad = Uint8Array.from([0, 0, ...u32(mouseDown), ...u32(mouseDown), ...u32(100), 0x07]);
  const broken = movie(6, [
    [
      sprite(1, [[]]),
      w.place({ depth: 1, character: 1, name: "a", clipActions: bad }),
      as1(`trace("placed"); stop();`, 6),
    ],
  ]);
  const halted = await play(broken, 1);
  halted.avm1.clipEvent(mouseDown);

  assert.deepEqual(halted.lines, ["placed"]);
  assert.ok(halted.avm1.halted);
});

test("fscommand quit stops the SWF once its frame has run, as Ruffle's harness ends a test", async () => {
  const quits = (url: string) =>
    doAction((a) => a.push("1").trace().getUrl(url, "").push("after").trace());
  for (const url of ["FSCommand:quit", "fscommand:QUIT"]) {
    const swf = movie(6, [[quits(url)], [traced("2")]]);
    const { lines, errors, avm1 } = await play(swf, 3);

    assert.deepEqual(lines, ["1", "after"]);
    assert.deepEqual(errors, []);
    assert.ok(avm1.halted);
  }

  // Any other command is dropped.
  const other = movie(6, [[quits("FSCommand:fullscreen")], [traced("2")]]);
  assert.deepEqual((await play(other, 2)).lines, ["1", "after", "2"]);
});

test("a host's fsCommand takes every command, quit too, and getURL's pages go to its navigate", async () => {
  const swf = movie(7, [
    [
      doAction((a) =>
        a
          .getUrl("FSCommand:quit", "")
          .getUrl("FSCommand:Show", "a b")
          .getUrl("http://a.example/", "blank")
          .getUrl("x.swf", "_level1")
          .push("v", 1)
          .op("SetVariable")
          .push("http://b.example/", "_self")
          .action(0x9a, [2])
          .push("FSCommand:two", "args")
          .action(0x9a, [0]),
      ),
      as1(
        `this.getURL("http://c.example/", "_BLANK", "get"); this.getURL("FSCommand:clip", 5);`,
        7,
      ),
    ],
    [traced("2")],
  ]);
  const commands: string[][] = [];
  const pages: unknown[][] = [];
  const { lines, errors } = await play(swf, 2, {
    fsCommand: (command, args) => commands.push([command, args]),
    navigate: (url, window, form) => pages.push([url, window, form]),
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(lines, ["2"]);
  assert.deepEqual(commands, [
    ["quit", ""],
    ["Show", "a b"],
    ["two", "args"],
    ["clip", "5"],
  ]);
  assert.deepEqual(pages, [
    ["http://a.example/", "_blank", null],
    ["http://b.example/", "_self", { method: "POST", vars: [["v", "1"]] }],
    ["http://c.example/", "_blank", { method: "GET", vars: [["v", "1"]] }],
  ]);
});
