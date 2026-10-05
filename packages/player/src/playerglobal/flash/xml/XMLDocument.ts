// flash.xml's legacy XMLDocument: playerglobal's parseXML builds its tree
// from the tags of avmplus' XML tokenizer, the runtime's, through
// XMLParser and XMLTag; XMLNode escapes text as its toString writes it.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export function xmlDocumentNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class XMLParserNatives {
    declare $parser: avm2.XMLParser | undefined;

    startParse(source: Value, ignoreWhite: Value): void {
      const parser = new avm2.XMLParser(s.rt.toString(source));
      parser.parse(!!ignoreWhite);
      this.$parser = parser;
    }

    /** The next tag into `tag`, an element's attributes as an object; a status, 0 for a tag. */
    getNext(tag: Value): number {
      if (tag === null || tag === undefined) {
        throw s.rt.error("TypeError", 2007, "tag");
      }

      const parser = this.$parser;
      if (!parser) {
        return -1;
      }

      const next = new avm2.XMLTag();
      const status = parser.getNext(next);
      const o = tag as AsObject;
      o.$type = next.type;
      o.$value = next.text;
      o.$empty = next.empty;
      o.$attrs = next.type === 1 ? s.rt.newObject(next.attributes) : null;
      return status;
    }
  }

  class XMLTagNatives {
    declare $type: number | undefined;
    declare $empty: boolean | undefined;
    declare $value: string | null | undefined;
    declare $attrs: Value;

    get type(): number {
      return this.$type ?? 0;
    }

    set type(v: Value) {
      this.$type = s.rt.toUint(v);
    }

    get empty(): boolean {
      return this.$empty ?? false;
    }

    set empty(v: Value) {
      this.$empty = !!v;
    }

    get value(): Value {
      return this.$value ?? null;
    }

    set value(v: Value) {
      this.$value = v === null || v === undefined ? null : s.rt.toString(v);
    }

    get attrs(): Value {
      return this.$attrs ?? null;
    }

    set attrs(v: Value) {
      this.$attrs = v;
    }
  }

  class XMLNodeNatives {
    static "flash.xml:XMLNode::escapeXML"(value: Value): string {
      return s.rt.toString(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
    }
  }

  avm2.registerNativeClass(natives, "flash.xml::XMLParser", XMLParserNatives);
  avm2.registerNativeClass(natives, "flash.xml::XMLTag", XMLTagNatives);
  avm2.registerNativeClass(natives, "flash.xml::XMLNode", XMLNodeNatives);
  return natives;
}
