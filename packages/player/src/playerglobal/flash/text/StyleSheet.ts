// flash.text.StyleSheet's natives: playerglobal keeps the style objects
// and their TextFormats itself, and asks these to parse CSS, colours and
// font lists, to hold the TextFormats by selector, and to tell the fields
// that use the sheet that it changed.
import { avm2 } from "@swf2es/runtime";
import type { TextObject } from "../../../display/display.js";
import type { Scripting } from "../../../scripting.js";
import { camelCase, cssColor, fontList, parseCss } from "../../../text/css.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** The fields a sheet styles, weakly: a field set to another sheet, or collected, drops out. */
const users = new WeakMap<AsObject, Set<WeakRef<TextObject>>>();

/** `field` now styled by `sheet`, which tells it of changes. */
export function useSheet(sheet: AsObject, field: TextObject): void {
  let set = users.get(sheet);
  if (!set) {
    set = new Set();
    users.set(sheet, set);
  }

  set.add(field.ref as WeakRef<TextObject>);
}

export function styleSheetNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class StyleSheetNatives {
    declare $styles: Value;

    get "flash.text:StyleSheet::_styles"(): Value {
      return this.$styles ?? null;
    }

    set "flash.text:StyleSheet::_styles"(v: Value) {
      this.$styles = v;
    }

    /** The fields that use this sheet styled again from their HTML. */
    "flash.text:StyleSheet::_update"(): void {
      const set = users.get(this as unknown as AsObject);
      for (const ref of set ?? []) {
        const field = ref.deref();
        if (!field || field.styleSheet !== (this as unknown as AsObject)) {
          set?.delete(ref);
          continue;
        }

        field.restyle?.();
      }
    }

    /** Each selector's style object, its properties camel-cased strings; null for a sheet Flash rejects. */
    "flash.text:StyleSheet::_parseCSSInternal"(css: Value): Value {
      const parsed = parseCss(s.rt.toString(css));
      if (!parsed) {
        return null;
      }

      const pairs: Value[] = [];
      for (const [selector, properties] of parsed) {
        const style: Value[] = [];
        for (const [name, value] of properties) {
          style.push(camelCase(name), value);
        }

        // Selectors as setStyle keeps them, lower-cased: of KEY and key, the later is kept.
        pairs.push(selector.toLowerCase(), s.rt.newObject(style));
      }

      return s.rt.newObject(pairs);
    }

    "flash.text:StyleSheet::_parseCSSFontFamily"(family: Value): string {
      return fontList(s.rt.toString(family));
    }

    "flash.text:StyleSheet::_parseColor"(color: Value): number {
      return cssColor(s.rt.toString(color));
    }
  }

  avm2.registerNativeClass(natives, "flash.text::StyleSheet", StyleSheetNatives);
  return natives;
}
