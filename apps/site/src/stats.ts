// The play page's way to the element's performance meter, besides its
// context menu: the controls' Performance box and Ctrl+Shift+F. The meter,
// and the viewer's choice kept for the next visit, are the element's.
import type { Swf2esPlayerElement } from "@swf2es/web";

/**
 * The element's meter turned on and off by `toggle` and by Ctrl+Shift+F,
 * the box following it however it is turned. The shortcut is the page's
 * even while the player has the focus: its F, pressed and released, never
 * reaches the SWF. An F held down before is the SWF's, its repeats and its
 * release with it, so that it is never left held there.
 */
export function bindMeter(player: Swf2esPlayerElement, toggle: HTMLInputElement): void {
  toggle.checked = player.performanceMeter;
  player.addEventListener("performancemeterchange", () => {
    toggle.checked = player.performanceMeter;
  });
  toggle.addEventListener("change", () => {
    player.performanceMeter = toggle.checked;
  });
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
        player.performanceMeter = !player.performanceMeter;
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
}
