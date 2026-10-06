// flash.filters.BlurFilter: its blurs and quality, kept as adl converts them.
import type { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { filterNatives } from "./BitmapFilter.js";

export function blurFilterNatives(s: Scripting): avm2.Natives {
  return filterNatives(s, "blur");
}
