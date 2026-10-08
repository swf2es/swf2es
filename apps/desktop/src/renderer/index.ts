// The desktop app's page: one <swf2es-player> filling the window, what to
// do when nothing plays, and what to say when the libraries are missing.
// It reaches the shell only through window.swf2esDesktop (shared/api.ts).
import { configure, type Swf2esPlayerElement } from "@swf2es/web";
import type { DesktopApi, LibraryState, OpenedMovie } from "../shared/api.js";
import { shellFetch } from "./network.js";
import { shellSocketHost } from "./sockets.js";

declare global {
  interface Window {
    swf2esDesktop: DesktopApi;
  }
}

const desktop = window.swf2esDesktop;

configure({
  // The shell serves them from where the user pointed it; a missing one is a 404.
  libraries: { builtin: "/libraries/builtin.abc", playerglobal: "/libraries/playerglobal.abc" },
  cache: true,
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
const librariesReady = () => libraries.builtin !== null && libraries.playerglobal !== null;

function showLibraries(state: LibraryState): void {
  libraries = state;
  for (const name of ["builtin", "playerglobal"] as const) {
    byId(`${name}-path`).textContent = state[name] ?? "not found";
    byId(`choose-${name}`).hidden = name === "builtin" && state.builtin !== null;
  }

  libraryPanel.hidden = librariesReady();
}

function showFailure(message: string | null): void {
  failure.hidden = message === null;
  failure.textContent = message ?? "";
}

function play(movie: OpenedMovie): void {
  configure({ sandboxType: movie.sandbox });
  showFailure(null);
  welcome.hidden = true;
  player.hidden = false;
  player.load(movie.url).then(
    () => player.focus(),
    (error: unknown) => {
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

desktop.onOpen(play);
desktop.onClose(close);
const state = await desktop.start();
showLibraries(state.libraries);
if (state.movie) {
  play(state.movie);
}
