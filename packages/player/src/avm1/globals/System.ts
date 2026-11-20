// AVM1's System: its capabilities as Flash Player 32's plug-in reports them
// on the host's system (hosts.ts's platformCapabilities), as AS3's
// flash.system.Capabilities has them, and its security functions, which
// have nothing to grant where every domain may already script. Flash has
// them all as plain, enumerable values a script may overwrite, in this
// order (PepperFlash 32 and AIR's adl).
import { avm1 } from "@swf2es/runtime";
import { type PlatformCapabilities, type ScreenCapabilities, serverString } from "../../hosts.js";

/** `_global.System` for a movie whose main SWF is of `version`, in a debugger player where `debug`. */
export function systemObject(
  realm: avm1.Realm,
  platform: PlatformCapabilities,
  screen: ScreenCapabilities,
  debug: boolean,
  version: number,
  sandboxType: string,
): avm1.Avm1Object {
  const system = new avm1.Avm1Object(realm.objectProto);
  system.define("capabilities", capabilitiesObject(realm, platform, screen, debug), 0);
  // Flash's default: settings stored by exact domain from SWF 7 on.
  system.define("exactSettings", version >= 7, avm1.VERSION_6);
  system.define("useCodepage", false, 0);
  system.define("security", securityObject(realm, sandboxType), 0);
  system.define("IME", imeObject(realm, version), 0);

  return system;
}

/** System.capabilities, its values in the order Flash defines them. */
function capabilitiesObject(
  realm: avm1.Realm,
  p: PlatformCapabilities,
  sc: ScreenCapabilities,
  debug: boolean,
): avm1.Avm1Object {
  const values: [string, avm1.Value][] = [
    ["hasAccessibility", true],
    ["pixelAspectRatio", sc.pixelAspectRatio],
    ["screenColor", "color"],
    ["screenDPI", sc.screenDPI],
    ["screenResolutionY", sc.screenResolutionY],
    ["screenResolutionX", sc.screenResolutionX],
    ["hasTLS", true],
    ["hasVideoEncoder", true],
    ["hasAudioEncoder", true],
    ["hasMP3", true],
    ["hasAudio", true],
    ["serverString", serverString(p, sc, debug)],
    ["version", p.version],
    ["hasStreamingAudio", true],
    ["hasStreamingVideo", true],
    ["hasEmbeddedVideo", true],
    ["hasPrinting", true],
    ["hasScreenPlayback", false],
    ["hasScreenBroadcast", false],
    ["isDebugger", debug],
    ["playerType", p.playerType],
    ["avHardwareDisable", false],
    ["localFileReadDisable", true],
    ["windowlessDisable", false],
    ["maxLevelIDC", "5.1"],
    ["isEmbeddedInAcrobat", false],
    ["manufacturer", p.manufacturer],
    ["os", p.os],
    ["cpuArchitecture", "x86"],
    ["cpuAddressSize", 64],
    ["supports32BitProcesses", true],
    ["supports64BitProcesses", true],
    ["language", p.language],
    ["hasIME", true],
  ];
  const capabilities = new avm1.Avm1Object(realm.objectProto);
  for (const [name, value] of values) {
    capabilities.define(name, value, 0);
  }

  return capabilities;
}

/** System.IME's conversion modes, each its own name. */
const CONVERSION_MODES = [
  "ALPHANUMERIC_FULL",
  "ALPHANUMERIC_HALF",
  "CHINESE",
  "JAPANESE_HIRAGANA",
  "JAPANESE_KATAKANA_FULL",
  "JAPANESE_KATAKANA_HALF",
  "KOREAN",
  "UNKNOWN",
];

/**
 * System.IME, as adl has it where no IME is installed: it stays disabled
 * in the UNKNOWN mode, and each of its functions fails. Its modes are
 * there from SWF 5, its broadcaster from SWF 6, its functions from SWF 8.
 */
function imeObject(realm: avm1.Realm, version: number): avm1.Avm1Object {
  const ime = new avm1.Avm1Object(realm.objectProto);
  const hidden = avm1.DONT_ENUM | avm1.DONT_DELETE;
  for (const mode of CONVERSION_MODES) {
    ime.define(mode, mode, hidden | avm1.READ_ONLY);
  }

  avm1.initializeBroadcaster(ime, realm, version);
  const results: [string, avm1.Value][] = [
    ["doConversion", false],
    ["getConversionMode", "UNKNOWN"],
    ["getEnabled", false],
    ["setCompositionString", false],
    ["setConversionMode", false],
    ["setEnabled", false],
  ];
  for (const [name, result] of results) {
    ime.define(
      name,
      realm.method(() => result),
      hidden | avm1.VERSION_8,
    );
  }

  return ime;
}

/** System.security: every domain may script already, and a policy file grants nothing more. */
function securityObject(realm: avm1.Realm, sandboxType: string): avm1.Avm1Object {
  const security = new avm1.Avm1Object(realm.objectProto);
  security.define(
    "allowDomain",
    realm.method(() => true),
    0,
  );
  security.define(
    "allowInsecureDomain",
    realm.method(() => true),
    avm1.VERSION_7,
  );
  security.define(
    "loadPolicyFile",
    realm.method(() => undefined),
    0,
  );
  security.define("sandboxType", sandboxType, 0);

  return security;
}
