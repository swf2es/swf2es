// flash.desktop.Clipboard as Flash Player has it: one Clipboard, the
// system's, generalClipboard, over the player's (scripting/clipboard.ts).
// playerglobal's AS3 maps formats to these natives and checks access with
// canReadContents and canWriteContents: a script reads only in a paste,
// writes only in a user's event. Flash Player carries text, HTML, rich
// text, a script's own formats as references and serialized objects; a
// URL is kept as AIR keeps it, but bitmaps and files are AIR's alone.
import { avm2 } from "@swf2es/runtime";
import { HTML, TEXT } from "../../../scripting/clipboard.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

const RTF = "air:rtf";
const URL_FORMAT = "air:url";
const REFERENCE = "air:reference:";
const SERIALIZATION = "air:serialization:";

/** Whether `format` is one of Flash's own, which keeps its name, rather than a script's. */
const system = (format: string) => format.startsWith("air:") || format.startsWith("flash:");

export function clipboardNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const clipboard = () => s.clipboard;
  const str = (v: Value) => s.rt.toString(v);
  /** clear and clearData check their own access, as no AS3 does it for them. */
  const writing = () => {
    if (!clipboard().writable) {
      throw s.rt.error("SecurityError", 2191);
    }
  };
  /** A stored ByteArray from its start, as each read deserializes it anew. */
  const rewound = (v: Value): Value => {
    if (v) {
      avm2.bytesOf(s.rt, v as AsObject).position = 0;
    }

    return v ?? null;
  };

  class ClipboardNatives {
    static get generalClipboard(): Value {
      return general(s);
    }

    /** Its formats, a script's own by the names it gave them. */
    get formats(): Value {
      const names = clipboard().formats.map((f) =>
        f.startsWith(REFERENCE)
          ? f.slice(REFERENCE.length)
          : f.startsWith(SERIALIZATION)
            ? f.slice(SERIALIZATION.length)
            : f,
      );
      return s.rt.array([...new Set(names)]);
    }

    clear(): void {
      writing();
      clipboard().clear();
    }

    clearData(format: Value): void {
      writing();
      const name = str(format);
      if (system(name)) {
        clipboard().delete(name);
      } else {
        clipboard().delete(REFERENCE + name);
        clipboard().delete(SERIALIZATION + name);
      }
    }

    // A dead clipboard is AIR's, one let go of after a drag.
    get "flash.desktop:Clipboard::alive"(): boolean {
      return true;
    }

    get "flash.desktop:Clipboard::canReadContents"(): boolean {
      return clipboard().readable;
    }

    get "flash.desktop:Clipboard::canWriteContents"(): boolean {
      return clipboard().writable;
    }

    "flash.desktop:Clipboard::nativeSetHandler"(format: Value, handler: Value): void {
      clipboard().setHandler(str(format), () => {
        s.rt.call(handler, null);
      });
    }

    "flash.desktop:Clipboard::setHandlerStoringData"(storing: Value): void {
      clipboard().storing = !!storing;
    }

    "flash.desktop:Clipboard::getObjectReference"(format: Value): Value {
      return clipboard().get(str(format));
    }

    "flash.desktop:Clipboard::putObjectReference"(format: Value, value: Value): void {
      clipboard().set(str(format), value);
    }

    "flash.desktop:Clipboard::getString"(): Value {
      return clipboard().get(TEXT) ?? null;
    }

    "flash.desktop:Clipboard::putString"(text: Value): void {
      clipboard().set(TEXT, str(text));
    }

    "flash.desktop:Clipboard::getHTML"(): Value {
      return clipboard().get(HTML) ?? null;
    }

    "flash.desktop:Clipboard::putHTML"(html: Value): void {
      clipboard().set(HTML, str(html));
    }

    "flash.desktop:Clipboard::getRTF"(): Value {
      return rewound(clipboard().get(RTF));
    }

    "flash.desktop:Clipboard::putRTF"(bytes: Value): void {
      clipboard().set(RTF, bytes);
    }

    "flash.desktop:Clipboard::getByteArray"(format: Value): Value {
      return rewound(clipboard().get(str(format)));
    }

    "flash.desktop:Clipboard::putByteArray"(format: Value, bytes: Value): void {
      clipboard().set(str(format), bytes);
    }

    get "flash.desktop:Clipboard::swfVersion"(): number {
      return s.rt.swfVersion;
    }

    get supportsFilePromise(): boolean {
      return false;
    }

    "flash.desktop:Clipboard::getURL"(): Value {
      return clipboard().get(URL_FORMAT) ?? null;
    }

    "flash.desktop:Clipboard::putURL"(url: Value): void {
      clipboard().set(URL_FORMAT, str(url));
    }

    // Bitmaps and files go only through AIR's clipboard.
    "flash.desktop:Clipboard::getBitmapData"(): Value {
      return null;
    }

    "flash.desktop:Clipboard::putBitmapData"(): void {}

    "flash.desktop:Clipboard::getFileList"(): Value {
      return null;
    }

    "flash.desktop:Clipboard::nativePutFileList"(): void {}

    "flash.desktop:Clipboard::nativeGetFilePromiseList"(): Value {
      return null;
    }

    "flash.desktop:Clipboard::nativePutFilePromiseList"(): void {}
  }

  avm2.registerNativeClass(natives, "flash.desktop::Clipboard", ClipboardNatives);
  return natives;
}

/** Each player's generalClipboard, made on first use. */
const generals = new WeakMap<Scripting, AsObject>();
/** Whether the player is making its generalClipboard, the one Clipboard `new` may make. */
let making = false;

function general(s: Scripting): AsObject {
  let o = generals.get(s);
  if (!o) {
    making = true;
    try {
      o = s.rt.constructClass(s.rt.classNamed("flash.desktop::Clipboard"), []) as AsObject;
    } finally {
      making = false;
    }

    generals.set(s, o);
  }

  return o;
}

/**
 * `new Clipboard()` is AIR's: Flash Player has the system's alone, and
 * refuses another with IllegalOperationError #2178.
 */
export function clipboardHooks(): Record<string, avm2.ClassHook> {
  return {
    "flash.desktop::Clipboard": {
      construct(rt: avm2.Runtime, cls: AsObject, args: Value[]): Value {
        if (!making) {
          throw rt.error("flash.errors::IllegalOperationError", 2178);
        }

        const o = cls.$it.instance() as AsObject;
        cls.$it.proto.$init.apply(o, args);
        return o;
      },
    },
  };
}
