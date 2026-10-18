// PrintJob's AS2 face, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/globals/print_job.rs has it: MIT OR Apache-2.0, Copyright
// (c) 2018-2022 Ruffle LLC and Ruffle contributors. Nothing prints: start
// gives false, as Flash does where the user cancels the print dialog, so
// addPage gives false and send does nothing.
import { avm1 } from "@swf2es/runtime";

const FIXED = avm1.DONT_ENUM | avm1.DONT_DELETE;

/** The page's and paper's measures, which a job reads once started: 0 before. */
const MEASURES = ["paperHeight", "paperWidth", "pageHeight", "pageWidth", "orientation"];

/** `PrintJob`. */
export function printJobClass(realm: avm1.Realm): avm1.Avm1Object {
  // Flash's prototype has its constructor before its __proto__, which SWF 7
  // on sees: up to 6 it inherits nothing, not even toString (adl).
  const proto = new avm1.Avm1Object();
  const jobs = new WeakSet<avm1.Avm1Object>();
  let measured = false;
  const constr = realm.classOf(
    proto,
    (self) => {
      jobs.add(self);
      // The first job made adds the measures to the prototype, over what a
      // script set there, in its place; later jobs add none again, not even
      // one deleted. Read of anything but a job, they are undefined (adl).
      if (!measured) {
        measured = true;
        for (const name of MEASURES) {
          const p = proto.define(name, undefined, 0);
          p.get = realm.method((job) => (jobs.has(job as avm1.Avm1Object) ? 0 : undefined));
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
