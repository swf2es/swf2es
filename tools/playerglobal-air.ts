// AIR's definitions that Flash Player's playerglobal declares with no API
// version of AIR's, so that a SWF for the browser would see them, though
// the browser's Flash Player has none of them. tools/playerglobal.ts marks
// those of AIR_ONLY as AIR 1.0's ([API("661")]) as it compiles ours, which
// leaves them to AIR's series of API versions alone, as avmplus versions
// any other AIR name: on the web a SWF finds none of them, by name or by
// code, and an AIR host finds them all.
//
// Measured in Flash Player 32's plugin (PlugIn LNX 32,0,0,142) with a SWF
// of version 43 that asked hasDefinition and getDefinitionByName for each
// of the 538 definitions our playerglobal declares: it lacks 121, each
// refused with ReferenceError #1065. 102 of them carry AIR's API versions
// already; these are the other 19, AIR_ONLY's and AIR_KEPT's. A SWF of a
// lower version lacks more, Flash Player's own names newer than it.

/** Hidden on the web: AIR's application and desktop, which a game checks to tell AIR from a browser. */
export const AIR_ONLY = [
  // The application, which games look for first, and how it was started.
  "flash.desktop::NativeApplication",
  "flash.desktop::InvokeEventReason",
  // Drags to and from the desktop, NativeDragManager's (AIR's by its version).
  "flash.desktop::NativeDragActions",
  "flash.desktop::NativeDragOptions",
  "flash.events::NativeDragEvent",
  // The installed application's updates.
  "flash.desktop::Updater",
  "flash.display::NativeWindow",
  "flash.filesystem::StorageVolumeInfo",
  // AIR's own WebKit.
  "flash.html::HTMLHost",
  "flash.html::HTMLLoader",
  "flash.html::HTMLPDFCapability",
  // XML signatures, judged by the system's certificate store.
  "flash.security::IURIDereferencer",
  "flash.security::RevocationCheckSettings",
  "flash.security::SignatureStatus",
  "flash.security::SignerTrustSettings",
  "flash.security::XMLSignatureValidator",
  // The application sandbox's privileges: files, windows, the screen.
  "flash.system::SecurityPrivilege",
];

/**
 * Left visible on the web, though the plugin lacks them: AIR's, but what
 * a browser could do. A name moves to AIR_ONLY to be hidden.
 */
export const AIR_KEPT = [
  // Every URLRequest's defaults (cache, redirects, idle timeout), which a fetch can honour.
  "flash.net::URLRequestDefaults",
  // TouchEvent.touchIntent's values, which a pointer's pointerType answers.
  "flash.events::TouchEventIntent",
];
