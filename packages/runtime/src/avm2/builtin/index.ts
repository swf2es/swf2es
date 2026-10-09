// builtin's classes whose natives are written against their declarations
// (see bind.ts), each with how it differs from others (see hooks.ts).
// natives/ holds the rest until they are ported.

import type { ClassHook } from "../hooks.js";
import type { Natives } from "../natives/define.js";
import { ArrayBuiltin } from "./Array.js";
import { BooleanBuiltin } from "./Boolean.js";
import type { BuiltinClass } from "./bind.js";
import { ClassBuiltin } from "./Class.js";
import { ErrorBuiltins } from "./Error.js";
import { FunctionBuiltin } from "./Function.js";
import { intBuiltin } from "./int.js";
import { MathBuiltin } from "./Math.js";
import { NamespaceBuiltin } from "./Namespace.js";
import { NumberBuiltin } from "./Number.js";
import { ObjectBuiltin } from "./Object.js";
import { QNameBuiltin } from "./QName.js";
import { StringBuiltin } from "./String.js";
import { uintBuiltin } from "./uint.js";

const classes: BuiltinClass[] = [
  ArrayBuiltin,
  BooleanBuiltin,
  ClassBuiltin,
  ...ErrorBuiltins,
  FunctionBuiltin,
  intBuiltin,
  MathBuiltin,
  NamespaceBuiltin,
  NumberBuiltin,
  ObjectBuiltin,
  QNameBuiltin,
  StringBuiltin,
  uintBuiltin,
];

export const classNatives: Natives = Object.assign({}, ...classes.map((c) => c.natives));

export const classHooks: Record<string, ClassHook> = Object.assign(
  {},
  ...classes.map((c) => c.hooks),
);
