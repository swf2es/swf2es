// flash.system.Capabilities: the screen values the host captured for this
// player, and the rest as Flash Player 32's browser plugin reports them on
// the host's system (hosts.ts's platformCapabilities), which a host may
// set apart.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

export function capabilitiesNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const p = () => s.platform;

  class CapabilitiesNatives {
    static get screenResolutionX(): number {
      return s.screenCapabilities.screenResolutionX;
    }

    static get screenResolutionY(): number {
      return s.screenCapabilities.screenResolutionY;
    }

    static get pixelAspectRatio(): number {
      return s.screenCapabilities.pixelAspectRatio;
    }

    static get screenDPI(): number {
      return s.screenCapabilities.screenDPI;
    }

    static get os(): string {
      return p().os;
    }

    static get manufacturer(): string {
      return p().manufacturer;
    }

    static get version(): string {
      return p().version;
    }

    static get language(): string {
      return p().language;
    }

    static get languages(): avm2.Value {
      return s.rt.newArray([p().language]);
    }

    static get playerType(): string {
      return p().playerType;
    }

    static get isDebugger(): boolean {
      return s.rt.debugger;
    }

    static get cpuArchitecture(): string {
      return "x86";
    }

    static get screenColor(): string {
      return "color";
    }

    // A browser tells a finger's screen from none, not a stylus's.
    static get touchscreenType(): string {
      return s.maxTouchPoints > 0 ? "finger" : "none";
    }

    static get maxLevelIDC(): string {
      return "5.1";
    }

    static get serverString(): string {
      return serverString(s);
    }

    static get "flash.system:Capabilities::_internal"(): number {
      return 0;
    }

    static hasMultiChannelAudio(_type: avm2.Value): boolean {
      return false;
    }

    // What a browser plugin has: sound, video and the rest it plays, printing,
    // accessibility, an IME and TLS; no screen broadcast, no local file reads.
    static get hasAudio(): boolean {
      return true;
    }

    static get hasMP3(): boolean {
      return true;
    }

    static get hasStreamingAudio(): boolean {
      return true;
    }

    static get hasStreamingVideo(): boolean {
      return true;
    }

    static get hasEmbeddedVideo(): boolean {
      return true;
    }

    static get hasAudioEncoder(): boolean {
      return true;
    }

    static get hasVideoEncoder(): boolean {
      return true;
    }

    static get hasPrinting(): boolean {
      return true;
    }

    static get hasAccessibility(): boolean {
      return true;
    }

    static get hasIME(): boolean {
      return true;
    }

    static get hasTLS(): boolean {
      return true;
    }

    static get supports32BitProcesses(): boolean {
      return true;
    }

    static get supports64BitProcesses(): boolean {
      return true;
    }

    static get hasScreenBroadcast(): boolean {
      return false;
    }

    static get hasScreenPlayback(): boolean {
      return false;
    }

    static get avHardwareDisable(): boolean {
      return false;
    }

    static get localFileReadDisable(): boolean {
      return true;
    }

    static get isEmbeddedInAcrobat(): boolean {
      return false;
    }
  }

  avm2.registerNativeClass(natives, "flash.system::Capabilities", CapabilitiesNatives);
  return natives;
}

/** The capabilities as Flash sends them to a server: its fields' codes, URL-encoded, in its order. */
function serverString(s: Scripting): string {
  const p = s.platform;
  const yes = (b: boolean) => (b ? "t" : "f");
  const sc = s.screenCapabilities;
  const fields: [string, string][] = [
    ["A", "t"],
    ["SA", "t"],
    ["SV", "t"],
    ["EV", "t"],
    ["MP3", "t"],
    ["AE", "t"],
    ["VE", "t"],
    ["ACC", "t"],
    ["PR", "t"],
    ["SP", "f"],
    ["SB", "f"],
    ["DEB", yes(s.rt.debugger)],
    ["V", p.version],
    ["M", p.manufacturer],
    ["R", `${sc.screenResolutionX}x${sc.screenResolutionY}`],
    ["COL", "color"],
    ["AR", String(sc.pixelAspectRatio)],
    ["OS", p.os],
    ["ARCH", "x86"],
    ["L", p.language],
    ["IME", "t"],
    ["PR32", "t"],
    ["PR64", "t"],
    ["PT", p.playerType],
    ["AVD", "f"],
    ["LFD", "t"],
    ["WD", "f"],
    ["TLS", "t"],
    ["ML", "5.1"],
    ["DP", String(sc.screenDPI)],
  ];
  return fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}
