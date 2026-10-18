// TextSnapshot's AS2 face, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/globals/text_snapshot.rs and display_object/text.rs's
// TextSnapshot have it: MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle
// LLC and Ruffle contributors. A snapshot is a clip's static texts' text,
// its direct children's in the order they are drawn, as it was when made:
// dynamic and input fields are not in it, nor the clip's grandchildren.
// Selection, hit tests, the select colour and the run info do nothing yet,
// as in Ruffle.
import { avm1 } from "@swf2es/runtime";
import { MovieClip, StaticTextObject } from "../../display/display.js";
import { asciiLower } from "../paths.js";

type Value = avm1.Value;
type Obj = avm1.Avm1Object;

/** A static text's text in a snapshot, and where it starts in the whole. */
interface Chunk {
  readonly text: string;
  readonly start: number;
}

/** A clip's static texts' text, as they were when the snapshot was made. */
export class Snapshot {
  readonly chunks: Chunk[] = [];
  readonly count: number;

  constructor(clip: MovieClip) {
    let start = 0;
    for (const child of clip.children) {
      const text = child instanceof StaticTextObject ? child.glyphs.text : null;
      if (text !== null && text !== "") {
        this.chunks.push({ text, start });
        start += text.length;
      }
    }

    this.count = start;
  }

  /** Each chunk's part from `from` to `to`, the indices the whole's. */
  private parts(from: number, to: number): string[] {
    return this.chunks
      .filter((c) => c.start < to && c.start + c.text.length > from)
      .map((c) => c.text.slice(Math.max(0, from - c.start), Math.max(0, to - c.start)));
  }

  /**
   * The text from `from` to `to`, at least one character, both clamped to
   * the text, a negative index 0; with `newlines`, a "\n" between texts.
   */
  getText(from: number, to: number, newlines: boolean): string {
    if (this.count === 0) {
      return "";
    }

    const start = Math.min(Math.max(0, from), this.count - 1);
    const end = Math.max(Math.min(Math.max(0, to), this.count), start + 1);
    return this.parts(start, end).join(newlines ? "\n" : "");
  }

  /** Where `text` is first found from `from` on, ASCII's case aside unless `caseSensitive`; -1 for none. */
  findText(from: number, text: string, caseSensitive: boolean): number {
    if (text === "" || from < 0) {
      return -1;
    }

    const whole = this.parts(from, this.count).join("");
    const index = caseSensitive ? whole.indexOf(text) : asciiLower(whole).indexOf(asciiLower(text));
    return index < 0 ? -1 : from + index;
  }
}

/** `TextSnapshot`. */
export function textSnapshotClass(realm: avm1.Realm): Obj {
  const snapshots = new WeakMap<Obj, Snapshot>();
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    // Of a clip given alone; anything else makes a snapshot of nothing, whose methods give undefined.
    (self, args) => {
      const target = args.length === 1 ? args[0] : undefined;
      const clip = target instanceof avm1.Avm1Object ? target.display?.target : undefined;
      if (clip instanceof MovieClip) {
        snapshots.set(self, new Snapshot(clip));
      }

      return self;
    },
    () => undefined,
  );
  const method = (name: string, f: (s: Snapshot, args: Value[], v: number) => Value) =>
    proto.define(
      name,
      realm.method((self, args, v) => {
        const s = snapshots.get(self);
        return s === undefined ? undefined : f(s, args, v);
      }),
      avm1.VERSION_6,
    );
  const none = () => undefined;

  method("getCount", (s, args) => (args.length === 0 ? s.count : undefined));
  method("setSelected", none);
  method("getSelected", none);
  method("getText", (s, args, v) =>
    args.length < 2 || args.length > 3
      ? undefined
      : s.getText(
          avm1.toNumber(args[0], v) | 0,
          avm1.toNumber(args[1], v) | 0,
          avm1.toBoolean(args[2], v),
        ),
  );
  method("getSelectedText", none);
  method("hitTestTextNearPos", none);
  method("findText", (s, args, v) =>
    args.length !== 3
      ? undefined
      : s.findText(
          avm1.toNumber(args[0], v) | 0,
          avm1.stringOf(args[1], v),
          avm1.toBoolean(args[2], v),
        ),
  );
  method("setSelectColor", none);
  method("getTextRunInfo", none);
  return constr;
}
