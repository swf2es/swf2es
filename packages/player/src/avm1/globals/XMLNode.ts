// XMLNode, AS1 and AS2's, and the tree XML documents are made of, as
// Ruffle's (https://github.com/ruffle-rs/ruffle) core/src/avm1/xml/tree.rs
// and core/src/avm1/globals/xml_node.rs have them: MIT OR Apache-2.0,
// Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors. A node is
// native, and its AVM1 object made as a script first reaches it, of
// XMLNode's prototype at that time; its attributes are a plain object
// without a prototype, listed by for..in in the order they were written.
import { avm1 } from "@swf2es/runtime";

type Value = avm1.Value;
type Obj = avm1.Avm1Object;

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;

export class XmlNode {
  /** Its AVM1 object, once a script has reached it. */
  object: Obj | null = null;
  parent: XmlNode | null = null;
  prev: XmlNode | null = null;
  next: XmlNode | null = null;
  readonly children: XmlNode[] = [];
  readonly attributes = new avm1.Avm1Object();
  /**
   * The `childNodes` array once asked for, kept in step with `children`,
   * and what makes a child's object for it.
   */
  childNodes: { array: Obj; objectOf: (node: XmlNode, version: number) => Obj } | null = null;
  /** A document's root's XML declaration and DOCTYPE, which its toString writes first. */
  xmlDecl: string | null = null;
  docTypeDecl: string | null = null;

  constructor(
    /** 1 for an element, 3 for text; any other number is kept, as text. */
    readonly type: number,
    /** An element's name or a text's value; null for a document's root. */
    public value: string | null,
  ) {}

  /** Itself and its ancestors, nearest first. */
  *ancestors(): Generator<XmlNode> {
    for (let n: XmlNode | null = this; n !== null; n = n.parent) {
      yield n;
    }
  }

  /** Whether `node` is this node or one of its ancestors. */
  private within(node: XmlNode): boolean {
    for (let n: XmlNode | null = this; n !== null; n = n.parent) {
      if (n === node) {
        return true;
      }
    }

    return false;
  }

  /** `child` put at `position` among the children, out of any other parent; nothing where it is an ancestor. */
  insert(position: number, child: XmlNode, version: number): void {
    // Only a node with children can be an ancestor but this one.
    if (child === this || (child.children.length > 0 && this.within(child))) {
      return;
    }

    const old = child.parent;
    if (old !== null) {
      old.orphan(child, version);
    }

    if (position >= this.children.length) {
      this.adopt(child, version);
      return;
    }

    child.parent = this;
    this.children.splice(position, 0, child);
    child.prev = this.children[position - 1] ?? null;
    child.next = this.children[position + 1] ?? null;
    if (child.prev !== null) {
      child.prev.next = child;
    }

    if (child.next !== null) {
      child.next.prev = child;
    }

    this.refresh(version);
  }

  append(child: XmlNode, version: number): void {
    this.insert(this.children.length, child, version);
  }

  /**
   * `child`, which has no parent, made the last child: no ancestor to
   * check, and `childNodes`, where a script has it, takes it in place.
   */
  adopt(child: XmlNode, version: number): void {
    const last = this.children.length > 0 ? this.children[this.children.length - 1] : null;
    child.parent = this;
    child.prev = last;
    child.next = null;
    if (last !== null) {
      last.next = child;
    }

    this.children.push(child);
    const cached = this.childNodes;
    if (cached !== null) {
      const i = this.children.length - 1;
      avm1.set(cached.array, String(i), cached.objectOf(child, version), version);
    }
  }

  /** Out of its parent's children. */
  remove(version: number): void {
    this.parent?.orphan(this, version);
  }

  /** Every child out, at once. */
  clear(version: number): void {
    for (const child of this.children) {
      child.parent = null;
      child.prev = null;
      child.next = null;
    }

    this.children.length = 0;
    this.refresh(version);
  }

  private orphan(child: XmlNode, version: number): void {
    const i = this.children.indexOf(child);
    if (i >= 0) {
      this.children.splice(i, 1);
    }

    child.unlink();
    child.parent = null;
    this.refresh(version);
  }

  /** Out of its siblings' list, which closes over the gap. */
  private unlink(): void {
    if (this.prev !== null) {
      this.prev.next = this.next;
    }

    if (this.next !== null) {
      this.next.prev = this.prev;
    }

    this.prev = null;
    this.next = null;
  }

  /**
   * `childNodes`, where a script has it, made the children's objects again,
   * in place, so that an array a script holds follows, as Flash's does.
   */
  refresh(version: number): void {
    const cached = this.childNodes;
    if (cached === null) {
      return;
    }

    avm1.set(cached.array, "length", 0, version);
    for (let i = 0; i < this.children.length; i++) {
      avm1.set(cached.array, String(i), cached.objectOf(this.children[i], version), version);
    }
  }

  /** The attributes' names, in the order for..in lists them, which is the order they were written. */
  attributeNames(version: number): string[] {
    return avm1.keys(this.attributes, version);
  }

  /** A copy, without a parent or an object, of its children too where `deep`; a loop, however deep. */
  duplicate(version: number, deep: boolean): XmlNode {
    const copy = (node: XmlNode) => {
      const clone = new XmlNode(node.type, node.value);
      copyAttributes(node.attributes, clone.attributes, version);
      return clone;
    };
    const root = copy(this);
    if (!deep) {
      return root;
    }

    const stack: [XmlNode, XmlNode][] = [[this, root]];
    for (let pair = stack.pop(); pair !== undefined; pair = stack.pop()) {
      const [from, to] = pair;
      for (const child of from.children) {
        const clone = copy(child);
        to.adopt(clone, version);
        stack.push([child, clone]);
      }
    }

    return root;
  }

  /**
   * The URI an `xmlns` attribute of it or an ancestor gives `prefix`, the
   * nearest first; the empty prefix takes any `xmlns` attribute.
   */
  namespaceOf(prefix: string, version: number): Value | null {
    for (const node of this.ancestors()) {
      for (const key of node.attributeNames(version)) {
        if (!key.startsWith("xmlns")) {
          continue;
        }

        const rest = key.slice(5);
        if (prefix === "" || (rest.startsWith(":") && rest.slice(1) === prefix)) {
          return avm1.get(node.attributes, key, version);
        }
      }
    }

    return null;
  }
}

/** `from`'s attributes on `to`, in the same for..in order. */
function copyAttributes(from: Obj, to: Obj, version: number): void {
  const names = avm1.keys(from, version);
  for (let i = names.length - 1; i >= 0; i--) {
    to.define(names[i], avm1.get(from, names[i], version), 0);
  }
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** `text` with XML's five characters escaped. */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * The node as XML text: an element with no children as `<a />`, a
 * document's root as its declarations and its children (adl).
 */
export function serialize(node: XmlNode, version: number): string {
  const out: string[] = [];
  if (node.xmlDecl !== null) {
    out.push(node.xmlDecl);
  }

  if (node.docTypeDecl !== null) {
    out.push(node.docTypeDecl);
  }

  // A loop over a stack of what is left to write, however deep the tree:
  // a node to open, or the end tag of an element whose children are written.
  const stack: (XmlNode | string)[] = [node];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if (typeof item === "string") {
      out.push(item);
      continue;
    }

    if (item.type !== ELEMENT_NODE) {
      out.push(escapeXml(item.value ?? ""));
      continue;
    }

    const name = item.value;
    if (name !== null) {
      out.push("<", name);
      for (const key of item.attributeNames(version)) {
        const value = avm1.stringOf(avm1.get(item.attributes, key, version), version);
        out.push(" ", key, '="', escapeXml(value), '"');
      }

      if (item.children.length === 0) {
        out.push(" />");
        continue;
      }

      out.push(">");
      stack.push(`</${name}>`);
    }

    for (let i = item.children.length - 1; i >= 0; i--) {
      stack.push(item.children[i]);
    }
  }

  return out.join("");
}

/** What XMLNode needs of the movie. */
export interface XmlHost {
  readonly realm: avm1.Realm;
}

/** The native side of the classes: the node of an object, and the object of a node. */
export interface XmlNodes {
  readonly constr: avm1.Avm1Function;
  readonly proto: Obj;
  /** The node `value` is the object of; null for anything else. */
  nodeOf(value: Value): XmlNode | null;
  /** `node`'s object, made now of XMLNode's prototype where it has none. */
  objectOf(node: XmlNode, version: number): Obj;
  /** `object` made the object of `node`. */
  bind(object: Obj, node: XmlNode): void;
}

/** `_global.XMLNode`. */
export function xmlNodeClass(host: XmlHost): XmlNodes {
  const realm = host.realm;
  const nodes = new WeakMap<Obj, XmlNode>();
  const nodeOf = (value: Value): XmlNode | null =>
    value instanceof avm1.Avm1Object ? (nodes.get(value) ?? null) : null;
  const bind = (object: Obj, node: XmlNode) => {
    node.object = object;
    nodes.set(object, node);
  };

  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    // Without a type and a value it is no node: its properties are undefined (adl).
    (self, args, v) => {
      if (args.length >= 2) {
        bind(self, new XmlNode(avm1.toNumber(args[0], v) & 0xff, avm1.stringOf(args[1], v)));
      }

      return self;
    },
    () => undefined,
  );
  // A node's object is of the prototype the class has when a script first reaches it.
  const objectOf = (node: XmlNode, version: number): Obj => {
    if (node.object === null) {
      const prototype = avm1.get(constr, "prototype", version);
      bind(new avm1.Avm1Object(prototype instanceof avm1.Avm1Object ? prototype : undefined), node);
    }

    return node.object as Obj;
  };
  const objectOrNull = (node: XmlNode | null, version: number): Value =>
    node === null ? null : objectOf(node, version);

  const method = (name: string, fn: avm1.Native) => proto.define(name, realm.method(fn), 0);
  /** A getter, and a setter where given, of a node, undefined for any other object. */
  const property = (
    name: string,
    get: (node: XmlNode, version: number) => Value,
    set?: (node: XmlNode, value: Value, version: number) => void,
  ) => {
    const p = proto.add(name, undefined, 0);
    p.get = realm.method((self, _, v) => {
      const node = nodes.get(self);
      return node === undefined ? undefined : get(node, v);
    });
    if (set !== undefined) {
      p.set = realm.method((self, args, v) => {
        const node = nodes.get(self);
        if (node !== undefined) {
          set(node, args[0], v);
        }

        return undefined;
      });
    }
  };

  method("cloneNode", (self, args, v) => {
    const node = nodes.get(self);
    if (node === undefined) {
      return undefined;
    }

    const deep = args.length > 0 && avm1.toBoolean(args[0], v);
    return objectOf(node.duplicate(v, deep), v);
  });
  method("removeNode", (self, _, v) => {
    nodes.get(self)?.remove(v);
    return undefined;
  });
  method("insertBefore", (self, args, v) => {
    const node = nodes.get(self);
    const child = nodeOf(args[0]);
    const before = nodeOf(args[1]);
    if (node === undefined || child === null || before === null || child.parent === node) {
      return undefined;
    }

    const position = node.children.indexOf(before);
    if (position >= 0) {
      node.insert(position, child, v);
    }

    return undefined;
  });
  method("appendChild", (self, args, v) => {
    const node = nodes.get(self);
    const child = nodeOf(args[0]);
    if (node !== undefined && child !== null && child.parent !== node) {
      node.append(child, v);
    }

    return undefined;
  });
  method("hasChildNodes", (self) => {
    const node = nodes.get(self);
    return node === undefined ? undefined : node.children.length > 0;
  });
  method("toString", (self, _, v) => {
    const node = nodes.get(self);
    return node === undefined ? "" : serialize(node, v);
  });
  method("getNamespaceForPrefix", (self, args, v) => {
    const node = nodes.get(self);
    if (node === undefined || args.length === 0) {
      return undefined;
    }

    return node.namespaceOf(avm1.stringOf(args[0], v), v);
  });
  method("getPrefixForNamespace", (self, args, v) => {
    const node = nodes.get(self);
    if (node === undefined || args.length === 0) {
      return undefined;
    }

    const uri = avm1.stringOf(args[0], v);
    for (const ancestor of node.ancestors()) {
      for (const key of ancestor.attributeNames(v)) {
        const value = avm1.stringOf(avm1.get(ancestor.attributes, key, v), v);
        if (value === uri && key.startsWith("xmlns")) {
          const rest = key.slice(5);
          return rest.startsWith(":") ? rest.slice(1) : "";
        }
      }
    }

    return null;
  });

  property("attributes", (node) => node.attributes);
  property("childNodes", (node, v) => {
    if (node.childNodes === null) {
      node.childNodes = { array: realm.newArray([], v), objectOf };
      node.refresh(v);
    }

    return node.childNodes.array;
  });
  property("firstChild", (node, v) => objectOrNull(node.children[0] ?? null, v));
  property("lastChild", (node, v) => objectOrNull(node.children.at(-1) ?? null, v));
  property("nextSibling", (node, v) => objectOrNull(node.next, v));
  // nodeName and nodeValue set the same: an element's name or a text's value.
  const setValue = (node: XmlNode, value: Value, v: number) => {
    if (value !== undefined) {
      node.value = avm1.stringOf(value, v);
    }
  };
  property("nodeName", (node) => (node.type === ELEMENT_NODE ? node.value : null), setValue);
  property("nodeType", (node) => node.type);
  property("nodeValue", (node) => (node.type === ELEMENT_NODE ? null : node.value), setValue);
  property("parentNode", (node, v) => objectOrNull(node.parent, v));
  property("previousSibling", (node, v) => objectOrNull(node.prev, v));
  property("prefix", (node) => {
    const name = node.type === ELEMENT_NODE ? node.value : null;
    if (name === null) {
      return null;
    }

    const colon = name.indexOf(":");
    return colon >= 0 && colon + 1 < name.length ? name.slice(0, colon) : "";
  });
  property("localName", (node) => {
    const name = node.type === ELEMENT_NODE ? node.value : null;
    if (name === null) {
      return null;
    }

    const colon = name.indexOf(":");
    return colon >= 0 && colon + 1 < name.length ? name.slice(colon + 1) : name;
  });
  property("namespaceURI", (node, v) => {
    const name = node.type === ELEMENT_NODE ? node.value : null;
    if (name === null) {
      return null;
    }

    const colon = name.indexOf(":");
    const prefix = colon >= 0 && colon + 1 < name.length ? name.slice(0, colon) : "";
    return node.namespaceOf(prefix, v) ?? "";
  });

  return { constr, proto, nodeOf, objectOf, bind };
}
