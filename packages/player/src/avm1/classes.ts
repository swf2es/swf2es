// Object.registerClass's classes: the constructor a symbol's clips are
// constructed as, bound by the symbol's export name for every SWF, and
// the name each was registered by, which SharedObject types objects by.
import { avm1 } from "@swf2es/runtime";
import { type DisplayObject, MovieClip } from "../display/display.js";
import type { Avm1 } from "./avm1.js";

type Value = avm1.Value;

/** A symbol name as registerClass keys it, by a SWF of `version`: in its case from SWF 7. */
function classKey(name: string, version: number): string {
  return version > 6 ? name : avm1.fold(name);
}

/** The classes Object.registerClass bound, by symbol name. */
export class RegisteredClasses {
  /**
   * Object.registerClass's classes, by symbol name, one for every SWF:
   * named in its case from SWF 7, folded up to SWF 6, by the code that
   * registers and by the SWF of the clip it is looked up for (the
   * corpus's register_class).
   */
  private readonly registered = new Map<string, avm1.Avm1Function>();
  /**
   * The name each key was last registered by, in the case it was given,
   * which AMF0 writes, and when: a constructor of two names is the later's.
   */
  private readonly spelled = new Map<string, { name: string; at: number }>();
  private registrations = 0;

  constructor(private readonly movie: Avm1) {}

  /**
   * The class Object.registerClass bound to `d`'s character's export name
   * in its SWF, null for none.
   */
  classOf(d: DisplayObject): avm1.Avm1Function | null {
    // A sprite's only: a button's symbol stays a Button (the corpus's register_class).
    const id = d instanceof MovieClip ? d.character?.id : undefined;
    const swf = this.movie.swfOf(d);
    const name = id === undefined ? undefined : swf.exportNames.get(id);
    return name === undefined ? null : (this.registered.get(classKey(name, swf.version)) ?? null);
  }

  /** The name Object.registerClass gave `constr`, as SharedObject's AMF0 types an object; null for none. */
  registeredName(constr: Value): string | null {
    if (!(constr instanceof avm1.Avm1Function)) {
      return null;
    }

    let found: { name: string; at: number } | null = null;
    for (const [key, registered] of this.registered) {
      const spelled = this.spelled.get(key) ?? { name: key, at: -1 };
      if (registered === constr && (found === null || spelled.at > found.at)) {
        found = spelled;
      }
    }

    return found?.name ?? null;
  }

  /** Object.registerClass(name, constructor): true where it binds or unbinds (null) the name. */
  registerClass(args: Value[], version: number): Value {
    if (args.length < 2) {
      return false;
    }

    const constr = args[1];
    if (constr !== undefined && constr !== null && !(constr instanceof avm1.Avm1Function)) {
      return false;
    }

    const name = avm1.stringOf(args[0], version);
    const key = classKey(name, version);
    if (constr instanceof avm1.Avm1Function) {
      this.registered.set(key, constr);
      this.spelled.set(key, { name, at: this.registrations++ });
    } else {
      this.registered.delete(key);
      this.spelled.delete(key);
    }

    return true;
  }
}
