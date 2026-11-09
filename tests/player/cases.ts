// The player's test cases: SWFs built here, played for a few frames, whose
// frames must look as Flash drew them. Flash's frames are in references/,
// made by run.ts --update with the Flash oracle. Each area's cases are in
// cases/, what they share in cases/common.ts.

import { avm1Cases } from "./cases/avm1.ts";
import { bitmapCases } from "./cases/bitmaps.ts";
import { blendCases } from "./cases/blends.ts";
import type { PlayerCase } from "./cases/common.ts";
import { filterCases } from "./cases/filters.ts";
import { mediaCases } from "./cases/media.ts";
import { scriptingCases } from "./cases/scripting.ts";
import { shaderCases } from "./cases/shaders.ts";
import { shapeCases } from "./cases/shapes.ts";
import { textCases } from "./cases/text.ts";
import { threeDCases } from "./cases/three-d.ts";
import { timelineCases } from "./cases/timeline.ts";

export {
  bare,
  boundClip,
  innerSwf,
  type PlayerCase,
  probeFont,
  scripted,
  stemFont,
  toneScript,
} from "./cases/common.ts";

export const cases: PlayerCase[] = [
  ...scriptingCases,
  ...shapeCases,
  ...textCases,
  ...bitmapCases,
  ...filterCases,
  ...timelineCases,
  ...mediaCases,
  ...avm1Cases,
  ...blendCases,
  ...threeDCases,
  ...shaderCases,
];
