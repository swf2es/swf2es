import type { SharedFrames } from "./scene/frames.ts";
import type { SharedLibrary } from "./scene/libraries.ts";

export type SceneRequest =
  | { type: "init"; id: number; frames: SharedFrames }
  | { type: "step"; id: number; frame: number }
  | { type: "overwrite"; id: number };

export type SceneResponse =
  | { type: "libraries"; libraries: { id: number; asset: SharedLibrary }[] }
  | { type: "done"; id: number; sequence: number | null }
  | { type: "error"; id: number; error: string };
