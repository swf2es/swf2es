// flash.display.Loader: a container whose one child is the root of the SWF
// it loaded. Its loads complete in a later frame (Scripting.completeLoads).
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { uncaughtErrorEvents } from "./LoaderInfo.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** A copy of a ByteArray's bytes, as they are now. */
function copyOf(s: Scripting, v: Value): Uint8Array {
  if (!v) {
    throw s.rt.error("TypeError", 2007, "bytes");
  }

  const b = avm2.bytesOf(s.rt, v);
  return new Uint8Array(b.buffer.subarray(0, b.length));
}

/**
 * A LoaderContext's parameters, which take the place of the content's URL
 * query in its loaderInfo.parameters: null when none were set. Flash
 * refuses any value that is not a String, null and undefined among them,
 * with Error #2196 at the call; an object that is not one, such as a
 * String, has no names and gives none.
 */
function contextParameters(s: Scripting, v: Value): Map<string, string> | null {
  if (v === null || v === undefined) {
    return null;
  }

  const parameters = new Map<string, string>();
  for (let i = s.rt.hasNext(v, 0); i !== 0; i = s.rt.hasNext(v, i)) {
    const value = s.rt.nextValue(v, i);
    if (typeof value !== "string") {
      throw s.rt.error("flash.errors::IllegalOperationError", 2196, "LoaderContext.parameters");
    }

    parameters.set(String(s.rt.nextName(v, i)), value);
  }

  return parameters;
}

export function loaderNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class LoaderNatives {
    declare $content: AsObject | null | undefined;
    declare $loaderInfo: AsObject | undefined;
    declare $uncaught: AsObject | undefined;
    declare $generation: number | undefined;
    declare $abort: AbortController | null | undefined;

    get content(): Value {
      return this.$content ?? null;
    }

    get contentLoaderInfo(): Value {
      if (!this.$loaderInfo) {
        this.$loaderInfo = s.loaderInfo(this);
      }

      return this.$loaderInfo;
    }

    // Both take the LoaderContext's fields after the source: checkPolicyFile,
    // applicationDomain, securityDomain, requestedContentParent, parameters,
    // the JPEG deblocking, allowCodeImport and imageDecodingPolicy. Only
    // applicationDomain, for where the content's code loads, and parameters
    // are read.
    "flash.display:Loader::_loadBytes"(
      bytes: Value,
      _checkPolicyFile: Value,
      applicationDomain: Value,
      _securityDomain: Value,
      _requestedContentParent: Value,
      parameters: Value,
    ): void {
      const copy = copyOf(s, bytes);
      const given = contextParameters(s, parameters);
      s.requestLoad(this, copy, s.loadDomain(applicationDomain), given);
    }

    "flash.display:Loader::_load"(
      request: Value,
      _checkPolicyFile: Value,
      applicationDomain: Value,
      _securityDomain: Value,
      _requestedContentParent: Value,
      parameters: Value,
    ): void {
      const given = contextParameters(s, parameters);
      s.requestLoadUrl(this, request as AsObject, s.loadDomain(applicationDomain), given);
    }

    "flash.display:Loader::_unload"(stopAllMovieClips: Value, _gc: Value): void {
      s.unload(this, !!stopAllMovieClips);
    }

    "flash.display:Loader::_getJPEGLoaderContextdeblockingfilter"(_context: Value): number {
      return 0;
    }

    "flash.display:Loader::_close"(): void {
      s.closeLoad(this);
    }

    "flash.display:Loader::_getUncaughtErrorEvents"(): Value {
      return uncaughtErrorEvents(s, this);
    }

    "flash.display:Loader::_setUncaughtErrorEvents"(v: Value): void {
      this.$uncaught = v;
    }
  }

  avm2.registerNativeClass(natives, "flash.display::Loader", LoaderNatives);
  return natives;
}
