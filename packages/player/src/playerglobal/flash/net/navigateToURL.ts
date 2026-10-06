// flash.net's navigateToURL and sendToURL: a page the host opens, and a
// request the host sends whose response nobody reads. Both check their
// arguments as Flash does, request then its url (TypeError #2007, as adl
// throws them), and take the request as URLStream's load does.
import type { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function navigateNatives(s: Scripting): avm2.Natives {
  const checked = (rt: avm2.Runtime, request: Value): avm2.AsObject => {
    if (request === null || request === undefined) {
      throw rt.error("TypeError", 2007, "request");
    }

    if (request.$url === null || request.$url === undefined) {
      throw rt.error("TypeError", 2007, "url");
    }

    return request;
  };

  return {
    "flash.net::navigateToURL": (rt) => (request: Value, window: Value) => {
      const page = checked(rt, request);
      const name = window === null || window === undefined ? null : rt.toString(window);
      s.navigateTo(page, name === null ? null : target(name));
    },
    "flash.net::sendToURL": (rt) => (request: Value) => {
      s.sendTo(checked(rt, request));
    },
  };
}

/**
 * "blank" in any case, with or without its underscore, as "_blank", and any
 * other name as given, as Ruffle's navigateToURL_target_normalize records
 * Flash Player doing.
 */
function target(name: string): string {
  return /^_?blank$/i.test(name) ? "_blank" : name;
}
