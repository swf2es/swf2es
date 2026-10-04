// flash.net's navigateToURL and sendToURL: a page the host opens, and a
// request the host sends whose response nobody reads. Both check their
// arguments as Flash does, request then its url (TypeError #2007, as adl
// throws them), and take the request as URLStream's load does.
import type { avm2 } from "@swf2es/runtime";
import type { FetchRequest, Scripting } from "../../../scripting.js";

type Value = avm2.Value;

/**
 * Opens the page a request asks for in the browser window or frame named,
 * "_self", "_blank", "_parent", "_top" or a name of the page's; null asks
 * for a new window, as Flash's does when no window is given.
 */
export type Navigate = (request: FetchRequest, window: string | null) => void;

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

/** Targets that would replace the player's own page or a frame around it. */
const IN_PLACE = new Set(["_self", "_parent", "_top", ""]);

/**
 * The browser's navigation, deliberately conservative, as Ruffle's web
 * navigator is without script access: only an http: or https: URL opens,
 * so a javascript: one cannot run in the embedding page, and a target that
 * would replace the page or a frame around it is refused. A GET opens in
 * window.open without an opener, so the page opened cannot reach back into
 * the player's; a POST is a form submitted to the window, the only way a
 * browser posts into one, its body read as form data. A host that trusts
 * its SWFs further gives a navigate of its own. Null where there is no
 * window to open, as in node.
 */
export function browserNavigate(): Navigate | null {
  if (typeof globalThis.open !== "function" || typeof document === "undefined") {
    return null;
  }

  return (request, window) => {
    const target = window ?? "_blank";
    if (IN_PLACE.has(target.toLowerCase())) {
      return;
    }

    let url: URL;
    try {
      url = new URL(request.url, globalThis.location?.href);
    } catch {
      return;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return;
    }

    if (request.method.toUpperCase() !== "POST" || !request.body) {
      globalThis.open(url.href, target, "noopener");
      return;
    }

    if (!document.body) {
      return;
    }

    const form = document.createElement("form");
    form.method = "POST";
    form.action = url.href;
    form.target = target;
    form.rel = "noopener";
    form.style.display = "none";
    for (const [name, value] of new URLSearchParams(new TextDecoder().decode(request.body))) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.append(input);
    }

    document.body.append(form);
    form.submit();
    form.remove();
  };
}
