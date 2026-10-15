// What the SWFs load, through the shell: the player's fetch host. A
// swf2es://file URL, a local SWF's own files, the page fetches as before,
// its sandbox judged where the shell serves them; an http or https one
// goes to the main process, which sends it as Flash's sandboxes and policy
// files allow (main/network.ts), so the page itself never goes to the
// network. Nothing else is fetched.
import type { FetchRequest, FetchResult } from "@swf2es/player";
import type { DesktopNetwork } from "../shared/api.js";

export function shellFetch(
  network: DesktopNetwork,
): (request: FetchRequest, signal: AbortSignal) => Promise<FetchResult> {
  return async (request, signal) => {
    const url = new URL(request.url);
    // By its parts: a URL's origin is "null" for a scheme the URL standard does not know.
    if (url.protocol === "swf2es:" && url.host === "file") {
      const response = await fetch(url.href, { signal });
      const headers: [string, string][] = [];
      response.headers.forEach((value, name) => {
        headers.push([name, value]);
      });
      return {
        bytes: response.ok ? new Uint8Array(await response.arrayBuffer()) : null,
        status: response.status,
        headers,
      };
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`swf2es: no ${url.protocol} URL is loaded`);
    }

    signal.throwIfAborted();
    return network.fetch(
      {
        url: url.href,
        method: request.method,
        headers: request.headers.map(([name, value]) => [name, value]),
        body: request.body,
        purpose: request.purpose ?? "data",
      },
      (abort) => signal.addEventListener("abort", abort, { once: true }),
    );
  };
}
