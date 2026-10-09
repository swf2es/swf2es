// The classes of static natives only, which cannot be instantiated, that
// are not ported to builtin/ yet.

import type { ClassHook } from "../hooks.js";

/** A class of static natives only, which cannot be instantiated: construct="none" in its declaration. */
const notInstantiated = (name: string): ClassHook => ({
  construct: (rt) => {
    throw rt.error("ArgumentError", 2012, name);
  },
});

export const objectHooks: Record<string, ClassHook> = {
  JSON: notInstantiated("JSON"),
  "flash.net::ObjectEncoding": notInstantiated("ObjectEncoding"),
  "avmplus::System": notInstantiated("System"),
  "avmplus::File": notInstantiated("File"),
};
