// The fetches of an element's load: the SWF itself, and what its SWFs load,
// through an AIR application's files, the embedder's fetch or the browser's.
import type { FetchRequest, FetchResult } from "@swf2es/player";
import { configuration } from "./config.js";
import type { Session } from "./element.js";

/** The SWF at `url`, by the embedder's fetch where it gave one, and the URL a redirect took it to. */
export async function fetchMovie(
  url: string,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; url: string }> {
  const fetchOf = configuration().fetch;
  if (fetchOf) {
    const result = await fetchOf(
      { url, method: "GET", headers: [], body: null, purpose: "movie" },
      signal,
    );
    if (!result.bytes) {
      throw new Error(`swf2es: ${result.status} for ${url}`);
    }

    return { bytes: result.bytes, url: result.url ?? url };
  }

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`swf2es: ${response.status} for ${url}`);
  }

  return { bytes: new Uint8Array(await response.arrayBuffer()), url: response.url || url };
}

/**
 * What a session's SWFs load by: its AIR application's files, then the
 * embedder's fetch or the browser's; `offline` (allowNetworking "none"),
 * nothing past the application's own files, which are no network.
 */
export function fetchFor(
  session: Session,
  offline: boolean,
): (request: FetchRequest, signal: AbortSignal) => Promise<FetchResult> {
  const fetchOf: (request: FetchRequest, signal: AbortSignal) => Promise<FetchResult> = offline
    ? () => Promise.reject(new Error("allowNetworking is none"))
    : (configuration().fetch ?? browserFetch);
  const app = session.air?.app;
  if (!app) {
    return fetchOf;
  }

  return (request, signal) => {
    const local = app.fetch(request, session.air?.files);
    if (!local) {
      return fetchOf(request, signal);
    }

    // A file the application does not hold, from the directory it came from: one the server
    // has none of is a file that is not there, not its error's body.
    const remote = local.bytes ? null : app.remote(request.url);
    return remote
      ? fetchOf({ ...request, url: remote, errorBody: false }, signal)
      : Promise.resolve(local);
  };
}

/** The host's fetch for what a SWF loads: the browser's, its status and headers as they come. */
async function browserFetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResult> {
  const response = await fetch(request.url, {
    signal,
    method: request.method,
    headers: request.headers.map(([name, value]) => [name, value]),
    body: request.body ? new Uint8Array(request.body).buffer : null,
  });
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => {
    headers.push([name, value]);
  });

  // An error's body only where it is asked for, as an AIR application's URLLoader reads it.
  const read = response.ok || (!!request.errorBody && response.status >= 400);
  return {
    bytes: read ? new Uint8Array(await response.arrayBuffer()) : null,
    status: response.status,
    headers,
    // Where a redirect took it: the SWF is judged and named by that.
    ...(response.redirected ? { url: response.url } : {}),
  };
}
