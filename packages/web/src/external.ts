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

/** How playerglobal's `call` begins and ends the name in the invocation it sends. */
const INVOKE = '<invoke name="';
const NAME_END = '" returntype="xml"><arguments>';

/**
 * An invocation's function name and arguments, as playerglobal's call
 * sends one. It writes the name as it is, unescaped, quotes and all, as an
 * inline function's source has them, so the name is what lies between the
 * start and the first end that follows it: the arguments come after, so
 * nothing in them can move where the name ends.
 */
export function readInvocation(xml: string): { name: string; args: PageValue[] } {
  const end = xml.indexOf(NAME_END, INVOKE.length);
  if (!xml.startsWith(INVOKE) || end < 0) {
    throw new Malformed("no invocation");
  }

  const args = parse(
    xml.slice(end + NAME_END.length - "<arguments>".length, xml.lastIndexOf("</invoke>")),
  );
  return { name: xml.slice(INVOKE.length, end), args: args.children.map(value) };
}

/** What a page calls a SWF's callback with: Flash's invocation, answered in XML. */
export function invocation(name: string, args: readonly PageValue[]): string {
  return `<invoke name="${escapeXml(name)}" returntype="xml">${argumentsToXml(args)}</invoke>`;
}

/** A function name that is a path of identifiers, `a.b.c`, around which spaces do not count. */
const PATH = /^[\p{L}_$][\p{L}\p{N}_$]*(\.[\p{L}_$][\p{L}\p{N}_$]*)*$/u;

/** What the page's `window` runs: the global object of where this runs. */
const page = globalThis as unknown as Record<string, unknown>;

/**
 * The function an ExternalInterface.call names, with what to call it on.
 * A path is looked up from the page's global object along its dots, on
 * what holds it. Any other name, an inline function's source as pages
 * wrote them, is evaluated alone, `(name)`, as the code the SWF gave it to
 * be; the call's arguments never are: they are applied to what it gives.
 * Under a policy that forbids eval, such a name comes to nothing.
 */
function pageFunction(name: string): { fn: unknown; self: unknown } {
  const path = name.trim();
  if (PATH.test(path)) {
    let self: unknown = page;
    let fn: unknown = page;
    for (const part of path.split(".")) {
      self = fn;
      fn = fn === null || fn === undefined ? undefined : (fn as Record<string, unknown>)[part];
    }

    return { fn, self };
  }

  // On a line of its own, so that a name ending in a // comment still closes.
  return { fn: new Function(`return (${name}\n);`)(), self: undefined };
}

/** How the host page answers ExternalInterface, and what it is told of callbacks. */
export interface PageBridge {
  /** The element's id, or its name; Flash's objectID. */
  objectID: string | null;
  /** The SWF added callback `name`, or removed it with null. */
  callback(name: string, call: ((...args: PageValue[]) => PageValue) | null): void;
  /** Whether the SWF still plays: a callback the page kept does nothing once it does not. */
  alive(): boolean;
}

/**
 * The ExternalInterface host for a page that lets SWFs script it: those
 * `allows` allows, by the calling SWF's URL (the player asks before it
 * calls here). Every call from a SWF is declined to evalJS, so that
 * playerglobal sends it as XML: its JavaScript form writes an object's
 * keys unquoted, as Flash's did, so a key could carry code into an eval.
 * The XML is read as data, and the name alone made a function
 * (pageFunction). The page's calls into the SWF go as XML both ways.
 */
export function externalInterfaceHost(
  bridge: PageBridge,
  report: (error: unknown) => void,
  allows: (url: string) => boolean = () => true,
): ExternalInterfaceHost {
  return {
    objectID: bridge.objectID,
    allows,
    evalJS: () => null,
    callOut(request) {
      try {
        const call = readInvocation(request);
        const { fn, self } = pageFunction(call.name);
        return typeof fn === "function" ? toXml(fn.apply(self, call.args)) : "<undefined/>";
      } catch {
        // XML it cannot read, a name that is no expression or that eval is refused for, or a call that threw.
        return "<undefined/>";
      }
    },
    addCallback(name, callback) {
      if (!callback) {
        bridge.callback(name, null);
        return;
      }

      bridge.callback(name, (...args) => {
        if (!bridge.alive()) {
          return undefined;
        }

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
