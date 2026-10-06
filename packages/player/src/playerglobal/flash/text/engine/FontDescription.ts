import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../../scripting.js";
import { deviceMetrics } from "../../../../text/fonts.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;
type StringProperty =
  | "fontName"
  | "fontWeight"
  | "fontPosture"
  | "fontLookup"
  | "renderingMode"
  | "cffHinting";

interface FontDescriptionData {
  fontName: string;
  fontWeight: string;
  fontPosture: string;
  fontLookup: string;
  renderingMode: string;
  cffHinting: string;
  locked: boolean;
}

const accepted: Partial<Record<StringProperty, readonly string[]>> = {
  fontWeight: ["normal", "bold"],
  fontPosture: ["normal", "italic"],
  fontLookup: ["device", "embeddedCFF"],
  renderingMode: ["normal", "cff"],
  cffHinting: ["none", "horizontalStem"],
};

function data(o: AsObject): FontDescriptionData {
  if (!o.$fontDescription) {
    o.$fontDescription = {
      fontName: "_serif",
      fontWeight: "normal",
      fontPosture: "normal",
      fontLookup: "device",
      renderingMode: "cff",
      cffHinting: "horizontalStem",
      locked: false,
    };
  }

  return o.$fontDescription;
}

export function fontDescriptionNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  const checked = (value: Value, name: StringProperty): string => {
    if (value === null || value === undefined) {
      throw s.rt.error("TypeError", 2007, name);
    }

    const string = s.rt.toString(value);
    if (accepted[name] && !accepted[name].includes(string)) {
      throw s.rt.error("ArgumentError", 2008, name);
    }

    return string;
  };

  const set = (o: AsObject, name: StringProperty, value: Value): void => {
    const state = data(o);
    if (state.locked) {
      throw s.rt.error("Error", 2185);
    }

    state[name] = checked(value, name);
  };

  const compatible = (name: Value, weight: Value, posture: Value, device: boolean): boolean => {
    if (!device && (name === null || name === undefined)) {
      return false;
    }

    const fontName = checked(name, "fontName");
    const fontWeight = checked(weight, "fontWeight");
    const fontPosture = checked(posture, "fontPosture");
    const bold = fontWeight === "bold";
    const italic = fontPosture === "italic";

    if (!device) {
      const fonts = [
        ...(s.codeLibrary()?.characters.values() ?? []),
        ...s.registeredFonts.values(),
      ];
      return fonts.some(
        (font) =>
          font.type === "fontCff" &&
          font.name.toLowerCase() === fontName.toLowerCase() &&
          font.bold === bold &&
          font.italic === italic,
      );
    }

    if (["_sans", "_serif", "_typewriter"].includes(fontName.toLowerCase())) {
      return false;
    }

    // A missing face resolves to the same fallback metrics on every sample.
    const font = deviceMetrics(fontName, 48, bold, italic);
    const sample = ["M", "W", "i", "1", "@"];
    if (s.platform.os === "Linux") {
      const substitutes: Record<string, string> = {
        arial: "Liberation Sans",
        "times new roman": "Liberation Serif",
        "courier new": "Liberation Mono",
      };
      const substitute = substitutes[fontName.toLowerCase()];
      if (substitute) {
        const mapped = deviceMetrics(substitute, 48, bold, italic);
        if (sample.every((char) => font.advance(char) === mapped.advance(char))) {
          return false;
        }
      }
    }

    const fallback = deviceMetrics("__swf2es_missing_font__", 48, bold, italic);
    return sample.some((char) => font.advance(char) !== fallback.advance(char));
  };

  class FontDescriptionNatives {
    get fontName(): string {
      return data(this as AsObject).fontName;
    }

    set fontName(value: Value) {
      set(this as AsObject, "fontName", value);
    }

    get fontWeight(): string {
      return data(this as AsObject).fontWeight;
    }

    set fontWeight(value: Value) {
      set(this as AsObject, "fontWeight", value);
    }

    get fontPosture(): string {
      return data(this as AsObject).fontPosture;
    }

    set fontPosture(value: Value) {
      set(this as AsObject, "fontPosture", value);
    }

    get fontLookup(): string {
      return data(this as AsObject).fontLookup;
    }

    set fontLookup(value: Value) {
      set(this as AsObject, "fontLookup", value);
    }

    get renderingMode(): string {
      return data(this as AsObject).renderingMode;
    }

    set renderingMode(value: Value) {
      set(this as AsObject, "renderingMode", value);
    }

    get cffHinting(): string {
      return data(this as AsObject).cffHinting;
    }

    set cffHinting(value: Value) {
      set(this as AsObject, "cffHinting", value);
    }

    get locked(): boolean {
      return data(this as AsObject).locked;
    }

    set locked(value: Value) {
      const state = data(this as AsObject);
      if (state.locked) {
        throw s.rt.error("Error", 2185);
      }

      state.locked = !!value;
    }

    static isFontCompatible(name: Value, weight: Value, posture: Value): boolean {
      return compatible(name, weight, posture, false);
    }

    static isDeviceFontCompatible(name: Value, weight: Value, posture: Value): boolean {
      return compatible(name, weight, posture, true);
    }
  }

  avm2.registerNativeClass(natives, "flash.text.engine::FontDescription", FontDescriptionNatives);
  return natives;
}
