// flash.filters.DropShadowFilter: a glow at a distance and angle, kept as
// adl converts them.
import type { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { filterNatives } from "./BitmapFilter.js";

export function dropShadowFilterNatives(s: Scripting): avm2.Natives {
  return filterNatives(s, "dropShadow");
}
