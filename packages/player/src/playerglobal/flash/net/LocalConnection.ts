// flash.net.LocalConnection: its connections are AS3 (as3/playerglobal);
// the domain it names its SWF by is the player's.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

/**
 * The domain of the SWF at `url`, as LocalConnection.domain and a null
 * XMLSocket host take it: its host, or "localhost" for a local file or a
 * URL without one, as Flash Player names a local SWF's (Ruffle's rule).
 */
export function swfDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:" || !parsed.hostname ? "localhost" : parsed.hostname;
  } catch {
    return "localhost";
  }
}

export function localConnectionNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class LocalConnectionNatives {
    get domain(): string {
      return swfDomain(s.url);
    }
  }

  avm2.registerNativeClass(natives, "flash.net::LocalConnection", LocalConnectionNatives);
  return natives;
}
