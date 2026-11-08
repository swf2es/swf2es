// The ABCs a SWF's ActionScript 3 links against, in the order
// Scripting.loadLibraries takes them: avmplus' builtin, swf2es's
// playerglobal, and AIR's library after them for an AIR application. Also
// @swf2es/player/libraries, for a host that compiles ahead of time, as the
// command does, without loading the player.
import { avm2 } from "@swf2es/runtime";

export { airLibrary } from "./air-library.js";
export { playerglobalLibrary } from "./playerglobal-library.js";

/** avmplus' builtin.abc (MPL-2.0), @swf2es/runtime's. */
export const builtinLibrary: Uint8Array = avm2.builtinLibrary;
