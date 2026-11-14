// Whether the SWF playing may open a socket or a WebSocket, and where to:
// the user asked once a server, and a remote SWF's socket policy.
import { dialog } from "electron";
import { allowedOnce, current, deniedOnce, networkMovie } from "./open.ts";
import { sandbox, settings, window } from "./state.ts";
import { network, proxiedWebSockets, proxy } from "./switches.ts";
import { hasWebSocket } from "./websocket-connections.ts";

/** The prompts on screen, by "host:port": a second connection there waits on the first's answer. */
const asking = new Map<string, Promise<boolean>>();

/**
 * Whether the SWF playing may connect a socket to `host`:`port`, and where
 * to: only with the network, and only as the user allows, once or always
 * for that SWF, when it first asks for that server; and for a remote SWF,
 * as that server's socket policy allows, at the address it came from.
 * Denied where no one can be asked.
 */
export async function permitSocket(
  host: string,
  port: number,
): Promise<{ address?: string } | null> {
  // AIR's application sandbox connects where it likes, unasked, with no socket policy.
  if (sandbox.application) {
    return {};
  }

  const playing = current;
  const swf = sandbox.swf;
  const endpoint = `${host}:${port}`;
  if (!playing || !swf || !sandbox.networkAllowed()) {
    process.stderr.write(`swf2es: no socket to ${endpoint}: the SWF has no network\n`);
    return null;
  }

  if (!(await allowedByUser(playing, swf, endpoint))) {
    return null;
  }

  if (networkMovie?.kind !== "remote") {
    return {};
  }

  try {
    return { address: await network.socketAddress(host, port) };
  } catch (error) {
    process.stderr.write(`swf2es: no socket to ${endpoint}: ${(error as Error).message}\n`);
    return null;
  }
}

/** Whether the user allows the SWF playing a socket to `endpoint`, asked once a server. */
async function allowedByUser(
  playing: NonNullable<typeof current>,
  swf: string,
  endpoint: string,
): Promise<boolean> {
  if (settings.socketAllowed(swf, endpoint) || allowedOnce.has(endpoint)) {
    return true;
  }

  if (deniedOnce.has(endpoint)) {
    return false;
  }

  let answer = asking.get(endpoint);
  if (!answer) {
    answer = askForSocket(playing.movie.name, swf, endpoint).finally(() => asking.delete(endpoint));
    asking.set(endpoint, answer);
  }

  return (await answer) && current === playing;
}

async function askForSocket(name: string, swf: string, endpoint: string): Promise<boolean> {
  if (!window) {
    return false;
  }

  const playing = current;
  let response: number;
  try {
    ({ response } = await dialog.showMessageBox(window, {
      type: "question",
      message: `${name} asks to connect to ${endpoint}.`,
      detail:
        "A socket lets the SWF send that server whatever it has. " +
        "Allow it only for a server you trust.",
      buttons: ["Allow Once", "Always Allow for This SWF", "Deny"],
      defaultId: 2,
      cancelId: 2,
      noLink: true,
    }));
  } catch {
    return false;
  }

  if (current !== playing) {
    return false;
  }

  switch (response) {
    case 0:
      allowedOnce.add(endpoint);
      return true;
    case 1:
      if (!settings.allowSocket(swf, endpoint)) {
        allowedOnce.add(endpoint);
      }

      return true;
    default:
      deniedOnce.add(endpoint);
      return false;
  }
}

/**
 * Whether what plays may open a WebSocket to `url`: an AIR application,
 * unasked and anywhere, as AIR's application sandbox connects and as its
 * sockets do here. air.net.WebSocket is AIR's alone, so nothing else has one.
 */
export function permitWebSocket(url: string): boolean {
  if (sandbox.application && hasWebSocket() && (!proxy || proxiedWebSockets)) {
    return true;
  }

  const why = !sandbox.application
    ? "only an AIR application has one"
    : !hasWebSocket()
      ? "this Electron has no WebSocket client"
      : "this Electron's WebSocket cannot go through the proxy";
  process.stderr.write(`swf2es: no WebSocket to ${url.slice(0, 2048)}: ${why}\n`);
  return false;
}
