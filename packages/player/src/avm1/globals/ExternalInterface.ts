// flash.external.ExternalInterface's AS2 face, as Ruffle's (https://github.com/
// ruffle-rs/ruffle) core/src/avm1/globals/external_interface.rs has it: MIT
// OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
// Values cross in Flash's ExternalInterface XML through the host's bridge
// (hosts.ts), as AS3's do: a call is offered to evalJS as JavaScript, then
// sent to callOut as an XML invocation, and the page's calls in come as
// one. The underscored helpers, which Flash's own AS2 class is built of
// and content can call, answer as Flash's do (the corpus's
// external_interface_* tests); _toAS and the rest read an XMLNode's
// nodeName, firstChild, childNodes and attributes by name, so they take
// any object shaped as one.
import { avm1 } from "@swf2es/runtime";
import type { ExternalInterfaceHost } from "../../hosts.js";

type Value = avm1.Value;
type Obj = avm1.Avm1Object;

/** What ExternalInterface reads of the movie. */
export interface ExternalHost {
  readonly realm: avm1.Realm;
  /** The page's bridge where it lets the calling SWF use it; null for none. */
  externalBridge(): ExternalInterfaceHost | null;
  /**
   * `body`, the page's call into a callback, run as AVM1 code between
   * frames, what it queued run after it: what it gave, undefined where it
   * did not run or threw.
   */
  callIn(body: () => Value): Value;
}

const ESCAPES: [string, string][] = [
  ["&", "&amp;"],
  ['"', "&quot;"],
  ["'", "&apos;"],
  ["<", "&lt;"],
  [">", "&gt;"],
];

/** `text` with XML's five characters escaped, `&` first. */
function escapeXml(text: string): string {
  let out = text;
  for (const [c, entity] of ESCAPES) {
    out = out.replaceAll(c, entity);
  }

  return out;
}

/** `text` with the five entities read back, `&amp;` last. */
function unescapeXml(text: string): string {
  let out = text;
  for (let i = ESCAPES.length - 1; i >= 0; i--) {
    out = out.replaceAll(ESCAPES[i][1], ESCAPES[i][0]);
  }

  return out;
}

const FLAGS = avm1.DONT_ENUM | avm1.DONT_DELETE | avm1.READ_ONLY;

/**
 * The most elements of an array-like the converters read, whatever length
 * it claims: a length a script made up must not keep a native loop from
 * the script timeout (as TextFormat's tabStops reads at most 2^16). Flash
 * reads them all, running into its timeout.
 */
const MAX_ELEMENTS = 0x10000;

/**
 * The most values one native call converts in all, elements, properties
 * and objects: an object shared down a tree of them (a = [b, b], b = [c,
 * c]...) is converted each time it is met, which grows exponentially in
 * loops that never reach the script timeout. Past it, what is left is
 * null (undefined for _toAS).
 */
const MAX_WORK = 0x10000;

/** `flash.external.ExternalInterface`. */
export function externalInterfaceClass(host: ExternalHost): Obj {
  const realm = host.realm;
  const constr = realm.classOf(
    new avm1.Avm1Object(realm.objectProto),
    () => undefined,
    () => undefined,
  );
  /** What the native call converting now may still convert. */
  let left = MAX_WORK;
  /** Up to `n` of the work left, taken: what was. */
  const spend = (n: number) => {
    const k = Math.min(n, left);
    left -= k;
    return k;
  };
  /** `f`, a native call's conversions, with its own budget, the outer one's kept for after it. */
  const budgeted = <T>(f: () => T): T => {
    const outer = left;
    left = MAX_WORK;
    try {
      return f();
    } finally {
      left = outer;
    }
  };
  const define = (name: string, f: avm1.Native, flags = avm1.VERSION_8) =>
    constr.define(
      name,
      realm.method((self, args, v) => budgeted(() => f(self, args, v))),
      FLAGS | flags,
    );

  /** A string argument, null where it is left out or makes an empty string. */
  const text = (args: Value[], v: number, f: (s: string) => string): Value => {
    if (args.length === 0) {
      return null;
    }

    const out = f(avm1.stringOf(args[0], v));
    return out === "" ? null : out;
  };
  const asObject = (x: Value, v: number): Obj =>
    x instanceof avm1.Avm1Object ? x : realm.box(x, v);
  /** How many elements of `o` to read: its length, capped, out of the work left. */
  const lengthOf = (o: Obj, v: number) =>
    spend(Math.min(MAX_ELEMENTS, Math.max(0, avm1.toNumber(avm1.get(o, "length", v), v) | 0)));
  /**
   * `f` of `o`, or `inside` where `o` is already being converted further
   * out: an object that holds itself ends there, where Flash's recursion
   * would run out of stack (as the page's toXml has it).
   */
  const open = new Set<Obj>();
  const once = <T>(o: Obj, inside: T, f: () => T): T => {
    if (open.has(o) || spend(1) === 0) {
      return inside;
    }

    open.add(o);
    try {
      return f();
    } finally {
      open.delete(o);
    }
  };

  const arrayToXml = (o: Obj, v: number): string => {
    const parts = ["<array>"];
    const n = lengthOf(o, v);
    for (let i = 0; i < n; i++) {
      parts.push(`<property id="${i}">`, toXml(avm1.get(o, String(i), v), v), "</property>");
    }

    parts.push("</array>");
    return parts.join("");
  };
  // Its own enumerable properties in for-in's order, their names as they are.
  const objectToXml = (o: Obj, v: number): string => {
    const parts = ["<object>"];
    const own = o.ownProperties();
    for (let i = own.length - 1; i >= 0; i--) {
      const p = own[i];
      if ((p.flags & avm1.DONT_ENUM) === 0) {
        if (spend(1) === 0) {
          break;
        }

        parts.push(`<property id="${p.name}">`, toXml(avm1.get(o, p.name, v), v), "</property>");
      }
    }

    parts.push("</object>");
    return parts.join("");
  };
  // Its elements after the first, as Flash's skips the function's name.
  const argumentsToXml = (o: Obj, v: number): string => {
    const parts = ["<arguments>"];
    const n = lengthOf(o, v);
    for (let i = 1; i < n; i++) {
      parts.push(toXml(avm1.get(o, String(i), v), v));
    }

    parts.push("</arguments>");
    return parts.join("");
  };
  // An object with an own length is an array, a String object among them.
  const toXml = (x: Value, v: number): string => {
    switch (typeof x) {
      case "undefined":
        return "<undefined/>";
      case "boolean":
        return x ? "<true/>" : "<false/>";
      case "number":
        return `<number>${avm1.stringOf(x, v)}</number>`;
      case "string": {
        const escaped = escapeXml(x);
        return `<string>${escaped === "" ? "null" : escaped}</string>`;
      }
    }

    if (!(x instanceof avm1.Avm1Object)) {
      return "<null/>";
    }

    if (x.own("length", v) !== undefined) {
      return once(x, "<null/>", () => arrayToXml(x, v));
    }

    return x instanceof avm1.Avm1Function ? "<null/>" : once(x, "<null/>", () => objectToXml(x, v));
  };

  const field = (o: Value, name: string, v: number): Value =>
    o instanceof avm1.Avm1Object ? avm1.get(o, name, v) : undefined;
  /** A node's children as their own array, none where it has no childNodes. */
  const children = (node: Value, v: number): Value[] => {
    const list = field(node, "childNodes", v);
    if (!(list instanceof avm1.Avm1Object)) {
      return [];
    }

    return Array.from({ length: lengthOf(list, v) }, (_, i) => avm1.get(list, String(i), v));
  };
  /** Each `<property id>` child's value, set on `into` by its id. */
  const properties = (node: Value, into: Obj, v: number): Obj => {
    for (const child of children(node, v)) {
      if (field(child, "nodeName", v) === "property") {
        const id = field(field(child, "attributes", v), "id", v);
        avm1.set(into, avm1.stringOf(id, v), toAs(field(child, "firstChild", v), v), v);
      }
    }

    return into;
  };
  // A node's name counts only as a string or a String object: one whose toString gives it does not.
  const toAs = (node: Value, v: number): Value => {
    const raw = field(asObject(node, v), "nodeName", v);
    const name =
      typeof raw === "string"
        ? raw
        : raw instanceof avm1.Avm1Object && typeof raw.primitive === "string"
          ? raw.primitive
          : null;
    switch (name) {
      case "null":
        return null;
      case "true":
        return true;
      case "false":
        return false;
      case "string":
        return unescapeXml(avm1.stringOf(field(node, "firstChild", v), v));
      case "number":
        return avm1.toNumber(avm1.stringOf(field(node, "firstChild", v), v), v);
      case "array":
      case "object":
        // A node that holds itself, as only a script's objects can, is undefined inside itself.
        return node instanceof avm1.Avm1Object
          ? once(node, undefined, () =>
              properties(node, name === "array" ? realm.newArray([], v) : realm.newObject(v), v),
            )
          : properties(node, name === "array" ? realm.newArray([], v) : realm.newObject(v), v);
      case "class":
        return avm1.stringOf(field(node, "firstChild", v), v);
      default:
        return undefined;
    }
  };
  const argumentsToAs = (node: Value, v: number): Obj =>
    realm.newArray(
      children(node, v).map((child) => toAs(child, v)),
      v,
    );

  /** The element `text` holds, parsed by the realm's XML as content would parse it. */
  const parse = (text: string, v: number): Value => {
    const xml = realm.construct(avm1.get(realm.global, "XML", v), [], v);
    if (!(xml instanceof avm1.Avm1Object)) {
      return undefined;
    }

    avm1.set(xml, "ignoreWhite", true, v);
    avm1.invoke(avm1.get(xml, "parseXML", v), xml, [text], v);
    return avm1.get(xml, "firstChild", v);
  };

  const available = constr.add("available", undefined, FLAGS | avm1.VERSION_8);
  available.get = realm.method(() => host.externalBridge() !== null);
  available.set = realm.method(() => undefined);

  // Only a function is a callback; the page's calls come as XML invocations and answer in XML.
  define("addCallback", (_, args, v) => {
    const bridge = host.externalBridge();
    const method = args[2];
    if (bridge === null || args.length < 3 || !(method instanceof avm1.Avm1Function)) {
      return false;
    }

    // Reading the request, the call and writing its answer all run as AVM1 code: the XML class,
    // a getter or a toString they meet are the content's.
    const self = args[1];
    bridge.addCallback(avm1.stringOf(args[0], v), (request) =>
      host.callIn(() =>
        budgeted(() => {
          const invocation = parse(request, v);
          const argsNode = children(invocation, v).find(
            (child) => field(child, "nodeName", v) === "arguments",
          );
          const given = children(argsNode, v).map((child) => toAs(child, v));
          return toXml(avm1.invoke(method, self, given, v), v);
        }),
      ),
    );
    return true;
  });
  // The page's answer, null where there is no page or nothing answers.
  define(
    "call",
    (_, args, v) => {
      const bridge = host.externalBridge();
      if (bridge === null) {
        return null;
      }

      const name = avm1.stringOf(args[0], v);
      const rest = args.slice(1);
      // As JavaScript only for a host that evaluates it; the web element's declines every call.
      let answer =
        bridge.evalJS === undefined
          ? null
          : bridge.evalJS(
              `try { __flash__toXML(${name}(${rest.map((x) => toJs(x, v)).join(",")})) ; } catch (e) { "<undefined/>"; }`,
            );
      if (answer === null) {
        // The name as it is, as AS3's playerglobal sends it: the page reads it so, an inline function among them.
        const xml = rest.map((x) => toXml(x, v)).join("");
        answer = bridge.callOut(
          `<invoke name="${name}" returntype="xml"><arguments>${xml}</arguments></invoke>`,
        );
      }

      return answer === null ? null : toAs(parse(answer, v), v);
    },
    0,
  );

  /** A value as JavaScript source, for a host that evaluates it. */
  const toJs = (x: Value, v: number): string => {
    switch (typeof x) {
      case "undefined":
        return "undefined";
      case "boolean":
        return String(x);
      case "number":
        return avm1.stringOf(x, v);
      case "string":
        return JSON.stringify(x);
    }

    if (!(x instanceof avm1.Avm1Object) || x instanceof avm1.Avm1Function) {
      return "null";
    }

    return once(x, "null", () =>
      x.own("length", v) !== undefined ? arrayToJs(x, v) : objectToJs(x, v),
    );
  };
  const arrayToJs = (o: Obj, v: number): string =>
    `[${Array.from({ length: lengthOf(o, v) }, (_, i) => toJs(avm1.get(o, String(i), v), v)).join(",")}]`;
  // Its keys quoted, so that none carries code into an eval.
  const objectToJs = (o: Obj, v: number): string => {
    const parts: string[] = [];
    const own = o.ownProperties();
    for (let i = own.length - 1; i >= 0; i--) {
      const p = own[i];
      if ((p.flags & avm1.DONT_ENUM) === 0) {
        if (spend(1) === 0) {
          break;
        }

        parts.push(`${JSON.stringify(p.name)}:${toJs(avm1.get(o, p.name, v), v)}`);
      }
    }

    return `({${parts.join(",")}})`;
  };

  define("_escapeXML", (_, args, v) => text(args, v, escapeXml));
  define("_unescapeXML", (_, args, v) => text(args, v, unescapeXml));
  define("_jsQuoteString", (_, args, v) => text(args, v, (s) => s.replaceAll('"', '\\"')));
  define("_toXML", (_, args, v) => toXml(args[0], v));
  define("_arrayToXML", (_, args, v) => arrayToXml(asObject(args[0], v), v));
  define("_argumentsToXML", (_, args, v) => argumentsToXml(asObject(args[0], v), v));
  define("_objectToXML", (_, args, v) => objectToXml(asObject(args[0], v), v));
  define("_toAS", (_, args, v) => toAs(args[0], v));
  define("_arrayToAS", (_, args, v) => properties(args[0], realm.newArray([], v), v));
  define("_objectToAS", (_, args, v) => properties(args[0], realm.newObject(v), v));
  define("_argumentsToAS", (_, args, v) => argumentsToAs(args[0], v));
  define("_toJS", (_, args, v) => toJs(args[0], v));
  define("_arrayToJS", (_, args, v) => arrayToJs(asObject(args[0], v), v));
  define("_objectToJS", (_, args, v) => objectToJs(asObject(args[0], v), v));
  define("_objectID", () => host.externalBridge()?.objectID ?? null);
  // The host's bridge needs no script put on the page.
  define("_initJS", () => undefined);
  define(
    "_evalJS",
    (_, args, v) => host.externalBridge()?.evalJS?.(avm1.stringOf(args[0], v)) ?? null,
  );
  define(
    "_callOut",
    (_, args, v) => host.externalBridge()?.callOut(avm1.stringOf(args[0], v)) ?? null,
  );
  return constr;
}
