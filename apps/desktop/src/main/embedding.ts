// The embedding parameters and FlashVars a command line gives a SWF, as a
// page's <object> or <embed> gave them to Flash Player: the attributes the
// <swf2es-player> element takes (@swf2es/web), read here and handed to the
// page with the movie, which sets them on its element.
//
//   --flashvars "a=1&b=2"  (or --flashvars=...)   repeatable, joined by "&"
//   --param quality=low    (or --param=...)        repeatable, the last of a name winning
//
// A SWF URL's own query reaches loaderInfo.parameters and _root as Flash
// merged it, with no switch: the player reads it, and FlashVars override it.

/** What a command line gives a SWF: the element's attributes by their lower-case names. */
export type Embedding = Readonly<Record<string, string>>;

/** The element's parameters that act in the desktop app. */
const SUPPORTED = new Set([
  "flashvars",
  "quality",
  "scale",
  "salign",
  "wmode",
  "bgcolor",
  "menu",
  "base",
  "allownetworking",
]);

const FULL_SCREEN =
  "a SWF's full screen is the window's here, always allowed, as in Flash's projector";
/** The element's parameters that change nothing here, and why. */
const IGNORED: Readonly<Record<string, string>> = {
  // A SWF's calls into the page would run beside window.swf2esDesktop.
  allowscriptaccess: "ExternalInterface stays off in the desktop app",
  allowfullscreen: FULL_SCREEN,
  allowfullscreeninteractive: FULL_SCREEN,
  movie: "name the SWF on the command line",
  src: "name the SWF on the command line",
};

export interface EmbeddingArguments {
  params: Embedding;
  /** The arguments without these switches and their values, for the SWF's to be found in. */
  rest: string[];
  /** What the switches got wrong, or asked for that does nothing here. */
  warnings: string[];
}

/**
 * The embedding a command line names, of the app's arguments up to an AIR
 * application's own after "--". A switch's value may follow it as an
 * argument of its own (`--flashvars "a=1"`) or after "=".
 */
export function embeddingArguments(argv: readonly string[]): EmbeddingArguments {
  const end = argv.indexOf("--");
  const own = end < 0 ? argv : argv.slice(0, end);
  const rest: string[] = [];
  const warnings: string[] = [];
  const params: Record<string, string> = {};
  const flashVars: string[] = [];
  const set = (name: string, value: string) => {
    if (name === "flashvars") {
      flashVars.push(value);
    } else if (SUPPORTED.has(name)) {
      params[name] = value;
    } else if (name === "allowscriptaccess" && value.trim().toLowerCase() === "never") {
      // What the app has anyway.
    } else if (Object.hasOwn(IGNORED, name)) {
      warnings.push(`--param ${name}: ignored, ${IGNORED[name]}`);
    } else {
      warnings.push(`--param ${name}: no such parameter`);
    }
  };

  for (let i = 0; i < own.length; i++) {
    const arg = own[i];
    const switched = /^--(flashvars|param)(=|$)/i.exec(arg);
    if (!switched) {
      rest.push(arg);
      continue;
    }

    const name = switched[1].toLowerCase();
    let value: string;
    if (switched[2] === "=") {
      value = arg.slice(switched[0].length);
    } else if (i + 1 < own.length) {
      value = own[++i];
    } else {
      warnings.push(`--${name} needs a value`);
      continue;
    }

    if (name === "flashvars") {
      flashVars.push(value);
      continue;
    }

    const equals = value.indexOf("=");
    if (equals <= 0) {
      warnings.push(`--param ${value}: not name=value`);
      continue;
    }

    set(value.slice(0, equals).trim().toLowerCase(), value.slice(equals + 1));
  }

  const joined = flashVars.filter((v) => v !== "").join("&");
  if (joined !== "") {
    params.flashvars = joined;
  }

  return { params, rest: end < 0 ? rest : [...rest, ...argv.slice(end)], warnings };
}

/**
 * `params` for the SWF at `movieUrl`: `base` resolved against its URL, as a
 * page's against the page's, the SWF standing in for the page it has not;
 * one that comes to anything but http, https or the SWF's own files
 * (swf2es://file) is left out, with a word to `warn`. The relative loads
 * it resolves are judged as any other, by the SWF's sandbox.
 */
export function embeddingFor(
  params: Embedding,
  movieUrl: string,
  warn: (message: string) => void,
): Embedding {
  if (params.base === undefined) {
    return params;
  }

  const { base, ...others } = params;
  let resolved: URL | null = null;
  try {
    resolved = new URL(base, movieUrl);
  } catch {
    // Left out below.
  }

  if (
    resolved === null ||
    !(
      resolved.protocol === "http:" ||
      resolved.protocol === "https:" ||
      (resolved.protocol === "swf2es:" && resolved.host === "file")
    )
  ) {
    warn(`--param base=${base}: not an http, https or relative URL; left out`);
    return others;
  }

  return { ...others, base: resolved.href };
}
