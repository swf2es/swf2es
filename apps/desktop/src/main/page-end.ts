// When the window's page ends, for what the main process holds for it
// (sockets, WebSockets, file grants, requests under way) to go with it.
import type { RenderProcessGoneDetails, WebContents } from "electron";

/**
 * How a page ended: it navigated or reloaded; its renderer process went,
 * crashed, killed or out of memory, which leaves the WebContents alive and
 * white, so neither of the others comes; or its WebContents was destroyed.
 */
type PageEnd = "navigated" | "gone" | "destroyed";

/**
 * Call `ended` each time `contents`' page ends, with why its process went
 * for "gone". A gone page may come back by a reload, a navigation of its own.
 */
export function onPageEnd(
  contents: Pick<WebContents, "on" | "once">,
  ended: (how: PageEnd, gone?: RenderProcessGoneDetails) => void,
): void {
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      ended("navigated");
    }
  });
  contents.on("render-process-gone", (_event, details) => ended("gone", details));
  contents.once("destroyed", () => ended("destroyed"));
}
