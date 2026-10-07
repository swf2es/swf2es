// ExternalInterface between a SWF and its page, in Flash's own protocol:
// what playerglobal sends and expects, and what Flash's plug-in put on the
// page as __flash__toXML and friends. Values cross as Flash serialised
// them: strings, numbers, booleans, null, undefined, dates, and arrays and
// objects, which arrive as plain copies on either side.
import type { ExternalInterfaceHost } from "@swf2es/player";

/** A value as the page sees one. */
export type PageValue = unknown;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

const escapeXml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/**
 * A page value as ExternalInterface's XML, as Flash's __flash__toXML wrote
 * it. A value met again inside itself is null, where Flash's recursed
 * until the stack ran out; a function is null, as playerglobal makes one.
 */
export function toXml(value: PageValue, seen = new Set<object>()): string {
  switch (typeof value) {
    case "string":
      return `<string>${escapeXml(value)}</string>`;
    case "undefined":
      return "<undefined/>";
    case "number":
      return `<number>${value}</number>`;
    case "boolean":
      return value ? "<true/>" : "<false/>";
    case "object":
      break;
    default:
      return "<null/>";
  }

  if (value === null || seen.has(value)) {
    return "<null/>";
  }

  if (value instanceof Date) {
    return `<date>${value.getTime()}</date>`;
  }

  seen.add(value);
  const parts: string[] = [];
  const entries = Array.isArray(value)
    ? value.map((item, i) => [String(i), item] as const)
    : Object.entries(value);
  for (const [id, item] of entries) {
    parts.push(`<property id="${escapeXml(id)}">${toXml(item, seen)}</property>`);
  }

  seen.delete(value);
  const tag = Array.isArray(value) ? "array" : "object";
  return `<${tag}>${parts.join("")}</${tag}>`;
}

/** The arguments of an invocation, as Flash's __flash__argumentsToXML. */
export function argumentsToXml(args: readonly PageValue[]): string {
  return `<arguments>${args.map((arg) => toXml(arg)).join("")}</arguments>`;
}

interface Element {
  name: string;
  attributes: Map<string, string>;
  /** Text, decoded, and the child elements, in order. */
  text: string;
  children: Element[];
}

/** Thrown for XML this does not read: what a SWF answers is always its own _toXML's. */
class Malformed extends Error {}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : +name.slice(1);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }

    return ENTITIES[name] ?? whole;
  });
}

/**
 * The elements of the XML ExternalInterface sends: tags, their attributes,
 * text and entities, no more. E4X writes what playerglobal's XML() makes,
 * which may close an empty element either way.
 */
function parse(xml: string): Element {
  let at = 0;
  const element = (): Element => {
    const open = /^<([\w:.-]+)/.exec(xml.slice(at, at + 256));
    if (!open) {
      throw new Malformed(`no element at ${at}`);
    }

    at += open[0].length;
    const node: Element = { name: open[1], attributes: new Map(), text: "", children: [] };
    for (;;) {
      const attribute = /^\s+([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(xml.slice(at));
      if (!attribute) {
        break;
      }

      node.attributes.set(attribute[1], decode(attribute[3] ?? attribute[4]));
      at += attribute[0].length;
    }

    const end = /^\s*(\/?)>/.exec(xml.slice(at, at + 64));
    if (!end) {
      throw new Malformed(`an unclosed tag at ${at}`);
    }

    at += end[0].length;
    if (end[1]) {
      return node;
    }

    const text: string[] = [];
    for (;;) {
      const next = xml.indexOf("<", at);
      if (next < 0) {
        throw new Malformed(`no end for <${node.name}>`);
      }

      text.push(xml.slice(at, next));
      at = next;
      if (xml.startsWith("</", at)) {
        const close = xml.indexOf(">", at);
        if (close < 0 || xml.slice(at + 2, close).trim() !== node.name) {
          throw new Malformed(`a wrong end for <${node.name}>`);
        }

        at = close + 1;
        node.text = decode(text.join(""));
        return node;
      }

      node.children.push(element());
    }
  };

  at = xml.search(/\S/);
  if (at < 0) {
    throw new Malformed("no XML");
  }

  return element();
}

/** Thrown into the page for an `<exception>`, as Flash's plug-in threw what marshallExceptions sent. */
export class ExternalInterfaceError extends Error {}

/** An ExternalInterface value's XML as a page value. */
export function fromXml(xml: string): PageValue {
  return value(parse(xml));
}

function value(node: Element): PageValue {
  switch (node.name) {
    case "string":
      return node.text;
    case "number":
      return Number(node.text);
    case "true":
      return true;
    case "false":
      return false;
    case "null":
      return null;
    case "date":
      return new Date(Number(node.text));
    case "array": {
      const array: PageValue[] = [];
      for (const property of node.children) {
        array[Number(property.attributes.get("id"))] = value(property.children[0]);
      }

      return array;
    }
    case "object": {
      const object: Record<string, PageValue> = {};
      for (const property of node.children) {
        const id = property.attributes.get("id") ?? "";
        // A plain own property, though the SWF named one __proto__.
        Object.defineProperty(object, id, {
          value: value(property.children[0]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }

      return object;
    }
    case "exception":
      throw new ExternalInterfaceError(node.text);
    default:
      return undefined;
  }
}

/** An invocation's function name and arguments, as playerglobal's call sends one when evalJS declined. */
export function readInvocation(xml: string): { name: string; args: PageValue[] } {
  const invoke = parse(xml);
  const args = invoke.children.find((c) => c.name === "arguments")?.children ?? [];
  return { name: invoke.attributes.get("name") ?? "", args: args.map(value) };
}

/** What a page calls a SWF's callback with: Flash's invocation, answered in XML. */
export function invocation(name: string, args: readonly PageValue[]): string {
  return `<invoke name="${escapeXml(name)}" returntype="xml">${argumentsToXml(args)}</invoke>`;
}

/** A function name that is a path of identifiers, `a.b.c`. */
const PATH = /^[\p{L}_$][\p{L}\p{N}_$]*(\.[\p{L}_$][\p{L}\p{N}_$]*)*$/u;

/** What playerglobal's `call` writes before the function's name (not ActiveX's, which this host is not). */
const CALL = "try { __flash__toXML(";

/** What the page's `window` runs: the global object of where this runs. */
const page = globalThis as unknown as Record<string, unknown>;

/**
 * A function name ExternalInterface.call gives, found from the page's
 * global object along its dots, with what holds it for `this`: undefined
 * for a name that is not a path, an inline function's source, say.
 */
function pagePath(name: string): { fn: unknown; self: unknown } | undefined {
  if (!PATH.test(name)) {
    return undefined;
  }

  let self: unknown = page;
  let fn: unknown = page;
  for (const part of name.split(".")) {
    self = fn;
    fn = fn === null || fn === undefined ? undefined : (fn as Record<string, unknown>)[part];
  }

  return { fn, self };
}

/** How the host page answers ExternalInterface, and what it is told of callbacks. */
export interface PageBridge {
  /** The element's id, or its name; Flash's objectID. */
  objectID: string | null;
  /** The SWF added callback `name`, or removed it with null. */
  callback(name: string, call: ((...args: PageValue[]) => PageValue) | null): void;
}

/**
 * The ExternalInterface host for a page that lets SWFs script it: those
 * `allows` allows, by the calling SWF's URL. A call to a function named
 * by a path is declined to evalJS, so playerglobal sends it as XML, read
 * here as data: its JavaScript form writes an object's keys unquoted, as
 * Flash's did, and a key could carry code into the eval. Only a name that
 * is no path, an inline function's source, which is code already, is
 * evaluated as Flash's plug-in did, `name(args)` inside __flash__toXML;
 * where the page forbids eval (a Content-Security-Policy), that call is
 * declined too, and comes to nothing. The page's calls into the SWF go
 * as XML both ways, needing no eval.
 */
export function externalInterfaceHost(
  bridge: PageBridge,
  report: (error: unknown) => void,
  allows: (url: string) => boolean = () => true,
): ExternalInterfaceHost {
  let evaluate: ((source: string) => unknown) | null | undefined;
  return {
    objectID: bridge.objectID,
    allows,
    evalJS(source) {
      if (source.startsWith(CALL)) {
        const name = source.slice(CALL.length, source.indexOf("(", CALL.length));
        if (PATH.test(name)) {
          return null;
        }
      }

      if (evaluate === undefined) {
        try {
          // Sloppy, so that the source's names are the page's globals, with
          // __flash__toXML in scope as Flash's plug-in put it on the page.
          evaluate = new Function(
            "__flash__toXML",
            "return function (__swf2es_source) { return eval(__swf2es_source); };",
          )((value: PageValue) => toXml(value)) as (source: string) => unknown;
        } catch {
          evaluate = null;
        }
      }

      if (evaluate === null) {
        return null;
      }

      try {
        const result = evaluate(source);
        return typeof result === "string" ? result : "<undefined/>";
      } catch (error) {
        // A policy that forbids eval may let Function be made yet refuse the eval in it.
        if (error instanceof EvalError) {
          evaluate = null;
          return null;
        }

        // Source that does not parse: a name that is no expression.
        return "<undefined/>";
      }
    },
    callOut(request) {
      let call: { name: string; args: PageValue[] };
      try {
        call = readInvocation(request);
      } catch {
        return "<undefined/>";
      }

      const found = pagePath(call.name);
      if (typeof found?.fn !== "function") {
        return "<undefined/>";
      }

      try {
        return toXml(found.fn.apply(found.self, call.args));
      } catch {
        return "<undefined/>";
      }
    },
    addCallback(name, callback) {
      if (!callback) {
        bridge.callback(name, null);
        return;
      }

      bridge.callback(name, (...args) => {
        let answer: unknown;
        try {
          answer = callback(invocation(name, args), null);
        } catch (error) {
          report(error);
          throw new ExternalInterfaceError(`Error calling method on NPObject: ${name}`);
        }

        return typeof answer === "string" ? fromXml(answer) : undefined;
      });
    },
  };
}
