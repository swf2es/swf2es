// The system's clipboard as a SWF sees it, flash.desktop.Clipboard's
// generalClipboard and System.setClipboard's: what it holds by Flash's
// native format names, and when scripts may touch it. Flash Player 10 lets
// a script write only while it handles a user's event, a key, a mouse
// button, a copy or a cut, and read only while it handles a paste.
import type { avm2 } from "@swf2es/runtime";
import type { ClipboardHost, ClipboardText } from "../hosts.js";

type Value = avm2.Value;

/** ClipboardFormats.TEXT_FORMAT and HTML_FORMAT, the formats a browser's clipboard carries too. */
export const TEXT = "air:text";
export const HTML = "air:html";

export class Clipboard {
  /**
   * What it holds, by native name: "air:text", "air:html", "air:rtf" and
   * "air:url", and a script's own formats as "air:reference:" and
   * "air:serialization:" and the name.
   */
  readonly contents = new Map<string, Value>();
  /**
   * Clipboard.setDataHandler's handlers, by native name, each run once
   * when its format is first read, and storing its data as it runs.
   */
  private readonly handlers = new Map<string, () => void>();
  /** A handler storing its data, which leaves the other handlers be. */
  storing = false;
  /** Moves with every write, so a gesture or a copy can tell whether a script wrote. */
  private version = 0;
  private gestures = 0;
  private pastes = 0;
  /** Inside a copy or cut whose event carries the data to the system, which then needs no write of its own. */
  private collecting = 0;

  constructor(private readonly host: ClipboardHost | null) {}

  /** Whether a script may write now: while a user's event is handled. */
  get writable(): boolean {
    return this.gestures > 0;
  }

  /** Whether a script may read now: while a paste is handled. */
  get readable(): boolean {
    return this.pastes > 0;
  }

  /** The text, and HTML if any, that goes to the system's clipboard. */
  get data(): ClipboardText {
    const text = this.get(TEXT);
    const html = this.get(HTML);
    return {
      text: typeof text === "string" ? text : "",
      ...(typeof html === "string" ? { html } : {}),
    };
  }

  /** The formats it holds, by native name, those a handler will give too. */
  get formats(): string[] {
    return [...new Set([...this.contents.keys(), ...this.handlers.keys()])];
  }

  /** What `format` holds, after its handler, if any, has run. */
  get(format: string): Value {
    const handler = this.handlers.get(format);
    if (handler) {
      this.handlers.delete(format);
      handler();
    }

    return this.contents.get(format);
  }

  set(format: string, value: Value): void {
    if (!this.storing) {
      this.handlers.delete(format);
    }

    this.contents.set(format, value);
    this.version++;
  }

  /** `handler` to give `format`'s data when it is first read, in place of what it holds. */
  setHandler(format: string, handler: () => void): void {
    this.contents.delete(format);
    this.handlers.set(format, handler);
    this.version++;
  }

  delete(format: string): void {
    this.contents.delete(format);
    this.handlers.delete(format);
    this.version++;
  }

  clear(): void {
    this.contents.clear();
    this.handlers.clear();
    this.version++;
  }

  /**
   * `f` as the handling of a user's event, in which scripts may write;
   * once the outermost ends, what they wrote goes to the host, unless a
   * copy event takes it.
   */
  gesture<T>(f: () => T): T {
    const start = this.version;
    this.gestures++;
    try {
      return f();
    } finally {
      this.gestures--;
      if (this.gestures === 0 && this.collecting === 0 && this.version !== start) {
        // A host that throws must not take the key or press's handling with it.
        try {
          this.host?.write(this.data);
        } catch {
          // The system's clipboard keeps what it had.
        }
      }
    }
  }

  /** `f` as a copy or cut: what it wrote, for the host's event to carry, or null where it wrote nothing. */
  collect(f: () => void): ClipboardText | null {
    const start = this.version;
    this.collecting++;
    try {
      this.gesture(f);
    } finally {
      this.collecting--;
    }

    return this.version !== start ? this.data : null;
  }

  /**
   * `f` as a paste of `data` from the system, in which scripts may read
   * it. The clipboard's own formats stay where the system's text is what
   * the SWF last put there, as a copy within the SWF comes back.
   */
  paste<T>(data: ClipboardText | null, f: () => T): T {
    if (data) {
      this.receive(data);
    }

    this.pastes++;
    try {
      return this.gesture(f);
    } finally {
      this.pastes--;
    }
  }

  private receive({ text, html }: ClipboardText): void {
    const held = this.data;
    if (held.text === text && (html === undefined || held.html === html)) {
      return;
    }

    this.contents.clear();
    this.handlers.clear();
    this.contents.set(TEXT, text);
    if (html !== undefined) {
      this.contents.set(HTML, html);
    }
  }
}
