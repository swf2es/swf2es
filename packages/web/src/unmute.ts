// The button the element shows over its player while the browser's autoplay
// rule holds the SWF's sound, as Flash's plug-in never needed one. A click
// on it, or Enter or Space, lets the sound run while the browser still
// counts the gesture, and goes no further: neither the SWF nor the page's
// own listeners on the element hear it.

export const UNMUTE_STYLE =
  " .unmute { position: absolute; inset: 0; z-index: 2; margin: auto; width: max-content;" +
  " height: max-content; display: flex; align-items: center; gap: 8px; padding: 10px 16px;" +
  " border: 0; border-radius: 8px; background: #000000c0; color: #fff;" +
  " font: 600 14px system-ui, sans-serif; cursor: pointer }" +
  " .unmute:hover { background: #000000e0 }" +
  " .unmute:focus-visible { outline: 2px solid #fff; outline-offset: 2px }" +
  " .unmute[hidden] { display: none }" +
  " .unmute svg { width: 20px; height: 20px; flex: none }";

const SVG = "http://www.w3.org/2000/svg";

/** A speaker with a cross, as a muted sound is drawn; made node by node, which a page's Trusted Types allow. */
function speaker(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const [d, fill] of [
    ["M11 5 6 9H2v6h4l5 4V5z", "currentColor"],
    ["m23 9-6 6M17 9l6 6", null],
  ]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d as string);
    if (fill) {
      path.setAttribute("fill", fill);
    }

    svg.append(path);
  }

  return svg;
}

/** The input that would reach the SWF or the page through the button, which is the button's alone. */
const OWN = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "keydown", "keyup"];

export class UnmutePrompt {
  readonly #button: HTMLButtonElement;

  /** `unmute` runs as the button is pressed, within the user's gesture. */
  constructor(parent: Node, unmute: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "unmute";
    button.hidden = true;
    button.setAttribute("aria-label", "Click to unmute the sound");
    const label = document.createElement("span");
    label.textContent = "Click to unmute";
    button.append(speaker(), label);
    for (const type of OWN) {
      button.addEventListener(type, (e) => e.stopPropagation());
    }

    // A button clicks on Enter and Space itself.
    button.addEventListener("click", () => {
      button.hidden = true;
      unmute();
    });
    parent.appendChild(button);
    this.#button = button;
  }

  get shown(): boolean {
    return !this.#button.hidden;
  }

  show(): void {
    this.#button.hidden = false;
  }

  hide(): void {
    this.#button.hidden = true;
  }

  /** Whether `event` came through the button, which handles it itself. */
  holds(event: Event): boolean {
    return event.composedPath().includes(this.#button);
  }
}
