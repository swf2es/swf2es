// flash.filters.BevelFilter: a highlight and a shadow at a distance and
// angle, kept as adl converts them.
import type { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { filterNatives } from "./BitmapFilter.js";

export function bevelFilterNatives(s: Scripting): avm2.Natives {
  return filterNatives(s, "bevel");
}
