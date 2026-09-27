/**
 * Language runtime that generated code calls into. Only AS2/AS3 semantics
 * live here; playerglobal belongs to @swf2es/player, so this package runs in
 * node next to avmshell for conformance tests.
 */
export * as avm2 from "./avm2/index.js";
export * as avm1 from "./avm1/index.js";
