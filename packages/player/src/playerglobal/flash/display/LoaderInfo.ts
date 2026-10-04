// flash.display.LoaderInfo: what is known of a SWF, the main one's or a
// Loader's; Scripting.loaderInfo makes one and keeps its facts on it.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

interface SwfFacts {
  version: number;
  frameRate: number;
  width: number;
  height: number;
  as3: boolean;
}

/** A LoaderInfo's facts about its SWF, which Flash refuses to tell before the SWF is loaded: Error #2099. */
function factsOf(s: Scripting, info: { $swf: SwfFacts | null }): SwfFacts {
  if (!info.$swf) {
    throw s.rt.error("Error", 2099);
  }

  return info.$swf;
}

/** The UncaughtErrorEvents of `owner`, a Loader or the main SWF's LoaderInfo, made when first asked for. */
export function uncaughtErrorEvents(s: Scripting, owner: AsObject): AsObject {
  if (!owner.$uncaught) {
    owner.$uncaught = s.rt.construct(s.rt.classNamed("flash.events::UncaughtErrorEvents"));
  }

  return owner.$uncaught;
}

export function loaderInfoNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class LoaderInfoNatives {
    declare $loader: AsObject | null;
    declare $content: AsObject | null;
    declare $bytes: Uint8Array | null;
    declare $swf: SwfFacts | null;
    declare $url: string | null;
    /** What `parameters` tells (Scripting.loaderInfo): its LoaderContext's, its URL's query, or the main SWF's flashvars. */
    declare $params: ReadonlyMap<string, string>;
    /** The application domain its content loads into, as its load chose it; unset for the main SWF's. */
    declare $domain: avm2.Domain | undefined;
    /** The URL the content gets when it is placed, for a load from bytes. */
    declare $dynamic: string | undefined;
    /** The URL of the SWF the Loader belongs to, even before its first load. */
    declare $loaderURL: string | null;
    declare $loaded: number;
    declare $total: number;
    declare $shared: AsObject | undefined;
    declare $uncaught: AsObject | undefined;

    get loader(): Value {
      return this.$loader;
    }

    get content(): Value {
      return this.$content;
    }

    get url(): Value {
      return this.$url;
    }

    get loaderURL(): Value {
      return this.$loaderURL;
    }

    get isURLInaccessible(): boolean {
      return false;
    }

    get bytesLoaded(): number {
      return this.$loaded;
    }

    get bytesTotal(): number {
      return this.$total;
    }

    // The domain its load chose (Scripting.loadDomain), or the main SWF's.
    get applicationDomain(): Value {
      factsOf(s, this);
      return s.applicationDomainOf(this.$domain ?? s.mainDomain);
    }

    get swfVersion(): number {
      return factsOf(s, this).version;
    }

    get actionScriptVersion(): number {
      return factsOf(s, this).as3 ? 3 : 2;
    }

    get frameRate(): number {
      return factsOf(s, this).frameRate;
    }

    get width(): number {
      return factsOf(s, this).width;
    }

    get height(): number {
      return factsOf(s, this).height;
    }

    get contentType(): Value {
      return this.$swf ? "application/x-shockwave-flash" : null;
    }

    get sharedEvents(): Value {
      if (!this.$shared) {
        this.$shared = s.rt.construct(s.rt.classNamed("flash.events::EventDispatcher"));
      }

      return this.$shared;
    }

    get sameDomain(): boolean {
      return true;
    }

    get childAllowsParent(): boolean {
      return true;
    }

    get parentAllowsChild(): boolean {
      return true;
    }

    get parentSandboxBridge(): Value {
      return null;
    }

    set parentSandboxBridge(_v: Value) {
      // One sandbox.
    }

    get childSandboxBridge(): Value {
      return null;
    }

    set childSandboxBridge(_v: Value) {
      // One sandbox.
    }

    /** The SWF's bytes as a ByteArray, when they are known. */
    get bytes(): Value {
      if (!this.$bytes) {
        return null;
      }

      const array = s.rt.construct(s.rt.classNamed("flash.utils::ByteArray")) as AsObject;
      const b = avm2.bytesOf(s.rt, array);
      b.write(this.$bytes);
      b.position = 0;
      return array;
    }

    // A new object at each ask, as Flash's: a script that changes one changes no other.
    "flash.display:LoaderInfo::_getArgs"(): Value {
      const args = s.rt.objectTraits.instance();
      for (const [name, value] of this.$params) {
        s.rt.setProperty(args, s.rt.publicName(name), value);
      }

      return args;
    }

    /** The Loader's and its LoaderInfo's uncaughtErrorEvents are one dispatcher. */
    "flash.display:LoaderInfo::_getUncaughtErrorEvents"(): Value {
      return uncaughtErrorEvents(s, this.$loader ?? this);
    }

    "flash.display:LoaderInfo::_setUncaughtErrorEvents"(v: Value): void {
      (this.$loader ?? this).$uncaught = v;
    }

    static getLoaderInfoByDefinition(_object: Value): Value {
      return null;
    }
  }

  avm2.registerNativeClass(natives, "flash.display::LoaderInfo", LoaderInfoNatives);
  return natives;
}
