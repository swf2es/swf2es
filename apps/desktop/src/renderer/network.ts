// What the SWFs load, through the shell: the player's fetch host. A
// swf2es://file URL, a local SWF's own files, the page fetches as before,
// its sandbox judged where the shell serves them; an http or https one
// goes to the main process, which sends it as Flash's sandboxes and policy
// files allow (main/network.ts), so the page itself never goes to the
// network. An AIR application's app:, app-storage: and file: URLs are read
// from disk through the shell while it plays. Nothing else is fetched.
import { type FetchHost, responseBytes } from "@swf2es/player";
import type { DesktopNetwork } from "../shared/api.js";

export function shellFetch(
  network: DesktopNetwork,
  /** An AIR application's local URL read, null where `url` is none; null where none plays. */
  airFile: () => ((url: string) => Promise<Uint8Array | null> | null) | null = () => null,
): FetchHost {
  return async (request, signal, progress) => {
    const local = airFile()?.(request.url);
    if (local) {
      const bytes = await local;
      signal.throwIfAborted();
      // A file that is not there is a failed load, as a 404 is.
      return { bytes, status: bytes ? 200 : 404, headers: [] };
    }

    const url = new URL(request.url);
    // By its parts: a URL's origin is "null" for a scheme the URL standard does not know.
    if (url.protocol === "swf2es:" && url.host === "file") {
      const response = await fetch(url.href, { signal });
      const headers: [string, string][] = [];
      response.headers.forEach((value, name) => {
        headers.push([name, value]);
      });
      const head = { status: response.status, headers };
      return { ...head, bytes: response.ok ? await responseBytes(response, head, progress) : null };
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
        ...(request.errorBody ? { errorBody: true } : {}),
      },
      (abort) => signal.addEventListener("abort", abort, { once: true }),
      progress,
    );
  };
}
