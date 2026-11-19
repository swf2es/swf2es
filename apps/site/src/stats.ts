// The play page's way to the element's performance meter, besides its
// context menu: the controls' Performance box and Ctrl+Shift+F. The meter is
// the element's; the page keeps the viewer's choice of either for the next
// visit under the element's own key, which its menu writes too.
import type { Swf2esPlayerElement } from "@swf2es/web";

/** The element's key for the viewer's choice, "1" for on. */
const STORED = "swf2es.performanceMeter";

function stored(): boolean {
  try {
    return localStorage.getItem(STORED) === "1";
  } catch {
    return false;
  }
}

function store(on: boolean): void {
  try {
    if (on) {
      localStorage.setItem(STORED, "1");
    } else {
      localStorage.removeItem(STORED);
    }
  } catch {
    // Kept for this page alone.
  }
}

/**
 * The element's meter turned on and off by `toggle` and by Ctrl+Shift+F,
 * the box following it however it is turned. The shortcut is the page's
 * even while the player has the focus: its F, pressed and released, never
 * reaches the SWF. An F held down before is the SWF's, its repeats and its
 * release with it, so that it is never left held there.
 */
export function bindMeter(player: Swf2esPlayerElement, toggle: HTMLInputElement): void {
  const set = (on: boolean) => {
    player.performanceMeter = on;
    store(on);
  };
  player.addEventListener("performancemeterchange", () => {
    toggle.checked = player.performanceMeter;
  });
  toggle.addEventListener("change", () => set(toggle.checked));
  let swallowed = false;
  addEventListener(
    "keydown",
    (e) => {
      if (e.code !== "KeyF" || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) {
        return;
      }

      if (e.repeat && !swallowed) {
        return;
      }

      e.preventDefault();
      e.stopImmediatePropagation();
      swallowed = true;
      if (!e.repeat) {
        set(!player.performanceMeter);
      }
    },
    { capture: true },
  );
  addEventListener(
    "keyup",
    (e) => {
      if (swallowed && e.code === "KeyF") {
        swallowed = false;
        e.stopImmediatePropagation();
      }
    },
    { capture: true },
  );
  // A release the window never hears, the focus gone elsewhere, leaves no F to swallow later.
  addEventListener("blur", () => {
    swallowed = false;
  });
  // As the viewer last left it, before any SWF plays.
  if (stored()) {
    player.performanceMeter = true;
  }

  toggle.checked = player.performanceMeter;
}
