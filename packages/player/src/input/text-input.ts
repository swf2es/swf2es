// Text that comes with no key of its own: an IME's composed text, a soft
// keyboard's, or any insertion a browser makes (DevTools' Input.insertText).
// A browser sends those only to an editable element, which the player's
// canvas is not, so the host keeps a hidden textarea of its own, focused
// while a SWF's input field has focus. Keys typed in it still bubble to
// bindKeyboard's listener, which types their characters; only text
// without such a key goes to the field from here.

import type { Keyboard } from "./keyboard.js";

/** The hidden textareas the player made: their keys are the SWF's, not the page's. */
const editors = new WeakSet<EventTarget>();

/** Whether `target` is the player's own textarea, whose keys are the SWF's. */
export function isTextInput(target: EventTarget | null): boolean {
  return !!target && editors.has(target);
}

/** The hidden textarea, focused while the SWF takes text: `sync` follows the SWF's focus. */
export interface TextInput {
  /** Focus the textarea while the host has focus and the SWF takes text, else the host. */
  sync(): void;
  destroy(): void;
}

/**
 * A hidden textarea in `box`, inside `host`, the element the page focuses,
 * through which committed text reaches the player: an insertion without a
 * composition, or a composition's end. Text a key typed, which the player
 * has from its keydown, is left out, as is text in mid-composition, which
 * the SWF never sees, and what was inserted is cleared away at once.
 */
export function bindTextInput(
  player: { keyboard: Keyboard | null },
  host: HTMLElement,
  box: HTMLElement,
): TextInput {
  const editor = box.ownerDocument.createElement("textarea");
  editors.add(editor);
  editor.tabIndex = -1;
  editor.autocomplete = "off";
  editor.spellcheck = false;
  editor.setAttribute("autocapitalize", "off");
  editor.setAttribute("autocorrect", "off");
  editor.style.cssText =
    "position:absolute;left:0;top:0;width:1px;height:1px;padding:0;border:0;margin:0;" +
    "opacity:0;resize:none;overflow:hidden;pointer-events:none;caret-color:transparent";
  box.append(editor);

  // A key bindKeyboard sent the SWF, down until let go: what it inserts, its keydown typed.
  let keyed = false;
  const insert = (text: string) => {
    if (text !== "") {
      player.keyboard?.insert(text);
    }
  };
  const keydown = (event: Event) => {
    const e = event as KeyboardEvent;
    keyed = !e.isComposing && e.keyCode !== 229;
  };
  const keyup = () => {
    keyed = false;
  };
  const compositionend = (event: Event) => {
    insert((event as CompositionEvent).data);
    editor.value = "";
  };
  const input = (event: Event) => {
    const e = event as InputEvent;
    if (e.isComposing) {
      return;
    }

    // A composition's own inputs, Safari's insertFromComposition after its end among them, are
    // left to compositionend, and a paste to bindKeyboard's paste listener.
    if (e.inputType === "insertText" && !keyed && e.data) {
      insert(e.data);
    }

    editor.value = "";
  };
  const listeners: [string, (e: Event) => void][] = [
    ["keydown", keydown],
    ["keyup", keyup],
    ["compositionend", compositionend],
    ["input", input],
  ];
  for (const [type, listener] of listeners) {
    editor.addEventListener(type, listener);
  }

  // The host's own methods, not what is on it: a SWF's ExternalInterface callbacks may be.
  const focusHost = () => HTMLElement.prototype.focus.call(host, { preventScroll: true });
  const focusOf = (node: Node) =>
    (Node.prototype.getRootNode.call(node) as Document | ShadowRoot).activeElement;
  return {
    sync() {
      const outer = focusOf(host);
      const inEditor = focusOf(editor) === editor;
      const hostFocused =
        outer === host || (outer !== null && Node.prototype.contains.call(host, outer));
      const editing = player.keyboard?.editing ?? false;
      if (editing && hostFocused && !inEditor) {
        editor.focus({ preventScroll: true });
      } else if (!editing && inEditor) {
        focusHost();
      }
    },
    destroy() {
      for (const [type, listener] of listeners) {
        editor.removeEventListener(type, listener);
      }

      // Removed while focused, the focus would leave the host for the page's body.
      if (focusOf(editor) === editor) {
        focusHost();
      }

      editor.remove();
    },
  };
}
