// builtin's classes whose natives are written against their declarations
// (see bind.ts), each with how it differs from others (see hooks.ts).
// natives/ holds the rest until they are ported.

import type { ClassHook } from "../hooks.js";
import type { Natives } from "../natives/define.js";
import { ArrayBuiltin } from "./Array.js";
import { BooleanBuiltin } from "./Boolean.js";
import type { BuiltinClass } from "./bind.js";
import { ClassBuiltin } from "./Class.js";
import { DateBuiltin } from "./Date.js";
import { ErrorBuiltins } from "./Error.js";
import { FunctionBuiltin } from "./Function.js";
import { ByteArrayBuiltin } from "./flash/utils/ByteArray.js";
import { DictionaryBuiltin } from "./flash/utils/Dictionary.js";
import { ProxyBuiltin } from "./flash/utils/Proxy.js";
import { intBuiltin } from "./int.js";
import { MathBuiltin } from "./Math.js";
import { NamespaceBuiltin } from "./Namespace.js";
import { NumberBuiltin } from "./Number.js";
import { ObjectBuiltin } from "./Object.js";
import { QNameBuiltin } from "./QName.js";
import { RegExpBuiltin } from "./RegExp.js";
import { StringBuiltin } from "./String.js";
import { uintBuiltin } from "./uint.js";
import { XMLBuiltin } from "./XML.js";
import { XMLListBuiltin } from "./XMLList.js";

const classes: BuiltinClass[] = [
  ArrayBuiltin,
  BooleanBuiltin,
  ByteArrayBuiltin,
  ClassBuiltin,
  DateBuiltin,
  DictionaryBuiltin,
  ...ErrorBuiltins,
  FunctionBuiltin,
  intBuiltin,
  MathBuiltin,
  NamespaceBuiltin,
  NumberBuiltin,
  ObjectBuiltin,
  ProxyBuiltin,
  QNameBuiltin,
  RegExpBuiltin,
  StringBuiltin,
  uintBuiltin,
  XMLBuiltin,
  XMLListBuiltin,
];

export const classNatives: Natives = Object.assign({}, ...classes.map((c) => c.natives));

export const classHooks: Record<string, ClassHook> = Object.assign(
  {},
  ...classes.map((c) => c.hooks),
);
