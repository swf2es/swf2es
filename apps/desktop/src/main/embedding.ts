// The embedding parameters and FlashVars a command line gives a SWF, as a
// page's <object> or <embed> gave them to Flash Player: the attributes the
// <swf2es-player> element takes (@swf2es/web), read here and handed to the
// page with the movie, which sets them on its element.
//
//   --flashvars="a=1&b=2"  (or --flashvars "...")   repeatable, joined by "&"
//   --param=quality=low    (or --param ...)          repeatable, the last of a name winning
//
// A value apart from its switch may not start with "-": other switches
// (--proxy, --trace) read every argument, and would take it for theirs.
//
// A SWF URL's own query reaches loaderInfo.parameters and _root as Flash
// merged it, with no switch: the player reads it, and FlashVars override it.

import { EMBEDDING_PARAMS } from "../shared/embedding.ts";

/** What a command line gives a SWF: the element's attributes by their lower-case names. */
export type Embedding = Readonly<Record<string, string>>;

const SUPPORTED = new Set(EMBEDDING_PARAMS);

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
    } else if (i + 1 < own.length && !own[i + 1].startsWith("-")) {
      value = own[++i];
    } else {
      warnings.push(`--${name} needs a value (--${name}=... for one that starts with -)`);
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

/** A local SWF's URL as the page has it, to tell where a relative base comes to. */
const LOCAL_DIRECTORY = "swf2es://file/directory/";

/**
 * `params` for the SWF a command line names, `movie` (a path or an http or
 * https URL; null for none), or for the AIR application it names instead,
 * where `air`, which has no page and gets none; settled once, where the
 * command line was read, with what it leaves out said in `warnings`. A
 * `base` is an http or https URL, or relative, to be resolved against the
 * SWF's URL as a page's against the page's: below a local SWF's own
 * directory, as nothing outside it is the SWF's to read.
 */
export function settleEmbedding(
  params: Embedding,
  movie: string | null,
  air: boolean,
): { params: Embedding; warnings: string[] } {
  if (air) {
    const given = Object.keys(params).length > 0;
    return {
      params: {},
      warnings: given
        ? ["--flashvars and --param: ignored for an AIR application, which has no page"]
        : [],
    };
  }

  if (params.base === undefined || movie === null) {
    return { params, warnings: [] };
  }

  const { base, ...others } = params;
  const left = (why: string) => ({ params: others, warnings: [`--param base=${base}: ${why}`] });
  let absolute: URL | null = null;
  try {
    absolute = new URL(base);
  } catch {
    // Relative.
  }

  if (absolute) {
    return absolute.protocol === "http:" || absolute.protocol === "https:"
      ? { params, warnings: [] }
      : left("not an http, https or relative URL; left out");
  }

  if (/^https?:\/\//i.test(movie)) {
    return { params, warnings: [] };
  }

  // A relative path's or a host's: a token for its directory stands for the directory.
  let local: URL | null = null;
  try {
    local = new URL(base, `${LOCAL_DIRECTORY}movie.swf`);
  } catch {
    // Left out below.
  }

  return local?.href.startsWith(LOCAL_DIRECTORY)
    ? { params, warnings: [] }
    : left("outside the SWF's directory, where it reads nothing; left out");
}

/**
 * `params`, as settleEmbedding left them, for the SWF at `movieUrl`: `base`
 * resolved against its URL. One that comes to anything but http, https or
 * the SWF's own files (swf2es://file) is left out. The relative loads it
 * resolves are judged as any other, by the SWF's sandbox.
 */
export function embeddingFor(params: Embedding, movieUrl: string): Embedding {
  if (params.base === undefined) {
    return params;
  }

  const { base, ...others } = params;
  let resolved: URL | null = null;
  try {
    resolved = new URL(base, movieUrl);
  } catch {
    return others;
  }

  const kept =
    resolved.protocol === "http:" ||
    resolved.protocol === "https:" ||
    (resolved.protocol === "swf2es:" && resolved.host === "file");
  return kept ? { ...others, base: resolved.href } : others;
}

/**
 * The arguments a second start sent in the single-instance lock's data, as
 * they were, else Electron's `given` for it, which may come reordered, a
 * switch's value apart from the switch.
 */
export function exactArguments(data: unknown, given: string[]): string[] {
  const argv = (data as { argv?: unknown } | null)?.argv;
  return Array.isArray(argv) && argv.every((a) => typeof a === "string") ? argv : given;
}
