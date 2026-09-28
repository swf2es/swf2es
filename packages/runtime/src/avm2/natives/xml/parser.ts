// XML text into tags, as avmplus' XMLParser: a tokenizer, not a validating
// parser, whose leniency and errors are avmplus', which E4X's are. The tree
// is made from its tags in xml.ts.
//
// Translated from avmplus' core/XMLParser16.cpp, this file is subject to the
// Mozilla Public License, v. 2.0: http://mozilla.org/MPL/2.0/.
import { isSpace } from "./chars.js";

// The tags, as XMLTag's node types.
export const TAG_ELEMENT = 1;
export const TAG_TEXT = 3;
export const TAG_CDATA = 4;
export const TAG_PROCESSING_INSTRUCTION = 7;
export const TAG_COMMENT = 8;
export const TAG_DOCTYPE = 10;
export const TAG_XML_DECLARATION = 13;

// What getNext gives, as XMLParser's status codes: a tag, the end, or the
// error E4X throws for each (see ERRORS in xml.ts).
export const OK = 0;
export const END = -1;
export const UNTERMINATED_CDATA = -2;
export const UNTERMINATED_XML_DECLARATION = -3;
export const UNTERMINATED_DOCTYPE = -4;
export const UNTERMINATED_COMMENT = -5;
export const MALFORMED_ELEMENT = -6;
export const UNTERMINATED_ATTRIBUTE_VALUE = -8;
export const UNTERMINATED_PROCESSING_INSTRUCTION = -10;

export class XMLTag {
  type = 0;
  /** An element's name (with "/" first for an end tag), or the text of any other tag. */
  text = "";
  /** Whether an element closed itself, as <a/>. */
  empty = false;
  /** An element's attributes, name then value. */
  attributes: string[] = [];

  reset(): void {
    this.type = 0;
    this.text = "";
    this.empty = false;
    this.attributes = [];
  }
}

/** The entities XMLParser knows: the XML ones, and nbsp. */
const ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: "\u00a0",
};

export class XMLParser {
  private pos = 0;
  private ignoreWhite = false;
  private condenseWhite = false;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  /** As XMLParser::parse: from the start, whitespace-only text left out if `ignoreWhite`. */
  parse(ignoreWhite: boolean): void {
    this.pos = 0;
    this.ignoreWhite = ignoreWhite;
  }

  setCondenseWhite(condense: boolean): void {
    this.condenseWhite = condense;
  }

  private atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  /** Past whitespace: false at the end. */
  private skipWhiteSpace(): boolean {
    while (!this.atEnd() && isSpace(this.text.charCodeAt(this.pos))) {
      this.pos++;
    }

    return !this.atEnd();
  }

  /** Whether the text at `at` starts with `s`, ignoring ASCII case, as matchesLatin1_caseless. */
  private matchesCaseless(s: string, at: number): boolean {
    return this.text.slice(at, at + s.length).toLowerCase() === s.toLowerCase();
  }

  /** The next tag into `tag`: OK, END, or an error. */
  getNext(tag: XMLTag): number {
    const str = this.text;
    tag.reset();
    if (this.atEnd()) {
      return END;
    }

    // With ignoreWhite, no text nodes of whitespace alone.
    if (this.ignoreWhite && !this.skipWhiteSpace()) {
      return END;
    }

    let start = this.pos;
    if (str[this.pos] !== "<") {
      // Text, up to the next < or the end.
      let next = str.indexOf("<", this.pos + 1);
      if (next < 0) {
        next = str.length;
      }

      this.pos = next;
      tag.text = this.unescape(start, next);
      if (this.ignoreWhite && this.condenseWhite) {
        tag.text = trimWhitespace(tag.text);
      }

      tag.type = TAG_TEXT;
      return OK;
    }

    if (this.matchesCaseless("<?xml ", start)) {
      const end = str.indexOf("?>", start + 6);
      if (end >= 0) {
        tag.text = str.slice(start + 2, end);
        this.pos = end + 2;
        tag.type = TAG_XML_DECLARATION;
        return OK;
      }

      return UNTERMINATED_XML_DECLARATION;
    }

    if (this.matchesCaseless("<!DOCTYPE", start)) {
      // Up to its >, past any <...> within it.
      let depth = 0;
      let end = start + 1;
      while (!this.atEnd()) {
        const ch = str[end++];
        if (ch === "<") {
          depth++;
        } else if (ch === ">") {
          if (!depth) {
            tag.text = str.slice(start, end);
            tag.type = TAG_DOCTYPE;
            this.pos = end;
            return OK;
          }

          depth--;
        }

        this.pos = end;
      }

      return UNTERMINATED_DOCTYPE;
    }

    if (this.matchesCaseless("<![CDATA[", start)) {
      start += 9;
      const end = str.indexOf("]]>", start);
      if (end >= 0) {
        tag.text = str.slice(start, end);
        tag.type = TAG_CDATA;
        this.pos = end + 3;
        return OK;
      }

      return UNTERMINATED_CDATA;
    }

    if (str.startsWith("<?", start)) {
      start += 2;
      const end = str.indexOf("?>", start);
      if (end >= 0) {
        tag.text = str.slice(start, end);
        tag.type = TAG_PROCESSING_INSTRUCTION;
        this.pos = end + 2;
        return OK;
      }

      return UNTERMINATED_PROCESSING_INSTRUCTION;
    }

    start = ++this.pos;
    if (str.startsWith("!--", start)) {
      start += 3;
      const end = str.indexOf("-->", start);
      if (end >= 0) {
        tag.text = str.slice(start, end);
        tag.type = TAG_COMMENT;
        this.pos = end + 3;
        return OK;
      }

      return UNTERMINATED_COMMENT;
    }

    // An element: its name, up to >, whitespace or />.
    start = this.pos;
    while (!this.atEnd()) {
      const ch = str[this.pos];
      if (ch === ">" || isSpace(ch.charCodeAt(0))) {
        break;
      }

      if (ch === "/" && this.pos < str.length - 1 && str[this.pos + 1] === ">") {
        break;
      }

      this.pos++;
    }

    if (this.atEnd() || this.pos === start) {
      return MALFORMED_ELEMENT;
    }

    tag.text = this.unescape(start, this.pos);
    tag.type = TAG_ELEMENT;

    // Its attributes.
    let ch = "";
    for (;;) {
      if (!this.skipWhiteSpace()) {
        return MALFORMED_ELEMENT;
      }

      ch = str[this.pos];
      if (ch === ">") {
        break;
      }

      if (ch === "/" && this.pos < str.length - 1 && str[this.pos + 1] === ">") {
        tag.empty = true;
        ch = str[++this.pos];
        break;
      }

      start = this.pos;
      while (!isSpace(ch.charCodeAt(0)) && ch !== "=" && ch !== ">") {
        this.pos++;
        if (this.atEnd()) {
          return MALFORMED_ELEMENT;
        }

        ch = str[this.pos];
      }

      if (start === this.pos) {
        return MALFORMED_ELEMENT;
      }

      const name = this.unescape(start, this.pos);
      if (!this.skipWhiteSpace()) {
        return MALFORMED_ELEMENT;
      }

      if (str[this.pos++] !== "=") {
        return MALFORMED_ELEMENT;
      }

      if (!this.skipWhiteSpace()) {
        return MALFORMED_ELEMENT;
      }

      const delimiter = str[this.pos++];
      if (delimiter !== '"' && delimiter !== "'") {
        return MALFORMED_ELEMENT;
      }

      // Up to the closing quote; < is not allowed within.
      start = this.pos;
      ch = "";
      while (ch !== delimiter) {
        if (this.atEnd() || ch === "<") {
          return UNTERMINATED_ATTRIBUTE_VALUE;
        }

        ch = str[this.pos++];
      }

      tag.attributes.push(name, this.unescape(start, this.pos - 1));
    }

    if (ch === ">") {
      this.pos++;
    }

    return OK;
  }

  /**
   * As XMLParser::unescape: [start, last) with its entity and character
   * references decoded: &#dd; and &#xhh; up to 0xFFFF, and ENTITIES. An &
   * without a ; ends the decoding; one that is not a known reference is
   * kept as it is.
   */
  private unescape(start: number, last: number): string {
    const str = this.text;
    if (start === last) {
      return "";
    }

    let bgn = str.indexOf("&", start);
    if (bgn < 0 || bgn >= last) {
      return str.slice(start, last);
    }

    let dest = "";
    let end = start;
    while (bgn >= start && bgn < last) {
      const ampBgn = bgn;
      const ampEnd = str.indexOf(";", ++bgn);
      if (ampEnd < 0 || ampEnd >= last) {
        break;
      }

      dest += str.slice(end, bgn - 1);
      end = ampEnd;
      let len = end - bgn;
      let ok = true;
      if (len >= 2) {
        if (str[bgn] === "#") {
          let ch = str.charCodeAt(++bgn);
          len--;
          let base = 10;
          if (len >= 2 && ch === 0x78) {
            base = 16;
            bgn++;
            len--;
          }

          if (len > 0) {
            let value = 0;
            while (len-- && ok) {
              ch = str.charCodeAt(bgn++);
              if (ch >= 0x41 && ch <= 0x46) {
                ch -= 7;
              } else if (ch >= 0x61 && ch <= 0x66) {
                ch -= 0x61 - 0x41 + 7;
              }

              ch -= 0x30;
              if (ch >= 0 && ch < base) {
                value = value * base + ch;
              } else {
                ok = false;
              }

              if (value > 0xffff) {
                ok = false;
              }
            }

            if (ok) {
              dest += String.fromCharCode(value);
              bgn = ++end;
            }
          }
        } else if (len <= 4) {
          const entity = ENTITIES[str.slice(bgn, end)];
          if (entity !== undefined && Object.hasOwn(ENTITIES, str.slice(bgn, end))) {
            dest += entity;
            bgn = ++end;
          } else {
            ok = false;
          }
        } else {
          ok = false;
        }
      } else {
        ok = false;
      }

      if (!ok) {
        // Kept as it is, rather than dropped, which would break content.
        bgn = end + 1;
        if (ampBgn < end) {
          dest += str.slice(ampBgn, end);
        }
      }

      bgn = str.indexOf("&", bgn);
      if (bgn >= last) {
        bgn = -1;
      }
    }

    if (end < last) {
      dest += str.slice(end, last);
    }

    return dest;
  }
}

/** As _condenseWhitespace: `s` without leading and trailing whitespace. */
function trimWhitespace(s: string): string {
  let start = 0;
  while (start < s.length && isSpace(s.charCodeAt(start))) {
    start++;
  }

  let end = s.length - 1;
  while (end > start && isSpace(s.charCodeAt(end))) {
    end--;
  }

  return s.slice(start, end + 1);
}
