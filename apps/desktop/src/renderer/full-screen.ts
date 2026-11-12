// Stage.displayState's full screen in the desktop app: the window's, through
// the shell, since the player's element already fills it. A SWF asks with
// no gesture, as an AIR application and Flash's projector could, which the
// Fullscreen API on the element would refuse. Esc leaves, as in Flash; the
// menu's F11 enters and leaves too, and the SWF hears of either.
import type { WindowFullScreen } from "@swf2es/web";
import type { DesktopFullScreen } from "../shared/api.js";

export function windowFullScreen(shell: DesktopFullScreen): WindowFullScreen {
  const listeners = new Set<(fullScreen: boolean) => void>();
  let full = false;
  shell.onChange((fullScreen) => {
    full = fullScreen;
    for (const listener of listeners) {
      listener(fullScreen);
    }
  });
  // In the capture phase: before the SWF's own key handlers, whatever has the focus.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && full) {
        full = false;
        shell.set(false);
        // No window manager tells of this one sooner than the SWF should hear.
        for (const listener of listeners) {
          listener(false);
        }
      }
    },
    true,
  );

  return {
    set: (fullScreen) => {
      full = fullScreen;
      shell.set(fullScreen);
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
