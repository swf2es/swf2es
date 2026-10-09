// XML: its natives, held to XML.decl.ts, and what calling or
// constructing it does. They call the E4X engine in xml/.
//
// Its natives translated from avmplus' core/XMLObject.cpp and XMLClass.cpp,
// and its settings from core/XML.as, this file is subject to the Mozilla
// Public License, v. 2.0: http://mozilla.org/MPL/2.0/.

import type { AsObject, Value } from "../descriptors.js";
import type { ClassHook } from "../hooks.js";
import { publicNs } from "../names.js";
import { bindNatives } from "./bind.js";
import { XMLDecl } from "./XML.decl.js";
import { CDATA, COMMENT, ELEMENT, TEXT, type XMLNode } from "./xml/node.js";
import {
  addNamespace,
  adopt,
  appendChild,
  child,
  childChanges,
  childrenOf,
  constructXML,
  deepCopy,
  descendantsOf,
  e4x,
  elements,
  getXML,
  hasXML,
  insertAt,
  insertChild,
  isXML,
  namespaceDeclarations,
  namespaceOf,
  normalize,
  processingInstructions,
  qnameOf,
  removeNamespace,
  replace,
  setLocalName,
  setName,
  setNamespace,
  setXML,
  star,
  toAttributeName,
  toXML,
  toXMLName,
  xmlOf,
  xmlProperties,
  xmlToString,
  xmlToXMLString,
} from "./xml/xml.js";

/** XML's names looked up by the engine, and XML(x), new XML(x). */
const xmlHook: ClassHook = {
  properties: xmlProperties,
  construct: constructXML,
  call: (rt, _cls, args) =>
    args[0] === null || args[0] === undefined ? toXML(rt, "") : toXML(rt, args[0]),
};

/** XML's settings as XML.defaultSettings gives them. */
const DEFAULTS = {
  ignoreComments: true,
  ignoreProcessingInstructions: true,
  ignoreWhitespace: true,
  prettyPrinting: true,
  prettyIndent: 2,
};

export const XMLBuiltin = bindNatives(
  XMLDecl,
  (rt) =>
    class XMLNatives {
      // Its class hook makes the XML: this never runs on one.
      XML() {}

      static get ignoreComments(): boolean {
        return e4x(rt).ignoreComments;
      }

      static set ignoreComments(v: boolean) {
        e4x(rt).ignoreComments = v;
      }

      static get ignoreProcessingInstructions(): boolean {
        return e4x(rt).ignoreProcessingInstructions;
      }

      static set ignoreProcessingInstructions(v: boolean) {
        e4x(rt).ignoreProcessingInstructions = v;
      }

      static get ignoreWhitespace(): boolean {
        return e4x(rt).ignoreWhitespace;
      }

      static set ignoreWhitespace(v: boolean) {
        e4x(rt).ignoreWhitespace = v;
      }

      static get prettyPrinting(): boolean {
        return e4x(rt).prettyPrinting;
      }

      static set prettyPrinting(v: boolean) {
        e4x(rt).prettyPrinting = v;
      }

      static get prettyIndent(): number {
        return e4x(rt).prettyIndent;
      }

      static set prettyIndent(v: number) {
        e4x(rt).prettyIndent = v;
      }

      // The settings, as a new Object of them.
      static "AS3::settings"() {
        const e = e4x(rt);
        return rt.newObject([
          "ignoreComments",
          e.ignoreComments,
          "ignoreProcessingInstructions",
          e.ignoreProcessingInstructions,
          "ignoreWhitespace",
          e.ignoreWhitespace,
          "prettyPrinting",
          e.prettyPrinting,
          "prettyIndent",
          e.prettyIndent,
        ]);
      }

      // Null or undefined sets the defaults; an object, each setting it
      // has of the right type, as XML.as checks "in" and "is".
      static "AS3::setSettings"(o: Value) {
        const e = e4x(rt);
        if (o === null || o === undefined) {
          Object.assign(e, DEFAULTS);
          return;
        }

        for (const key of [
          "ignoreComments",
          "ignoreProcessingInstructions",
          "ignoreWhitespace",
          "prettyPrinting",
        ] as const) {
          const v = rt.in(key, o) ? rt.getProperty(o, rt.publicName(key)) : undefined;
          if (typeof v === "boolean") {
            e[key] = v;
          }
        }

        const indent = rt.in("prettyIndent", o)
          ? rt.getProperty(o, rt.publicName("prettyIndent"))
          : undefined;
        if (typeof indent === "number") {
          rt.setProperty(rt.builtinClass("XML"), rt.publicName("prettyIndent"), indent);
        }
      }

      static "AS3::defaultSettings"() {
        return rt.newObject(Object.entries(DEFAULTS).flat());
      }

      "AS3::length"() {
        return 1;
      }

      // As XML.as: with a prefix, the in-scope namespace of it; with none, its own.
      "AS3::namespace"(this: AsObject, ...args: Value[]) {
        const node: XMLNode = this.$node;
        return args.length ? namespaceOf(rt, node, 1, args[0]) : namespaceOf(rt, node, 0, null);
      }

      // As XML.as: the public toJSON, Object.prototype's or the prototype's own.
      "AS3::toJSON"(this: AsObject, k: string | null) {
        return rt.callProperty(this, rt.publicName("toJSON"), k);
      }

      "AS3::valueOf"(this: AsObject) {
        return this;
      }

      "AS3::toString"(this: AsObject) {
        const node: XMLNode = this.$node;
        return xmlToString(rt, node);
      }

      "AS3::toXMLString"(this: AsObject) {
        const node: XMLNode = this.$node;
        return xmlToXMLString(rt, node);
      }

      "AS3::hasOwnProperty"(this: AsObject, p: Value) {
        return hasXML(rt, this, toXMLName(rt, p));
      }

      "AS3::propertyIsEnumerable"(this: AsObject, p: Value) {
        return rt.toString(p) === "0";
      }

      "AS3::addNamespace"(this: AsObject, v: Value) {
        const node: XMLNode = this.$node;
        return addNamespace(rt, this, node, v);
      }

      "AS3::appendChild"(this: AsObject, c: Value) {
        const node: XMLNode = this.$node;
        return appendChild(rt, this, node, c);
      }

      "AS3::attribute"(this: AsObject, name: Value) {
        return getXML(rt, this, toAttributeName(rt, name));
      }

      "AS3::attributes"(this: AsObject) {
        return getXML(rt, this, toAttributeName(rt, "*"));
      }

      "AS3::child"(this: AsObject, name: Value) {
        const node: XMLNode = this.$node;
        return child(rt, this, node, name);
      }

      "AS3::childIndex"(this: AsObject) {
        const node: XMLNode = this.$node;
        return node.childIndex();
      }

      "AS3::children"(this: AsObject) {
        return getXML(rt, this, toXMLName(rt, "*"));
      }

      "AS3::comments"(this: AsObject) {
        const node: XMLNode = this.$node;
        return childrenOf(rt, this, node, COMMENT);
      }

      "AS3::contains"(this: AsObject, v: Value) {
        const node: XMLNode = this.$node;
        return this === v || (isXML(v) && node.equals(v.$node as XMLNode));
      }

      "AS3::copy"(this: AsObject) {
        const node: XMLNode = this.$node;
        return xmlOf(rt, deepCopy(rt, node));
      }

      "AS3::descendants"(this: AsObject, name: Value) {
        const node: XMLNode = this.$node;
        return descendantsOf(rt, node, toXMLName(rt, star(name)));
      }

      "AS3::elements"(this: AsObject, name: Value) {
        const node: XMLNode = this.$node;
        return elements(rt, this, node, star(name));
      }

      "AS3::hasComplexContent"(this: AsObject) {
        const node: XMLNode = this.$node;
        return node.hasComplexContent();
      }

      "AS3::hasSimpleContent"(this: AsObject) {
        const node: XMLNode = this.$node;
        return node.hasSimpleContent();
      }

      "AS3::inScopeNamespaces"(this: AsObject) {
        const node: XMLNode = this.$node;
        const list = node.inScopeNamespaces();
        return rt.newArray(list.length ? list : [publicNs]);
      }

      "AS3::insertChildAfter"(this: AsObject, c1: Value, c2: Value) {
        const node: XMLNode = this.$node;
        return insertChild(rt, this, node, c1, c2, true);
      }

      "AS3::insertChildBefore"(this: AsObject, c1: Value, c2: Value) {
        const node: XMLNode = this.$node;
        return insertChild(rt, this, node, c1, c2, false);
      }

      "AS3::localName"(this: AsObject) {
        const node: XMLNode = this.$node;
        return node.name;
      }

      "AS3::name"(this: AsObject) {
        const node: XMLNode = this.$node;
        return node.name === null ? null : qnameOf(rt, node);
      }

      "private::_namespace"(this: AsObject, prefix: Value, argc: Value) {
        const node: XMLNode = this.$node;
        return namespaceOf(rt, node, argc, prefix);
      }

      "AS3::namespaceDeclarations"(this: AsObject) {
        const node: XMLNode = this.$node;
        return namespaceDeclarations(rt, node);
      }

      "AS3::nodeKind"(this: AsObject) {
        const node: XMLNode = this.$node;
        return node.nodeKind();
      }

      "AS3::normalize"(this: AsObject) {
        const node: XMLNode = this.$node;
        normalize(rt, node);
        return this;
      }

      "AS3::parent"(this: AsObject) {
        const node: XMLNode = this.$node;
        return node.parent ? xmlOf(rt, node.parent) : undefined;
      }

      "AS3::processingInstructions"(this: AsObject, name: Value) {
        const node: XMLNode = this.$node;
        return processingInstructions(rt, this, node, star(name));
      }

      "AS3::prependChild"(this: AsObject, v: Value) {
        const node: XMLNode = this.$node;
        const c = adopt(v);
        insertAt(rt, node, 0, c);
        childChanges(rt, node, "nodeAdded", c);
        return this;
      }

      "AS3::removeNamespace"(this: AsObject, v: Value) {
        const node: XMLNode = this.$node;
        removeNamespace(rt, node, v);
        return this;
      }

      "AS3::replace"(this: AsObject, name: Value, v: Value) {
        const node: XMLNode = this.$node;
        return replace(rt, this, node, name, v);
      }

      "AS3::setChildren"(this: AsObject, v: Value) {
        setXML(rt, this, toXMLName(rt, "*"), v);
        return this;
      }

      "AS3::setLocalName"(this: AsObject, name: Value) {
        const node: XMLNode = this.$node;
        return setLocalName(rt, node, name);
      }

      "AS3::setName"(this: AsObject, name: Value) {
        const node: XMLNode = this.$node;
        return setName(rt, node, name);
      }

      "AS3::setNamespace"(this: AsObject, ns: Value) {
        const node: XMLNode = this.$node;
        return setNamespace(rt, node, ns);
      }

      "AS3::text"(this: AsObject) {
        const node: XMLNode = this.$node;
        return childrenOf(rt, this, node, TEXT | CDATA);
      }

      "AS3::notification"(this: AsObject) {
        const node: XMLNode = this.$node;
        return node.notification ?? null;
      }

      "AS3::setNotification"(this: AsObject, f: Value) {
        const node: XMLNode = this.$node;
        if (f !== null && f !== undefined && !f.$f) {
          throw rt.error("ArgumentError", 1508, "f");
        }

        if (node.kind === ELEMENT) {
          node.notification = f ?? null;
        }

        return undefined;
      }
    },
  xmlHook,
);
