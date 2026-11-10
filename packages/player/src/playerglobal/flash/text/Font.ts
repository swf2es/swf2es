// flash.text.Font: embedded SWF font metadata and explicit font registration.
import { avm2 } from "@swf2es/runtime";
import type { AnyFontCharacter, FontCharacter } from "../../../display/timeline.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;

function style(font: AnyFontCharacter): string {
  if (font.bold && font.italic) {
    return "boldItalic";
  }
  if (font.bold) {
    return "bold";
  }

  return font.italic ? "italic" : "regular";
}

/**
 * The fonts enumerateFonts lists: the running code's SWF's, with layout or
 * no glyphs, and, unless `registered` is false, those registered.
 */
export function embeddedFonts(s: Scripting, registered = true): AnyFontCharacter[] {
  const fonts: AnyFontCharacter[] = [];
  const library = s.code.codeLibrary();
  if (library) {
    for (const character of library.characters.values()) {
      if (
        character.type === "font" &&
        (character.font.layout || character.font.glyphs.length === 0)
      ) {
        fonts.push(character);
      }
    }
  }

  if (registered) {
    fonts.push(...s.symbols.registeredFonts.values());
  }

  return fonts;
}

export function fontNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const glyphCodes = new WeakMap<FontCharacter, Set<number>>();

  class FontNatives {
    declare $font: AnyFontCharacter | null;

    get fontName(): string | null {
      return this.$font?.name ?? null;
    }

    get fontStyle(): string | null {
      return this.$font ? style(this.$font) : null;
    }

    get fontType(): string | null {
      return this.$font ? (this.$font.type === "fontCff" ? "embeddedCFF" : "embedded") : null;
    }

    hasGlyphs(text: string): boolean {
      const font = this.$font;
      if (!font) {
        return false;
      }

      if (font.type === "fontCff") {
        return text.length === 0;
      }

      let glyphs = glyphCodes.get(font);
      if (!glyphs) {
        glyphs = new Set(font.font.glyphs.map((glyph) => glyph.code));
        glyphCodes.set(font, glyphs);
      }

      for (let i = 0; i < text.length; i++) {
        if (!glyphs.has(text.charCodeAt(i))) {
          return false;
        }
      }

      return true;
    }

    /**
     * The fonts as Font objects, by name: a registered font an instance of
     * the class it was registered by, as Flash makes it, so that its class
     * name finds that class again; the SWF's own a plain Font, as Flash
     * makes those though a class is bound to them.
     */
    static enumerateFonts(_enumerateDeviceFonts: boolean): AsObject {
      const plain = s.rt.classNamed("flash.text::Font");
      const fonts: { font: AnyFontCharacter; cls: AsObject }[] = [];
      for (const font of embeddedFonts(s, false)) {
        fonts.push({ font, cls: plain });
      }

      for (const [cls, font] of s.symbols.registeredFonts) {
        fonts.push({ font, cls });
      }

      // Stable: a SWF's own font before one registered of the same name, as adl lists them.
      fonts.sort((a, b) => {
        const first = a.font.name.toLowerCase();
        const second = b.font.name.toLowerCase();
        return first < second ? -1 : first > second ? 1 : 0;
      });

      return s.rt.array(
        fonts.map(({ font, cls }) => {
          const object = s.rt.construct(cls) as AsObject;
          object.$font = font;
          return object;
        }),
      );
    }

    static registerFont(cls: AsObject): void {
      const font = cls?.$it && s.symbols.fontSymbol(cls.$it);
      if (!font) {
        throw s.rt.error("ArgumentError", 1508, "font");
      }

      s.symbols.registerFont(cls, font);
    }
  }

  avm2.registerNativeClass(natives, "flash.text::Font", FontNatives);
  return natives;
}

export function fontHooks(s: Scripting): Record<string, avm2.ClassHook> {
  return {
    "flash.text::Font": {
      create: (traits) => {
        const object = Object.create(traits.proto);
        object.$font = s.symbols.fontSymbol(traits);
        return object;
      },
    },
  };
}
