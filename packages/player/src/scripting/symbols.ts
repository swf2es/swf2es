// What SymbolClass binds: the character, and its library, a class makes
// when a script constructs it, a display object's or a resource's (bitmap,
// bytes, sound, font); the fonts scripts register; and the decodes of
// identical sounds, which the libraries alive share.
import { readSymbolClass, type Sound, type Swf, tags } from "@swf2es/format";
import type { avm2 } from "@swf2es/runtime";
import { BitmapStore } from "../bitmap/bitmap.js";
import {
  BitmapObject,
  ButtonObject,
  Container,
  type DisplayObject,
  displayFor,
  EMPTY_TIMELINE,
  MovieClip,
  ShapeObject,
  TextObject,
  VideoObject,
} from "../display/display.js";
import {
  type AnyFontCharacter,
  type BitmapCharacter,
  type Character,
  INVALID_PIXELS,
  type Library,
  type SoundCharacter,
} from "../display/timeline.js";
import type { DecodedSound } from "../media/audio.js";
import type { Scripting } from "../scripting.js";
import { FontSet } from "../text/fonts.js";

type AsObject = avm2.AsObject;

/** What SymbolClass bound a class to: a character of a SWF's library. */
interface Symbol {
  character: Character;
  library: Library;
}

interface SharedAudio {
  definition: WeakRef<Sound>;
  decoded: DecodedSound | null;
  pending: Promise<DecodedSound> | null;
  serial: number;
}

export class Symbols {
  private readonly audioEntries = new WeakMap<SoundCharacter, SharedAudio>();
  private readonly sharedAudio = new Map<number, SharedAudio[]>();
  private readonly sharedAudioGone = new FinalizationRegistry<{
    hash: number;
    entry: SharedAudio;
    serial: number;
  }>(({ hash, entry, serial }) => {
    if (entry.serial !== serial || entry.definition.deref()) {
      return;
    }

    this.removeSharedAudio(hash, entry);
  });
  /**
   * The character, and its SWF's library, each class SymbolClass bound
   * makes, for a `new` of the class from a script: by the module that
   * defines the class, as the SWF's domain found it, then its name, so a
   * class of the same name in another domain has its own; `unbound` for a
   * name nothing defined when it was bound. Weakly, by the module: a SWF
   * let go takes its symbols with it.
   */
  private readonly symbols = new WeakMap<avm2.Abc, Map<string, Symbol>>();
  private readonly unbound = new Map<string, Symbol>();
  /**
   * The font sets of the libraries whose embedded fonts have been made
   * visible to this player, for the fonts registered later. Weakly, so
   * that a SWF let go is not kept for them; but by the set, not the
   * library, as a text field keeps only its library's set, and a field
   * kept from a SWF otherwise let go still takes the fonts registered.
   */
  private readonly fontSets = new Set<WeakRef<FontSet>>();
  private readonly fontSetsSeen = new WeakSet<FontSet>();
  /** Font classes explicitly registered by scripts, in registration order. */
  readonly registeredFonts = new Map<AsObject, AnyFontCharacter>();

  constructor(private readonly s: Scripting) {}

  /** SymbolClass: bind the SWF's characters to their classes, in its library. */
  bind(swf: Swf, library: Library): void {
    const domain = library.domain ?? this.s.mainDomain;
    for (const t of swf.tags) {
      if (t.code === tags.SymbolClass) {
        for (const [id, name] of readSymbolClass(swf.bytes, t)) {
          const qualified = qualify(name);
          library.classes.set(id, qualified);
          const character = library.characters.get(id);
          if (character) {
            const abc = this.s.rt.definingAbc(qualified, domain);
            let byName = abc ? this.symbols.get(abc) : this.unbound;
            if (!byName) {
              byName = new Map();
              this.symbols.set(abc as avm2.Abc, byName);
            }

            // A class keeps the symbol first bound to it: another SWF that
            // binds it, one that finds it in a parent's domain, makes its own
            // timeline's instances of it but not a script's (the corpus's
            // loader_duplicate_class).
            if (!byName.has(qualified)) {
              byName.set(qualified, { character, library });
            }
          }
        }
      }
    }
  }

  /** The bitmap a class SymbolClass bound is of, if `traits` or a base is one's. */
  bitmapSymbol(traits: SymbolTraits): BitmapCharacter | null {
    for (let t: SymbolTraits | null = traits; t; t = t.base as SymbolTraits | null) {
      const symbol = this.symbolOf(t);
      if (symbol) {
        return symbol.character.type === "bitmap" ? symbol.character : null;
      }
    }

    return null;
  }

  /**
   * The bytes of the DefineBinaryData a class SymbolClass bound, if
   * `traits` or a base is one's: one buffer for all its instances, which
   * see each other's writes, as Flash's.
   */
  binarySymbol(traits: SymbolTraits): Uint8Array<ArrayBuffer> | null {
    for (let t: SymbolTraits | null = traits; t; t = t.base as SymbolTraits | null) {
      const symbol = this.symbolOf(t);
      if (symbol) {
        const character = symbol.character;
        if (character.type !== "binary") {
          return null;
        }

        character.shared ??= new Uint8Array(character.data);
        return character.shared;
      }
    }

    return null;
  }

  /** A DefineSound a class or one of its bases was bound to. */
  soundSymbol(traits: SymbolTraits): SoundCharacter | null {
    for (let t: SymbolTraits | null = traits; t; t = t.base as SymbolTraits | null) {
      const symbol = this.symbolOf(t);
      if (symbol) {
        return symbol.character.type === "sound" ? symbol.character : null;
      }
    }

    return null;
  }

  /** A DefineFont a class or one of its bases was bound to. */
  fontSymbol(traits: SymbolTraits): AnyFontCharacter | null {
    for (let t: SymbolTraits | null = traits; t; t = t.base as SymbolTraits | null) {
      const symbol = this.symbolOf(t);
      if (symbol) {
        return symbol.character.type === "font" || symbol.character.type === "fontCff"
          ? symbol.character
          : null;
      }
    }

    return null;
  }

  /** Keep a SWF's own fonts and fonts registered elsewhere available to its fields. */
  addFontLibrary(library: Library): void {
    if (this.fontSetsSeen.has(library.fonts)) {
      return;
    }

    for (const ref of this.fontSets) {
      if (!ref.deref()) {
        this.fontSets.delete(ref);
      }
    }

    this.fontSetsSeen.add(library.fonts);
    this.fontSets.add(new WeakRef(library.fonts));
    for (const font of this.registeredFonts.values()) {
      if (font.type === "font") {
        library.fonts.add(font.font);
      }
    }
  }

  /** Make a registered font available to fields made by every loaded SWF. */
  registerFont(cls: AsObject, font: AnyFontCharacter): void {
    if (
      this.registeredFonts.has(cls) ||
      [...this.registeredFonts.values()].some(
        (registered) =>
          registered.name.toLowerCase() === font.name.toLowerCase() &&
          registered.type === font.type &&
          registered.bold === font.bold &&
          registered.italic === font.italic,
      )
    ) {
      return;
    }

    this.registeredFonts.set(cls, font);
    for (const ref of this.fontSets) {
      const fonts = ref.deref();
      if (!fonts) {
        this.fontSets.delete(ref);
      } else if (font.type === "font") {
        fonts.add(font.font);
      }
    }
  }

  /** Decode a sound on first play; live libraries can share an identical decode. */
  soundClip(character: SoundCharacter): Promise<DecodedSound> | null {
    if (!this.s.audio) {
      return null;
    }

    const own = this.audioEntries.get(character);
    if (own?.pending) {
      return own.pending;
    }

    const ownDecoded = own?.decoded;
    if (ownDecoded) {
      return Promise.resolve(ownDecoded);
    }

    const definition = character.definition;
    const hash = soundHash(definition);
    for (const entry of this.sharedAudio.get(hash) ?? []) {
      const prior = entry.definition.deref();
      if (!prior || !sameSound(prior, definition)) {
        continue;
      }

      const decoded = entry.decoded;
      const clip = entry.pending ?? (decoded ? Promise.resolve(decoded) : null);
      if (clip) {
        entry.definition = new WeakRef(definition);
        this.sharedAudioGone.register(definition, {
          hash,
          entry,
          serial: ++entry.serial,
        });
        this.audioEntries.set(character, entry);
        return clip;
      }
    }

    const entry: SharedAudio = {
      definition: new WeakRef(definition),
      decoded: null,
      pending: null,
      serial: 1,
    };
    const audio = this.s.audio;
    const clip = Promise.resolve().then(() => audio.decode(definition));
    entry.pending = clip;
    const matches = this.sharedAudio.get(hash) ?? [];
    matches.push(entry);
    this.sharedAudio.set(hash, matches);
    this.sharedAudioGone.register(definition, { hash, entry, serial: 1 });
    void clip.then(
      (decoded) => {
        entry.decoded = decoded;
        entry.pending = null;
      },
      () => this.removeSharedAudio(hash, entry),
    );
    this.audioEntries.set(character, entry);
    return clip;
  }

  private removeSharedAudio(hash: number, entry: SharedAudio): void {
    const matches = this.sharedAudio.get(hash)?.filter((candidate) => candidate !== entry) ?? [];
    if (matches.length > 0) {
      this.sharedAudio.set(hash, matches);
    } else {
      this.sharedAudio.delete(hash);
    }
  }

  /** What SymbolClass bound the class of `traits` to, if anything: by its defining module, then its name. */
  private symbolOf(traits: SymbolTraits): Symbol | undefined {
    const abc = traits.abc as avm2.Abc | null | undefined;
    return (abc && this.symbols.get(abc)?.get(traits.name)) ?? this.unbound.get(traits.name);
  }

  /** A new plain BitmapData of a bitmap's pixels, as a Bitmap of the bitmap gets. */
  bitmapDataOf(character: BitmapCharacter): AsObject {
    const data = this.s.rt.construct(
      this.s.rt.classNamed("flash.display::BitmapData"),
      1,
      1,
    ) as AsObject;
    data.$store = BitmapStore.of(character.pixels ?? INVALID_PIXELS);
    return data;
  }

  /**
   * The display object for an instance a script makes with `new`: the
   * character of a class SymbolClass bound, if the class or a base of it
   * is one, else an empty clip, shape or container by the nearest base.
   */
  displayFor(traits: SymbolTraits): DisplayObject {
    const library: Library = this.s.library ?? {
      characters: new Map(),
      root: EMPTY_TIMELINE,
      classes: new Map(),
      construct: null,
      constructLater: null,
      constructPlaced: null,
      uncaught: null,
      removing: null,
      fonts: new FontSet(),
    };
    for (let t: SymbolTraits | null = traits; t; t = t.base as SymbolTraits | null) {
      // A display object's class bound to data has no display of it.
      const symbol = this.symbolOf(t);
      if (
        symbol &&
        symbol.character.type !== "binary" &&
        symbol.character.type !== "font" &&
        symbol.character.type !== "fontCff" &&
        symbol.character.type !== "sound"
      ) {
        if (symbol.character.type === "text") {
          // A new linked TextField has its symbol's bounds, but not its timeline's initial text.
          const text = new TextObject(symbol.character, false);
          text.fonts = symbol.library.fonts;
          return text;
        }

        const display = displayFor(symbol.character, symbol.library);
        // A bound button a script makes has its states, as a timeline's does.
        if (display instanceof ButtonObject && symbol.character.type === "button") {
          this.s.makeButtonStates(display, symbol.character, symbol.library);
        }

        return display;
      }

      if (t.name === "flash.display::SimpleButton") {
        return new ButtonObject();
      }

      if (t.name === "flash.display::MovieClip") {
        return new MovieClip(EMPTY_TIMELINE, library);
      }

      if (t.name === "flash.display::Shape") {
        return new ShapeObject(null);
      }

      // Only a timeline makes a MorphShape or a StaticText.
      if (t.name === "flash.display::MorphShape") {
        throw this.s.rt.error("ArgumentError", 2012, "MorphShape$");
      }

      if (t.name === "flash.text::StaticText") {
        throw this.s.rt.error("ArgumentError", 2012, "StaticText$");
      }

      // Only a load of an AVM1 SWF makes one (requestLoad).
      if (t.name === "flash.display::AVM1Movie") {
        throw this.s.rt.error("ArgumentError", 2012, "AVM1Movie$");
      }

      if (t.name === "flash.display::Bitmap") {
        return new BitmapObject(null);
      }

      if (t.name === "flash.media::Video") {
        return new VideoObject();
      }

      if (t.name === "flash.text::TextField") {
        const text = new TextObject(null);
        text.fonts = (this.s.code.codeLibrary() ?? library).fonts;
        return text;
      }
    }

    return new Container();
  }
}

/** Compare the bytes too: a 32-bit hash only narrows a bucket, never decides identity. */
function sameSound(a: Sound, b: Sound): boolean {
  if (
    a.format !== b.format ||
    a.sampleRate !== b.sampleRate ||
    a.sampleSize !== b.sampleSize ||
    a.channels !== b.channels ||
    a.sampleCount !== b.sampleCount ||
    a.seekSamples !== b.seekSamples ||
    a.data.length !== b.data.length
  ) {
    return false;
  }

  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] !== b.data[i]) {
      return false;
    }
  }

  return true;
}

function soundHash(sound: Sound): number {
  let hash = 0x811c9dc5;
  for (const value of [
    sound.format,
    sound.sampleRate,
    sound.sampleSize,
    sound.channels,
    sound.sampleCount,
    sound.seekSamples,
  ]) {
    hash = Math.imul(hash ^ value, 0x01000193);
  }

  for (const byte of sound.data) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }

  return hash >>> 0;
}

/** A class's traits as the symbol lookups read them: its name, its module, its base's. */
interface SymbolTraits {
  name: string;
  abc?: unknown;
  base: unknown;
}

/** "pkg.Name", as SymbolClass writes a class, as "pkg::Name". */
function qualify(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? name : `${name.slice(0, i)}::${name.slice(i + 1)}`;
}
