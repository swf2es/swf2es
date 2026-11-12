// flash.net.URLRequestDefaults, AIR's, kept on the web too
// (tools/playerglobal-air.ts): what each URLRequest starts with, copied in
// as it is made (URLRequest's hook), so that a change reaches only the
// requests made after it. The browser asks for what is requested with its
// own agent, cache, cookies and credentials; the values are kept and read
// back as AIR reports them.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { AIR_RUNTIME_VERSION } from "../desktop/NativeApplication.js";

type Value = avm2.Value;

export interface RequestDefaults {
  followRedirects: boolean;
  manageCookies: boolean;
  authenticate: boolean;
  useCache: boolean;
  cacheResponse: boolean;
  idleTimeout: number;
  /** As set: a request copies it so, though null and "" read here as AIR's own agent. */
  userAgent: string | null;
}

const kept = new WeakMap<Scripting, RequestDefaults>();

/** The player's defaults, as AIR starts them. */
export function requestDefaults(s: Scripting): RequestDefaults {
  let d = kept.get(s);
  if (!d) {
    d = {
      followRedirects: true,
      manageCookies: true,
      authenticate: true,
      useCache: true,
      cacheResponse: true,
      idleTimeout: 0,
      userAgent: null,
    };
    kept.set(s, d);
  }

  return d;
}

/**
 * In AIR, AIR's own user agent, which adl 51.3 on Windows gives as
 * "Mozilla/5.0 (Windows; U; en-US) AppleWebKit/533.19.4 (KHTML, like Gecko)
 * AdobeAIR/51.3", for the platform and locale Capabilities reports. On the
 * web, where Flash Player has no such class, the browser's, which its
 * requests carry.
 */
export function defaultUserAgent(s: Scripting): string {
  const browser = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
  if (!s.air && browser) {
    return browser;
  }

  const { manufacturer, locale } = s.platform;
  let system: string;
  switch (manufacturer) {
    case "Adobe Windows":
      system = "Windows; U";
      break;
    case "Adobe Macintosh":
      system = "Macintosh; U; Intel Mac OS X";
      break;
    default:
      system = "X11; U; Linux x86_64";
  }

  const version = AIR_RUNTIME_VERSION.split(".").slice(0, 2).join(".");
  return `Mozilla/5.0 (${system}; ${locale}) AppleWebKit/533.19.4 (KHTML, like Gecko) AdobeAIR/${version}`;
}

/** An idle timeout as AIR takes it: NaN too, but nothing below zero. */
export function idleTimeout(s: Scripting, v: Value): number {
  const n = s.rt.toNumber(v);
  if (n < 0) {
    throw s.rt.error("RangeError", 2006);
  }

  return n;
}

export function urlRequestDefaultsNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const d = () => requestDefaults(s);

  class URLRequestDefaultsNatives {
    static get followRedirects(): boolean {
      return d().followRedirects;
    }

    static set followRedirects(v: Value) {
      d().followRedirects = !!v;
    }

    static get manageCookies(): boolean {
      return d().manageCookies;
    }

    static set manageCookies(v: Value) {
      d().manageCookies = !!v;
    }

    static get authenticate(): boolean {
      return d().authenticate;
    }

    static set authenticate(v: Value) {
      d().authenticate = !!v;
    }

    static get useCache(): boolean {
      return d().useCache;
    }

    static set useCache(v: Value) {
      d().useCache = !!v;
    }

    static get cacheResponse(): boolean {
      return d().cacheResponse;
    }

    static set cacheResponse(v: Value) {
      d().cacheResponse = !!v;
    }

    static get idleTimeout(): number {
      return d().idleTimeout;
    }

    static set idleTimeout(v: Value) {
      d().idleTimeout = idleTimeout(s, v);
    }

    static get userAgent(): string {
      return d().userAgent || defaultUserAgent(s);
    }

    static set userAgent(v: Value) {
      d().userAgent = v === null || v === undefined ? null : s.rt.toString(v);
    }

    // The browser asks for a page's credentials itself; AIR takes any, nulls too.
    static setLoginCredentialsForHost(): Value {
      return undefined;
    }
  }

  avm2.registerNativeClass(natives, "flash.net::URLRequestDefaults", URLRequestDefaultsNatives);
  return natives;
}
