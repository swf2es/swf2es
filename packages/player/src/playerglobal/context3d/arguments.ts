// What Context3D's natives check of their arguments that needs no context: AIR's errors for
// a value it refuses.

import {
  FRAGMENT_CONSTANTS,
  type ProgramType,
  profileLimits,
  TEXTURE_FORMATS,
  type TextureFormat,
  VERTEX_CONSTANTS,
} from "@swf2es/context3d";
import type { Scripting } from "../../scripting.js";

import type { ContextState } from "./lifecycle.js";

/**
 * A maxBackBufferWidth or maxBackBufferHeight set: AIR takes it between the back buffer's
 * size (at least 32), in stage pixels even where it is drawn at the screen's, and the GPU's
 * limit.
 */
export function most(value: number, size: number, limit: number): number {
  return Math.min(limit, Math.max(32, size, value | 0));
}

/** The checks, throwing AIR's errors in `s`'s runtime. */
export function argumentChecks(s: Scripting) {
  /** Whether a buffer's usage is dynamicDraw: only it and staticDraw are, by their case. */
  const dynamicUsage = (usage: string | null): boolean => {
    switch (usage) {
      case "staticDraw":
        return false;
      case "dynamicDraw":
        return true;
      case null:
        throw s.rt.error("TypeError", 2007, "bufferUsage");
      default:
        throw s.rt.error("ArgumentError", 2008, "bufferUsage");
    }
  };
  /** AIR 51 refuses a negative streamingLevels (#2004) and one past the smallest level (#3711). */
  const streamingLevels = (levels: number, side: number): void => {
    if (levels < 0) {
      throw s.rt.error("Error", 2004);
    }
    // A side that is no power of two, which the backend refuses, has no levels to compare.
    if (side > 0 && levels > Math.floor(Math.log2(side))) {
      throw s.rt.error("ArgumentError", 3711);
    }
  };
  /**
   * The constant registers a setter writes: `count` from `first`. Every profile takes 250
   * vertex and 200 fragment registers, whatever its AGAL reads, and refuses a run that starts
   * or ends past them (#2006), a matrix's four too (Profiles.as).
   */
  const within = (stage: ProgramType, first: number, count: number): number => {
    if (
      first < 0 ||
      first + Math.max(count, 0) > (stage === "vertex" ? VERTEX_CONSTANTS : FRAGMENT_CONSTANTS)
    ) {
      throw s.rt.error("RangeError", 2006);
    }

    return count;
  };
  /** A program type, which AIR names programType when it refuses one. */
  const programType = (type: string | null): ProgramType => {
    switch (type) {
      case "vertex":
      case "fragment":
        return type;
      case null:
        throw s.rt.error("TypeError", 2007, "programType");
      default:
        throw s.rt.error("ArgumentError", 2008, "programType");
    }
  };

  /** A texture's format: one Flash names (#2008), and in rgbaHalfFloat's case one its profile has (#3759). */
  const textureFormat = (entry: ContextState, format: string | null): TextureFormat => {
    if (format === null) {
      throw s.rt.error("TypeError", 2007, "format");
    }
    if (!TEXTURE_FORMATS.includes(format as TextureFormat)) {
      throw s.rt.error("ArgumentError", 2008, "format");
    }
    if (format === "rgbaHalfFloat" && !profileLimits(entry.profile).halfFloat) {
      throw s.rt.error("ArgumentError", 3759);
    }

    return format as TextureFormat;
  };

  return { dynamicUsage, streamingLevels, within, programType, textureFormat };
}
