// What a character makes: the display object a timeline places for it,
// and its bringing to life once placed.
import { BitmapStore } from "../bitmap/bitmap.js";
import { BitmapObject } from "./bitmapobject.js";
import { ButtonObject, buttonStates } from "./buttonobject.js";
import type { DisplayObject } from "./displayobject.js";
import { MovieClip } from "./movieclip.js";
import { ShapeObject } from "./shapeobject.js";
import { StaticTextObject, TextObject } from "./textobjects.js";
import { type DisplayCharacter, INVALID_PIXELS, type Library } from "./timeline.js";

/** A display object for a character, before its first frame: a shape, or a clip. */
/** `hasImage` is PlaceObject3's flag where a timeline places it, which a bitmap's construction reads. */
export function displayFor(
  character: DisplayCharacter,
  library: Library,
  hasImage = false,
): DisplayObject {
  if (character.type === "shape") {
    return new ShapeObject(character);
  }

  if (character.type === "morph") {
    return ShapeObject.ofMorph(character);
  }

  if (character.type === "bitmap") {
    // With scripts, its Bitmap's constructor gives it its data; without, a copy of the pixels.
    const bitmap = new BitmapObject(
      library.construct ? null : BitmapStore.of(character.pixels ?? INVALID_PIXELS),
    );
    bitmap.character = character;
    bitmap.hasImage = hasImage;
    return bitmap;
  }

  if (character.type === "static") {
    return new StaticTextObject(character, library.characters);
  }

  if (character.type === "text") {
    const text = new TextObject(character);
    text.fonts = library.fonts;
    return text;
  }

  // Its states are made where it is constructed (Scripting.construct).
  if (character.type === "button") {
    const button = new ButtonObject();
    button.character = character;
    button.library = library;
    button.trackAsMenu = character.trackAsMenu;
    button.scale9Grid = character.grid;
    return button;
  }

  const clip = new MovieClip(character.timeline, library);
  clip.character = character;
  clip.scale9Grid = character.grid;
  return clip;
}

/**
 * Bring a display object the timeline placed to life: its AS3 object
 * constructed where the SWF has scripts, which enters a clip's first frame
 * and names it on its parent, else a clip's first frame entered. After the
 * placement, as Flash has it, so that the parent and the name are there.
 */
export function construct(
  display: DisplayObject,
  character: DisplayCharacter,
  library: Library,
): void {
  library.avm1?.made(display);
  if (library.construct) {
    library.construct(display, character);
  } else if (display instanceof MovieClip) {
    display.enterFirstFrame();
  } else if (display instanceof ButtonObject && character.type === "button") {
    buttonStates(
      display,
      character,
      library,
      (d, c) => construct(d, c, library),
      () => {},
    );
  }
}

/** A display object for a character as the timeline would place it, alive, but in no container. */
export function instantiate(character: DisplayCharacter, library: Library): DisplayObject {
  const display = displayFor(character, library);
  construct(display, character, library);
  return display;
}
