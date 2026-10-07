/**
 * swf2es on any web page: the `<swf2es-player>` element, defined as this
 * module loads where there is a DOM, `replaceFlash` for a page's Flash
 * tags, and the page's one configuration.
 */
import { defineElement } from "./element.js";

export {
  type Configuration,
  configuration,
  configure,
  type SocketProxy,
} from "./config.js";
export {
  defineElement,
  parseColor,
  parseFlashVars,
  Swf2esPlayerElement,
  type SwfSource,
  scriptAccess,
  TAG,
} from "./element.js";
export { ExternalInterfaceError, type PageValue } from "./external.js";
export { type Placement, place, type ScaleMode, scaleMode } from "./layout.js";
export { flashAttributes, isFlash, replaceFlash, watchFlash } from "./replace.js";

defineElement();
