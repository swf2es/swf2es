// What an <embed>'s attributes say, read as Flash read them: sizes, colours,
// FlashVars, allowScriptAccess and quality; and the element's own.
import type { ApiVersionOption } from "@swf2es/player";

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

/**
 * What the SWFs' relative URLs resolve against without a `base`: "page",
 * the page's URL, as Flash Player's plug-in had them, for a page that
 * embeds its own SWFs; or "movie", each SWF's own (AVM1's the main SWF's),
 * as its projector had them, for a player that re-hosts SWFs from
 * elsewhere. The element's `relativeurls` attribute, else the page's
 * configure({ relativeUrls }), else "page".
 */
export type RelativeUrls = "page" | "movie";

/** `value`, the attribute's, as a choice; `fallback` for none or another word. */
export function relativeUrls(
  value: string | null,
  fallback: RelativeUrls | undefined,
): RelativeUrls {
  switch (value?.trim().toLowerCase()) {
    case "page":
      return "page";
    case "movie":
      return "movie";
    default:
      return fallback ?? "page";
  }
}

/** Whether `url` has a path a relative URL can go under (http:, file:, app:), not blob:, data: or about:. */
export function hierarchical(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\//i.test(url);
}

/**
 * Where every SWF's relative URLs resolve, AS3's and AVM1's, the children's
 * and getURL's too, as Flash's plug-in resolved them from the page's
 * `base` (PepperFlash 32): "." is the SWF's directory, any other value is
 * against the page's URL; without one, or one no URL with a path comes of,
 * the page's URL for "page", and null for "movie" or a page with no path
 * (blob:, data:): each SWF its own.
 */
export function relativeBase(
  base: string | null,
  swfUrl: string | null,
  pageUrl: string,
  choice: RelativeUrls,
): string | null {
  const given = base?.trim() ?? "";
  if (given !== "") {
    try {
      const against = given === "." && swfUrl !== null && hierarchical(swfUrl) ? swfUrl : pageUrl;
      const url = new URL(given, against).href;
      if (hierarchical(url)) {
        return url;
      }
    } catch {
      // Against a page with no path: as though there were none.
    }
  }

  return choice === "page" && hierarchical(pageUrl) ? pageUrl : null;
}

/**
 * The `apiversion` attribute as Scripting's apiVersion: "latest", "root"
 * or a SWF version, a whole number from 1; `fallback` for none or another
 * word.
 */
export function apiVersion(
  value: string | null,
  fallback: ApiVersionOption | undefined,
): ApiVersionOption {
  const word = value?.trim().toLowerCase();
  if (word === "latest" || word === "root") {
    return word;
  }

  if (word !== undefined && /^\d+$/.test(word) && Number(word) >= 1) {
    return Number(word);
  }

  return fallback ?? "latest";
}
