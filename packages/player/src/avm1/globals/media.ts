// AVM1's Camera, Microphone, NetStream and Video, which swf2es's AVM1 does
// not play: their names and the versions they appear from, as adl has them,
// with nothing behind them. There is no camera or microphone to get, a
// stream plays nothing and a Video shows nothing. Called as functions they
// give undefined; with new, an object of their prototype.
import { avm1 } from "@swf2es/runtime";

const HIDDEN = avm1.DONT_ENUM | avm1.DONT_DELETE;

/** A class whose prototype has `methods`, each doing nothing, from the version its flags give. */
function placeholderClass(
  realm: avm1.Realm,
  methods: [name: string, flags: number][],
): { constr: avm1.Avm1Function; proto: avm1.Avm1Object } {
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self) => self,
    () => undefined,
  );
  for (const [name, flags] of methods) {
    proto.define(
      name,
      realm.method(() => undefined),
      HIDDEN | flags,
    );
  }

  return { constr, proto };
}

/** A device class's `get`, which finds none, and `names`, which lists none, at every version. */
function noDevices(realm: avm1.Realm, constr: avm1.Avm1Function): void {
  constr.define(
    "get",
    realm.method(() => null),
    0,
  );
  const names = constr.add("names", undefined, 0);
  names.get = realm.method((_, __, version) => realm.newArray([], version));
  names.set = realm.method(() => undefined);
}

/** `_global.Camera`. */
export function cameraClass(realm: avm1.Realm): avm1.Avm1Function {
  const { constr } = placeholderClass(
    realm,
    [
      "setCursor",
      "setKeyFrameInterval",
      "setLoopback",
      "setMode",
      "setMotionLevel",
      "setQuality",
    ].map((name) => [name, avm1.VERSION_6]),
  );
  noDevices(realm, constr);
  return constr;
}

/** `_global.Microphone`: its codec's settings from SWF 10. */
export function microphoneClass(realm: avm1.Realm): avm1.Avm1Function {
  const { constr } = placeholderClass(realm, [
    ["setCodec", avm1.VERSION_10],
    ["setEncodeQuality", avm1.VERSION_10],
    ["setFramesPerPacket", avm1.VERSION_10],
    ["setGain", avm1.VERSION_6],
    ["setRate", avm1.VERSION_6],
    ["setSilenceLevel", avm1.VERSION_6],
    ["setUseEchoSuppression", avm1.VERSION_6],
  ]);
  noDevices(realm, constr);
  return constr;
}

/**
 * `_global.NetStream`: what plays a stream from SWF 5, what publishes or
 * closes one from SWF 6, getInfo from SWF 10. Its three properties read
 * undefined, as a stream's do before it connects.
 */
export function netStreamClass(realm: avm1.Realm): avm1.Avm1Function {
  const { constr, proto } = placeholderClass(realm, [
    ["attachAudio", avm1.VERSION_6],
    ["attachVideo", avm1.VERSION_6],
    ["close", avm1.VERSION_6],
    ["getInfo", avm1.VERSION_10],
    ["onPeerConnect", 0],
    ["pause", 0],
    ["play", 0],
    ["play2", 0],
    ["publish", 0],
    ["receiveAudio", 0],
    ["receiveVideo", 0],
    ["seek", 0],
    ["send", avm1.VERSION_6],
    ["setBufferTime", avm1.VERSION_6],
  ]);
  for (const name of ["backBufferTime", "checkPolicyFile", "maxPauseBufferTime"]) {
    const p = proto.add(name, undefined, HIDDEN);
    p.get = realm.method(() => undefined);
    p.set = realm.method(() => undefined);
  }

  return constr;
}

/** `_global.Video`. */
export function videoClass(realm: avm1.Realm): avm1.Avm1Function {
  return placeholderClass(realm, [
    ["attachVideo", avm1.VERSION_6],
    ["clear", avm1.VERSION_6],
  ]).constr;
}
