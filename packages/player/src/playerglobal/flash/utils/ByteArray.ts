// The player supplies charset encoding and decoding where avmshell has stubs.
// Instances of a subclass bound to DefineBinaryData start with shared data
// at position 0, each seeing the others' writes until resized. Crossbridge
// keeps a C program's initialized data so, one subclass per data section.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

// AIR retains BOMs here, unlike readUTFBytes. Bound the cache for SWF-supplied labels.
const decoders = new Map<string, TextDecoder>();
let fallback: TextDecoder | undefined;

function decoderFor(name: string): TextDecoder {
  let decoder = decoders.get(name);
  if (decoder) {
    return decoder;
  }

  try {
    // Windows Flash does not accept these web-only labels or trim encoding names.
    if (name !== name.trim() || name === "utf8" || name === "euc-kr") {
      throw new RangeError();
    }

    decoder = new TextDecoder(name === "cn-gb" ? "gbk" : name, { ignoreBOM: true });
  } catch {
    // A browser has no system code page. Use the Western Windows Flash default.
    fallback ??= new TextDecoder("windows-1252");
    decoder = fallback;
  }

  if (name.length <= 64) {
    if (decoders.size === 32) {
      decoders.delete(decoders.keys().next().value as string);
    }

    decoders.set(name, decoder);
  }

  return decoder;
}

function singleByte(bytes: Uint8Array, ascii: boolean): string {
  if (ascii) {
    const end = bytes.findIndex((byte) => byte >= 0x80);
    if (end >= 0) {
      bytes = bytes.subarray(0, end);
    }
  }

  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 4096) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + 4096)));
  }

  return parts.join("");
}

function utf16(bytes: Uint8Array, little: boolean): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const parts: string[] = [];
  const units: number[] = [];
  for (let i = 0; i < bytes.length; i += 2) {
    const unit = view.getUint16(i, little);
    if (unit === 0) {
      break;
    }

    units.push(unit);
    if (units.length === 4096) {
      parts.push(String.fromCharCode(...units));
      units.length = 0;
    }
  }

  parts.push(String.fromCharCode(...units));
  return parts.join("");
}

// Windows Flash uses CP932's replacement and private-use characters for invalid Shift-JIS.
function shiftJisFallback(bytes: Uint8Array, decoder: TextDecoder): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if ((byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc)) {
      const next = bytes[++i];
      if (next === undefined || next < 0x40 || next === 0x7f || next > 0xfc) {
        parts.push("\u30fb");
      } else {
        parts.push(decoder.decode(bytes.subarray(i - 1, i + 1)).replaceAll("\ufffd", "\u30fb"));
      }
    } else if (byte === 0x80) {
      parts.push("\u0080");
    } else if (byte === 0xa0 || byte >= 0xfd) {
      parts.push(String.fromCharCode(byte === 0xa0 ? 0xf8f0 : 0xf8f1 + byte - 0xfd));
    } else {
      parts.push(decoder.decode(bytes.subarray(i, i + 1)));
    }
  }

  return parts.join("");
}

// What a code page writes for each character, from its decoder: every
// single byte, then for a double-byte page every lead and trail byte pair,
// the first sequence that decodes to a character kept for it. Made once
// per page, when first written in.
const encodings = new Map<string, Map<string, number>>();

/** Lead bytes of the double-byte pages TextDecoder knows; their trails are any byte from 0x40. */
const DOUBLE_BYTE = new Set(["shift_jis", "gbk", "gb18030", "big5", "euc-kr", "euc-jp"]);

function encodingFor(decoder: TextDecoder): Map<string, number> {
  let table = encodings.get(decoder.encoding);
  if (table) {
    return table;
  }

  table = new Map();
  const one = new Uint8Array(1);
  for (let byte = 0; byte < 0x100; byte++) {
    one[0] = byte;
    const text = decoder.decode(one);
    if (text.length === 1 && text !== "\ufffd" && !table.has(text)) {
      table.set(text, byte);
    }
  }

  if (DOUBLE_BYTE.has(decoder.encoding)) {
    const two = new Uint8Array(2);
    for (let lead = 0x81; lead < 0xff; lead++) {
      two[0] = lead;
      for (let trail = 0x40; trail < 0xff; trail++) {
        two[1] = trail;
        const text = decoder.decode(two);
        if (text.length === 1 && text !== "\ufffd" && !table.has(text)) {
          table.set(text, 0x10000 | (lead << 8) | trail);
        }
      }
    }
  }

  encodings.set(decoder.encoding, table);
  return table;
}

function utf16Bytes(text: string, little: boolean): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < text.length; i++) {
    view.setUint16(i * 2, text.charCodeAt(i), little);
  }

  return bytes;
}

/**
 * `text` in charset `name`, as Windows Flash converts it: UTF-8 and UTF-16
 * as they are, a code page's characters by its table, and a character it
 * has not as "?", as WideCharToMultiByte writes one.
 */
function encode(text: string, name: string): Uint8Array {
  switch (name) {
    case "utf-8":
      return new TextEncoder().encode(text);
    case "utf-16":
    case "utf-16le":
    case "unicode":
      return utf16Bytes(text, true);
    case "utf-16be":
    case "unicodefffe":
      return utf16Bytes(text, false);
  }

  const latin = name === "iso-8859-1" || name === "iso_8859-1" || name === "latin1";
  const ascii = name === "ascii" || name === "us-ascii";
  const table = latin || ascii ? null : encodingFor(decoderFor(name));
  const out: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    let byte: number | undefined;
    if (latin || ascii) {
      byte = char.length === 1 && code < (ascii ? 0x80 : 0x100) ? code : undefined;
    } else {
      byte = (table as Map<string, number>).get(char);
    }

    if (byte === undefined) {
      out.push(0x3f);
    } else if (byte > 0xffff) {
      out.push((byte >> 8) & 0xff, byte & 0xff);
    } else {
      out.push(byte);
    }
  }

  return new Uint8Array(out);
}

export function byteArrayNatives(s: Scripting): avm2.Natives {
  const write = (b: avm2.Bytes, value: Value, charset: Value): void => {
    const rt = s.rt;
    if (value === null || value === undefined) {
      throw rt.error("TypeError", 2007, "value");
    }

    if (charset === null || charset === undefined) {
      throw rt.error("TypeError", 2007, "charSet");
    }

    b.write(encode(rt.toString(value), rt.toString(charset).toLowerCase()));
  };

  const read = (b: avm2.Bytes, length: Value, charset: Value): string => {
    const rt = s.rt;
    if (charset === null || charset === undefined) {
      throw rt.error("TypeError", 2007, "charSet");
    }

    const count = rt.toUint(length);
    b.checkEOF(count);
    const name = rt.toString(charset).toLowerCase();
    switch (name) {
      case "utf-16":
      case "utf-16le":
      case "unicode":
        return utf16(b.readView(count - (count % 2)), true);
      case "utf-16be":
      case "unicodefffe":
        return utf16(b.readView(count - (count % 2)), false);
    }

    let bytes = b.readView(count);
    const nul = bytes.indexOf(0);
    if (nul >= 0) {
      bytes = bytes.subarray(0, nul);
    }

    switch (name) {
      case "iso-8859-1":
      case "iso_8859-1":
      case "latin1":
        return singleByte(bytes, false);
      case "ascii":
      case "us-ascii":
        return singleByte(bytes, true);
    }

    const decoder = decoderFor(name);
    const text = decoder.decode(bytes);
    return decoder.encoding === "shift_jis" && text.includes("\ufffd")
      ? shiftJisFallback(bytes, decoder)
      : text;
  };

  return {
    "flash.utils::ByteArray#readMultiByte": avm2.plain(function (
      this: avm2.AsObject,
      length: Value,
      charset: Value,
    ) {
      return read(avm2.bytesOf(s.rt, this), length, charset);
    }),
    "flash.utils::ByteArray#writeMultiByte": avm2.plain(function (
      this: avm2.AsObject,
      value: Value,
      charset: Value,
    ) {
      write(avm2.bytesOf(s.rt, this), value, charset);
    }),
    "flash.utils::ObjectOutput#writeMultiByte": avm2.plain(function (
      this: avm2.AsObject,
      value: Value,
      charset: Value,
    ) {
      write(this.$amf.bytes, value, charset);
    }),
    "flash.utils::ObjectInput#readMultiByte": avm2.plain(function (
      this: avm2.AsObject,
      length: Value,
      charset: Value,
    ) {
      return read(this.$amf.bytes, length, charset);
    }),
  };
}

export function byteArrayHooks(s: Scripting): Record<string, avm2.ClassHook> {
  return {
    "flash.utils::ByteArray": {
      ...avm2.byteArrayHook,
      create: (traits, rt) => {
        const o = avm2.byteArrayHook.create(traits, rt);
        const data = s.symbols.binarySymbol(traits);
        if (data) {
          const b = avm2.bytesOf(rt, o);
          b.buffer = data;
          b.view = new DataView(data.buffer);
          b.length = data.length;
        }

        return o;
      },
    },
  };
}
