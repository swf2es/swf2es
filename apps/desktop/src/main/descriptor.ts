// An AIR application's descriptor (`<name>-app.xml`), as adl reads what it
// needs of one to run it: the application's id, and its first window's
// content SWF, title and size. Elements are found by name, whatever
// namespace the descriptor's AIR version gives them; what is not there is
// left to its default. Apart from Electron, so that node tests it
// (tests/desktop/descriptor.test.ts).

export interface Descriptor {
  id: string;
  /** The content SWF's path, relative to the application's directory, "/"-separated. */
  content: string;
  title: string | null;
  width: number | null;
  height: number | null;
}

/** The text of the first `<name>` element in `xml`, entities decoded; null for none. */
function element(xml: string, name: string): string | null {
  const m = new RegExp(
    `<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>`,
  ).exec(xml);
  return m ? decode(m[1].trim()) : null;
}

/** XML's five entities and its character references, and a CDATA section's text. */
function decode(text: string): string {
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(text);
  if (cdata) {
    return cdata[1];
  }

  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    switch (e.toLowerCase()) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return String.fromCodePoint(
          e[1].toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)),
        );
    }
  });
}

/** A whole number of pixels, or null for none or nonsense. */
function size(text: string | null): number | null {
  const n = text === null ? Number.NaN : Number(text);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** What `xml`, a descriptor, says; an Error naming what it lacks that adl requires. */
export function readDescriptor(xml: string): Descriptor {
  if (!/<(?:[\w.-]+:)?application[\s>]/.test(xml)) {
    throw new Error("not an AIR application descriptor: no <application>");
  }

  // The comments out first, which may hold an element of each name.
  const text = xml.replace(/<!--[\s\S]*?-->/g, "");
  const id = element(text, "id");
  const window = element(text, "initialWindow");
  const content = window === null ? null : element(window, "content");
  if (!id) {
    throw new Error("the descriptor names no <id>");
  }

  if (!content) {
    throw new Error("the descriptor's <initialWindow> names no <content>");
  }

  return {
    id,
    content: content.replaceAll("\\", "/"),
    title: window === null ? null : element(window, "title"),
    width: window === null ? null : size(element(window, "width")),
    height: window === null ? null : size(element(window, "height")),
  };
}
