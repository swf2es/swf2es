// What an <embed>'s attributes say, read as Flash read them: sizes, colours,
// FlashVars, allowScriptAccess and quality.

/** "550" is pixels, as an <embed>'s width is; "100%" and other CSS lengths are themselves. */
export function cssLength(value: string | null): string | null {
  if (value === null || value.trim() === "") {
    return null;
  }

  return /^\s*\d+(\.\d+)?\s*$/.test(value) ? `${Number(value)}px` : value.trim();
}

/** A colour as Flash's bgcolor gives it, "#RRGGBB" or "RRGGBB"; null for none or another form. */
export function parseColor(value: string | null): number | null {
  const hex = /^\s*#?([0-9a-f]{6})\s*$/i.exec(value ?? "")?.[1];
  return hex ? Number.parseInt(hex, 16) : null;
}

/** FlashVars, "name=value&...", URL-encoded, as Flash read them. */
export function parseFlashVars(value: string | null): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, text] of new URLSearchParams(value ?? "")) {
    vars[name] = text;
  }

  return vars;
}

/**
 * Whether a SWF from `swfUrl` may script its page, by allowScriptAccess as
 * Flash read it: "always", "never", or by default "sameDomain", the SWF's
 * origin the page's.
 */
export function scriptAccess(value: string | null, swfUrl: string, pageUrl: string): boolean {
  switch (value?.toLowerCase()) {
    case "always":
      return true;
    case "never":
      return false;
    default:
      try {
        const origin = new URL(swfUrl, pageUrl).origin;
        // An opaque origin ("null": data:, a sandboxed frame) is no one's domain, not even its own.
        return origin !== "null" && origin === new URL(pageUrl).origin;
      } catch {
        return false;
      }
  }
}

/** Flash's quality names; the auto ones as what they start at. */
export function quality(value: string | null): string {
  const named = (value ?? "high").toUpperCase();
  if (named === "AUTOLOW") {
    return "LOW";
  }

  return ["LOW", "MEDIUM", "HIGH", "BEST"].includes(named) ? named : "HIGH";
}
