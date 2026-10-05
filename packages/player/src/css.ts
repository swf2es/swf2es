// The CSS that StyleSheet.parseCSS reads, as Flash reads it: selectors
// before a block, properties name: value inside, comments skipped. Flash
// finds few things wrong, and on any of them the whole sheet is ignored
// (Ruffle's CssStream, which its corpus checks against Flash).

const WHITESPACE = " \n\r\t";

/** Each selector's properties, names as written; null for a sheet Flash rejects. */
export function parseCss(input: string): Map<string, Map<string, string>> | null {
  let pos = 0;
  const peek = (): string | undefined => input[pos];

  const skipComment = (): boolean => {
    if (input.startsWith("/*", pos)) {
      pos += 2;
      while (!input.startsWith("*/", pos)) {
        pos++;
        if (pos >= input.length) {
          return false;
        }
      }

      pos += 2;
      return true;
    }

    return false;
  };

  const skip = (): boolean => {
    let found = false;
    while (skipComment() || (pos < input.length && WHITESPACE.includes(input[pos]))) {
      if (pos < input.length && WHITESPACE.includes(input[pos])) {
        pos++;
      }

      found = true;
    }

    return found;
  };

  const until = (stops: string): string => {
    const start = pos;
    while (pos < input.length && !stops.includes(input[pos])) {
      pos++;
    }

    return input.slice(start, pos);
  };

  const selectors = (): string[] | null => {
    const out: string[] = [];
    for (;;) {
      skip();
      const name = until("{, \n\r\t");
      if (name) {
        out.push(name);
      }

      skip();
      const next = peek();
      if (next === "{") {
        pos++;
        if (!out.length) {
          out.push("");
        }

        return out;
      }

      if (next !== ",") {
        return null;
      }

      pos++;
    }
  };

  const properties = (): Map<string, string> | null => {
    const out = new Map<string, string>();
    for (;;) {
      skip();
      if (peek() === "}") {
        pos++;
        return out;
      }

      if (peek() === undefined) {
        return out;
      }

      // Spaces before a name are skipped, after it kept, and within it an error.
      const start = pos;
      let name = until(": \n\r\t");
      if (skip()) {
        if (peek() === ":") {
          name = input.slice(start, pos);
        } else if (peek() !== undefined) {
          return null;
        }
      }

      if (peek() !== ":") {
        return null;
      }

      pos++;
      skip();
      const valueStart = pos;
      let value = until(";:}");
      for (;;) {
        const next = peek();
        if (next === ":") {
          // A colon in a value ends it at the line's end, if it has one.
          pos = valueStart;
          const line = until("\n\r");
          if (peek() !== undefined) {
            pos++;
            out.set(name, line);
            break;
          }

          pos = valueStart;
          value = until(";}");
          continue;
        }

        if (next === ";") {
          pos++;
          out.set(name, value);
          break;
        }

        if (next === "}") {
          pos++;
          const end = value.search(/[\n\r]/);
          out.set(name, end < 0 ? value : value.slice(0, end));
          return out;
        }

        return null;
      }
    }
  };

  const result = new Map<string, Map<string, string>>();
  for (;;) {
    skip();
    if (peek() === undefined) {
      return result;
    }

    const names = selectors();
    if (!names) {
      return null;
    }

    const block = properties();
    if (!block) {
      return null;
    }

    for (const name of names) {
      result.set(name, new Map(block));
    }
  }
}

/** A property name as a style object has it: font-size is fontSize. */
export function camelCase(name: string): string {
  return name.replace(/-(.)/g, (_, c: string) => c.toUpperCase());
}

/** A font-family list as a TextFormat's font: the generic families as Flash names them, spaces dropped around names. */
export function fontList(input: string): string {
  const generic: Record<string, string> = {
    mono: "_typewriter",
    "sans-serif": "_sans",
    serif: "_serif",
  };
  return input
    .split(",")
    .map((name) => name.replace(/^ +/, ""))
    .filter((name) => name !== "")
    .map((name) => generic[name] ?? name)
    .join(",");
}

/** A colour #RRGGBB, of at most six digits; 0 for anything else. */
export function cssColor(input: string): number {
  if (!input.startsWith("#")) {
    return 0;
  }

  const digits = input.slice(1).trimEnd();
  return digits.length <= 6 && /^[0-9a-fA-F]+$/.test(digits) ? Number.parseInt(digits, 16) : 0;
}
