// The builtins' native methods, in TypeScript, bound by the names the
// compiler gives them: "Class.name" for a static method, "Class#name" for an
// instance method, the name alone for a script's function, with "get:" and
// "set:" for accessors and "uri::name" outside the public namespace. And how
// the builtin classes differ from others: how their instances hold native
// state, and what calling or constructing them does.

import { objectStreamNatives } from "../builtin/flash/utils/ByteArray.js";
import { classHooks, classNatives } from "../builtin/index.js";
import { xmlNatives } from "../builtin/xml/xml.js";
import type { ClassHook } from "../hooks.js";
import type { Runtime } from "../runtime.js";
import { aliasesNatives } from "./aliases.js";
import { concurrentNatives } from "./concurrent.js";
import type { Natives } from "./define.js";
import { describeNatives } from "./describe.js";
import { jsonNatives } from "./json.js";
import { objectHooks } from "./object.js";
import { shellHooks, shellNatives } from "./shell.js";
import { toplevelNatives } from "./toplevel.js";
import { vectorHooks, vectorNatives } from "./vector.js";

/** The builtins' natives for `rt`: most are the same for every runtime; a class of natives closes over it. */
export function builtinNatives(rt: Runtime): Natives {
  return {
    ...classNatives,
    ...toplevelNatives,
    ...describeNatives,
    ...aliasesNatives,
    ...shellNatives(rt),
    ...vectorNatives,
    ...objectStreamNatives(rt),
    ...concurrentNatives(rt),
    ...jsonNatives(),
    ...xmlNatives,
  };
}

export function builtinHooks(): Record<string, ClassHook> {
  return {
    ...classHooks,
    ...objectHooks,
    ...vectorHooks,
    ...shellHooks,
  };
}
