// The desktop app's page: one <swf2es-player> filling the window, and what
// to do when nothing plays.
// It reaches the shell only through window.swf2esDesktop (shared/api.ts).
import { configure, type Swf2esPlayerElement } from "@swf2es/web";
import type { AirLaunch, DesktopApi, LibraryState, OpenedMovie } from "../shared/api.js";
import { airHosts, airPath } from "./air.js";
import { shellFiles } from "./files.js";
import { windowFullScreen } from "./full-screen.js";
import { shellFetch } from "./network.js";
import { shellSocketHost } from "./sockets.js";
import { shellWebSocketHost } from "./websockets.js";

declare global {
  interface Window {
    swf2esDesktop: DesktopApi;
  }
}

const desktop = window.swf2esDesktop;
/** The AIR application playing, whose local URLs are read through the shell; null for a SWF. */
let airLaunch: AirLaunch | null = null;

configure({
  cache: true,
  fileHost: shellFiles(desktop.files),
  sockets: shellSocketHost(desktop.sockets),
  webSockets: shellWebSocketHost(desktop.webSockets),
  fetch: shellFetch(desktop.network, () => {
    const launch = airLaunch;
    return launch
      ? (url) => {
          const path = airPath(launch, url);
          return path === null ? null : desktop.air.read(path);
        }
      : null;
  }),
  loadPolicyFile: (url) => desktop.network.loadPolicyFile(url),
  fullScreen: windowFullScreen(desktop.fullScreen),
});

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const player = byId<Swf2esPlayerElement>("player");
const welcome = byId<HTMLElement>("welcome");
const failure = byId<HTMLElement>("failure");

/** A playerglobal.abc the user chose, which the shell serves, in place of swf2es's own. */
function useLibraries(state: LibraryState): void {
  configure({
    libraries: {
      playerglobal: state.playerglobal !== null ? "/libraries/playerglobal.abc" : undefined,
    },
  });
}

function showFailure(message: string | null): void {
  failure.hidden = message === null;
  failure.textContent = message ?? "";
}

let loadGeneration = 0;

function play(movie: OpenedMovie): void {
  const generation = ++loadGeneration;
  airLaunch = movie.air ?? null;
  configure({
    sandboxType: movie.sandbox,
    air: movie.air ? airHosts(movie.air, desktop.air) : null,
  });
  showFailure(null);
  welcome.hidden = true;
  player.hidden = false;
  player.load(movie.url).then(
    () => {
      if (generation === loadGeneration) {
        player.focus();
      }
    },
    (error: unknown) => {
      if (generation !== loadGeneration) {
        return;
      }

      player.hidden = true;
      welcome.hidden = false;
      showFailure(`${movie.name} did not play: ${error instanceof Error ? error.message : error}`);
    },
  );
}

function close(): void {
  loadGeneration++;
  player.destroy();
  player.hidden = true;
  welcome.hidden = false;
  showFailure(null);
}

byId("open").addEventListener("click", () => desktop.openDialog());
byId("open-url").addEventListener("click", () => desktop.openUrlDialog());

// A file dropped anywhere is offered to the shell; the page never navigates to it.
document.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "copy";
  }
});
document.addEventListener("drop", (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files[0];
  if (file) {
    desktop.openDropped(file);
  }
});

// An open or close during optional backend loading takes precedence over the startup snapshot.
let started = false;
let pending: OpenedMovie | null | undefined;
desktop.onOpen((movie) => {
  if (started) {
    play(movie);
  } else {
    pending = movie;
  }
});
desktop.onClose(() => {
  if (started) {
    close();
  } else {
    pending = null;
  }
});
const state = await desktop.start();
configure({ build: state.build ?? undefined });
if (state.stage3D) {
  try {
    const { createStage3D } = await import("./stage3d.js");
    configure({ stage3D: createStage3D });
  } catch (error) {
    console.warn("swf2es: Stage3D backend could not be loaded; using default playback.", error);
  }
}

useLibraries(state.libraries);
started = true;
const movie = pending === undefined ? state.movie : pending;
if (movie) {
  play(movie);
}
