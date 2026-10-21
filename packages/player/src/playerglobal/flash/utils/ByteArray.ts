// The player supplies charset decoding where avmshell has a stub.
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

export function byteArrayNatives(s: Scripting): avm2.Natives {
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
