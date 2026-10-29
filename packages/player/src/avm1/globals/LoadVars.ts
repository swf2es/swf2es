// LoadVars, AS1 and AS2's, and the loading it shares with XML, as Ruffle's
// (https://github.com/ruffle-rs/ruffle) core/src/avm1/globals/load_vars.rs
// and core/src/loader.rs (load_form_into_load_vars) have them: MIT OR
// Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
// A load sets the object's hidden _bytesLoaded, _bytesTotal and loaded
// first; once the answer has come, between frames, it calls onHTTPStatus
// with its status, then onData with its text, or with undefined where it
// failed or was empty. LoadVars' onData decodes the text's variables onto
// the object and calls onLoad.
import { avm1 } from "@swf2es/runtime";
import type { FetchResult } from "../../hosts.js";
import { type Avm1Net, type NetRequest, textFor } from "../net.js";

type Value = avm1.Value;
type Obj = avm1.Avm1Object;

/** What a load needs of the movie. */
export interface LoadHost {
  readonly realm: avm1.Realm;
  readonly net: Avm1Net;
  /** The SWF's version, which a load's callbacks run by. */
  readonly version: number;
  /** `o[name](...args)`, as a callback between frames runs it. */
  callback(o: Obj, name: string, args: Value[]): void;
  /** getURL's page: `url` in `window`, with `form`'s variables. */
  navigate(url: string, window: string, form: avm1.UrlForm): void;
}

const HIDDEN = avm1.DONT_ENUM | avm1.DONT_DELETE;
const FORM = "application/x-www-form-urlencoded";

/** `name` on `o` as `value`: defined hidden where it has none, else set as a script would. */
function setHidden(o: Obj, name: string, value: Value, version: number): void {
  if (avm1.has(o, name, version)) {
    avm1.set(o, name, value, version);
  } else {
    o.define(name, value, HIDDEN);
  }
}

/** The text of a load's answer as Flash reads it: UTF-8, a BOM dropped, bad bytes replaced. */
function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** `request` loaded for `target`, by LoadVars' and XML's rules (above). */
export function startLoad(
  host: LoadHost,
  target: Obj,
  request: NetRequest,
  version: number,
  httpStatus = true,
): void {
  setHidden(target, "_bytesLoaded", 0, version);
  setHidden(target, "_bytesTotal", undefined, version);
  setHidden(target, "loaded", false, version);
  host.net.fetch(request, (result: FetchResult) => {
    const v = host.version;
    const length = result.bytes?.length ?? 0;
    if (result.bytes !== null) {
      avm1.set(target, "_bytesTotal", length, v);
      if (length > 0) {
        avm1.set(target, "_bytesLoaded", length, v);
      }
    }

    if (httpStatus) {
      host.callback(target, "onHTTPStatus", [result.status]);
    }

    const data = result.bytes !== null && length > 0 ? textFor(textOf(result.bytes), v) : undefined;
    host.callback(target, "onData", [data]);
  });
}

/**
 * URL-encoded variables, `a=1&b=2`, as name and value pairs in order,
 * empty parts left out, each unescaped as unescape does (adl: `%zz` is `z`).
 */
export function parseForm(text: string, version: number): [string, string][] {
  const pairs: [string, string][] = [];
  for (const part of text.split("&")) {
    if (part === "") {
      continue;
    }

    const eq = part.indexOf("=");
    const name = eq < 0 ? part : part.slice(0, eq);
    const value = eq < 0 ? "" : part.slice(eq + 1);
    pairs.push([avm1.unescapeAvm1(name, version), avm1.unescapeAvm1(value, version)]);
  }

  return pairs;
}

/**
 * `o`'s variables as for..in lists them, each as a string; one whose
 * getter throws is "undefined", as a form of them sends it.
 */
export function formVars(o: Obj, version: number): [string, string][] {
  const vars: [string, string][] = [];
  for (const name of avm1.keys(o, version)) {
    let text: string;
    try {
      text = avm1.stringOf(avm1.get(o, name, version), version);
    } catch (error) {
      if (!(error instanceof avm1.Avm1Throw)) {
        throw error;
      }

      text = "undefined";
    }

    vars.push([name, text]);
  }

  return vars;
}

/**
 * A request for `url` with `vars`: in the query for a GET, after a `&`
 * where the URL has a query already, or in a POST's body as a form's.
 */
export function formRequest(
  url: string,
  method: "GET" | "POST",
  vars: [string, string][],
  contentType = FORM,
  headers: [string, string][] = [],
): NetRequest {
  const query = new URLSearchParams(vars).toString();
  if (method === "GET") {
    return {
      url: `${url}${url.includes("?") ? "&" : "?"}${query}`,
      method,
      headers: [],
      body: null,
    };
  }

  return {
    url,
    method,
    headers: [...headers, ["Content-Type", contentType]],
    body: new TextEncoder().encode(query),
  };
}

/** A method's name, "GET" in any case for a GET; anything else a POST. */
function methodOf(value: Value, version: number): "GET" | "POST" {
  return avm1.stringOf(value, version).toUpperCase() === "GET" ? "GET" : "POST";
}

/** The headers addRequestHeader gave a LoadVars or an XML, name and value. */
const requestHeaders = new WeakMap<Obj, [string, string][]>();

export function headersOf(o: Obj): [string, string][] {
  return requestHeaders.get(o) ?? [];
}

/** addRequestHeader, LoadVars' and XML's: a name and a value, or an array of names and values. */
export function addRequestHeader(self: Obj, args: Value[], version: number): Value {
  const headers = requestHeaders.get(self) ?? [];
  requestHeaders.set(self, headers);
  const add = (name: Value, value: Value) => {
    if (typeof name === "string" && typeof value === "string") {
      headers.push([name, value]);
    }
  };
  const list = args[0];
  if (list instanceof avm1.Avm1Object && list.array) {
    const length = avm1.toNumber(avm1.get(list, "length", version), version);
    for (let i = 0; i + 1 < length; i += 2) {
      add(avm1.get(list, String(i), version), avm1.get(list, String(i + 1), version));
    }
  } else {
    add(args[0], args[1]);
  }

  return undefined;
}

/** `self[name](...args)` where it is a function. */
function call(self: Obj, name: string, args: Value[], v: number): Value {
  return avm1.invoke(avm1.get(self, name, v), self, args, v);
}

const FIXED = avm1.DONT_ENUM | avm1.DONT_DELETE;

/** `_global.LoadVars`. */
export function loadVarsClass(host: LoadHost): avm1.Avm1Function {
  const realm = host.realm;
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self) => self,
    () => undefined,
  );
  const method = (name: string, fn: avm1.Native) => proto.define(name, realm.method(fn), FIXED);
  const contentType = (self: Obj, v: number) => avm1.stringOf(avm1.get(self, "contentType", v), v);

  method("load", (self, args, v) => {
    if (args.length === 0) {
      return false;
    }

    startLoad(
      host,
      self,
      { url: avm1.stringOf(args[0], v), method: "GET", headers: [], body: null },
      v,
    );
    return true;
  });
  method("send", (self, args, v) => {
    if (args.length === 0) {
      return false;
    }

    const url = avm1.stringOf(args[0], v);
    const window = args.length > 1 ? avm1.stringOf(args[1], v) : "";
    host.navigate(url, window, { method: methodOf(args[2], v), vars: formVars(self, v) });
    return true;
  });
  method("sendAndLoad", (self, args, v) => {
    const url = avm1.stringOf(args[0], v);
    const target = args[1];
    if (!(target instanceof avm1.Avm1Object)) {
      return false;
    }

    const request = formRequest(
      url,
      methodOf(args[2], v),
      formVars(self, v),
      contentType(self, v),
      headersOf(self),
    );
    startLoad(host, target, request, v);
    return true;
  });
  method("decode", (self, args, v) => {
    if (args.length === 0) {
      return false;
    }

    for (const [name, value] of parseForm(avm1.stringOf(args[0], v), v)) {
      avm1.set(self, name, value, v);
    }

    return undefined;
  });
  method("getBytesLoaded", (self, _, v) => avm1.get(self, "_bytesLoaded", v));
  method("getBytesTotal", (self, _, v) => avm1.get(self, "_bytesTotal", v));
  method("toString", (self, _, v) => {
    const parts: string[] = [];
    for (const name of avm1.keys(self, v)) {
      const value = avm1.stringOf(avm1.get(self, name, v), v);
      parts.push(`${avm1.escapeAvm1(name, v)}=${avm1.escapeAvm1(value, v)}`);
    }

    return parts.join("&");
  });
  proto.define("contentType", FORM, FIXED);
  method("onLoad", () => undefined);
  method("onData", (self, args, v) => {
    const data = args[0];
    const success = data !== undefined && data !== null;
    if (success) {
      call(self, "decode", [data], v);
      avm1.set(self, "loaded", true, v);
    }

    call(self, "onLoad", [success], v);
    return undefined;
  });
  method("addRequestHeader", (self, args, v) => addRequestHeader(self, args, v));

  return constr;
}
