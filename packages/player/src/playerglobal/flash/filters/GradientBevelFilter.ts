// flash.filters.GradientBevelFilter: a bevel through a gradient's stops.
import type { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { filterNatives } from "./BitmapFilter.js";

export function gradientBevelFilterNatives(s: Scripting): avm2.Natives {
  return filterNatives(s, "gradientBevel", ({ gradientProps }) => gradientProps());
}
