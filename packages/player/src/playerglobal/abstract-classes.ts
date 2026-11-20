// The playerglobal classes a script may not construct, as Flash's natives
// declare them construct="abstract" (or "abstract-restricted"): `new` of
// one throws #2012, though the player's factories make them
// (Runtime.constructNative). What adl throws for each is the
// abstract-classes player case's reference. The display classes refuse in
// SymbolLibrary.displayFor, where the display object of a script's `new`
// is made; Context3D's family in its AS3 constructors.
import type { avm2 } from "@swf2es/runtime";

const ABSTRACT = [
  "flash.accessibility::Accessibility",
  "flash.display::Graphics",
  "flash.display::LoaderInfo",
  "flash.display::Stage3D",
  "flash.external::ExternalInterface",
  "flash.geom::Utils3D",
  "flash.media::StageVideo",
  "flash.net::SharedObject",
  "flash.net.drm::DRMManager",
  "flash.net.drm::DRMPlaybackTimeWindow",
  "flash.net.drm::DRMVoucher",
  "flash.system::Capabilities",
  "flash.system::IME",
  "flash.system::MessageChannel",
  "flash.system::Security",
  "flash.system::System",
  "flash.system::Worker",
  "flash.system::WorkerDomain",
  "flash.text::TextSnapshot",
  "flash.text.engine::TextLineMirrorRegion",
  "flash.ui::Keyboard",
  "flash.ui::Mouse",
  "flash.ui::Multitouch",
];

/** Also restricted: a script's subclass is refused too, naming itself. */
const RESTRICTED = ["flash.ui::GameInputControl"];

/** `hooks` with the abstract classes' construct hooks added to whatever else each has. */
export function withAbstractClasses(
  hooks: Record<string, avm2.ClassHook>,
): Record<string, avm2.ClassHook> {
  const refuse: avm2.ClassHook["construct"] = (rt, cls) => {
    throw rt.cantInstantiate(cls.$it.name);
  };
  for (const name of ABSTRACT) {
    hooks[name] = { ...hooks[name], construct: refuse };
  }

  for (const name of RESTRICTED) {
    hooks[name] = { ...hooks[name], construct: refuse, restricted: true };
  }

  // Flash's ContentElement refuses in its AS3 constructor, which names it so; its
  // subclasses construct.
  hooks["flash.text.engine::ContentElement"] = {
    ...hooks["flash.text.engine::ContentElement"],
    construct: (rt) => {
      throw rt.error("ArgumentError", 2012, "ContentElement");
    },
  };
  return hooks;
}
