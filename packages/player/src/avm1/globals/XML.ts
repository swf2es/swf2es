// XML, AS1 and AS2's document, as Ruffle's (https://github.com/ruffle-rs/
// ruffle) core/src/avm1/globals/xml.rs has it: MIT OR Apache-2.0, Copyright
// (c) 2018-2022 Ruffle LLC and Ruffle contributors; where adl parts from
// Ruffle, as adl has it. An XML is an XMLNode, its document's root, with no
// name; parseXML replaces the root's children with what it reads, and on
// an error keeps what it read before, `status` the error's number. load
// and sendAndLoad go as LoadVars' do.
import { avm1 } from "@swf2es/runtime";
import { bytesFor, type NetRequest } from "../net.js";
import { addRequestHeader, headersOf, type LoadHost, startLoad } from "./LoadVars.js";
import {
  ELEMENT_NODE,
  serialize,
  TEXT_NODE,
  type XmlHost,
  XmlNode,
  type XmlNodes,
} from "./XMLNode.js";

type Value = avm1.Value;
type Obj = avm1.Avm1Object;

// parseXML's statuses, as Flash 8 lists them.
export const OK = 0;
export const CDATA_NOT_TERMINATED = -2;
export const DECL_NOT_TERMINATED = -3;
export const DOCTYPE_NOT_TERMINATED = -4;
export const COMMENT_NOT_TERMINATED = -5;
export const ELEMENT_MALFORMED = -6;
export const ATTRIBUTE_NOT_TERMINATED = -8;
export const MISMATCHED_START = -9;
export const MISMATCHED_END = -10;

/** The entities Flash knows by name, nbsp among them (adl). */
const NAMED: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  apos: "'",
  quot: '"',
  nbsp: " ",
};

/** An entity, `&...;`, decoded; null for one that is none, which is kept as it is. */
function entity(text: string): string | null {
  const body = text.slice(1, -1);
  if (Object.hasOwn(NAMED, body)) {
    return NAMED[body];
  }

  let digits: string;
  let radix: number;
  if (body.startsWith("#x")) {
    digits = body.slice(2);
    radix = 16;
  } else if (body.startsWith("#")) {
    digits = body.slice(1);
    radix = 10;
  } else {
    return null;
  }

  if (!(radix === 16 ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) {
    return null;
  }

  // &#0; is nothing (adl).
  const code = Number.parseInt(digits, radix);
  if (code === 0) {
    return "";
  }

  return code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? null : String.fromCodePoint(code);
}

/**
 * Text or an attribute's value with its entities decoded, each alone: a
 * bare `&` before one is kept, and `&&amp;` is `&&`, as Flash has them
 * (Ruffle's avm1_unescape); `&#X41;`, an unknown name, are kept as written.
 */
export function unescapeXml(text: string): string {
  return text.includes("&") ? text.replace(/&[^;&]*;/g, (e) => entity(e) ?? e) : text;
}

const isWhite = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";
const allWhite = (text: string) => /^[ \t\n\r]*$/.test(text);

/** What parsing found besides the tree. */
export interface Parsed {
  status: number;
  xmlDecl: string | null;
  docTypeDecl: string | null;
}

/**
 * `text` read into `root`'s children as Flash reads it (adl): elements,
 * text, and CDATA as text; the XML declaration and DOCTYPE, in any case,
 * kept aside; comments dropped; whitespace-only text too where
 * `ignoreWhite`. Any other `<?` is malformed, and any other `<!` an
 * element whose name starts with `!`. Attributes need no space between
 * them, and a name's first value is kept. An end tag of an element further
 * up closes those within it as unmatched starts; one of none is an error.
 * It stops at the first error, what it read before kept. `id` gets each
 * element with an `id` attribute.
 */
export function parseXml(
  text: string,
  root: XmlNode,
  ignoreWhite: boolean,
  id: (value: string, node: XmlNode) => void,
  version: number,
): Parsed {
  const parsed: Parsed = { status: OK, xmlDecl: null, docTypeDecl: null };
  const open: XmlNode[] = [root];
  const top = () => open[open.length - 1];
  const addText = (value: string) => {
    if (value !== "" && !(ignoreWhite && allWhite(value))) {
      top().append(new XmlNode(TEXT_NODE, value), version);
    }
  };
  const fail = (status: number): Parsed => {
    parsed.status = status;
    return parsed;
  };
  const startsCaseless = (s: string, at: number) =>
    text.slice(at, at + s.length).toLowerCase() === s.toLowerCase();

  let i = 0;
  while (i < text.length) {
    if (text[i] !== "<") {
      let next = text.indexOf("<", i);
      if (next < 0) {
        next = text.length;
      }

      addText(unescapeXml(text.slice(i, next)));
      i = next;
      continue;
    }

    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end < 0) {
        return fail(COMMENT_NOT_TERMINATED);
      }

      i = end + 3;
      continue;
    }

    if (text.startsWith("<![CDATA[", i)) {
      const end = text.indexOf("]]>", i + 9);
      if (end < 0) {
        return fail(CDATA_NOT_TERMINATED);
      }

      addText(text.slice(i + 9, end));
      i = end + 3;
      continue;
    }

    if (startsCaseless("<!DOCTYPE", i)) {
      // Up to its >, past any <...> within it.
      let depth = 0;
      let end = -1;
      for (let j = i + 9; j < text.length && end < 0; j++) {
        if (text[j] === "<") {
          depth++;
        } else if (text[j] === ">") {
          if (depth === 0) {
            end = j;
          }

          depth--;
        }
      }

      if (end < 0) {
        return fail(DOCTYPE_NOT_TERMINATED);
      }

      parsed.docTypeDecl = text.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    if (text.startsWith("<?", i)) {
      if (!startsCaseless("<?xml", i) || !isWhite(text[i + 5])) {
        return fail(ELEMENT_MALFORMED);
      }

      const end = text.indexOf("?>", i + 5);
      if (end < 0) {
        return fail(DECL_NOT_TERMINATED);
      }

      parsed.xmlDecl = text.slice(i, end + 2);
      i = end + 2;
      continue;
    }

    if (text.startsWith("</", i)) {
      const end = text.indexOf(">", i + 2);
      if (end < 0) {
        return fail(ELEMENT_MALFORMED);
      }

      const name = text.slice(i + 2, end).replace(/[ \t\n\r]+$/, "");
      let at = open.length - 1;
      while (at > 0 && open[at].value !== name) {
        at--;
      }

      if (at === 0) {
        return fail(MISMATCHED_END);
      }

      if (at < open.length - 1) {
        parsed.status = MISMATCHED_START;
      }

      open.length = at;
      i = end + 1;
      continue;
    }

    // An element: its name, up to whitespace, > or />, then its attributes.
    let j = i + 1;
    while (j < text.length && !isWhite(text[j]) && text[j] !== ">" && !text.startsWith("/>", j)) {
      j++;
    }

    if (j === i + 1 || j >= text.length) {
      return fail(ELEMENT_MALFORMED);
    }

    const element = new XmlNode(ELEMENT_NODE, text.slice(i + 1, j));
    const names: string[] = [];
    const values: string[] = [];
    let empty = false;
    for (;;) {
      while (isWhite(text[j])) {
        j++;
      }

      if (j >= text.length) {
        return fail(ELEMENT_MALFORMED);
      }

      if (text[j] === ">") {
        j++;
        break;
      }

      if (text.startsWith("/>", j)) {
        empty = true;
        j += 2;
        break;
      }

      const start = j;
      while (j < text.length && !isWhite(text[j]) && text[j] !== "=" && text[j] !== ">") {
        j++;
      }

      const name = text.slice(start, j);
      while (isWhite(text[j])) {
        j++;
      }

      if (name === "" || text[j] !== "=") {
        return fail(ELEMENT_MALFORMED);
      }

      j++;
      while (isWhite(text[j])) {
        j++;
      }

      const quote = text[j];
      if (quote !== '"' && quote !== "'") {
        return fail(ELEMENT_MALFORMED);
      }

      const close = text.indexOf(quote, j + 1);
      if (close < 0) {
        return fail(ATTRIBUTE_NOT_TERMINATED);
      }

      if (!names.includes(name)) {
        names.push(name);
        values.push(unescapeXml(text.slice(j + 1, close)));
      }

      j = close + 1;
    }

    // Added last first, so that for..in, which lists the newest first, has them as written.
    for (let a = names.length - 1; a >= 0; a--) {
      element.attributes.define(names[a], values[a], 0);
    }

    for (let a = 0; a < names.length; a++) {
      if (names[a] === "id") {
        id(values[a], element);
      }
    }

    top().append(element, version);
    if (!empty) {
      open.push(element);
    }

    i = j;
  }

  return open.length > 1 ? fail(MISMATCHED_START) : parsed;
}

/** The document of an XML object; its root keeps the declarations. */
interface Document {
  root: XmlNode;
  idMap: Obj;
  status: Value;
}

/** What XML needs of the movie. */
export interface XmlClassHost extends XmlHost, LoadHost {}

/** `_global.XML`, given XMLNode's class, and its native side. */
export function xmlClass(host: XmlClassHost, nodes: XmlNodes): avm1.Avm1Function {
  const realm = host.realm;
  const documents = new WeakMap<Obj, Document>();
  const proto = new avm1.Avm1Object(nodes.proto);

  /** `text` read into the document of `self`, by its ignoreWhite. */
  const parse = (self: Obj, doc: Document, text: string, v: number) => {
    const ignoreWhite = avm1.toBoolean(avm1.get(self, "ignoreWhite", v), v);
    const parsed = parseXml(
      text,
      doc.root,
      ignoreWhite,
      (value, node) => doc.idMap.define(value, nodes.objectOf(node, v), 0),
      v,
    );
    doc.status = parsed.status;
    if (parsed.xmlDecl !== null) {
      doc.root.xmlDecl = parsed.xmlDecl;
    }

    if (parsed.docTypeDecl !== null) {
      doc.root.docTypeDecl = parsed.docTypeDecl;
    }
  };

  const constr = realm.classOf(
    proto,
    (self, args, v) => {
      const doc: Document = {
        root: new XmlNode(ELEMENT_NODE, null),
        idMap: new avm1.Avm1Object(),
        status: OK,
      };
      nodes.bind(self, doc.root);
      documents.set(self, doc);
      // No text, undefined or null, is no parse (adl: new XML(undefined) is empty).
      if (args[0] !== undefined && args[0] !== null) {
        parse(self, doc, avm1.stringOf(args[0], v), v);
      }

      return self;
    },
    () => undefined,
  );

  // In Flash's order, which for..in lists reversed (adl).
  const method = (name: string, fn: avm1.Native) => proto.define(name, realm.method(fn), 0);
  const property = (
    name: string,
    get: (doc: Document) => Value,
    set: ((doc: Document, value: Value, v: number) => void) | null,
    flags = 0,
  ) => {
    const p = proto.add(name, undefined, flags);
    p.get = realm.method((self) => {
      const doc = documents.get(self);
      return doc === undefined ? undefined : get(doc);
    });
    if (set !== null) {
      p.set = realm.method((self, args, v) => {
        const doc = documents.get(self);
        if (doc !== undefined) {
          set(doc, args[0], v);
        }

        return undefined;
      });
    }
  };
  /** A declaration as set: none for undefined or null. */
  const declaration = (value: Value, v: number) =>
    value === undefined || value === null ? null : avm1.stringOf(value, v);

  method("createElement", (self, args, v) => {
    if (!documents.has(self) || args.length === 0) {
      return undefined;
    }

    return nodes.objectOf(new XmlNode(ELEMENT_NODE, avm1.stringOf(args[0], v)), v);
  });
  method("createTextNode", (self, args, v) => {
    if (!documents.has(self) || args.length === 0) {
      return undefined;
    }

    return nodes.objectOf(new XmlNode(TEXT_NODE, avm1.stringOf(args[0], v)), v);
  });
  method("parseXML", (self, args, v) => {
    const doc = documents.get(self);
    if (doc === undefined) {
      return undefined;
    }

    for (let i = doc.root.children.length - 1; i >= 0; i--) {
      doc.root.children[i].remove(v);
    }

    if (args.length > 0) {
      parse(self, doc, avm1.stringOf(args[0], v), v);
    }

    return undefined;
  });
  method("load", (self, args, v) => {
    if (args[0] === null || !documents.has(self)) {
      return false;
    }

    const url = avm1.stringOf(args[0], v);
    startLoad(host, self, { url, method: "GET", headers: [], body: null }, v);
    return true;
  });
  // Flash 8's send: the document posted, its answer dropped; no window shows it.
  method("send", (self, args, v) => {
    const doc = documents.get(self);
    if (args.length === 0 || doc === undefined) {
      return false;
    }

    host.net.send(postOf(self, args[0], doc.root, v));
    return true;
  });
  method("sendAndLoad", (self, args, v) => {
    const doc = documents.get(self);
    const target = args[1];
    if (args[0] === null || doc === undefined || !(target instanceof avm1.Avm1Object)) {
      return undefined;
    }

    startLoad(host, target, postOf(self, args[0], doc.root, v), v);
    return undefined;
  });
  method("onLoad", () => undefined);
  method("onData", (self, args, v) => {
    const src = args[0];
    if (src === undefined) {
      call(self, "onLoad", [false], v);
    } else {
      call(self, "parseXML", [avm1.stringOf(src, v)], v);
      avm1.set(self, "loaded", true, v);
      call(self, "onLoad", [true], v);
    }

    return undefined;
  });
  method("getBytesLoaded", (self, _, v) => avm1.get(self, "_bytesLoaded", v));
  method("getBytesTotal", (self, _, v) => avm1.get(self, "_bytesTotal", v));
  method("addRequestHeader", (self, args, v) => addRequestHeader(self, args, v));
  proto.define("contentType", "application/x-www-form-urlencoded", 0);
  property(
    "docTypeDecl",
    (doc) => doc.root.docTypeDecl ?? undefined,
    (doc, value, v) => {
      doc.root.docTypeDecl = declaration(value, v);
    },
  );
  proto.define("ignoreWhite", false, 0);
  proto.define("loaded", undefined, 0);
  property(
    "status",
    (doc) => doc.status,
    (doc, value) => {
      doc.status = value;
    },
  );
  property(
    "xmlDecl",
    (doc) => doc.root.xmlDecl ?? undefined,
    (doc, value, v) => {
      doc.root.xmlDecl = declaration(value, v);
    },
  );
  property("idMap", (doc) => doc.idMap, null, avm1.DONT_ENUM | avm1.DONT_DELETE);

  /** `self`'s document posted to `url` as its contentType, with its request headers. */
  const postOf = (self: Obj, url: Value, root: XmlNode, v: number): NetRequest => {
    const type = avm1.stringOf(avm1.get(self, "contentType", v), v);
    return {
      url: avm1.stringOf(url, v),
      method: "POST",
      headers: [...headersOf(self), ["Content-Type", type]],
      body: bytesFor(serialize(root, v), v),
    };
  };

  return constr;
}

/** `self[name](...args)` where it is a function. */
export function call(self: Obj, name: string, args: Value[], v: number): Value {
  return avm1.invoke(avm1.get(self, name, v), self, args, v);
}
