// The play page's way to the element's performance meter, besides its
// context menu: the controls' Show stats button and Ctrl+Shift+F. The meter is
// the element's; the page keeps the viewer's choice of either for the next
// visit under the element's own keys, which its menu writes too.
import type { MeterCorner, Swf2esPlayerElement } from "@swf2es/web";

/** The element's keys for the viewer's choice, "1" for on, and for its corner. */
const STORED = "swf2es.performanceMeter";
const STORED_CORNER = "swf2es.performanceMeterCorner";
/** The corners Ctrl+Shift+F moves the meter through, as the element's menu does, then off. */
const CORNERS: MeterCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

function storedCorner(): MeterCorner | null {
  try {
    const corner = localStorage.getItem(STORED_CORNER);
    return CORNERS.find((c) => c === corner) ?? null;
  } catch {
    return null;
  }
}

function storeCorner(corner: MeterCorner): void {
  try {
    if (corner === "top-left") {
      localStorage.removeItem(STORED_CORNER);
    } else {
      localStorage.setItem(STORED_CORNER, corner);
    }
  } catch {
    // Kept for this page alone.
  }
}

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
 * The element's meter turned on and off by `toggle`, a toggle button, and by Ctrl+Shift+F,
 * which shows it in its kept corner, moves it through the others, and hides
 * it back in the corner it started from, so that the shortcut and the button
 * open it in the same corner, and one the viewer picked from the menu
 * stays theirs; the button follows the meter however it is turned. The shortcut is the page's
 * even while the player has the focus: its F, pressed and released, never
 * reaches the SWF. An F held down before is the SWF's, its repeats and its
 * release with it, so that it is never left held there.
 */
export function bindMeter(player: Swf2esPlayerElement, toggle: HTMLButtonElement): void {
  const set = (on: boolean) => {
    player.performanceMeter = on;
    store(on);
  };
  /** The corner the shortcut's cycle began in, and hides the meter back in. */
  let start = player.performanceMeterCorner;
  let cycling = false;
  const pressed = () => toggle.setAttribute("aria-pressed", String(player.performanceMeter));
  player.addEventListener("performancemeterchange", () => {
    pressed();
    // Moved or shown otherwise, by the menu, the button or a kept choice: a cycle begins there.
    if (!cycling) {
      start = player.performanceMeterCorner;
    }
  });
  toggle.addEventListener("click", () => set(!player.performanceMeter));
  const place = (corner: MeterCorner) => {
    player.performanceMeterCorner = corner;
    storeCorner(corner);
  };
  const cycle = () => {
    cycling = true;
    try {
      const at = player.performanceMeterCorner;
      const next = CORNERS[(CORNERS.indexOf(at) + 1) % CORNERS.length];
      if (!player.performanceMeter) {
        start = at;
        set(true);
      } else if (next !== start) {
        place(next);
      } else {
        set(false);
        place(start);
      }
    } finally {
      cycling = false;
    }
  };
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
        cycle();
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
  const corner = storedCorner();
  if (corner) {
    player.performanceMeterCorner = corner;
  }

  if (stored()) {
    player.performanceMeter = true;
  }

  pressed();
}
