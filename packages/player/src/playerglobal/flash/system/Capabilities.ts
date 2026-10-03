// flash.system.Capabilities: the screen values the host captured for this
// player, and the rest as Flash Player 32's browser plugin reports them on
// the host's system (platformCapabilities), which a host may set apart.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

/** What Capabilities reports of the system the player runs on. */
export interface PlatformCapabilities {
  /** "Windows 10", "Mac OS 10.15.7", "Linux"... */
  os: string;
  /** "Adobe Windows", "Adobe Macintosh" or "Adobe Linux". */
  manufacturer: string;
  /** The platform and the player's version: "WIN 32,0,0,465". */
  version: string;
  /** A language code: "en", or with its country for Chinese and Portuguese ("zh-CN"). */
  language: string;
  /** "PlugIn", "ActiveX", "StandAlone", "External" or "Desktop". */
  playerType: string;
}

/** The platform as the host's browser reports it, a Linux plugin's where it has none. */
export function platformCapabilities(): PlatformCapabilities {
  const navigator = (globalThis as { navigator?: { userAgent?: string; language?: string } })
    .navigator;
  const agent = navigator?.userAgent ?? "";
  const mac = /Mac OS X (\d+)[._](\d+)(?:[._](\d+))?/.exec(agent);
  const [os, manufacturer, platform] = /Windows/.test(agent)
    ? ["Windows 10", "Adobe Windows", "WIN"]
    : mac
      ? [`Mac OS ${mac[1]}.${mac[2]}${mac[3] ? `.${mac[3]}` : ""}`, "Adobe Macintosh", "MAC"]
      : ["Linux", "Adobe Linux", "LNX"];
  // Flash gives the country only where the language needs it.
  const tag = navigator?.language ?? "en";
  const [lang, country] = tag.split("-");
  const language = (lang === "zh" || lang === "pt") && country ? `${lang}-${country}` : lang;
  return { os, manufacturer, version: `${platform} 32,0,0,465`, language, playerType: "PlugIn" };
}

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

    static get touchscreenType(): string {
      return "none";
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
