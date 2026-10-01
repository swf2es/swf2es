// flash.net.URLRequest: a URL and how to ask for it, kept as fields.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function urlRequestNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class URLRequestNatives {
    declare $url: Value;
    declare $data: Value;
    declare $method: string | undefined;
    declare $contentType: Value;
    declare $headers: Value;
    declare $digest: Value;
    declare $followRedirects: boolean | undefined;
    declare $userAgent: Value;
    declare $manageCookies: boolean | undefined;
    declare $useCache: boolean | undefined;
    declare $cacheResponse: boolean | undefined;
    declare $idleTimeout: number | undefined;
    declare $authenticate: boolean | undefined;

    get url(): Value {
      return this.$url ?? null;
    }

    set url(v: Value) {
      this.$url = v === null || v === undefined ? null : String(v);
    }

    get data(): Value {
      return this.$data ?? null;
    }

    set data(v: Value) {
      this.$data = v;
    }

    get method(): string {
      return this.$method ?? "GET";
    }

    "flash.net:URLRequest::setMethod"(v: Value): void {
      this.$method = String(v);
    }

    get contentType(): Value {
      return this.$contentType ?? "application/x-www-form-urlencoded";
    }

    set contentType(v: Value) {
      this.$contentType = v;
    }

    get requestHeaders(): Value {
      if (!this.$headers) {
        this.$headers = s.rt.array([]);
      }

      return this.$headers;
    }

    "flash.net:URLRequest::setRequestHeaders"(v: Value): void {
      this.$headers = v;
    }

    get digest(): Value {
      return this.$digest ?? null;
    }

    set digest(v: Value) {
      this.$digest = v;
    }

    useRedirectedURL(): void {
      // Nothing redirects.
    }

    get followRedirects(): boolean {
      return this.$followRedirects ?? true;
    }

    set followRedirects(v: Value) {
      this.$followRedirects = !!v;
    }

    get userAgent(): Value {
      return this.$userAgent ?? null;
    }

    set userAgent(v: Value) {
      this.$userAgent = v;
    }

    get manageCookies(): boolean {
      return this.$manageCookies ?? true;
    }

    set manageCookies(v: Value) {
      this.$manageCookies = !!v;
    }

    get useCache(): boolean {
      return this.$useCache ?? true;
    }

    set useCache(v: Value) {
      this.$useCache = !!v;
    }

    get cacheResponse(): boolean {
      return this.$cacheResponse ?? true;
    }

    set cacheResponse(v: Value) {
      this.$cacheResponse = !!v;
    }

    "flash.net:URLRequest::_SetIdleTimeout"(v: Value): void {
      this.$idleTimeout = Number(v);
    }

    get idleTimeout(): number {
      return this.$idleTimeout ?? 0;
    }

    get authenticate(): boolean {
      return this.$authenticate ?? true;
    }

    set authenticate(v: Value) {
      this.$authenticate = !!v;
    }
  }

  avm2.registerNativeClass(natives, "flash.net::URLRequest", URLRequestNatives);
  return natives;
}
