// A SWF's characters, and its timelines as frames of display commands:
// what the root and each sprite place, move and remove on each frame, and
// the frames' labels. Definitions are read once, at load, as the whole
// file is there.
import {
  type Bitmap,
  isBitmapTag,
  type Place,
  readBinaryData,
  readBitmap,
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

export type Character = ShapeCharacter | SpriteCharacter | BitmapCharacter | BinaryCharacter;

/** What a timeline can place: every character but data. */
export type DisplayCharacter = Exclude<Character, BinaryCharacter>;

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
        const shape = readShape(bytes, t.code, t.offset, t.length);
        // Its bitmap fills' bitmaps, which a SWF defines before the shapes that use them.
        const bitmap = (id: number) => {
          const c = library.get(id);
          return c?.type === "bitmap" ? c : null;
        };
        library.set(shape.id, {
          type: "shape",
          id: shape.id,
          shape,
          layers: shapeLayers(shape, bitmap),
        });
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
  return { characters, root, classes: new Map(), construct: null, removing: null };
}
