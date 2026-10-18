// PrintJob's AS2 face, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/globals/print_job.rs has it: MIT OR Apache-2.0, Copyright
// (c) 2018-2022 Ruffle LLC and Ruffle contributors. Nothing prints: start
// gives false, as Flash does where the user cancels the print dialog, and so
// a job never has pages to add or send.
import { avm1 } from "@swf2es/runtime";

const FIXED = avm1.DONT_ENUM | avm1.DONT_DELETE;

/** The page's and paper's measures, which a job reads once started: 0 before. */
const MEASURES = ["paperHeight", "paperWidth", "pageHeight", "pageWidth", "orientation"];

/** `PrintJob`. */
export function printJobClass(realm: avm1.Realm): avm1.Avm1Object {
  // Flash's prototype has its constructor before its __proto__, which SWF 7
  // on sees: up to 6 it inherits nothing, not even toString (adl).
  const proto = new avm1.Avm1Object();
  const constr = realm.classOf(
    proto,
    (self) => {
      // Flash adds the measures to the prototype as the first job is made.
      for (const name of MEASURES) {
        if (proto.exact(name) === undefined) {
          const p = proto.add(name, undefined, avm1.DONT_DELETE);
          p.get = realm.method(() => 0);
          p.set = realm.method(() => undefined);
        }
      }

      return self;
    },
    () => undefined,
  );
  proto.define("__proto__", realm.objectProto, FIXED | avm1.VERSION_7);
  proto.define(
    "start",
    realm.method(() => false),
    FIXED | avm1.VERSION_7,
  );
  proto.define(
    "addPage",
    realm.method(() => false),
    FIXED | avm1.VERSION_7,
  );
  proto.define(
    "send",
    realm.method(() => undefined),
    FIXED | avm1.VERSION_7,
  );
  return constr;
}
