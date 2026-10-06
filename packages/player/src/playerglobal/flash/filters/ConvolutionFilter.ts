// flash.filters.ConvolutionFilter: its matrix and size, as floats and
// whole numbers, and the rest of its values as adl converts them.
import type { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { filterNatives } from "./BitmapFilter.js";

export function convolutionFilterNatives(s: Scripting): avm2.Natives {
  return filterNatives(s, "convolution", ({ elements, floats, matrixSize }) => ({
    matrix: [
      (f) => s.rt.array([...f.matrix]),
      (f, v) => {
        f.matrix = floats(elements(v, "matrix"), f.matrixX * f.matrixY);
      },
    ],
    // Resized, the flat values stay in order, as many as fit, the rest 0.
    matrixX: [
      (f) => f.matrixX,
      (f, v) => {
        f.matrixX = matrixSize(v);
        f.matrix = floats(f.matrix, f.matrixX * f.matrixY);
      },
    ],
    matrixY: [
      (f) => f.matrixY,
      (f, v) => {
        f.matrixY = matrixSize(v);
        f.matrix = floats(f.matrix, f.matrixX * f.matrixY);
      },
    ],
  }));
}
