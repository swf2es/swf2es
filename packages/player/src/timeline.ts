// A SWF's characters, and its timelines as frames of display commands:
// what the root and each sprite place, move and remove on each frame, and
// the frames' labels. Definitions are read once, at load, as the whole
// file is there.
import {
  type Bitmap,
  type ButtonRecord,
  type EditText,
  type Font,
  type Font4,
  type FontName,
  isBitmapTag,
  type MorphShape,
  type Place,
  readBinaryData,
  readBitmap,
  readButton,
  readButtonSound,
  readEditText,
  readFont,
  readFont4,
  readFrameLabel,
  readMorphShape,
  readPlace,
  readRemove,
  readSceneData,
  readShape,
  readSound,
  readSoundStreamBlock,
  readSoundStreamHead,
  readSprite,
  readStartSound,
  readStaticText,
  type SceneData,
  type Sound,
  type SoundInfo,
  type SoundStreamBlock,
  type SoundStreamHead,
  type StartSound,
  type StaticText,
  type Swf,
  type Tag,
  tags,
} from "@swf2es/format";
import type { avm2 } from "@swf2es/runtime";
import type { BitmapStore } from "./bitmap.js";
import type { DisplayObject, MovieClip } from "./display.js";
import { FontSet } from "./fonts.js";
import { boundsOf, type ShapeBounds, type ShapeLayer, shapeLayers } from "./shapes.js";

export type FrameCommand = { type: "place"; place: Place } | { type: "remove"; depth: number };

/** A frame's name, or a scene's, and its frame, 1 the first. */
export interface FrameName {
  name: string;
  frame: number;
}

export interface Timeline {
  /** Frame k's commands at index k - 1. */
  frames: FrameCommand[][];
  /**
   * The labels scripts read, in frame order: the scene data's where the
   * SWF has it (a root's DefineSceneAndFrameLabelData), even none, its
   * FrameLabel tags otherwise. One after the last frame is kept.
   */
  labels: FrameName[];
  /** The labels a goto finds: those, or the FrameLabel tags where the scene data has none. */
  gotoLabels: FrameName[];
  /** The FrameLabel tags by frame, which currentFrameLabel reads, scene data or not. */
  frameLabels: Map<number, string>;
  /** Scenes by their first frame, in order; one unnamed scene of every frame without scene data. */
  scenes: FrameName[];
  /** StartSound and StartSound2 tags by frame, 1 the first. */
  sounds: Map<number, StartSound[]>;
  /** Its SoundStreamHead's stream, if it has one with blocks. */
  stream: SoundStream | null;
}

/** A timeline's stream: the head, and each block with the frame it is on. */
export interface SoundStream {
  head: SoundStreamHead;
  blocks: SoundStreamBlock[];
  /** The block on each frame that has one, by frame. */
  byFrame: Map<number, number>;
  /** The blocks as one sound and the sample each starts at, made when the stream first plays. */
  sound?: { character: SoundCharacter; starts: number[] };
}

/**
 * What plays a library's timeline sounds (the playerglobal's Sound.ts),
 * with a page's audio device; null where nothing plays them.
 */
export interface TimelineSounds {
  /** `clip` entered `frame`: its StartSound tags, and its stream's block there if it plays. */
  frame(clip: MovieClip, frame: number): void;
  /** `clip` stopped or jumped: its stream stops, to start again at a block it plays on to. */
  stopStream(clip: MovieClip): void;
  /** A sound of `library` that `owner` starts as SOUNDINFO says, as a button's state change does. */
  start(owner: DisplayObject, library: Library, id: number, info: SoundInfo): void;
  /** The timeline took `display` off: the streams of the clips in it stop, as they no longer play. */
  removed(display: DisplayObject): void;
}

export interface ShapeCharacter {
  type: "shape";
  id: number;
  /** The DefineShape's bounds: its records, read once into `layers`, are not kept. */
  shape: ShapeBounds;
  layers: ShapeLayer[];
}

/** DefineMorphShape or DefineMorphShape2, and its latest blends by ratio, least recent first (morph.ts). */
export interface MorphCharacter {
  type: "morph";
  id: number;
  morph: MorphShape;
  blends: Map<number, ShapeCharacter>;
  /** Its bitmap fills' bitmaps. */
  bitmap: (id: number) => BitmapCharacter | null;
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

/** DefineText or DefineText2: glyphs of its SWF's fonts, which it finds as it is shown (static-text.ts). */
export interface StaticTextCharacter {
  type: "static";
  id: number;
  definition: StaticText;
}

/** DefineButton or DefineButton2: the characters it shows in each state. */
export interface ButtonCharacter {
  type: "button";
  id: number;
  records: ButtonRecord[];
  trackAsMenu: boolean;
  /** DefineButtonSound's: over to up, up to over, over to down, down to over; null without. */
  sounds: ({ id: number; info: SoundInfo } | null)[] | null;
}

/** DefineFont2 or 3: its name and style, for the fields that name it, and its glyphs and layout. */
export interface FontCharacter extends FontName {
  type: "font";
  font: Font;
}

/** DefineFont4: CFF fonts belong to the Flash Text Engine, not classic TextField layout. */
export interface CffFontCharacter extends FontName {
  type: "fontCff";
  font: Font4;
}

export type AnyFontCharacter = FontCharacter | CffFontCharacter;

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

export interface SoundCharacter {
  type: "sound";
  id: number;
  definition: Sound;
}

export type Character =
  | ShapeCharacter
  | MorphCharacter
  | SpriteCharacter
  | ButtonCharacter
  | BitmapCharacter
  | TextCharacter
  | StaticTextCharacter
  | BinaryCharacter
  | FontCharacter
  | CffFontCharacter
  | SoundCharacter;

/** What a timeline can place: every character but data and fonts. */
export type DisplayCharacter = Exclude<
  Character,
  BinaryCharacter | FontCharacter | CffFontCharacter | SoundCharacter
>;

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
  /**
   * Where the error of a constructor a goto ran goes, as Flash reports it
   * apart from the goto; without it, the error reaches the goto's caller.
   */
  uncaught: ((error: unknown) => void) | null;
  /** Has the AS3 object of a child a frame played on placed made in the frame's construct phase; null where there are no scripts. */
  constructLater: ((display: DisplayObject, character: DisplayCharacter) => void) | null;
  /** Told before a timeline child goes, for the events a script sees; null in an AVM1 movie. */
  /** Tells of a display object about to lose its parent, and whether the timeline takes it (a script's removal otherwise). */
  removing: ((display: DisplayObject, byTimeline: boolean) => void) | null;
  /** The SWF's embedded fonts, by name, which its fields lay their text out in. */
  fonts: FontSet;
  /** The application domain its code was loaded into, where its class names resolve; the root's if none. */
  domain?: avm2.Domain;
  /** The SWF's version, which some behaviour of what it places follows. */
  version?: number;
  /** Plays its timelines' and buttons' sounds; null where nothing does. */
  sounds?: TimelineSounds | null;
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
  // Its bitmap fills' bitmaps as the SWF has them now, which defines them before the shapes that
  // use them; a shape with any is the SWF's own, not shared.
  // The parse is not kept: no function made here refers to it, so its records go.
  const bitmaps = new Map<number, BitmapCharacter | null>();
  const styles = [shape.fills];
  for (const r of shape.records) {
    if (r.type === "style" && r.styles) {
      styles.push(r.styles.fills);
    }
  }

  for (const fills of styles) {
    for (const fill of fills) {
      if (fill.type === "bitmap" && !bitmaps.has(fill.bitmap)) {
        bitmaps.set(fill.bitmap, bitmap(fill.bitmap));
      }
    }
  }

  let layers: ShapeLayer[] | null = null;
  const character: ShapeCharacter = {
    type: "shape",
    id: shape.id,
    shape: boundsOf(shape),
    // Drawn into layers when first asked for, from the tag: most of the shapes a large
    // application's SWFs define are never shown, and their layers were most of its memory.
    get layers() {
      layers ??= shapeLayers(
        readShape(bytes, t.code, t.offset, t.length),
        (id) => bitmaps.get(id) ?? null,
      );
      return layers;
    },
  };
  if (bitmaps.size === 0) {
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
  const frameLabels = new Map<number, string>();
  const sounds = new Map<number, StartSound[]>();
  let head: SoundStreamHead | null = null;
  const blocks: SoundStreamBlock[] = [];
  const byFrame = new Map<number, number>();
  let scenes: SceneData | null = null;
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
        frameLabels.set(frames.length, readFrameLabel(bytes, t));
        break;
      case tags.StartSound:
      case tags.StartSound2: {
        const list = sounds.get(frames.length) ?? [];
        list.push(readStartSound(bytes, t));
        sounds.set(frames.length, list);
        break;
      }
      case tags.SoundStreamHead:
      case tags.SoundStreamHead2:
        head ??= readSoundStreamHead(bytes, t);
        break;
      case tags.SoundStreamBlock:
        // A block before the head, or a second on a frame, has no place in the stream.
        if (head && !byFrame.has(frames.length)) {
          byFrame.set(frames.length, blocks.length);
          blocks.push(readSoundStreamBlock(bytes, t, head.format));
        }
        break;
      case tags.DefineSceneAndFrameLabelData:
        scenes = readSceneData(bytes, t);
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
      case tags.DefineMorphShape:
      case tags.DefineMorphShape2: {
        const morph = readMorphShape(bytes, t.code, t.offset, t.length);
        library.set(morph.id, {
          type: "morph",
          id: morph.id,
          morph,
          blends: new Map(),
          bitmap: (id) => {
            const c = library.get(id);
            return c?.type === "bitmap" ? c : null;
          },
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
      case tags.DefineButton:
      case tags.DefineButton2: {
        const button = readButton(bytes, t);
        library.set(button.id, {
          type: "button",
          id: button.id,
          records: button.records,
          trackAsMenu: button.trackAsMenu,
          sounds: null,
        });
        break;
      }
      case tags.DefineButtonSound: {
        const given = readButtonSound(bytes, t);
        const button = library.get(given.id);
        if (button?.type === "button") {
          button.sounds = given.sounds;
        }
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
      case tags.DefineFont4: {
        const font = readFont4(bytes, t);
        library.set(font.id, {
          type: "fontCff",
          id: font.id,
          name: font.name,
          bold: font.bold,
          italic: font.italic,
          font,
        });
        break;
      }
      case tags.DefineText:
      case tags.DefineText2: {
        const definition = readStaticText(bytes, t);
        library.set(definition.id, { type: "static", id: definition.id, definition });
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
      case tags.DefineSound: {
        const definition = readSound(bytes, t);
        library.set(definition.id, { type: "sound", id: definition.id, definition });
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

  // Scene data counts frames from 0; a frame name from 1, as scripts do.
  const named = (list: { frame: number; name: string }[]) =>
    list.map(({ frame, name }) => ({ name, frame: frame + 1 }));
  // Scene data that names no scene is none, as Flash reads it; its first
  // scene starts the timeline whatever frame it gives.
  const data = (scenes as SceneData | null)?.scenes.length ? (scenes as SceneData) : null;
  const tagged = [...frameLabels].map(([frame, name]) => ({ name, frame }));
  const labels = data ? named(data.labels).sort((a, b) => a.frame - b.frame) : tagged;
  const sceneList = data ? named(data.scenes) : [{ name: "", frame: 1 }];
  sceneList[0].frame = 1;
  return {
    frames,
    labels,
    gotoLabels: labels.length > 0 ? labels : tagged,
    frameLabels,
    scenes: sceneList,
    sounds,
    stream: head && blocks.length > 0 ? { head, blocks, byFrame } : null,
  };
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

  return {
    characters,
    root,
    classes: new Map(),
    construct: null,
    constructLater: null,
    uncaught: null,
    removing: null,
    fonts,
    version: swf.header.version,
    sounds: null,
  };
}
