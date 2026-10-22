import type { MenuItem } from "../input/context-menu.js";
import type { Player } from "../player.js";

const openMenus = new WeakMap<Document, () => void>();

/** DOM menus stay outside Pixi's scene graph and exist only while open. */
export function bindContextMenu(
  canvas: HTMLCanvasElement,
  player: Player,
  point: (event: MouseEvent) => [number, number],
): () => void {
  const document = canvas.ownerDocument;
  const window = document.defaultView;
  const root = canvas.getRootNode();
  const focusTarget = root instanceof ShadowRoot ? root.host : canvas;
  const keyboardEvents = new WeakSet<MouseEvent>();
  let dismiss: (() => void) | null = null;

  const open = (event: MouseEvent) => {
    if (event.defaultPrevented || player.destroyed) {
      return;
    }

    const keyboard = keyboardEvents.has(event);
    const [x, y] = keyboard
      ? [
          player.scripting?.mouseStageX ?? player.width / 2,
          player.scripting?.mouseStageY ?? player.height / 2,
        ]
      : point(event);
    if (x < 0 || y < 0 || x >= player.width || y >= player.height) {
      return;
    }

    event.preventDefault();
    openMenus.get(document)?.();
    dismiss?.();
    const items = player.contextMenu({
      x,
      y,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
    });
    if (player.destroyed) {
      return;
    }

    items.push({
      caption: "About swf2es",
      enabled: true,
      separatorBefore: items.length > 0,
      select: () => window?.open("https://swf2es.github.io/swf2es/", "_blank", "noopener"),
    });
    const lifetime = new AbortController();
    const options = { capture: true, signal: lifetime.signal };
    const prior = document.activeElement as HTMLElement | null;
    const host = document.createElement("div");
    host.dataset.swf2esContextMenu = "";
    host.setAttribute("popover", "manual");
    host.style.cssText =
      "position:fixed;inset:auto;margin:0;padding:0;border:0;background:none;z-index:2147483647";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { color-scheme: light dark; }
      [role=menu] { box-sizing:border-box; min-width:190px; max-width:calc(100vw - 8px);
        max-height:calc(100dvh - 8px); overflow:auto; padding:4px; border:1px solid #777;
        border-radius:6px; background:Canvas; color:CanvasText;
        box-shadow:0 4px 16px #0006; font:13px system-ui,sans-serif; }
      button { display:block; width:100%; box-sizing:border-box; padding:6px 18px;
        border:0; border-radius:3px; background:transparent; color:inherit;
        text-align:left; font:inherit; white-space:pre-wrap; overflow-wrap:anywhere; cursor:default; }
      button:focus-visible, button:focus, button:hover:not(:disabled) {
        outline:none; background:Highlight; color:HighlightText; }
      button:disabled { color:GrayText; }
      button[aria-checked=true]::before { content:"✓ "; }
      hr { border:0; border-top:1px solid GrayText; margin:4px; }
    `;
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "SWF context menu");
    menu.tabIndex = -1;
    const buttons: HTMLButtonElement[] = [];
    let closed = false;
    const close = (restore = false) => {
      if (closed) {
        return;
      }

      closed = true;
      lifetime.abort();
      host.remove();
      dismiss = null;
      if (openMenus.get(document) === close) {
        openMenus.delete(document);
      }
      if (restore && prior?.isConnected) {
        prior.focus({ preventScroll: true });
      }
    };
    dismiss = close;
    openMenus.set(document, close);
    const select = (item: MenuItem) => {
      if (closed) {
        return;
      }

      close(true);
      if (!player.destroyed) {
        item.select();
      }
    };
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.separatorBefore && i > 0) {
        const separator = document.createElement("hr");
        separator.setAttribute("role", "separator");
        menu.append(separator);
      }

      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemradio");
      if (item.checked !== undefined) {
        button.setAttribute("aria-checked", String(item.checked));
      }

      button.textContent = item.caption;
      button.disabled = !item.enabled;
      button.tabIndex = -1;
      button.addEventListener("click", () => select(item));
      if (item.enabled) {
        buttons.push(button);
      }

      menu.append(button);
    }

    shadow.append(style, menu);
    // The top layer escapes the embedding element's overflow and keeps menus in full screen.
    const parent =
      root instanceof ShadowRoot ? root : (document.fullscreenElement ?? document.body);
    parent.append(host);
    host.showPopover?.();
    const rect = host.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const clientX = keyboard ? canvasRect.left + canvasRect.width / 2 : event.clientX;
    const clientY = keyboard ? canvasRect.top + canvasRect.height / 2 : event.clientY;
    host.style.left = `${Math.max(4, Math.min(clientX, (window?.innerWidth ?? 0) - rect.width - 4))}px`;
    host.style.top = `${Math.max(4, Math.min(clientY, (window?.innerHeight ?? 0) - rect.height - 4))}px`;
    (buttons[0] ?? menu).focus({ preventScroll: true });

    const inside = (e: Event) => e.composedPath().includes(host);
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!inside(e)) {
          close();
        }
      },
      options,
    );
    host.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.addEventListener(
      "focusin",
      (e) => {
        if (!inside(e)) {
          close();
        }
      },
      options,
    );
    host.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    window?.addEventListener("blur", () => close(), options);
    window?.addEventListener("resize", () => close(), options);
    document.addEventListener(
      "scroll",
      (e) => {
        if (!inside(e)) {
          close();
        }
      },
      options,
    );
    document.addEventListener("keyup", (e) => e.stopPropagation(), options);
    document.addEventListener(
      "keydown",
      (e) => {
        e.stopPropagation();
        const index = buttons.indexOf(shadow.activeElement as HTMLButtonElement);
        let next = index;
        switch (e.key) {
          case "ArrowDown":
            next = (index + 1) % buttons.length;
            break;
          case "ArrowUp":
            next = (index - 1 + buttons.length) % buttons.length;
            break;
          case "Home":
            next = 0;
            break;
          case "End":
            next = buttons.length - 1;
            break;
          case "Enter":
          case " ":
            e.preventDefault();
            buttons[index]?.click();
            return;
          case "Escape":
            e.preventDefault();
            close(true);
            return;
          case "Tab":
            close(true);
            return;
          default:
            return;
        }

        e.preventDefault();
        buttons[next]?.focus({ preventScroll: true });
      },
      options,
    );
  };
  const keyboardMenu = (event: Event) => {
    const e = event as KeyboardEvent;
    if (e.defaultPrevented || (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey))) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    const menu = new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true });
    keyboardEvents.add(menu);
    canvas.dispatchEvent(menu);
  };
  canvas.addEventListener("contextmenu", open);
  focusTarget.addEventListener("keydown", keyboardMenu, { capture: true });
  if (focusTarget !== canvas) {
    focusTarget.addEventListener("contextmenu", open as EventListener);
  }

  return () => {
    dismiss?.();
    canvas.removeEventListener("contextmenu", open);
    focusTarget.removeEventListener("contextmenu", open as EventListener);
    focusTarget.removeEventListener("keydown", keyboardMenu, { capture: true });
  };
}
