// A SWF's characters, and its timelines as frames of display commands:
// what the root and each sprite place, move and remove on each frame, and
// the frames' labels. Definitions are read once, at load, as the whole
// file is there.
import {
  type Place,
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

export type Character = ShapeCharacter | SpriteCharacter;

export interface Library {
  characters: Map<number, Character>;
  root: Timeline;
  /**
   * Gives a display object the player just made its AS3 object, where the
   * SWF has scripts (Scripting.construct); null in an AVM1 movie. A clip's
   * first frame is entered on the way, by Sprite's constructChildren.
   */
  construct: ((display: DisplayObject, character: Character) => void) | null;
}

function timelineOf(
  bytes: Uint8Array,
  list: Tag[],
  frameCount: number,
  library: Map<number, Character>,
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
        library.set(shape.id, { type: "shape", id: shape.id, shape, layers: shapeLayers(shape) });
        break;
      }
      case tags.DefineSprite: {
        const sprite = readSprite(bytes, t);
        library.set(sprite.id, {
          type: "sprite",
          id: sprite.id,
          timeline: timelineOf(bytes, sprite.tags, sprite.frameCount, library),
        });
        break;
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
  const root = timelineOf(swf.bytes, swf.tags, swf.frameCount, characters);
  return { characters, root, construct: null };
}
