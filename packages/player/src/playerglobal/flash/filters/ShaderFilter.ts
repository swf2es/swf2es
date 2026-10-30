// flash.filters.ShaderFilter: its Shader, which must hold a kernel, and how
// far it grows the filtered bitmap each way, whole and never negative, as
// adl keeps them. Flash Player's playerglobal reads and sets the
// extensions through a private rectangle, `_extendBy`, whose left, top,
// right and bottom they are; both ways reach the same record.
import type { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { kernelOfShader } from "../display/shaders.js";
import { filterNatives, type Prop } from "./BitmapFilter.js";

type Value = avm2.Value;
type AsObject = avm2.AsObject;

export function shaderFilterNatives(s: Scripting): avm2.Natives {
  const extension = (v: Value): number => {
    const n = s.rt.toInt(v);
    if (n < 0) {
      throw s.rt.error("RangeError", 2006);
    }

    return n;
  };
  const side = (k: number): Prop => [
    (f) => f.extensions[k],
    (f, v) => {
      f.extensions[k] = extension(v);
    },
  ];
  return filterNatives(s, "shader", () => ({
    shader: [
      (f) => (f.shader as Value) ?? null,
      (f, v) => {
        if (v === null || v === undefined) {
          throw s.rt.error("TypeError", 2007, "shader");
        }

        if (!kernelOfShader(v)) {
          throw s.rt.error("ArgumentError", 2171);
        }

        f.shader = v as object;
      },
    ],
    leftExtension: side(0),
    topExtension: side(1),
    rightExtension: side(2),
    bottomExtension: side(3),
    "flash.filters:ShaderFilter::_extendBy": [
      (f) => {
        const [left, top, right, bottom] = f.extensions;
        return s.rt.construct(
          s.rt.classNamed("flash.geom::Rectangle"),
          left,
          top,
          right - left,
          bottom - top,
        );
      },
      (f, v) => {
        if (v === null || v === undefined) {
          throw s.rt.error("TypeError", 2007, "extendBy");
        }

        const read = (k: string) => s.rt.getProperty(v as AsObject, s.rt.publicName(k));
        f.extensions = [
          extension(read("left")),
          extension(read("top")),
          extension(read("right")),
          extension(read("bottom")),
        ];
      },
    ],
  }));
}
