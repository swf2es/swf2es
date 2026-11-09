// The player's 3D cases (cases.ts): perspective, projection, nested
// turns, masks, and Matrix3D.
import { bare, type PlayerCase } from "./common.ts";

/** The SWF with its header's version set to `version`. */
function withVersion(swf: Uint8Array, version: number): Uint8Array {
  swf[3] = version;
  return swf;
}

export const threeDCases: PlayerCase[] = [
  {
    name: "three-d-layer",
    swf: (abc) => bare(abc, 1, "ThreeDLayer", 320, 160),
    script: "ThreeDLayer",
    frames: 1,
    capture: [1],
    // Within 8 a channel: adl's rounding of the alpha and of its bitmap's edges.
    tolerance: 8,
    maxOutliers: 0,
  },
  {
    name: "flip-zero-scale",
    swf: (abc) => bare(abc, 1, "FlipZeroScale", 160, 20),
    script: "FlipZeroScale",
    frames: 1,
    capture: [1],
    // The two boxes it draws as 3D objects, both drawn from a bitmap, smoothed: their edges'
    // levels differ by a little.
    tolerance: 24,
    maxOutliers: 250,
  },
  {
    name: "three-d",
    swf: (abc) => bare(abc, 1, "ThreeD"),
    script: "ThreeD",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  // Drawn in perspective from a bitmap of each 3D object (display/plane.ts). The stages are 500
  // wide: adl draws with the focal length of a stage that wide, whatever the SWF's, where Flash
  // Player draws with its stage's, as its bounds and local3DToGlobal are in both.
  {
    name: "three-d-flip",
    swf: (abc) => bare(abc, 7, "ThreeDFlip", 500, 200),
    script: "ThreeDFlip",
    frames: 7,
    capture: [1, 2, 3, 4, 5, 6, 7],
    tolerance: 40,
    maxOutliers: 500,
  },
  {
    name: "three-d-scene",
    swf: (abc) => bare(abc, 2, "ThreeDScene", 500, 400),
    script: "ThreeDScene",
    frames: 2,
    capture: [1],
    tolerance: 40,
    maxOutliers: 500,
  },
  {
    name: "three-d-nested-turn",
    swf: (abc) => bare(abc, 4, "ThreeDNestedTurn", 500, 300),
    script: "ThreeDNestedTurn",
    frames: 4,
    capture: [1, 4],
    tolerance: 40,
    maxOutliers: 500,
  },
  {
    name: "three-d-behind-hit",
    swf: (abc) => bare(abc, 2, "ThreeDBehindHit", 500, 400),
    script: "ThreeDBehindHit",
    frames: 2,
    capture: [1],
    tolerance: 40,
    maxOutliers: 500,
  },
  {
    name: "three-d-blend-turn",
    swf: (abc) => bare(abc, 3, "ThreeDBlendTurn", 500, 200),
    script: "ThreeDBlendTurn",
    frames: 3,
    capture: [1, 3],
    tolerance: 40,
    maxOutliers: 400,
  },
  {
    name: "three-d-mixed",
    swf: (abc) => bare(abc, 1, "ThreeDMixed", 500, 400),
    script: "ThreeDMixed",
    frames: 1,
    capture: [1],
    tolerance: 40,
    maxOutliers: 400,
  },
  {
    name: "three-d-projection",
    swf: (abc) => bare(abc, 2, "ThreeDProjection", 500, 400),
    script: "ThreeDProjection",
    frames: 2,
    capture: [1],
    tolerance: 40,
    maxOutliers: 200,
  },
  {
    name: "three-d-mask",
    swf: (abc) => bare(abc, 1, "ThreeDMask", 500, 400),
    script: "ThreeDMask",
    frames: 1,
    capture: [1],
    // Flash's mask in a bitmap cuts at whole texels, ours at a quarter of one: an outside
    // mask's edges fall up to a texel apart.
    tolerance: 40,
    maxOutliers: 700,
  },
  {
    name: "three-d-mask-moving",
    swf: (abc) => bare(abc, 4, "ThreeDMaskMoving", 500, 400),
    script: "ThreeDMaskMoving",
    frames: 4,
    capture: [1, 2, 4],
    // As three-d-mask's: an outside mask's edges fall up to a texel apart.
    tolerance: 40,
    maxOutliers: 700,
  },
  {
    name: "three-d-matrix-shared",
    swf: (abc) => bare(abc, 1, "ThreeDMatrixShared", 100, 100),
    script: "ThreeDMatrixShared",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "three-d-matrix-silent",
    swf: (abc) => bare(abc, 3, "ThreeDMatrixSilent", 400, 420),
    script: "ThreeDMatrixSilent",
    frames: 3,
    capture: [1, 3],
    tolerance: 40,
    maxOutliers: 100,
  },
  {
    name: "three-d-mask-handover",
    swf: (abc) => bare(abc, 4, "ThreeDMaskHandover", 420, 420),
    script: "ThreeDMaskHandover",
    frames: 4,
    capture: [1, 2, 3, 4],
    // The turned cards' edges fall a pixel apart, as in three-d-mask.
    tolerance: 40,
    maxOutliers: 2500,
  },
  {
    name: "three-d-filter-blend",
    swf: (abc) => bare(abc, 1, "ThreeDFilterBlend", 500, 400),
    script: "ThreeDFilterBlend",
    frames: 1,
    capture: [1],
    tolerance: 24,
    maxOutliers: 100,
  },
  {
    name: "three-d-matrix",
    swf: (abc) => bare(abc, 1, "ThreeDMatrix", 500, 400),
    script: "ThreeDMatrix",
    frames: 1,
    capture: [1],
    tolerance: 24,
    maxOutliers: 50,
  },
  {
    name: "three-d-bounds",
    swf: (abc) => bare(abc, 3, "ThreeDBounds", 500, 400),
    script: "ThreeDBounds",
    frames: 3,
    capture: [2],
    // The edges of the cards under turned parents fall a pixel apart.
    tolerance: 40,
    maxOutliers: 700,
  },
  {
    name: "point-at",
    swf: (abc) => bare(abc, 1, "PointAt"),
    script: "PointAt",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "matrix3d-swf12",
    swf: (abc) => withVersion(bare(abc, 1, "Matrix3DVersions"), 12),
    script: "Matrix3DVersions",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "matrix3d-swf13",
    swf: (abc) => withVersion(bare(abc, 1, "Matrix3DVersions"), 13),
    script: "Matrix3DVersions",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
];
