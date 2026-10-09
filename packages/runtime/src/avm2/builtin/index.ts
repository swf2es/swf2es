// builtin's classes whose natives are written against their declarations
// (see bind.ts), and how those classes differ from others (see hooks.ts).
// natives/ holds the rest until they are ported.

import type { ClassHook } from "../hooks.js";
import type { Natives } from "../natives/define.js";
import { arrayHooks, arrayNatives } from "./Array.js";
import { booleanNatives } from "./Boolean.js";
import { errorHooks, errorNatives } from "./Error.js";
import { intNatives } from "./int.js";
import { mathNatives } from "./Math.js";
import { numberHooks, numberNatives } from "./Number.js";
import { stringHooks, stringNatives } from "./String.js";
import { uintNatives } from "./uint.js";

const classes: Natives[] = [
  arrayNatives,
  booleanNatives,
  errorNatives,
  intNatives,
  mathNatives,
  numberNatives,
  stringNatives,
  uintNatives,
];

export const classNatives: Natives = Object.assign({}, ...classes);

export const classHooks: Record<string, ClassHook> = {
  ...arrayHooks,
  ...errorHooks,
  ...numberHooks,
  ...stringHooks,
};
