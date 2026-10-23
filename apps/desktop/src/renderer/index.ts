// The desktop app's page: one <swf2es-player> filling the window, what to
// do when nothing plays, and what to say when the libraries are missing.
// It reaches the shell only through window.swf2esDesktop (shared/api.ts).
import { configure, type Swf2esPlayerElement } from "@swf2es/web";
import type { DesktopApi, LibraryState, OpenedMovie } from "../shared/api.js";
import { shellFiles } from "./files.js";
import { shellFetch } from "./network.js";
import { shellSocketHost } from "./sockets.js";

declare global {
  interface Window {
    swf2esDesktop: DesktopApi;
  }
}

const desktop = window.swf2esDesktop;

configure({
  cache: true,
  fileHost: shellFiles(desktop.files),
  sockets: shellSocketHost(desktop.sockets),
  fetch: shellFetch(desktop.network),
  loadPolicyFile: (url) => desktop.network.loadPolicyFile(url),
});

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const player = byId<Swf2esPlayerElement>("player");
const welcome = byId<HTMLElement>("welcome");
const libraryPanel = byId<HTMLElement>("libraries");
const failure = byId<HTMLElement>("failure");

let libraries: LibraryState = { builtin: null, playerglobal: null };
// A playerglobal the user chose in place of swf2es's own is optional.
const librariesReady = () => libraries.builtin !== null;

function showLibraries(state: LibraryState): void {
  libraries = state;
  // The shell serves them from where the user pointed it; a missing one is a 404.
  configure({
    libraries: {
      builtin: "/libraries/builtin.abc",
      playerglobal: state.playerglobal !== null ? "/libraries/playerglobal.abc" : undefined,
    },
  });
  byId("builtin-path").textContent = state.builtin ?? "not found";
  byId("playerglobal-path").textContent = state.playerglobal ?? "swf2es's own";
  byId("choose-builtin").hidden = state.builtin !== null;
  libraryPanel.hidden = librariesReady();
}

function showFailure(message: string | null): void {
  failure.hidden = message === null;
  failure.textContent = message ?? "";
}

let loadGeneration = 0;

function play(movie: OpenedMovie): void {
  const generation = ++loadGeneration;
  configure({ sandboxType: movie.sandbox });
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
      // An ActionScript 3 SWF fails for want of the libraries: say so, not the 404.
      if (!librariesReady()) {
        libraryPanel.hidden = false;
        showFailure(`${movie.name} needs the libraries below to play.`);
        return;
      }

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
byId("choose-playerglobal").addEventListener("click", () => desktop.chooseLibrary("playerglobal"));
byId("choose-builtin").addEventListener("click", () => desktop.chooseLibrary("builtin"));

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
if (state.stage3D) {
  try {
    const { createStage3D } = await import("./stage3d.js");
    configure({ stage3D: createStage3D });
  } catch (error) {
    console.warn("swf2es: Stage3D backend could not be loaded; using default playback.", error);
  }
}

showLibraries(state.libraries);
started = true;
const movie = pending === undefined ? state.movie : pending;
if (movie) {
  play(movie);
}
