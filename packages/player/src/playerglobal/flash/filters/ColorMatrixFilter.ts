// flash.filters.ColorMatrixFilter: its matrix, 20 floats.
import type { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { filterNatives } from "./BitmapFilter.js";

export function colorMatrixFilterNatives(s: Scripting): avm2.Natives {
  return filterNatives(s, "colorMatrix", ({ elements, floats }) => ({
    matrix: [
      (f) => s.rt.array([...f.matrix]),
      (f, v) => {
        f.matrix = floats(elements(v, "matrix"), 20);
      },
    ],
  }));
}
