// AVM1's Camera, Microphone, NetStream and Video, which swf2es's AVM1 does
// not play: their names and the versions they appear from, as adl has them,
// with nothing behind them. There is no camera or microphone to get, a
// stream plays nothing and a Video shows nothing. Called as functions they
// give undefined; with new, an object of their prototype.
import { avm1 } from "@swf2es/runtime";

const HIDDEN = avm1.DONT_ENUM | avm1.DONT_DELETE;

/**
 * A class whose prototype has `methods`, each doing nothing, from the
 * version its flags give; `made` sees each object new makes.
 */
function placeholderClass(
  realm: avm1.Realm,
  methods: [name: string, flags: number][],
  made?: (self: avm1.Avm1Object, args: avm1.Value[]) => void,
): { constr: avm1.Avm1Function; proto: avm1.Avm1Object } {
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self, args) => {
      made?.(self, args);
      return self;
    },
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

/** What a stream on the local connection reads, which plays nothing, its buffer's time aside. */
const STREAM_VALUES: [string, avm1.Value][] = [
  ["audiocodec", 128],
  ["bufferLength", 0],
  ["bytesLoaded", 0],
  ["bytesTotal", 0],
  ["currentFps", 0],
  ["decodedFrames", 0],
  ["liveDelay", 0],
  ["time", 0],
  ["videocodec", 2048],
];

/** A stream made on a NetConnection: whether it has a stream's state (NetConnection.ts). */
export interface StreamConnections {
  streams(connection: avm1.Avm1Object): boolean;
}

/**
 * `_global.NetStream`: what plays a stream from SWF 5, what publishes or
 * closes one from SWF 6, getInfo from SWF 10. Its properties read
 * undefined, as a stream's do before it connects. The first stream made
 * on a NetConnection that connect took, failed not yet, gives the
 * prototype enumerable getters of a stream's state from SWF 6, over what
 * a script set there, which such a stream reads as one that has found
 * nothing to play (adl). Nothing plays, and play tells nothing.
 */
export function netStreamClass(
  realm: avm1.Realm,
  connections: StreamConnections,
): avm1.Avm1Function {
  const buffers = new WeakMap<avm1.Avm1Object, { time: number }>();
  const ofStream =
    (read: (buffer: { time: number }) => avm1.Value) =>
    (self: avm1.Avm1Object): avm1.Value => {
      const buffer = buffers.get(self);
      return buffer === undefined ? undefined : read(buffer);
    };
  let streamed = false;
  const made = (self: avm1.Avm1Object, args: avm1.Value[]) => {
    const connection = args.length > 0 ? args[0] : undefined;
    if (!(connection instanceof avm1.Avm1Object) || !connections.streams(connection)) {
      return;
    }

    buffers.set(self, { time: 0 });
    if (streamed) {
      return;
    }

    streamed = true;
    const getter = (name: string, read: (self: avm1.Avm1Object) => avm1.Value) => {
      const p = proto.add(name, undefined, avm1.VERSION_6);
      p.get = realm.method((self) => read(self));
    };

    for (const [name, value] of STREAM_VALUES) {
      getter(
        name,
        ofStream(() => value),
      );
    }

    getter(
      "bufferTime",
      ofStream((buffer) => buffer.time),
    );
  };
  const { constr, proto } = placeholderClass(
    realm,
    [
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
    ],
    made,
  );
  proto.define(
    "setBufferTime",
    realm.method((self, args, version) => {
      const buffer = buffers.get(self);
      if (buffer !== undefined) {
        buffer.time = avm1.toNumber(args[0], version);
      }

      return undefined;
    }),
    HIDDEN | avm1.VERSION_6,
  );

  for (const name of ["backBufferTime", "checkPolicyFile", "maxPauseBufferTime"]) {
    const p = proto.add(name, undefined, HIDDEN);
    p.get = realm.method((self) =>
      name === "checkPolicyFile" && buffers.has(self) ? false : undefined,
    );
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
