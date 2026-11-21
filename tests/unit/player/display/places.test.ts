// The packed place records and frame commands of a SWF's timelines (display/places.ts):
// every field read back as format's reader reads it, set or not, moves and places; the
// commands of each frame in tag order; and a goto's folding of places, as the objects did.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  type Place,
  readActions,
  readPlace,
  readRemove,
  readSprite,
  readSwf,
  type Swf,
  type Tag,
  tags,
} from "../../../../packages/format/dist/index.js";
import {
  ButtonObject,
  type DisplayObject,
  type MovieClip,
  ShapeObject,
} from "../../../../packages/player/dist/display/display.js";
import {
  ACTIONS,
  giveScratch,
  PLACE,
  Places,
  REMOVE,
  takeScratch,
} from "../../../../packages/player/dist/display/places.js";
import { readLibrary, type Timeline } from "../../../../packages/player/dist/display/timeline.js";
import { Player } from "../../../../packages/player/dist/player.js";
import * as w from "../../../swf-writer.ts";

const PLACE_CODES = new Set<number>([
  tags.PlaceObject,
  tags.PlaceObject2,
  tags.PlaceObject3,
  tags.PlaceObject4,
]);

/** A PlaceObject (the first), whose body w.place does not write. */
function placeObject1(character: number, depth: number, color: boolean): Uint8Array {
  const body = new w.BitWriter();
  body.u16(character).u16(depth);
  w.matrix(body, { a: 1.5, b: -0.25, c: 0.25, d: 0.75, tx: -333, ty: 4444 });
  if (color) {
    // A CXFORM without alpha: multipliers then offsets, in 9 bits.
    body.ub(1, 1).ub(1, 1).ub(4, 9);
    for (const v of [128, 255, -255]) {
      body.sb(9, v);
    }

    for (const v of [-12, 0, 200]) {
      body.sb(9, v);
    }
  }

  return w.tag(tags.PlaceObject, body.done());
}

const move = { a: 0.5, b: 0.125, c: -0.125, d: 2, tx: 1234, ty: -5678 };

/** Places of every field, set and unset, moves and places, on a root and in a sprite of AVM1. */
function everyField(): Uint8Array {
  const inner = [
    w.place({ depth: 1, character: 1, name: "inner", matrix: move }),
    w.showFrame(),
    w.place({ depth: 1, move: true, matrix: move, ratio: 7 }),
    w.remove(1),
    w.doAction([0x07]),
    w.showFrame(),
    w.end(),
  ];
  return w.swf({
    version: 10,
    width: 100,
    height: 100,
    frameRate: 12,
    frameCount: 4,
    tags: [
      w.fileAttributes(false),
      w.shape({ id: 1, bounds: [0, 20, 0, 20], fills: [0xffff0000], paths: [] }),
      w.sprite(2, 2, inner),
      placeObject1(1, 1, true),
      placeObject1(1, 2, false),
      w.place({
        depth: 3,
        character: 2,
        name: "clip",
        matrix: { tx: 20, ty: 40 },
        colorTransform: { mult: [1, 0.5, 0.25, 0.75], add: [10, -20, 30, -40] },
        ratio: 65535,
        clipDepth: 9,
        clipActions: w.clipActions(10, [{ events: 1, actions: [0x07] }]),
      }),
      w.place({ depth: 4, character: 1, className: "Some.Class", blendMode: 8 }),
      w.place({ depth: 5, character: 1, hasImage: true, cacheAsBitmap: true, visible: false }),
      w.place({ depth: 6, className: "Image", hasImage: true, opaqueBackground: 0x80ff8000 }),
      w.place({
        depth: 7,
        character: 1,
        blurs: [4, 2],
        glows: [{ color: 0xff, blur: 3, strength: 1 }],
      }),
      w.place({ depth: 8, character: 1, metaData: new Uint8Array([6, 7, 0x61, 0x62, 0x63]) }),
      w.place({ depth: 9, character: 1, cacheAsBitmap: false, visible: true, blurs: [] }),
      w.showFrame(),
      w.place({ depth: 3, move: true, matrix: move }),
      w.place({ depth: 3, move: true, colorTransform: { mult: [1, 1, 1, 0.5] } }),
      w.place({ depth: 3, move: true, character: 1, ratio: 0, name: "renamed" }),
      w.place({ depth: 4, move: true, blendMode: 1, clipDepth: 0 }),
      w.remove(2),
      w.doAction([0x07]),
      w.showFrame(),
      w.place({ depth: 2, character: 1, matrix: move }),
      w.place({ depth: 2, move: true, matrix: move }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** Each timeline's tags: the root's, and each sprite's in tag order. */
function timelineTags(swf: Swf): Tag[][] {
  const lists: Tag[][] = [swf.tags];
  for (const t of swf.tags) {
    if (t.code === tags.DefineSprite) {
      lists.push(readSprite(swf.bytes, t).tags);
    }
  }

  return lists;
}

/** Every place of `swf` packed and read back as format reads it. */
function roundTrip(swf: Swf): number {
  const actions = readActions(swf);
  const places = new Places();
  const strings = new Map<string, string>();
  const read: Place[] = [];
  for (const list of timelineTags(swf)) {
    for (const t of list) {
      if (PLACE_CODES.has(t.code)) {
        const place = readPlace(swf.bytes, t, actions);
        read.push(place);
        places.add(place, strings);
      }
    }
  }

  places.seal();
  for (let i = 0; i < read.length; i++) {
    assert.deepEqual(places.place(i), read[i], `place ${i}`);
  }

  return read.length;
}

test("every field of a place reads back as format's reader reads it, set or not", () => {
  const swf = readSwf(everyField());
  assert.equal(roundTrip(swf), 17);

  const places = new Places();
  const actions = readActions(swf);
  const all = swf.tags.filter((t) => PLACE_CODES.has(t.code));
  for (const t of all) {
    places.add(readPlace(swf.bytes, t, actions));
  }

  // The fields' accessors, as applyPlace reads them: -1 or null where unset.
  assert.equal(places.character(0), 1);
  assert.equal(places.colorTransform(1), -1);
  assert.equal(places.ratio(2), 65535);
  assert.equal(places.clipDepth(2), 9);
  assert.notEqual(places.actions(2), null);
  assert.equal(places.blendMode(3), 8);
  assert.equal(places.className(3), "Some.Class");
  assert.equal(places.cacheAsBitmap(4), true);
  assert.equal(places.visible(4), false);
  assert.equal(places.hasImage(4), true);
  assert.equal(places.character(5), -1);
  assert.equal(places.opaqueBackground(5), 0x80ff8000);
  assert.equal(places.setsRare(6), true);
  assert.equal(places.setsRare(0), false);
  assert.equal(places.cacheAsBitmap(8), false);
  assert.equal(places.visible(8), true);
  assert.equal(places.move(9), true);
  assert.equal(places.ratio(11), 0);
  assert.equal(places.clipDepth(12), 0);
  assert.equal(places.blendMode(12), 1);
  // The same matrix is kept once.
  assert.equal(places.matrix(9), places.matrix(13));
  assert.equal(places.matrix(13), places.matrix(14));
  assert.deepEqual(places.pixelMatrix(places.matrix(9)), {
    ...move,
    tx: move.tx / 20,
    ty: move.ty / 20,
  });
});

/** What a timeline's frame does, each command as format reads it. */
function framesOf(timeline: Timeline): unknown[][] {
  const store = timeline.store;
  const frames: unknown[][] = [];
  for (let f = 1; f <= timeline.frameCount; f++) {
    const frame: unknown[] = [];
    for (let c = store.start(timeline, f); c < store.end(timeline, f); c++) {
      const arg = store.args[c];
      switch (store.kinds[c]) {
        case PLACE:
          frame.push(store.places.place(arg));
          break;
        case REMOVE:
          frame.push(["remove", arg]);
          break;
        case ACTIONS:
          frame.push(["actions", arg]);
          break;
      }
    }

    frames.push(frame);
  }

  return frames;
}

/** The same from the tags, a frame for each ShowFrame. */
function framesOfTags(swf: Swf, list: Tag[]): unknown[][] {
  const actions = readActions(swf);
  const frames: unknown[][] = [[]];
  for (const t of list) {
    const frame = frames[frames.length - 1];
    if (PLACE_CODES.has(t.code)) {
      frame.push(readPlace(swf.bytes, t, actions));
    } else if (t.code === tags.RemoveObject || t.code === tags.RemoveObject2) {
      frame.push(["remove", readRemove(swf.bytes, t)]);
    } else if (t.code === tags.DoAction && t.length > 0) {
      frame.push(["actions", t.offset]);
    } else if (t.code === tags.ShowFrame) {
      frames.push([]);
    }
  }

  frames.pop();
  return frames;
}

test("a timeline's frames run their places, removals and actions in tag order", () => {
  const swf = readSwf(everyField());
  const library = readLibrary(swf);
  assert.deepEqual(framesOf(library.root), framesOfTags(swf, swf.tags));

  const sprite = library.characters.get(2);
  assert.equal(sprite?.type, "sprite");
  if (sprite?.type === "sprite") {
    assert.deepEqual(framesOf(sprite.timeline), framesOfTags(swf, timelineTags(swf)[1]));
    // Both timelines share the store, and its names: one string for each.
    assert.equal(sprite.timeline.store, library.root.store);
  }
});

// What movieclip.ts folded places with before they were packed.
const IDENTITY = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
const IDENTITY_COLOR = { rMul: 1, gMul: 1, bMul: 1, aMul: 1, rAdd: 0, gAdd: 0, bAdd: 0, aAdd: 0 };

function asFirstPlaced(place: Place): Place {
  return {
    ...place,
    matrix: place.matrix ?? IDENTITY,
    colorTransform: place.colorTransform ?? IDENTITY_COLOR,
    ratio: place.ratio ?? 0,
    blendMode: place.blendMode ?? 0,
    filters: place.filters ?? new Uint8Array([0]),
    cacheAsBitmap: place.cacheAsBitmap ?? false,
  };
}

function mergePlace(previous: Place, next: Place): Place {
  return {
    ...previous,
    character: next.character ?? previous.character,
    matrix: next.matrix ?? previous.matrix,
    colorTransform: next.colorTransform ?? previous.colorTransform,
    ratio: next.ratio ?? previous.ratio,
    name: next.name ?? previous.name,
    clipDepth: next.clipDepth ?? previous.clipDepth,
    className: next.className ?? previous.className,
    blendMode: next.blendMode ?? previous.blendMode,
    cacheAsBitmap: next.cacheAsBitmap ?? previous.cacheAsBitmap,
    visible: next.visible ?? previous.visible,
    opaqueBackground: next.opaqueBackground ?? previous.opaqueBackground,
    filters: next.filters ?? previous.filters,
    actions: next.actions ?? previous.actions,
  };
}

test("a goto folds places together as it did their objects, a rewind's as first placed", () => {
  const swf = readSwf(everyField());
  const actions = readActions(swf);
  const read = swf.tags
    .filter((t) => PLACE_CODES.has(t.code))
    .map((t) => readPlace(swf.bytes, t, actions));
  const places = new Places();
  for (const place of read) {
    places.add(place);
  }

  places.seal();
  const scratch = new Places();
  for (let first = 0; first < read.length; first++) {
    for (const rewind of [false, true]) {
      scratch.reset(places);
      const j = scratch.copy(places, first);
      let expected = read[first];
      if (rewind) {
        scratch.firstPlaced(j);
        expected = asFirstPlaced(expected);
      }

      assert.deepEqual(scratch.place(j), expected, `${first} copied`);
      for (let next = 0; next < read.length; next++) {
        scratch.merge(j, places, next);
        expected = mergePlace(expected, read[next]);
        assert.deepEqual(scratch.place(j), expected, `${first} with ${next} folded in`);
      }

      scratch.unnamed(j);
      assert.deepEqual(scratch.place(j), { ...expected, name: null });
    }
  }
});

/** A place of nothing but what `fields` give. */
function bare(fields: Partial<Place>): Place {
  return {
    depth: 1,
    move: true,
    character: null,
    matrix: null,
    colorTransform: null,
    ratio: null,
    name: null,
    clipDepth: null,
    className: null,
    hasImage: false,
    blendMode: null,
    cacheAsBitmap: null,
    visible: null,
    opaqueBackground: null,
    filters: null,
    metaData: null,
    actions: null,
    corrupt: 0,
    ...fields,
  };
}

// A 32-bit LCG, so the places are the same every run.
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s >>> 8;
  };
}

test("thousands of matrices and colour transforms, many repeated, are each kept once and read back", () => {
  const next = lcg(3);
  const pick = (n: number) => next() % n;
  // Pools small enough that values repeat, large enough that the tables grow and rehash.
  const scale = () => (pick(1 << 18) - (1 << 17)) / 0x10000;
  const shapes = Array.from({ length: 400 }, () => ({
    a: scale(),
    b: scale(),
    c: scale(),
    d: scale(),
  }));
  const offsets = Array.from({ length: 50 }, () => pick(40000) - 20000);
  const places = new Places();
  const read: Place[] = [];
  const matrices = new Set<string>();
  const colors = new Set<string>(["256,256,256,256,0,0,0,0"]);
  for (let i = 0; i < 6000; i++) {
    const matrix =
      i % 7 === 0 ? null : { ...shapes[pick(400)], tx: offsets[pick(50)], ty: offsets[pick(8)] };
    const mult = [256, pick(512), 256, pick(300)];
    const add = [pick(64) - 32, 0, 0, 0];
    const colorTransform =
      i % 3 === 0
        ? {
            rMul: mult[0] / 256,
            gMul: mult[1] / 256,
            bMul: mult[2] / 256,
            aMul: mult[3] / 256,
            rAdd: add[0],
            gAdd: add[1],
            bAdd: add[2],
            aAdd: add[3],
          }
        : null;
    const place = bare({ depth: (i % 500) + 1, matrix, colorTransform, ratio: i % 5 ? null : i });
    read.push(place);
    places.add(place);
    if (matrix) {
      matrices.add(matrixKey(matrix));
    }

    if (colorTransform) {
      colors.add([...mult, ...add].join());
    }
  }

  places.seal();
  for (let i = 0; i < read.length; i++) {
    assert.deepEqual(places.place(i), read[i], `place ${i}`);
  }

  // Each distinct one once, the identity among them from the start.
  assert.equal(places.matrixCount, matrices.size + (matrices.has(matrixKey(IDENTITY)) ? 0 : 1));
  assert.equal(places.colorCount, colors.size);
  // Past the tables' first sizes, so they grew and were rehashed.
  assert.ok(places.matrixCount > 300 && places.colorCount > 300);
});

/** What the store keeps a matrix once by. */
function matrixKey(m: { a: number; b: number; c: number; d: number; tx: number; ty: number }) {
  return [m.a, m.b, m.c, m.d, m.tx, m.ty].join();
}

test("a goto's scratch records come from a pool, emptied as given back, one for each goto under way", () => {
  const store = new Places();
  for (let i = 0; i < 200; i++) {
    store.add(bare({ depth: i + 1, name: `n${i}`, matrix: { ...IDENTITY, tx: i }, actions: [i] }));
  }

  store.add(bare({ depth: 999, matrix: { ...IDENTITY, tx: 5 } }));
  store.seal();
  const plain = 200;

  // A large goto, then a small one: the scratch is reused, with nothing of the large one left.
  const first = takeScratch(store);
  for (let i = 0; i < 200; i++) {
    first.copy(store, i);
  }

  giveScratch(first);
  const again = takeScratch(store);
  assert.equal(again, first);
  assert.equal(again.count, 0);
  const j = again.copy(store, plain);
  assert.deepEqual(again.place(j), store.place(plain));
  assert.equal(again.name(j), null);
  assert.equal(again.actions(j), null);

  // A goto inside another takes a scratch of its own; the outer one's records stay as they were.
  const outer = again;
  const a = outer.copy(store, 3);
  const inner = takeScratch(store);
  assert.notEqual(inner, outer);
  for (let i = 0; i < 50; i++) {
    inner.merge(inner.copy(store, i), store, plain);
  }

  giveScratch(inner);
  assert.deepEqual(outer.place(a), store.place(3));
  assert.deepEqual(outer.place(j), store.place(plain));
  giveScratch(outer);
});

/** A movie of square 1 and sprite 3 (a square that slides on 4 frames), and the frames given. */
function nestedMovie(...frames: Uint8Array[][]): Player {
  const square = w.shape({
    id: 1,
    bounds: [0, 1000, 0, 1000],
    fills: [0xff0000],
    paths: [{ fill1: 1, commands: [{ move: [0, 0] }, { line: [1000, 0] }, { line: [0, 0] }] }],
  });
  const sprite = w.sprite(3, 4, [
    w.place({ depth: 1, character: 1, matrix: { tx: 0 } }),
    w.showFrame(),
    ...[1, 2, 3].flatMap((f) => [
      w.place({ depth: 1, move: true, matrix: { tx: 100 * f } }),
      w.showFrame(),
    ]),
    w.end(),
  ]);
  const tags = [w.fileAttributes(true), square, sprite];
  for (const frame of frames) {
    tags.push(...frame, w.showFrame());
  }

  tags.push(w.end());
  return new Player(
    w.swf({ width: 200, height: 100, frameRate: 24, frameCount: frames.length, tags }),
  );
}

test("a goto run inside another's, from a removal it makes, leaves both as each alone would", () => {
  const frames = () =>
    nestedMovie(
      [w.place({ depth: 1, character: 1 }), w.place({ depth: 2, character: 1, matrix: { tx: 0 } })],
      [w.place({ depth: 2, move: true, matrix: { tx: 200 } }), w.place({ depth: 5, character: 3 })],
      [w.remove(1), w.place({ depth: 2, move: true, matrix: { tx: 400, ty: 60 } })],
      [w.place({ depth: 2, move: true, colorTransform: { mult: [0.5, 1, 1, 1] } })],
    );
  const alone = frames();
  alone.root.gotoFrame(4);
  const clip = alone.root.depths.get(5) as MovieClip;
  clip.gotoFrame(4);
  clip.gotoFrame(2);

  const player = frames();
  const root = player.root;
  root.gotoFrame(2);
  const nested = root.depths.get(5) as MovieClip;
  nested.gotoFrame(4);
  // The removal on frame 3 runs while the root's goto folds its places: a listener's goto then.
  let calls = 0;
  root.library.removing = () => {
    calls++;
    nested.gotoFrame(2);
  };
  root.gotoFrame(4);
  root.library.removing = null;

  assert.equal(calls, 1);
  const state = (d: DisplayObject | undefined) => [
    d?.matrix.tx,
    d?.matrix.ty,
    d?.colorTransform?.rMul ?? null,
  ];
  assert.deepEqual(state(root.depths.get(2)), state(alone.root.depths.get(2)));
  assert.deepEqual(state(root.depths.get(2)), [20, 3, 0.5]);
  assert.deepEqual(state(nested.depths.get(1)), state(clip.depths.get(1)));
  // A rewind's place puts back the colour a first place leaves unsaid: none, as identity.
  assert.deepEqual(state(nested.depths.get(1)), [5, 0, 1]);
});

/** A DefineButton2 of one record, square 1 in the up and hit test states, coloured and added. */
function lookedButton(id: number): Uint8Array {
  const record = new w.BitWriter();
  // HasBlendMode, StateHitTest, StateUp.
  record
    .u8(0x20 | 0x08 | 0x01)
    .u16(1)
    .u16(1);
  w.matrix(record, { tx: 400, ty: 200 });
  record.align();
  // A CXFORMWITHALPHA of multipliers alone: red halved.
  record.ub(1, 0).ub(1, 1).ub(4, 10).sb(10, 128).sb(10, 256).sb(10, 256).sb(10, 256).align();
  record.u8(8);
  const body = new w.BitWriter().u16(id).u8(0).u16(0).raw(record.done()).u8(0);
  return w.tag(34, body.done());
}

test("a button's record places its look in the states, and its transform alone in the hit test state", () => {
  const swf = w.swf({
    width: 200,
    height: 100,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.shape({ id: 1, bounds: [0, 100, 0, 100], fills: [0xff0000], paths: [] }),
      lookedButton(4),
      w.place({ depth: 1, character: 4 }),
      w.showFrame(),
      w.end(),
    ],
  });
  const button = new Player(swf).root.depths.get(1) as ButtonObject;
  assert.ok(button instanceof ButtonObject);
  const up = button.upState as DisplayObject;
  const hit = button.hitTestState as DisplayObject;
  assert.deepEqual(
    [up.matrix.tx, up.matrix.ty, up.colorTransform?.rMul, up.blendMode],
    [20, 10, 0.5, "add"],
  );
  assert.deepEqual(
    [hit.matrix.tx, hit.matrix.ty, hit.colorTransform, hit.blendMode],
    [20, 10, null, "normal"],
  );
});

/** A Shape a script made. */
class Shape extends ShapeObject {
  constructor() {
    super(null);
  }
}

test("to an object a script transformed a place gives its name, clip depth and cacheAsBitmap alone", () => {
  const places = new Places();
  const everything = places.add(
    bare({
      name: "named",
      matrix: { ...IDENTITY, tx: 400 },
      colorTransform: { ...IDENTITY_COLOR, rMul: 0.5 },
      clipDepth: 7,
      blendMode: 8,
      cacheAsBitmap: true,
      visible: false,
      filters: new Uint8Array([1, 1, 0, 0, 4, 0, 0, 0, 4, 0, 8]),
    }),
  );
  places.seal();

  const shape = new Shape();
  shape.touch();
  shape.applyPlace(places, everything);
  assert.deepEqual([shape.name, shape.clipDepth, shape.cachedAsBitmap], ["named", 7, true]);
  assert.deepEqual(
    [shape.matrix.tx, shape.colorTransform, shape.visible, shape.blendMode, shape.filters.length],
    [0, null, true, "normal", 0],
  );

  // Untouched, it takes all of it.
  const plain = new Shape();
  plain.applyPlace(places, everything);
  assert.deepEqual(
    [
      plain.matrix.tx,
      plain.colorTransform?.rMul,
      plain.visible,
      plain.blendMode,
      plain.filters.length,
    ],
    [20, 0.5, false, "add", 1],
  );
});

// Ruffle's corpus, where tests/player/corpus/fetch-ruffle.ts has fetched it: every place of
// every SWF there read back as format reads it.
const corpus = new URL("../../../player/corpus/ruffle/tests/", import.meta.url).pathname;

function swfsUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...swfsUnder(path));
    } else if (name.endsWith(".swf")) {
      out.push(path);
    }
  }

  return out;
}

test("every place of the corpus's SWFs reads back", { skip: !existsSync(corpus) }, () => {
  let count = 0;
  for (const path of swfsUnder(corpus)) {
    let swf: Swf;
    try {
      swf = readSwf(readFileSync(path));
    } catch {
      continue;
    }

    count += roundTrip(swf);
  }

  assert.ok(count > 0);
});
