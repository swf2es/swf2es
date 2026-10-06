// What a host may give the player in place of the browser's: where a SWF's
// navigateToURL goes, where its SharedObjects are kept, and the system
// Capabilities reports; with the browser's defaults for each.
import type { FetchRequest } from "./scripting.js";

/**
 * Opens the page a request asks for in the browser window or frame named,
 * "_self", "_blank", "_parent", "_top" or a name of the page's; null asks
 * for a new window, as Flash's does when no window is given.
 */
export type Navigate = (request: FetchRequest, window: string | null) => void;

/** Targets that would replace the player's own page or a frame around it. */
const IN_PLACE = new Set(["_self", "_parent", "_top", ""]);

/**
 * The browser's navigation, deliberately conservative, as a SWF is not to
 * be trusted by the page that embeds it: only an http: or https: URL opens,
 * so a javascript: one cannot run in the embedding page; a target that
 * would replace the page or a frame around it is refused, as Ruffle's web
 * navigator refuses it without script access; and every other target opens
 * a new window, since a name reaches the window or frame of that name,
 * noopener or not, so a SWF cannot reuse a window it named. A GET opens in
 * window.open without an opener; a POST is a form submitted to a new
 * window, the only way a browser posts into one, its body read as form
 * data. A host that trusts its SWFs further gives a navigate of its own.
 * Null where there is no window to open, as in node.
 */
export function browserNavigate(): Navigate | null {
  if (typeof globalThis.open !== "function" || typeof document === "undefined") {
    return null;
  }

  return (request, window) => {
    if (window !== null && IN_PLACE.has(window.toLowerCase())) {
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
      globalThis.open(url.href, "_blank", "noopener");
      return;
    }

    if (!document.body) {
      return;
    }

    const form = document.createElement("form");
    form.method = "POST";
    form.action = url.href;
    form.target = "_blank";
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

/**
 * Where the host keeps shared objects' bytes, by key: the browser's
 * localStorage by default, else memory.
 */
export interface SharedObjectStorage {
  get(key: string): Uint8Array | null;
  set(key: string, bytes: Uint8Array): void;
  remove(key: string): void;
  keys(): string[];
}

/**
 * The default storage: localStorage, base64 under a prefix, where the host
 * has it and lets it be read; memory otherwise. localStorage is first reached
 * when a SWF first uses a shared object, since merely reading it can throw
 * (a SecurityError where site data is blocked). A write it refuses, a full
 * quota say, throws, which flush reports as Error #2130.
 */
export function defaultStorage(): SharedObjectStorage {
  const memory = new Map<string, Uint8Array>();
  const inMemory: SharedObjectStorage = {
    get: (key) => memory.get(key) ?? null,
    set: (key, bytes) => {
      memory.set(key, bytes.slice());
    },
    remove: (key) => {
      memory.delete(key);
    },
    keys: () => [...memory.keys()],
  };
  let chosen: SharedObjectStorage | undefined;
  const storage = (): SharedObjectStorage => {
    if (!chosen) {
      let local: Storage | undefined;
      try {
        local = (globalThis as { localStorage?: Storage }).localStorage;
        local?.getItem(PREFIX);
      } catch {
        local = undefined;
      }

      chosen = local ? localStorageOf(local) : inMemory;
    }

    return chosen;
  };

  return {
    get: (key) => storage().get(key),
    set: (key, bytes) => storage().set(key, bytes),
    remove: (key) => storage().remove(key),
    keys: () => storage().keys(),
  };
}

const PREFIX = "swf2es:so:";

function localStorageOf(local: Storage): SharedObjectStorage {
  return {
    get: (key) => {
      const text = local.getItem(PREFIX + key);
      return text === null ? null : Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    },
    set: (key, bytes) => {
      // In chunks: one String.fromCharCode of every byte overflows the stack.
      const parts: string[] = [];
      for (let i = 0; i < bytes.length; i += 0x2000) {
        parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x2000)));
      }

      local.setItem(PREFIX + key, btoa(parts.join("")));
    },
    remove: (key) => local.removeItem(PREFIX + key),
    keys: () => {
      const keys: string[] = [];
      for (let i = 0; i < local.length; i++) {
        const k = local.key(i);
        if (k?.startsWith(PREFIX)) {
          keys.push(k.slice(PREFIX.length));
        }
      }

      return keys;
    },
  };
}

/** What Capabilities reports of the system the player runs on. */
export interface PlatformCapabilities {
  /** "Windows 10", "Mac OS 10.15.7", "Linux"... */
  os: string;
  /** "Adobe Windows", "Adobe Macintosh" or "Adobe Linux". */
  manufacturer: string;
  /** The platform and the player's version: "WIN 32,0,0,465". */
  version: string;
  /** A language code: "en", or with its country for Chinese and Portuguese ("zh-CN"). */
  language: string;
  /** "PlugIn", "ActiveX", "StandAlone", "External" or "Desktop". */
  playerType: string;
}

/** The platform as the host's browser reports it, a Linux plugin's where it has none. */
export function platformCapabilities(): PlatformCapabilities {
  const navigator = (globalThis as { navigator?: { userAgent?: string; language?: string } })
    .navigator;
  const agent = navigator?.userAgent ?? "";
  const mac = /Mac OS X (\d+)[._](\d+)(?:[._](\d+))?/.exec(agent);
  const [os, manufacturer, platform] = /Windows/.test(agent)
    ? ["Windows 10", "Adobe Windows", "WIN"]
    : mac
      ? [`Mac OS ${mac[1]}.${mac[2]}${mac[3] ? `.${mac[3]}` : ""}`, "Adobe Macintosh", "MAC"]
      : ["Linux", "Adobe Linux", "LNX"];
  // Flash gives the country only where the language needs it.
  const tag = navigator?.language ?? "en";
  const [lang, country] = tag.split("-");
  const language = (lang === "zh" || lang === "pt") && country ? `${lang}-${country}` : lang;
  return { os, manufacturer, version: `${platform} 32,0,0,465`, language, playerType: "PlugIn" };
}
