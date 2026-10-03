// A SWF's characters, and its timelines as frames of display commands:
// what the root and each sprite place, move and remove on each frame, and
// the frames' labels. Definitions are read once, at load, as the whole
// file is there.
import {
  type Bitmap,
  type EditText,
  type Font,
  type FontName,
  isBitmapTag,
  type Place,
  readBinaryData,
  readBitmap,
  readEditText,
  readFont,
  readFrameLabel,
  readPlace,
  readRemove,
  readShape,
  readSprite,
  type Shape,
  type Swf,
  type Tag,
  tags,
} from "@swf2es/format";
import type { BitmapStore } from "./bitmap.js";
import type { DisplayObject } from "./display.js";
import { FontSet } from "./fonts.js";
import { type ShapeLayer, shapeLayers } from "./shapes.js";

export type FrameCommand = { type: "place"; place: Place } | { type: "remove"; depth: number };

export interface Timeline {
  /** Frame k's commands at index k - 1. */
  frames: FrameCommand[][];
  /** Labels by name: the frame they are on, 1 the first. */
  labels: Map<string, number>;
}

export interface ShapeCharacter {
  type: "shape";
  id: number;
  shape: Shape;
  layers: ShapeLayer[];
}

export interface SpriteCharacter {
  type: "sprite";
  id: number;
  timeline: Timeline;
}

export interface TextCharacter {
  type: "text";
  id: number;
  definition: EditText;
  /** The font it names by id, if the SWF defines it: its name and style, which the field shows its text in. */
  font: FontName | null;
}

/** DefineFont2 or 3: its name and style, for the fields that name it, and its glyphs and layout. */
export interface FontCharacter extends FontName {
  type: "font";
  font: Font;
}

/** A bitmap's pixels as every copy of it starts: premultiplied ARGB; 0 by 0 for what Flash cannot read. */
export interface BitmapPixels {
  width: number;
  height: number;
  transparent: boolean;
  pixels: Uint32Array;
}

export interface BitmapCharacter {
  type: "bitmap";
  id: number;
  definition: Bitmap;
  /** Set when the SWF is read for the lossless formats, and once decoded for an image; null until then. */
  pixels: BitmapPixels | null;
  /** The store bitmap fills draw it from, one for every shape; made when one is first drawn. */
  store?: BitmapStore;
}

/** DefineBinaryData's bytes, which a ByteArray subclass bound to them starts with. */
export interface BinaryCharacter {
  type: "binary";
  id: number;
  data: Uint8Array;
  /** The bytes every instance shares, as Flash's do until one is resized: made when the first is. */
  shared?: Uint8Array<ArrayBuffer>;
}

export type Character =
  | ShapeCharacter
  | SpriteCharacter
  | BitmapCharacter
  | TextCharacter
  | BinaryCharacter
  | FontCharacter;

/** What a timeline can place: every character but data and fonts. */
export type DisplayCharacter = Exclude<Character, BinaryCharacter | FontCharacter>;

/** What Flash makes of a bitmap it cannot read. */
export const INVALID_PIXELS: BitmapPixels = {
  width: 0,
  height: 0,
  transparent: false,
  pixels: new Uint32Array(0),
};

export interface Library {
  characters: Map<number, Character>;
  root: Timeline;
  /** SymbolClass: the class each character is bound to, by qualified name "pkg::Name"; id 0 the document class. */
  classes: Map<number, string>;
  /**
   * Gives a display object the player just made its AS3 object, where the
   * SWF has scripts (Scripting.construct); null in an AVM1 movie. A clip's
   * first frame is entered on the way, by Sprite's constructChildren.
   */
  construct: ((display: DisplayObject, character: DisplayCharacter) => void) | null;
  /** Told before a timeline child goes, for the events a script sees; null in an AVM1 movie. */
  /** Tells of a display object about to lose its parent, and whether the timeline takes it (a script's removal otherwise). */
  removing: ((display: DisplayObject, byTimeline: boolean) => void) | null;
  /** The SWF's embedded fonts, by name, which its fields lay their text out in. */
  fonts: FontSet;
}

/**
 * Shapes by their tag's bytes, shared by every SWF that defines one alike:
 * a SWF loaded again, as each of a crowd of one creature may be, draws
 * with the first's fills and lines, which the renderer keeps by shape,
 * rather than building and holding its own. A shape filled with a bitmap
 * keeps to its SWF, whose bitmap it is. Held weakly: one no library holds
 * goes, and its entry after it.
 */
const sharedShapes = new Map<number, { tag: Uint8Array; shape: WeakRef<ShapeCharacter> }[]>();
const sharedGone = new FinalizationRegistry<{ hash: number; tag: Uint8Array }>(({ hash, tag }) => {
  const list = sharedShapes.get(hash)?.filter((entry) => entry.tag !== tag) ?? [];
  if (list.length > 0) {
    sharedShapes.set(hash, list);
  } else {
    sharedShapes.delete(hash);
  }
});

/** FNV-1a over the tag's code and bytes. */
function tagHash(code: number, tag: Uint8Array): number {
  let hash = Math.imul(0x811c9dc5 ^ code, 0x01000193);
  for (let i = 0; i < tag.length; i++) {
    hash = Math.imul(hash ^ tag[i], 0x01000193);
  }

  return hash >>> 0;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}

/** The shape a DefineShape tag defines, as another SWF defined it alike if one did. */
function shapeOf(
  bytes: Uint8Array,
  t: Tag,
  bitmap: (id: number) => BitmapCharacter | null,
): ShapeCharacter {
  const tag = bytes.subarray(t.offset, t.offset + t.length);
  const hash = tagHash(t.code, tag);
  for (const entry of sharedShapes.get(hash) ?? []) {
    const shared = entry.shape.deref();
    if (shared && sameBytes(entry.tag, tag)) {
      return shared;
    }
  }

  const shape = readShape(bytes, t.code, t.offset, t.length);
  let filled = false;
  const layers = shapeLayers(shape, (id) => {
    filled = true;
    return bitmap(id);
  });
  const character: ShapeCharacter = { type: "shape", id: shape.id, shape, layers };
  if (!filled) {
    const own = tag.slice();
    const list = sharedShapes.get(hash) ?? [];
    list.push({ tag: own, shape: new WeakRef(character) });
    sharedShapes.set(hash, list);
    sharedGone.register(character, { hash, tag: own });
  }

  return character;
}

function timelineOf(
  bytes: Uint8Array,
  list: Tag[],
  frameCount: number,
  library: Map<number, Character>,
  jpeg: { tables: Uint8Array | null },
): Timeline {
  const frames: FrameCommand[][] = [[]];
  const labels = new Map<string, number>();
  for (const t of list) {
    const frame = frames[frames.length - 1];
    switch (t.code) {
      case tags.ShowFrame:
        frames.push([]);
        break;
      case tags.PlaceObject:
      case tags.PlaceObject2:
      case tags.PlaceObject3:
        frame.push({ type: "place", place: readPlace(bytes, t) });
        break;
      case tags.RemoveObject:
      case tags.RemoveObject2:
        frame.push({ type: "remove", depth: readRemove(bytes, t) });
        break;
      case tags.FrameLabel:
        labels.set(readFrameLabel(bytes, t), frames.length);
        break;
      case tags.DefineShape:
      case tags.DefineShape2:
      case tags.DefineShape3:
      case tags.DefineShape4: {
        // Its bitmap fills' bitmaps, which a SWF defines before the shapes that use them.
        const bitmap = (id: number) => {
          const c = library.get(id);
          return c?.type === "bitmap" ? c : null;
        };
        const shape = shapeOf(bytes, t, bitmap);
        library.set(shape.id, shape);
        break;
      }
      case tags.DefineSprite: {
        const sprite = readSprite(bytes, t);
        library.set(sprite.id, {
          type: "sprite",
          id: sprite.id,
          timeline: timelineOf(bytes, sprite.tags, sprite.frameCount, library, jpeg),
        });
        break;
      }
      case tags.DefineFont2:
      case tags.DefineFont3: {
        const font = readFont(bytes, t);
        library.set(font.id, {
          type: "font",
          id: font.id,
          name: font.name,
          bold: font.bold,
          italic: font.italic,
          font,
        });
        break;
      }
      case tags.DefineEditText: {
        const definition = readEditText(bytes, t);
        const font = definition.fontId === null ? null : library.get(definition.fontId);
        library.set(definition.id, {
          type: "text",
          id: definition.id,
          definition,
          font: font?.type === "font" ? font : null,
        });
        break;
      }
      case tags.DefineBinaryData: {
        const { id, data } = readBinaryData(bytes, t);
        library.set(id, { type: "binary", id, data });
        break;
      }
      case tags.JPEGTables:
        jpeg.tables = bytes.slice(t.offset, t.offset + t.length);
        break;
      default:
        if (isBitmapTag(t.code)) {
          const definition = readBitmap(bytes, t, jpeg.tables);
          library.set(definition.id, {
            type: "bitmap",
            id: definition.id,
            definition,
            pixels:
              definition.type === "pixels"
                ? definition
                : definition.type === "invalid"
                  ? INVALID_PIXELS
                  : null,
          });
        }
    }
  }

  // The frames after the last ShowFrame hold nothing; a timeline has as many as its header says.
  frames.length = Math.max(1, Math.min(frames.length, frameCount || 1));
  while (frames.length < (frameCount || 1)) {
    frames.push([]);
  }

  return { frames, labels };
}

/** The characters a SWF defines, and its root timeline. */
export function readLibrary(swf: Swf): Library {
  const characters = new Map<number, Character>();
  const root = timelineOf(swf.bytes, swf.tags, swf.frameCount, characters, { tables: null });
  const fonts = new FontSet();
  for (const c of characters.values()) {
    if (c.type === "font") {
      fonts.add(c.font);
    }
  }

  return { characters, root, classes: new Map(), construct: null, removing: null, fonts };
}
