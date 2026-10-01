// A SWF's scripts: its DoABCs compiled through @swf2es/codegen and loaded
// into a runtime with playerglobal's natives, its SymbolClass binding
// characters to classes, and the link between a display object and the
// AS3 object that is its other face (docs/architecture.md, "Scripts and
// the display list"). The runtime allocates every DisplayObject through a
// hook that takes the display object the player has pending, when the
// player constructs a timeline child's class, or makes one for a `new`.
import type { Codegen } from "@swf2es/codegen";
import { readDoAbc, readSymbolClass, type Swf, tags } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import {
  Container,
  type DisplayObject,
  displayFor,
  EMPTY_TIMELINE,
  MovieClip,
  ShapeObject,
} from "./display.js";
import { dispatchTo } from "./playerglobal/flash/events/EventDispatcher.js";
import { playerHooks, playerNatives } from "./playerglobal/index.js";
import type { Character, Library } from "./timeline.js";

type AsObject = avm2.AsObject;

/** AS3 classes placed children are instances of when SymbolClass binds none. */
const DEFAULT_CLASS = { shape: "flash.display::Shape", sprite: "flash.display::MovieClip" };

export class Scripting {
  readonly rt: avm2.Runtime;
  /** SymbolClass: each bound character's class, by qualified name "pkg::Name". */
  readonly classes = new Map<number, string>();
  /** The character each bound class makes, for a `new` of the class from a script. */
  readonly symbols = new Map<string, Character>();
  /** The display object the next DisplayObject allocation is for, while the player constructs a timeline child's class. */
  pending: DisplayObject | null = null;
  /** The stage, once the player has made it, and the root it holds. */
  stage: Container | null = null;
  root: MovieClip | null = null;
  library: Library | null = null;
  /** Whether a script asked the stage to render (Stage.invalidate). */
  invalidated = false;
  /** The display objects listening for each frame event, in the order they first listened; a broadcast reaches these. */
  private readonly broadcasts = new Map<string, Set<AsObject>>();
  /** What flash.display.Stage reports and sets; the player copies the frame rate back each frame. */
  stageWidth = 0;
  stageHeight = 0;
  frameRate = 24;
  quality = "HIGH";
  private readonly hashes: string[] = [];

  constructor(
    readonly codegen: Codegen,
    options: avm2.RuntimeOptions = {},
  ) {
    this.rt = new avm2.Runtime(
      { ...avm2.builtinNatives(), ...playerNatives(this) },
      { ...avm2.builtinHooks(), ...playerHooks(this) },
      options,
    );
    this.codegen.reset(50);
  }

  /** Load the libraries the SWF's code links against (builtin, playerglobal), whose scripts run on first use. */
  async loadLibraries(abcs: Uint8Array[]): Promise<void> {
    for (const abc of abcs) {
      await this.load(abc, true, false);
    }
  }

  /** Load the SWF's DoABCs in tag order, each run unless its lazy flag defers it to first use, then its SymbolClass. */
  async loadSwf(swf: Swf, library: Library): Promise<void> {
    this.library = library;
    for (const t of swf.tags) {
      if (t.code === tags.DoABC || t.code === tags.DoABC2) {
        const { lazy, abc } = readDoAbc(swf.bytes, t);
        await this.load(abc, false, !lazy);
      }
    }

    for (const t of swf.tags) {
      if (t.code === tags.SymbolClass) {
        for (const [id, name] of readSymbolClass(swf.bytes, t)) {
          const qualified = qualify(name);
          this.classes.set(id, qualified);
          const character = library.characters.get(id);
          if (character) {
            this.symbols.set(qualified, character);
          }
        }
      }
    }
  }

  private async load(abc: Uint8Array, builtin: boolean, run: boolean): Promise<void> {
    const error = this.codegen.add(abc, builtin);
    if (error) {
      throw new Error(`an ABC was rejected: VerifyError #${error}`);
    }

    this.hashes.push(hashOf(abc));
    const { module } = this.codegen.compile(this.hashes);
    const factory = (await import(`data:text/javascript,${encodeURIComponent(module)}`)).default;
    const linked = factory(this.rt);
    if (run) {
      this.rt.run(linked);
    }
  }

  /**
   * The AS3 object of a timeline child the player just made: an instance
   * of the class SymbolClass binds its character to, else of MovieClip or
   * Shape, constructed with `display` as its other face. A clip's first
   * frame is entered by Sprite's constructChildren on the way.
   */
  construct(display: DisplayObject, character: Character): void {
    const name = this.classes.get(character.id) ?? DEFAULT_CLASS[character.type];
    const object = this.constructAs(display, this.rt.classNamed(name));
    // Flash gives the parent a property of the child's instance name, which
    // a sealed class without it refuses: ReferenceError #1056, as Flash.
    const parent = display.parent?.object;
    if (parent && display.name) {
      this.rt.setProperty(parent, avm2.qname(avm2.publicNs, display.name), object);
    }
  }

  /** Construct `cls` for `display`: the allocation hook takes it as the instance's other face. */
  constructAs(display: DisplayObject, cls: AsObject): AsObject {
    this.pending = display;
    try {
      return this.rt.construct(cls);
    } finally {
      this.pending = null;
    }
  }

  /**
   * The display object for an instance a script makes with `new`: the
   * character of a class SymbolClass bound, if the class or a base of it
   * is one, else an empty clip, shape or container by the nearest base.
   */
  displayFor(traits: {
    name: string;
    base: { name: string; base: unknown } | null;
  }): DisplayObject {
    const library = this.library ?? {
      characters: new Map(),
      root: EMPTY_TIMELINE,
      construct: null,
    };
    for (let t: typeof traits | null = traits; t; t = t.base as typeof traits | null) {
      const symbol = this.symbols.get(t.name);
      if (symbol) {
        return displayFor(symbol, library);
      }

      if (t.name === "flash.display::MovieClip") {
        return new MovieClip(EMPTY_TIMELINE, library);
      }

      if (t.name === "flash.display::Shape") {
        return new ShapeObject(null);
      }
    }

    return new Container();
  }

  /** A flash.events.Event of `type`. */
  event(type: string, bubbles = false): AsObject {
    return this.rt.construct(this.rt.classNamed("flash.events::Event"), type, bubbles, false);
  }

  /** The display objects a broadcast of `type` reaches, for EventDispatcher to keep. */
  broadcastTargets(type: string): Set<AsObject> {
    let targets = this.broadcasts.get(type);
    if (!targets) {
      targets = new Set();
      this.broadcasts.set(type, targets);
    }

    return targets;
  }

  /**
   * Dispatch an event of `type` to every display object that listens for
   * it, on the display list or not, in the order they first listened, each
   * its own event and its own target only: Flash's frame events have no
   * capture or bubble phase.
   */
  broadcast(type: string): void {
    const targets = this.broadcasts.get(type);
    if (!targets) {
      return;
    }

    for (const target of [...targets]) {
      dispatchTo(this, target, this.event(type));
    }
  }

  /**
   * Run the frame scripts of the clips under `root` that entered a frame
   * with one since they last ran, in tree order, and again for what those
   * scripts made jump, until none is left (bounded, as a script that jumps
   * on every run would never settle).
   */
  runFrameScripts(root: DisplayObject): void {
    for (let round = 0; round < 64; round++) {
      let ran = false;
      const visit = (o: DisplayObject) => {
        if (o instanceof MovieClip && o.object && o.scriptedFrame !== o.currentFrame) {
          o.scriptedFrame = o.currentFrame;
          const script = o.frameScripts.get(o.currentFrame);
          if (script) {
            ran = true;
            this.rt.call(script, o.object);
          }
        }

        if (o instanceof Container) {
          for (const child of [...o.children]) {
            visit(child);
          }
        }
      };
      visit(root);
      if (!ran) {
        return;
      }
    }
  }

  /**
   * What follows the timelines' advance in a frame: the frame events and
   * scripts, in Flash's order. The first frame, after construction, has no
   * ENTER_FRAME: Flash goes to FRAME_CONSTRUCTED, the scripts and EXIT_FRAME.
   */
  frame(root: DisplayObject, entered = true): void {
    if (entered) {
      this.broadcast("enterFrame");
    }

    this.broadcast("frameConstructed");
    this.runFrameScripts(root);
    this.broadcast("exitFrame");
    if (this.invalidated) {
      this.invalidated = false;
      this.broadcast("render");
    }
  }
}

/** "pkg.Name", as SymbolClass writes a class, as "pkg::Name". */
function qualify(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? name : `${name.slice(0, i)}::${name.slice(i + 1)}`;
}

/**
 * A hash of an ABC's bytes for the modules' record of what they were
 * linked against: FNV-1a, twice, which tells ABCs apart within one SWF.
 * A cache shared between machines keys on the SHA-256 the AOT side has.
 */
function hashOf(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 0x01000193);
    b = Math.imul(b ^ byte, 0x01000193);
  }

  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}
