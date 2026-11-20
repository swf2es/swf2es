// AVM1's flash.text.TextRenderer, as adl has it: its settings are kept and
// read back, though swf2es draws text the same whatever they are. Neither
// called nor constructed does it give an object. Flash keeps the settings
// for the whole player; here each movie has its own.
import { avm1 } from "@swf2es/runtime";

/** `flash.text`, with its TextRenderer. */
export function textPackage(realm: avm1.Realm): avm1.Avm1Object {
  const text = new avm1.Avm1Object(realm.objectProto);
  const proto = new avm1.Avm1Object(realm.objectProto);
  const renderer = realm.classOf(
    proto,
    () => undefined,
    () => undefined,
  );

  // A string other than "lcd" sets "crt", which adl reads back for
  // "default" too; anything else leaves it.
  let displayMode = "crt";
  const mode = renderer.add("displayMode", undefined, 0);
  mode.get = realm.method(() => displayMode);
  mode.set = realm.method((_, args) => {
    if (typeof args[0] === "string") {
      displayMode = args[0] === "lcd" ? "lcd" : "crt";
    }

    return undefined;
  });

  // The anti-aliasing tables' quality levels, 3, 4 or 7, as an integer:
  // 3.5 and "3" set 3, any other level leaves it.
  let maxLevel = 4;
  const level = renderer.add("maxLevel", undefined, 0);
  level.get = realm.method(() => maxLevel);
  level.set = realm.method((_, args, version) => {
    const value = avm1.toNumber(args[0], version) | 0;
    if (value === 3 || value === 4 || value === 7) {
      maxLevel = value;
    }

    return undefined;
  });

  renderer.define(
    "setAdvancedAntialiasingTable",
    realm.method(() => undefined),
    0,
  );
  text.define("TextRenderer", renderer, 0);
  return text;
}
