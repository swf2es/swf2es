// --log-network's lines: what a SWF asked of the network, as the terminal
// shows it. The page has no network of its own, so its DevTools' Network
// tab shows none of this; the main process, which sends the requests, says
// them here instead. Apart from Electron, so that node tests it.

/** A size as a person reads it: bytes, then kB and MB to one decimal. */
function size(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} kB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A URL short enough for a line, and with nothing a terminal would act on. */
function shown(url: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is taken out
  return url.slice(0, 2048).replace(/[\u0000-\u001f\u007f]/g, "?");
}

/** A request answered: its method, URL, status, body's size and how long it took. */
export function requestLine(
  method: string,
  url: string,
  status: number,
  bytes: number | null,
  ms: number,
): string {
  const body = bytes === null ? "no body" : size(bytes);
  return `swf2es: net ${method} ${shown(url)} ${status} ${body} ${Math.round(ms)} ms`;
}

/** A request that got no answer: refused, failed or aborted, and why. */
export function failureLine(method: string, url: string, why: string, ms: number): string {
  return `swf2es: net ${method} ${shown(url)} ${why} ${Math.round(ms)} ms`;
}

/** A socket's connection asked for, opened, refused or closed. */
export function socketLine(id: number, what: string): string {
  return `swf2es: socket #${id} ${shown(what)}`;
}
