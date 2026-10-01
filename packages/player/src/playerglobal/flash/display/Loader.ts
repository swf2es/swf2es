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
    // the JPEG deblocking, allowCodeImport and imageDecodingPolicy. The one
    // domain there is is the current, so they are not read yet.
    "flash.display:Loader::_loadBytes"(bytes: Value): void {
      s.requestLoad(this, copyOf(s, bytes));
    }

    "flash.display:Loader::_load"(request: Value): void {
      s.requestLoadUrl(this, String(request?.$url ?? ""));
    }

    "flash.display:Loader::_unload"(_stopAllMovieClips: Value, _gc: Value): void {
      s.unload(this);
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
