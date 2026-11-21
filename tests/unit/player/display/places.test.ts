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
import { ACTIONS, PLACE, Places, REMOVE } from "../../../../packages/player/dist/display/places.js";
import { readLibrary, type Timeline } from "../../../../packages/player/dist/display/timeline.js";
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
