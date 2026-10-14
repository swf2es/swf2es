import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ActionBlock,
  ButtonCondition,
  ClipEvent,
  readActions,
  readButton,
  readPlace,
  readSwf,
  type Swf,
  tags,
} from "@swf2es/format";
import * as w from "../../swf-writer.ts";

const STOP = [0x07, 0x00];
const PLAY = [0x06, 0x00];
const NEXT = [0x04, 0x00];

function movie(version: number, list: Uint8Array[]): Swf {
  return readSwf(w.swf({ version, width: 10, height: 10, frameCount: 2, tags: list }));
}

function bytesOf(swf: Swf, block: ActionBlock): number[] {
  return [...swf.bytes.subarray(block.offset, block.offset + block.length)];
}

test("a SWF's blocks are listed in tag order, each with its owner and its bytes", () => {
  const swf = movie(6, [
    w.doInitAction(5, PLAY),
    w.sprite(5, 2, [w.showFrame(), w.doAction(NEXT), w.showFrame(), w.end()]),
    w.doAction(STOP),
    w.place({
      depth: 3,
      character: 5,
      clipActions: w.clipActions(6, [
        { events: ClipEvent.load | ClipEvent.enterFrame, actions: PLAY },
        { events: ClipEvent.keyPress, key: 13, actions: NEXT },
        { events: ClipEvent.construct, actions: STOP },
      ]),
    }),
    w.showFrame(),
    w.button(8, 5, PLAY),
    w.button2(9, 5, [
      { conditions: ButtonCondition.idleToOverUp | ButtonCondition.overUpToIdle, actions: NEXT },
      { conditions: (32 << 9) | ButtonCondition.overDownToOverUp, actions: STOP },
    ]),
    w.doAction([]),
    w.showFrame(),
    w.end(),
  ]);
  const list = readActions(swf);

  assert.equal(list.version, 6);
  assert.deepEqual(
    list.blocks.map((b) => [b.index, b.owner, bytesOf(swf, b)]),
    [
      [0, { type: "init", sprite: 5, timeline: null, frame: 0 }, PLAY],
      [1, { type: "frame", timeline: 5, frame: 1 }, NEXT],
      [2, { type: "frame", timeline: null, frame: 0 }, STOP],
      [3, { type: "clip", timeline: null, frame: 0, depth: 3, events: 3, key: 0 }, PLAY],
      [4, { type: "clip", timeline: null, frame: 0, depth: 3, events: 1 << 17, key: 13 }, NEXT],
      [5, { type: "clip", timeline: null, frame: 0, depth: 3, events: 1 << 18, key: 0 }, STOP],
      [6, { type: "button", button: 8, conditions: 0x08, key: 0 }, PLAY],
      [7, { type: "button", button: 9, conditions: 0x03, key: 0 }, NEXT],
      [8, { type: "button", button: 9, conditions: 0x08, key: 32 }, STOP],
      [9, { type: "frame", timeline: null, frame: 1 }, []],
    ],
  );

  const place = swf.tags[3];
  assert.equal(place.code, tags.PlaceObject2);
  assert.deepEqual(list.byTag.get(place.offset), [3, 4, 5]);
  assert.deepEqual(readPlace(swf.bytes, place, list).actions, [3, 4, 5]);
  assert.equal(readPlace(swf.bytes, place).actions, null);
  assert.equal(readPlace(swf.bytes, place, list).depth, 3);
  assert.deepEqual(readButton(swf.bytes, swf.tags[5], list).actions, [6]);
  const two = readButton(swf.bytes, swf.tags[6], list);
  assert.deepEqual(two.actions, [7, 8]);
  assert.equal(two.records.length, 1);
});

test("SWF 5's clip event flags are 16 bits, so its keyPress and construct bits are none", () => {
  const swf = movie(5, [
    w.place({
      depth: 1,
      character: 1,
      clipActions: w.clipActions(5, [
        { events: ClipEvent.mouseDown, actions: PLAY },
        { events: ClipEvent.data | ClipEvent.release, actions: STOP },
      ]),
    }),
    w.showFrame(),
    w.end(),
  ]);

  assert.deepEqual(
    readActions(swf).blocks.map((b) => [
      b.owner.type === "clip" && b.owner.events,
      bytesOf(swf, b),
    ]),
    [
      [ClipEvent.mouseDown, PLAY],
      [ClipEvent.data | ClipEvent.release, STOP],
    ],
  );

  // The same records read as SWF 6's take each 16-bit flags and the next two bytes as one.
  const as6 = { ...swf, header: { ...swf.header, version: 6 } };
  assert.notDeepEqual(
    readActions(as6).blocks.map((b) => bytesOf(swf, b)),
    [PLAY, STOP],
  );
});

test("a sprite's frames are its own, nested in another's or not", () => {
  const swf = movie(8, [
    w.doAction(PLAY),
    w.sprite(2, 2, [
      w.doAction(NEXT),
      w.showFrame(),
      w.sprite(3, 3, [w.showFrame(), w.showFrame(), w.doAction(STOP), w.showFrame(), w.end()]),
      w.doInitAction(3, PLAY),
      w.place({
        depth: 4,
        character: 3,
        clipActions: w.clipActions(8, [{ events: ClipEvent.unload, actions: STOP }]),
      }),
      w.showFrame(),
      w.end(),
    ]),
    w.showFrame(),
    w.doAction(NEXT),
    w.showFrame(),
    w.end(),
  ]);

  assert.deepEqual(
    readActions(swf).blocks.map((b) => b.owner),
    [
      { type: "frame", timeline: null, frame: 0 },
      { type: "frame", timeline: 2, frame: 0 },
      { type: "frame", timeline: 3, frame: 2 },
      { type: "init", sprite: 3, timeline: 2, frame: 1 },
      { type: "clip", timeline: 2, frame: 1, depth: 4, events: ClipEvent.unload, key: 0 },
      { type: "frame", timeline: null, frame: 1 },
    ],
  );
});

test("PlaceObject3's clip actions follow its own fields", () => {
  const swf = movie(10, [
    w.place({
      depth: 2,
      character: 1,
      name: "a",
      blendMode: 3,
      visible: true,
      clipActions: w.clipActions(10, [{ events: ClipEvent.enterFrame, actions: NEXT }]),
    }),
    w.end(),
  ]);
  const list = readActions(swf);

  assert.equal(swf.tags[0].code, tags.PlaceObject3);
  assert.deepEqual(
    list.blocks.map((b) => bytesOf(swf, b)),
    [NEXT],
  );
  assert.equal(readPlace(swf.bytes, swf.tags[0], list).name, "a");
});

/** A PlaceObject2 of depth 1 whose CLIPACTIONS are `body`, as given. */
function placeWith(body: w.BitWriter): Uint8Array {
  return w.tag(26, new w.BitWriter().u8(0x80).u16(1).raw(body.done()).done());
}

test("a truncated or malformed clip action ends the place's list, keeping those before it", () => {
  // The second record's length runs past the tag.
  const past = new w.BitWriter().u16(0).u32(3).u32(1).u32(2).raw(STOP);
  past.u32(2).u32(100).raw(PLAY);
  // A final record's flags cut to 2 bytes, as SWFs in the wild have them.
  const short = new w.BitWriter().u16(0).u32(1).u32(1).u32(2).raw(STOP).u16(0);
  // keyPress with no room for its key code.
  const keyless = new w.BitWriter()
    .u16(0)
    .u32(1 << 17)
    .u32(1 << 17)
    .u32(0);
  // Flags of none of the known events are a record Flash skips, not the list's end.
  const unknown = new w.BitWriter()
    .u16(0)
    .u32((1 << 31) | 1)
    .u32(1 << 31)
    .u32(2)
    .raw(STOP)
    .u32(1)
    .u32(2)
    .raw(PLAY)
    .u32(0);
  // No room for a record's length.
  const lengthless = new w.BitWriter().u16(0).u32(1).u32(1).u16(2);
  const swf = movie(6, [
    placeWith(past),
    placeWith(short),
    placeWith(keyless),
    placeWith(unknown),
    placeWith(lengthless),
    w.end(),
  ]);
  const list = readActions(swf);

  assert.deepEqual(
    list.blocks.map((b) => [b.tag, bytesOf(swf, b)]),
    [
      [swf.tags[0].offset, STOP],
      [swf.tags[1].offset, STOP],
      [swf.tags[3].offset, PLAY],
    ],
  );
  assert.equal(readPlace(swf.bytes, swf.tags[2], list).actions, null);
});

test("a malformed button action ends the button's list; an action offset of 0 has none", () => {
  const head = (id: number, offset: number) =>
    new w.BitWriter()
      .u16(id)
      .u8(0)
      .u16(offset)
      .u8(0x0f)
      .u16(1)
      .u16(1)
      .ub(1, 0)
      .ub(1, 0)
      .ub(5, 0)
      .align()
      .ub(1, 0)
      .ub(1, 0)
      .ub(4, 0)
      .align()
      .u8(0);
  // A size of 2 is shorter than its own head.
  const tooShort = head(1, 1).u16(6).u16(1).raw(STOP).u16(2).u16(1).raw(PLAY);
  // A size past the tag's end.
  const tooLong = head(2, 1).u16(40).u16(1).raw(STOP);
  // Records that end without a last one of size 0 end at the tag's end.
  const unended = head(3, 1).u16(6).u16(4).raw(NEXT);
  const swf = movie(6, [
    w.tag(tags.DefineButton2, tooShort.done()),
    w.tag(tags.DefineButton2, tooLong.done()),
    w.tag(tags.DefineButton2, unended.done()),
    w.button2(4, 1),
    w.tag(tags.DefineButton2, head(5, 0).u16(0).u16(1).raw(STOP).done()),
    w.end(),
  ]);

  assert.deepEqual(
    readActions(swf).blocks.map((b) => [b.owner, bytesOf(swf, b)]),
    [
      [{ type: "button", button: 1, conditions: 1, key: 0 }, STOP],
      [{ type: "button", button: 3, conditions: 4, key: 0 }, NEXT],
    ],
  );
});

test("DoInitAction too short for its sprite id, and a tag cut by the file's end", () => {
  const cut = w.doAction([0x96, 0x05, 0x00, 0x00, 0x61, 0x62, 0x00, 0x26, 0x00]);
  const file = w.swf({
    version: 7,
    width: 1,
    height: 1,
    frameCount: 1,
    tags: [w.tag(tags.DoInitAction, new Uint8Array([5])), cut],
  });
  const swf = readSwf(file.subarray(0, file.length - 3));
  const list = readActions(swf);

  assert.equal(swf.truncated, true);
  assert.deepEqual(
    list.blocks.map((b) => [b.owner.type, bytesOf(swf, b)]),
    [["frame", [0x96, 0x05, 0x00, 0x00, 0x61, 0x62]]],
  );
});
