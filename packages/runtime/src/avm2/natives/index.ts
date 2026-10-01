// The builtins' native methods, in TypeScript, bound by the names the
// compiler gives them: "Class.name" for a static method, "Class#name" for an
// instance method, the name alone for a script's function, with "get:" and
// "set:" for accessors and "uri::name" outside the public namespace. And how
// the builtin classes differ from others: how their instances hold native
// state, and what calling or constructing them does.

import type { ClassHook, Runtime } from "../runtime.js";
import { aliasesNatives } from "./aliases.js";
import { arrayHooks, arrayNatives } from "./array.js";
import { byteArrayHook, byteArrayNatives, domainNatives } from "./bytearray.js";
import { dateHook, dateNatives } from "./date.js";
import type { Natives } from "./define.js";
import { describeNatives } from "./describe.js";
import { dictionaryNatives } from "./dictionary.js";
import { jsonNatives } from "./json.js";
import { numberHooks, numberNatives } from "./number.js";
import { objectHooks, objectNatives } from "./object.js";
import { proxyHooks, proxyNatives } from "./proxy.js";
import { regexpHooks, regexpNatives } from "./regexp.js";
import { shellNatives } from "./shell.js";
import { stringHooks, stringNatives } from "./string.js";
import { errorHooks, toplevelNatives } from "./toplevel.js";
import { vectorHooks, vectorNatives } from "./vector.js";
import { xmlHooks, xmlNatives } from "./xml/xml.js";

/** The builtins' natives for `rt`: most are the same for every runtime; a class of natives closes over it. */
export function builtinNatives(rt: Runtime): Natives {
  return {
    ...objectNatives,
    ...arrayNatives,
    ...stringNatives,
    ...regexpNatives(rt),
    ...numberNatives,
    ...toplevelNatives,
    ...describeNatives,
    ...proxyNatives,
    ...aliasesNatives,
    ...shellNatives(rt),
    ...dictionaryNatives,
    ...vectorNatives,
    ...byteArrayNatives(rt),
    ...domainNatives(rt),
    ...dateNatives(),
    ...jsonNatives(),
    ...xmlNatives,
  };
}

export function builtinHooks(): Record<string, ClassHook> {
  return {
    ...objectHooks,
    ...numberHooks,
    ...stringHooks,
    ...arrayHooks,
    ...regexpHooks,
    "flash.utils::ByteArray": byteArrayHook,
    Date: dateHook,
    ...vectorHooks,
    ...xmlHooks,
    ...proxyHooks,
    ...errorHooks,
  };
}
