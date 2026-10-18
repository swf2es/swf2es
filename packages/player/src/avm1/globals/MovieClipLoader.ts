// MovieClipLoader, AS2's loadMovie with events, as Ruffle's
// (https://github.com/ruffle-rs/ruffle) core/src/avm1/globals/movie_clip_loader.rs
// has it: MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle
// contributors. A loader is a broadcaster, itself its first listener; the
// player tells its listeners of each load (avm1.ts, "loadClip"):
// onLoadStart, onLoadProgress, onLoadComplete or onLoadError as the load
// arrives, and onLoadInit once the loaded movie's first frame's actions
// have run.
import { avm1 } from "@swf2es/runtime";
import type { DisplayObject } from "../../display/display.js";

type Value = avm1.Value;

/** What MovieClipLoader asks of the movie. */
export interface LoaderHost {
  readonly realm: avm1.Realm;
  /** What a path from the code's target, or a display object's AVM1 object, names; null for nothing. */
  resolve(value: Value, version: number): DisplayObject | null;
  /** Level `n`'s clip, null where there is none. */
  level(n: number): DisplayObject | null;
  /** Level `n`'s clip, an empty one made where there is none, as a load into it makes one. */
  levelToLoad(n: number): DisplayObject;
  /** The SWF or image at `url` loaded into `target`, `loader`'s listeners told of it. */
  loadClip(loader: avm1.Avm1Object, target: DisplayObject, url: string): void;
  /** unloadMovie: what `d` shows unloaded. */
  unloadMovie(d: DisplayObject): void;
  /** The size of the SWF `d` is of, as it came, which getProgress gives. */
  sizeOf(d: DisplayObject): number;
}

const FIXED = avm1.DONT_ENUM | avm1.DONT_DELETE;

/** A level's number as Rust's `as i32` casts one: cut toward zero, saturated, NaN 0. */
function levelNumber(n: number): number {
  return Number.isNaN(n) ? 0 : Math.trunc(Math.max(-0x80000000, Math.min(0x7fffffff, n)));
}

/** `_global.MovieClipLoader`. */
export function movieClipLoaderClass(host: LoaderHost, version: number): avm1.Avm1Function {
  const realm = host.realm;
  const proto = new avm1.Avm1Object(realm.objectProto);
  avm1.initializeBroadcaster(proto, realm, version);
  const constr = realm.classOf(
    proto,
    (self, _, v) => {
      self.define("_listeners", realm.newArray([self], v), avm1.DONT_ENUM);
      return self;
    },
    () => undefined,
  );

  /**
   * The display object a target names: a path from the code's target, a
   * level by number (made for a load), a display object's AVM1 object;
   * null for anything else.
   */
  const targetOf = (value: Value, v: number, load: boolean): DisplayObject | null => {
    if (typeof value === "number") {
      const n = levelNumber(value);
      return load ? host.levelToLoad(n) : host.level(n);
    }

    if (typeof value === "string" || value instanceof avm1.Avm1Object) {
      return host.resolve(value, v);
    }

    return null;
  };

  // The URL must be a string; true where the target names a display object.
  proto.define(
    "loadClip",
    realm.method((self, args, v) => {
      if (args.length < 2) {
        return undefined;
      }

      const url = args[0];
      if (typeof url !== "string") {
        return false;
      }

      const target = targetOf(args[1], v, true);
      if (target === null) {
        return false;
      }

      host.loadClip(self, target, url);
      return true;
    }),
    FIXED,
  );
  // Each of the target's SWF's size, as it came; an object without either where the target
  // names nothing, undefined for no target or an object that is no display object's.
  proto.define(
    "getProgress",
    realm.method((_, args, v) => {
      if (args.length === 0) {
        return undefined;
      }

      const value = args[0];
      if (value instanceof avm1.Avm1Object && value.display === null) {
        return undefined;
      }

      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        !(value instanceof avm1.Avm1Object)
      ) {
        return undefined;
      }

      const result = new avm1.Avm1Object(null);
      const target = targetOf(value, v, false);
      if (target !== null) {
        const size = host.sizeOf(target);
        result.define("bytesLoaded", size, 0);
        result.define("bytesTotal", size, 0);
      }

      return result;
    }),
    FIXED,
  );
  proto.define(
    "unloadClip",
    realm.method((_, args, v) => {
      if (args.length === 0) {
        return undefined;
      }

      const target = targetOf(args[0], v, false);
      if (target === null) {
        return false;
      }

      host.unloadMovie(target);
      return true;
    }),
    FIXED,
  );
  return constr;
}
