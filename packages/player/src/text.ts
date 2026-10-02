// A TextField's text and formatting, as Flash keeps them: the characters,
// each with its own format, and a default format for text that comes with
// none. Its htmlText is written as Flash writes it, a P for each paragraph
// with a FONT of the run's five font attributes and a FONT inside it for
// each later run's changes, and read as Flash reads it, a paragraph's end
// and a BR a line only in a multiline field.

/** Every attribute a character's format has. */
export interface CharFormat {
  font: string;
  size: number;
  color: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  url: string;
  target: string;
  align: string;
  leftMargin: number;
  rightMargin: number;
  indent: number;
  leading: number;
  blockIndent: number;
  letterSpacing: number;
  kerning: boolean;
  bullet: boolean;
  tabStops: number[];
  display: string;
}

/** A TextFormat's values: null where it sets nothing, or where a range's characters differ. */
export type PartialFormat = { [K in keyof CharFormat]: CharFormat[K] | null };

/** A new TextField's defaultTextFormat, as adl gives it. */
export const DEFAULT_FORMAT: CharFormat = {
  font: "Times New Roman",
  size: 12,
  color: 0,
  bold: false,
  italic: false,
  underline: false,
  url: "",
  target: "",
  align: "left",
  leftMargin: 0,
  rightMargin: 0,
  indent: 0,
  leading: 0,
  blockIndent: 0,
  letterSpacing: 0,
  kerning: false,
  bullet: false,
  tabStops: [],
  display: "block",
};

export const FORMAT_KEYS = Object.keys(DEFAULT_FORMAT) as (keyof CharFormat)[];

/** A TextFormat that sets nothing. */
export function emptyFormat(): PartialFormat {
  const out = {} as PartialFormat;
  for (const k of FORMAT_KEYS) {
    (out as Record<string, unknown>)[k] = null;
  }

  out.display = "block";
  return out;
}

/** `base` with what `change` sets. */
export function applied(base: CharFormat, change: PartialFormat): CharFormat {
  const out = { ...base };
  for (const k of FORMAT_KEYS) {
    const v = change[k];
    if (v !== null) {
      (out as Record<string, unknown>)[k] = v;
    }
  }

  return out;
}

function same(a: CharFormat, b: CharFormat): boolean {
  return (
    a === b ||
    FORMAT_KEYS.every((k) =>
      k === "tabStops" ? a.tabStops.join() === b.tabStops.join() : a[k] === b[k],
    )
  );
}

/** Text as a field keeps it: Flash's line ends are \r. */
function normalize(text: string): string {
  return text.replace(/\r\n|\n/g, "\r");
}

export class TextModel {
  text = "";
  /** Each character's format; runs share one object. */
  formats: CharFormat[] = [];
  defaultFormat: CharFormat = { ...DEFAULT_FORMAT };

  /** The text, all in the default format, as `text` sets it. */
  setText(text: string): void {
    this.text = normalize(text);
    this.formats = new Array(this.text.length).fill(this.defaultFormat);
  }

  /**
   * `text` in place of [begin, end), as replaceText and appendText put it:
   * in the format of the character before, else of the one it replaces,
   * else the default.
   */
  replace(begin: number, end: number, text: string): void {
    const inserted = normalize(text);
    const format = this.formats[begin - 1] ?? this.formats[begin] ?? this.defaultFormat;
    this.text = this.text.slice(0, begin) + inserted + this.text.slice(end);
    this.formats.splice(begin, end - begin, ...new Array(inserted.length).fill(format));
  }

  /** What [begin, end) has in common: each value null where its characters differ; the default's for none. */
  formatOf(begin: number, end: number): PartialFormat {
    const out = { ...(this.formats[begin] ?? this.defaultFormat) } as PartialFormat;
    for (let i = begin + 1; i < end; i++) {
      const f = this.formats[i];
      for (const k of FORMAT_KEYS) {
        const v = out[k];
        if (
          v !== null &&
          (k === "tabStops" ? (v as number[]).join() !== f.tabStops.join() : v !== f[k])
        ) {
          (out as Record<string, unknown>)[k] = null;
        }
      }
    }

    return out;
  }

  /** [begin, end) given what `change` sets, as setTextFormat does. */
  setFormat(change: PartialFormat, begin: number, end: number): void {
    const made = new Map<CharFormat, CharFormat>();
    for (let i = begin; i < end; i++) {
      const old = this.formats[i];
      let next = made.get(old);
      if (!next) {
        next = applied(old, change);
        made.set(old, next);
      }

      this.formats[i] = next;
    }
  }

  /** The runs of each paragraph: its text up to a \r, in runs of one format. */
  private paragraphs(): { format: CharFormat; text: string }[][] {
    const out: { format: CharFormat; text: string }[][] = [];
    let runs: { format: CharFormat; text: string }[] = [];
    for (let i = 0; i < this.text.length; i++) {
      const c = this.text[i];
      if (c === "\r") {
        out.push(runs);
        runs = [];
        continue;
      }

      const last = runs[runs.length - 1];
      if (last && same(last.format, this.formats[i])) {
        last.text += c;
      } else {
        runs.push({ format: this.formats[i], text: c });
      }
    }

    if (runs.length) {
      out.push(runs);
    }

    return out;
  }

  /** The text as htmlText gives it. */
  toHtml(): string {
    const out: string[] = [];
    for (const runs of this.paragraphs()) {
      const first = runs[0]?.format ?? this.defaultFormat;
      const block: string[] = [];
      const extra: string[] = [];
      for (const [key, name] of [
        ["leftMargin", "LEFTMARGIN"],
        ["rightMargin", "RIGHTMARGIN"],
        ["indent", "INDENT"],
        ["leading", "LEADING"],
        ["blockIndent", "BLOCKINDENT"],
      ] as const) {
        if (first[key] !== 0) {
          extra.push(`${name}="${first[key]}"`);
        }
      }

      if (first.tabStops.length) {
        extra.push(`TABSTOPS="${first.tabStops.join(",")}"`);
      }

      // A bullet's paragraph is an LI alone, with no P.
      block.push(first.bullet ? "<LI>" : `<P ALIGN="${first.align.toUpperCase()}">`);

      let open = 0;
      let current: CharFormat | null = null;
      for (const { format, text } of runs) {
        const attributes = fontAttributes(format, current);
        if (attributes) {
          block.push(`<FONT ${attributes}>`);
          open++;
        }

        current = format;
        let run = escapeHtml(text);
        if (format.underline) {
          run = `<U>${run}</U>`;
        }

        if (format.italic) {
          run = `<I>${run}</I>`;
        }

        if (format.bold) {
          run = `<B>${run}</B>`;
        }

        if (format.url) {
          run = `<A HREF="${escapeHtml(format.url)}" TARGET="${escapeHtml(format.target)}">${run}</A>`;
        }

        block.push(run);
      }

      if (!runs.length) {
        block.push(`<FONT ${fontAttributes(first, null)}>`);
        open++;
      }

      block.push("</FONT>".repeat(open));
      block.push(first.bullet ? "</LI>" : "</P>");
      out.push(
        extra.length
          ? `<TEXTFORMAT ${extra.join(" ")}>${block.join("")}</TEXTFORMAT>`
          : block.join(""),
      );
    }

    return out.join("");
  }

  /**
   * htmlText set: tags read as Flash reads them, each run in the format
   * its tags give over the default; a paragraph's end and a BR end a line
   * only in a multiline field.
   */
  setHtml(html: string, multiline: boolean): void {
    let text = "";
    const formats: CharFormat[] = [];
    const stack: CharFormat[] = [this.defaultFormat];
    const top = () => stack[stack.length - 1];
    const add = (s: string, format: CharFormat) => {
      text += s;
      for (let k = 0; k < s.length; k++) {
        formats.push(format);
      }
    };
    const line = () => {
      if (multiline) {
        add("\r", top());
      }
    };

    const tag = /<(\/?)([a-zA-Z]+)([^>]*)>/g;
    let at = 0;
    for (let m = tag.exec(html); m; m = tag.exec(html)) {
      const plain = html.slice(at, m.index);
      if (plain) {
        add(normalize(unescapeHtml(plain)), top());
      }

      at = m.index + m[0].length;
      const closing = m[1] === "/";
      const name = m[2].toLowerCase();
      if (name === "br") {
        line();
        continue;
      }

      const known = ["p", "font", "b", "i", "u", "a", "textformat", "li", "span"];
      if (!known.includes(name)) {
        continue;
      }

      if (closing) {
        if (stack.length > 1) {
          stack.pop();
        }

        if (name === "p" || name === "li") {
          line();
        }

        continue;
      }

      const attributes = attributesOf(m[3]);
      const f = { ...top() };
      switch (name) {
        case "p":
          if (attributes.align) {
            f.align = attributes.align.toLowerCase();
          }
          break;
        case "font":
          if (attributes.face) {
            f.font = attributes.face;
          }

          if (attributes.size) {
            const size = attributes.size;
            f.size = /^[+-]/.test(size) ? f.size + Number(size) : Number(size);
          }

          if (attributes.color) {
            f.color = Number.parseInt(attributes.color.replace("#", ""), 16) || 0;
          }

          if (attributes.letterspacing) {
            f.letterSpacing = Number(attributes.letterspacing) || 0;
          }

          if (attributes.kerning) {
            f.kerning = attributes.kerning !== "0";
          }
          break;
        case "b":
          f.bold = true;
          break;
        case "i":
          f.italic = true;
          break;
        case "u":
          f.underline = true;
          break;
        case "a":
          f.url = attributes.href ?? "";
          f.target = attributes.target ?? "";
          break;
        case "li":
          f.bullet = true;
          break;
        case "textformat":
          for (const [attribute, key] of [
            ["leftmargin", "leftMargin"],
            ["rightmargin", "rightMargin"],
            ["indent", "indent"],
            ["leading", "leading"],
            ["blockindent", "blockIndent"],
          ] as const) {
            if (attributes[attribute] !== undefined) {
              f[key] = Number(attributes[attribute]) || 0;
            }
          }

          if (attributes.tabstops) {
            f.tabStops = attributes.tabstops.split(",").map(Number);
          }
          break;
      }

      stack.push(f);
    }

    const rest = html.slice(at);
    if (rest) {
      add(normalize(unescapeHtml(rest)), top());
    }

    this.text = text;
    this.formats = formats;
  }
}

/** A FONT's attributes for `format`: all five for a paragraph's first run, else those that differ from `current`; "" for none. */
function fontAttributes(format: CharFormat, current: CharFormat | null): string {
  const out: string[] = [];
  if (!current || current.font !== format.font) {
    out.push(`FACE="${escapeHtml(format.font)}"`);
  }

  if (!current || current.size !== format.size) {
    out.push(`SIZE="${format.size}"`);
  }

  if (!current || current.color !== format.color) {
    out.push(
      `COLOR="#${(format.color >>> 0).toString(16).toUpperCase().padStart(6, "0").slice(-6)}"`,
    );
  }

  if (!current || current.letterSpacing !== format.letterSpacing) {
    out.push(`LETTERSPACING="${format.letterSpacing}"`);
  }

  if (!current || current.kerning !== format.kerning) {
    out.push(`KERNING="${format.kerning ? 1 : 0}"`);
  }

  return out.join(" ");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number(name.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }

    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: " ",
    };
    return named[name.toLowerCase()] ?? whole;
  });
}

/** A tag's attributes by lower-case name, quoted with either quote or not. */
function attributesOf(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const attribute = /([a-zA-Z]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (let m = attribute.exec(source); m; m = attribute.exec(source)) {
    out[m[1].toLowerCase()] = unescapeHtml(m[3] ?? m[4] ?? m[5] ?? "");
  }

  return out;
}
