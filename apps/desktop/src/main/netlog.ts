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

/**
 * A request answered: its method, URL, status, body's size and how long it
 * took, where the HTTP cache answered it, fresh or after a 304, whether
 * its connection was one kept from an earlier request, and whether
 * --ignore-policy-files let it through where a policy file was to.
 */
export function requestLine(
  method: string,
  url: string,
  status: number,
  bytes: number | null,
  ms: number,
  cache?: "hit" | "revalidated",
  reused?: boolean,
  policyIgnored?: boolean,
): string {
  const body = bytes === null ? "no body" : size(bytes);
  let from = "";
  switch (cache) {
    case "hit":
      from = " from cache";
      break;
    case "revalidated":
      from = " revalidated";
      break;
  }

  const connection = reused ? " reused" : "";
  const allowed = policyIgnored ? ` ${POLICY_IGNORED}` : "";
  return `swf2es: net ${method} ${shown(url)} ${status} ${body} ${Math.round(ms)} ms${from}${connection}${allowed}`;
}

/** What a line ends in where --ignore-policy-files let it through in place of a policy file. */
export const POLICY_IGNORED = "allowed by --ignore-policy-files";

/** A request that got no answer: refused, failed or aborted, and why. */
export function failureLine(method: string, url: string, why: string, ms: number): string {
  return `swf2es: net ${method} ${shown(url)} ${why} ${Math.round(ms)} ms`;
}

/** A socket's connection asked for, opened, refused or closed. */
export function socketLine(id: number, what: string): string {
  return `swf2es: socket #${id} ${shown(what)}`;
}

/** How much of a message --log-sockets shows. */
const PREVIEW = 512;

/** The start of `bytes`: as text where it is text, bytes that are no printable ASCII as dots, else in hex. */
function preview(bytes: Uint8Array): string {
  const shownBytes = bytes.subarray(0, PREVIEW);
  let printable = 0;
  for (let i = 0; i < shownBytes.length; i++) {
    const b = shownBytes[i];
    if ((b >= 32 && b < 127) || b === 9 || b === 10 || b === 13 || b === 0) {
      printable++;
    }
  }

  let text = "";
  // Mostly text, as a line protocol's messages are, a NUL ending each: shown as text.
  if (printable * 10 >= shownBytes.length * 9) {
    for (let i = 0; i < shownBytes.length; i++) {
      const b = shownBytes[i];
      text += b >= 32 && b < 127 ? String.fromCharCode(b) : ".";
    }
  } else {
    for (let i = 0; i < shownBytes.length; i++) {
      text += (i > 0 ? " " : "") + shownBytes[i].toString(16).padStart(2, "0");
    }
  }

  return text + (bytes.length > PREVIEW ? "…" : "");
}

/**
 * What a socket sent (">") or received ("<"): its size and its start, as
 * text where it is text, bytes that are no printable ASCII as dots, else
 * in hex. A message past PREVIEW bytes ends in an ellipsis.
 */
export function socketDataLine(id: number, sent: boolean, bytes: Uint8Array): string {
  return `swf2es: socket #${id} ${sent ? ">" : "<"} ${bytes.length} B  ${preview(bytes)}`;
}

/** A WebSocket's connection asked for, opened, refused, failed or closed. */
export function webSocketLine(id: number, what: string): string {
  return `swf2es: websocket #${id} ${shown(what)}`;
}

/** What a WebSocket frame that is not text is called in a line, by its opcode. */
const FRAMES: Record<number, string> = { 2: "binary", 8: "close", 9: "ping", 10: "pong" };

const utf8 = new TextDecoder();

/**
 * What a WebSocket sent (">") or received ("<"), by its opcode: a text
 * message's size and its first PREVIEW characters, control characters as
 * dots; a binary one's, a ping's, a pong's and a close frame's as a
 * socket's.
 */
export function webSocketDataLine(
  id: number,
  sent: boolean,
  opcode: number,
  payload: Uint8Array,
): string {
  const head = `swf2es: websocket #${id} ${sent ? ">" : "<"}`;
  if (opcode !== 1) {
    const kind = FRAMES[opcode] ?? `opcode ${opcode}`;
    return `${head} ${kind} ${payload.length} B  ${preview(payload)}`;
  }

  // By code point, so that no pair is cut in two; bytes that are no UTF-8 as U+FFFD. PREVIEW
  // characters take no more than four bytes each.
  const decoded = Array.from(utf8.decode(payload.subarray(0, PREVIEW * 4)));
  const characters = decoded.slice(0, PREVIEW);
  const text = characters
    .join("")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is taken out
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ".");
  const more = decoded.length > PREVIEW || payload.length > PREVIEW * 4 ? "…" : "";
  return `${head} text ${payload.length} B  ${text}${more}`;
}
