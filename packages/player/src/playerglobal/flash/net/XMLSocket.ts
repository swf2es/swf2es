// flash.net.XMLSocket: AS3 over a Socket (as3/playerglobal); connect with a
// null host asks here for the SWF's own domain.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { swfDomain } from "./LocalConnection.js";

export function xmlSocketNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class XMLSocketNatives {
    get "flash.net:XMLSocket::domain"(): string {
      return swfDomain(s.url);
    }
  }

  avm2.registerNativeClass(natives, "flash.net::XMLSocket", XMLSocketNatives);
  return natives;
}
