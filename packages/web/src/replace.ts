// A page's Flash tags, <object> and <embed>, swapped for <swf2es-player>
// with what they told Flash: the movie, its FlashVars, how it is shown
// and scripted, its size, and the id and name the page's scripts find it by.
import { defineElement, type Swf2esPlayerElement, TAG } from "./element.js";

const FLASH_TYPES = new Set([
  "application/x-shockwave-flash",
  "application/futuresplash",
  "application/vnd.adobe.flash.movie",
]);
const FLASH_CLASSID = "clsid:d27cdb6e-ae6d-11cf-96b8-444553540000";

/** The parameters the element takes, by their lower-case names in a tag. */
const CARRIED = [
  "flashvars",
  "wmode",
  "scale",
  "salign",
  "base",
  "allowscriptaccess",
  "quality",
  "bgcolor",
  "menu",
];

/** Attributes the element keeps as they were, for the page's styles and scripts. */
const KEPT = ["id", "name", "class", "style", "title", "width", "height", "align"];

const isSwfUrl = (url: string | null) => /\.swf$/i.test((url ?? "").replace(/[?#].*$/s, ""));

/** The <param>s directly in an <object>, by lower-case name. */
function params(object: Element): Map<string, string> {
  const found = new Map<string, string>();
  for (const child of object.children) {
    const name = child.getAttribute("name")?.toLowerCase();
    if (child.localName === "param" && name && !found.has(name)) {
      found.set(name, child.getAttribute("value") ?? "");
    }
  }

  return found;
}

/** Whether `element` is a Flash <object> or <embed>: by its type, its ActiveX class, or a .swf for its movie. */
export function isFlash(element: Element): boolean {
  const type = element.getAttribute("type")?.toLowerCase().trim() ?? "";
  if (element.localName === "embed") {
    return FLASH_TYPES.has(type) || isSwfUrl(element.getAttribute("src"));
  }

  if (element.localName !== "object") {
    return false;
  }

  const p = params(element);
  return (
    FLASH_TYPES.has(type) ||
    element.getAttribute("classid")?.toLowerCase().trim() === FLASH_CLASSID ||
    isSwfUrl(element.getAttribute("data")) ||
    isSwfUrl(p.get("movie") ?? p.get("src") ?? null)
  );
}

/**
 * What a Flash tag and the Flash tags nested in it as fallbacks tell, the
 * outer first, as attributes of the element: an IE <object> with <param>s
 * often wraps an <embed> with the same as attributes, or with what the
 * <object> left out.
 */
export function flashAttributes(outer: Element): Map<string, string> {
  const attributes = new Map<string, string>();
  const set = (name: string, value: string | null | undefined) => {
    if (value !== null && value !== undefined && !attributes.has(name)) {
      attributes.set(name, value);
    }
  };
  const tags = [outer, ...outer.querySelectorAll("object, embed")].filter(isFlash);
  for (const tag of tags) {
    const p = tag.localName === "object" ? params(tag) : new Map<string, string>();
    const at = (name: string) => tag.getAttribute(name);
    set(
      "src",
      tag.localName === "embed" ? at("src") : (p.get("movie") ?? p.get("src") ?? at("data")),
    );
    for (const name of CARRIED) {
      set(name, p.get(name) ?? at(name));
    }

    for (const name of KEPT) {
      set(name, at(name));
    }
  }

  return attributes;
}

/**
 * Swap each Flash <object> and <embed> under `root` for a <swf2es-player>
 * carrying its parameters, in its place: the outermost of nested ones, its
 * fallbacks going with it. Returns the elements made.
 */
export function replaceFlash(root: ParentNode = document): Swf2esPlayerElement[] {
  defineElement();
  const made: Swf2esPlayerElement[] = [];
  const tags = [...root.querySelectorAll("object, embed")];
  if (root instanceof Element && (root.localName === "object" || root.localName === "embed")) {
    tags.unshift(root);
  }

  for (const tag of tags) {
    // A fallback of an outer one goes with it.
    const outer = tag.parentElement?.closest("object, embed");
    if (!isFlash(tag) || (outer && isFlash(outer))) {
      continue;
    }

    const attributes = flashAttributes(tag);
    if (!attributes.get("src")) {
      continue;
    }

    const player = document.createElement(TAG) as Swf2esPlayerElement;
    for (const [name, value] of attributes) {
      player.setAttribute(name, value);
    }

    tag.replaceWith(player);
    made.push(player);
  }

  return made;
}

/**
 * replaceFlash now, and again for each Flash tag the page adds under `root`
 * later, until the returned function is called.
 */
export function watchFlash(root: ParentNode & Node = document): () => void {
  replaceFlash(root);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element && node.isConnected) {
          replaceFlash(node);
        }
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
