// Button's AS2 face as far as the frame needs it, a button's prototype, as
// Ruffle's (https://github.com/ruffle-rs/ruffle) core/src/avm1/globals/
// button.rs has it: MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC
// and Ruffle contributors. Its events and the rest of its properties come
// with the pointer (docs/avm1.md, step 12).
import { avm1 } from "@swf2es/runtime";
import { ButtonObject } from "../../display/display.js";
import { filtersProperty } from "./filters.js";
import { blendModeProperty, DEPTH_BIAS, type Movie } from "./MovieClip.js";

/** Button: its constructor and its prototype, as `_global.Button`. */
export function buttonClass(movie: Movie): {
  constr: avm1.Avm1Function;
  proto: avm1.Avm1Object;
} {
  const realm = movie.realm;
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self) => self,
    () => undefined,
  );
  proto.define("useHandCursor", true, 0);
  proto.define("enabled", true, 0);
  proto.define(
    "getDepth",
    realm.method((self) => {
      const d = self instanceof avm1.Avm1Object ? self.display?.target : undefined;
      const depth = (d as { depth?: number | null } | undefined)?.depth;
      return depth === undefined || depth === null ? undefined : depth - DEPTH_BIAS;
    }),
    avm1.VERSION_6,
  );
  const buttonOf = (self: avm1.Avm1Object) => {
    const d = self.display?.live()?.display?.target;
    return d instanceof ButtonObject ? d : null;
  };
  // Read-only as Ruffle declares them, which their setters still take; listed (adl).
  filtersProperty(realm, proto, avm1.READ_ONLY | avm1.VERSION_8, buttonOf, () => movie.filterFaces);
  blendModeProperty(realm, proto, avm1.READ_ONLY | avm1.VERSION_8, buttonOf);
  return { constr, proto };
}
