// The player's activation as a browser host sees it: Flash Player is
// active while it has the system's focus, and a browser tells the page's
// through the window's focus and blur and the document's visibility. A
// plug-in lost focus to the page around it too, which an element that
// takes the keys tells by its focusout.

/**
 * Tell `player` when the page gains or loses focus or is hidden or shown
 * (Player.setActive), and, with `element`, when the focus moves from the
 * element to the page around it, whose keys the element no longer hears.
 * The player stays active until one of them says otherwise.
 */
export function bindActivation(
  player: { setActive(active: boolean): void },
  win: Window,
  element: HTMLElement | null = null,
): () => void {
  const doc = win.document;
  let focused = true;
  let left = false;
  const update = () => {
    player.setActive(focused && !left && doc.visibilityState !== "hidden");
  };
  const focus = () => {
    focused = true;
    update();
  };
  const blur = () => {
    focused = false;
    update();
  };
  const focusin = () => {
    left = false;
    update();
  };
  const focusout = (event: Event) => {
    const to = (event as FocusEvent).relatedTarget as Node | null;
    // The window's own blur takes the element's focus too: that is not the page's.
    if (doc.hasFocus() && !(to && element?.contains(to))) {
      left = true;
      update();
    }
  };
  win.addEventListener("focus", focus);
  win.addEventListener("blur", blur);
  doc.addEventListener("visibilitychange", update);
  element?.addEventListener("focusin", focusin);
  element?.addEventListener("focusout", focusout);

  return () => {
    win.removeEventListener("focus", focus);
    win.removeEventListener("blur", blur);
    doc.removeEventListener("visibilitychange", update);
    element?.removeEventListener("focusin", focusin);
    element?.removeEventListener("focusout", focusout);
  };
}
