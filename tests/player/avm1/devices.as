// The globals of devices and streams AVM1 plays nothing of, by version
// (packages/player/src/avm1/globals/media.ts, Accessibility.ts,
// TextRenderer.ts and System.IME): which names each version sees, what a
// call or new of them gives, and the values their functions give where
// there is no screen reader, IME, camera or stream. Camera.get and the
// device names are left out: adl waits on the system's devices for them.
function ty(name, o, list) {
  var s = [];
  for (var i = 0; i < list.length; i++) {
    s.push(list[i] + ":" + typeof o[list[i]]);
  }
  trace(name + " " + s.join(" "));
}
function en(name, o) {
  var s = [];
  for (var k in o) {
    s.push(k);
  }
  s.sort();
  trace(name + " enumerates " + s.join(" "));
}
ty("globals", _global, ["Accessibility", "Camera", "Microphone", "NetStream", "Video", "LocalConnection", "TextField", "flash"]);
ty("prototypes", { a: Camera.prototype, b: Microphone.prototype, c: NetStream.prototype, d: Video.prototype, e: LocalConnection.prototype, f: TextField.prototype }, ["a", "b", "c", "d", "e", "f"]);
ty("NetStream", NetStream.prototype, ["attachAudio", "attachVideo", "backBufferTime", "checkPolicyFile", "close", "getInfo", "maxPauseBufferTime", "onPeerConnect", "pause", "play", "play2", "publish", "receiveAudio", "receiveVideo", "seek", "send", "setBufferTime"]);
ty("Video", Video.prototype, ["attachVideo", "clear"]);
ty("Camera", Camera.prototype, ["setCursor", "setKeyFrameInterval", "setLoopback", "setMode", "setMotionLevel", "setQuality"]);
ty("Camera statics", Camera, ["get"]);
ty("Microphone", Microphone.prototype, ["setCodec", "setEncodeQuality", "setFramesPerPacket", "setGain", "setRate", "setSilenceLevel", "setUseEchoSuppression"]);
ty("Microphone statics", Microphone, ["get"]);
ty("IME", System.IME, ["ALPHANUMERIC_FULL", "UNKNOWN", "_listeners", "addListener", "broadcastMessage", "removeListener", "doConversion", "getConversionMode", "getEnabled", "setCompositionString", "setConversionMode", "setEnabled"]);
ty("Accessibility", Accessibility, ["isActive", "sendEvent", "updateProperties"]);
ty("LocalConnection", LocalConnection.prototype, ["close", "connect", "domain", "send"]);
en("Accessibility", Accessibility);
en("Camera", Camera);
en("Camera.prototype", Camera.prototype);
en("NetStream.prototype", NetStream.prototype);
en("IME", System.IME);
trace("called " + typeof NetStream() + " " + typeof Video() + " " + typeof Camera() + " " + typeof Microphone());
trace("new " + typeof new NetStream() + " " + typeof new Video() + " " + typeof new Camera() + " " + typeof new Microphone());
var stream = new NetStream();
trace("stream " + stream.backBufferTime + " " + stream.checkPolicyFile + " " + stream.maxPauseBufferTime + " " + stream.time + " " + stream.play("none.flv") + " " + stream.pause() + " " + (stream.__proto__ == NetStream.prototype));
var ime = System.IME;
var modes = ["ALPHANUMERIC_FULL", "ALPHANUMERIC_HALF", "CHINESE", "JAPANESE_HIRAGANA", "JAPANESE_KATAKANA_FULL", "JAPANESE_KATAKANA_HALF", "KOREAN", "UNKNOWN"];
var s = "";
for (var i = 0; i < modes.length; i++) {
  s += ime[modes[i]] + " ";
}
trace("modes " + s);
ime.KOREAN = "changed";
trace("mode written " + ime.KOREAN);
trace("IME " + ime.getEnabled() + " " + ime.setEnabled(true) + " " + ime.getEnabled() + " " + ime.getConversionMode() + " " + ime.setConversionMode("KOREAN") + " " + ime.getConversionMode() + " " + ime.doConversion() + " " + ime.setCompositionString("x"));
trace("Accessibility " + Accessibility.isActive() + " " + Accessibility.sendEvent() + " " + Accessibility.updateProperties() + " " + (Accessibility.constructor == Object));
var R = flash.text.TextRenderer;
if (typeof R == "function") {
  en("flash.text", flash.text);
  en("TextRenderer", R);
  trace("TextRenderer " + R.displayMode + " " + R.maxLevel + " " + R.setAdvancedAntialiasingTable() + " " + typeof R() + " " + typeof new R() + " " + (R.prototype.constructor == R));
  var levels = [0, 3, 4, 5, 7, 8, 3.5, "3", "abc", true, null];
  s = "";
  for (var i = 0; i < levels.length; i++) {
    R.maxLevel = 7;
    R.maxLevel = levels[i];
    s += levels[i] + ">" + R.maxLevel + " ";
  }
  trace("maxLevel " + s);
  var displayModes = ["lcd", "crt", "LCD", "default", "advanced", "", 5, undefined, null, true];
  s = "";
  for (var i = 0; i < displayModes.length; i++) {
    R.displayMode = "lcd";
    R.displayMode = displayModes[i];
    s += displayModes[i] + ">" + R.displayMode + " ";
  }
  trace("displayMode " + s);
  // Flash keeps them for the player, past this movie: back to its defaults.
  R.displayMode = "crt";
  R.maxLevel = 4;
}
