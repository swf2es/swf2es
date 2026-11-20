// AVM1's Stage singleton: the stage of the player the movie plays in, the
// AS3 player's for a SWF loaded inside AS3, which its scale mode, align and
// menu are shared with (Flash Player 32). Flash exposes them as
// enumerable, deletable getters and setters; assigning to the dimensions
// never changes the stage's size.
import { avm1 } from "@swf2es/runtime";
import { stageAlignment } from "../../stage.js";

export interface StageSize {
  readonly stageWidth: number;
  readonly stageHeight: number;
}

/** What Stage reads and sets of the stage. */
export interface StageHost extends StageSize {
  /** As AS3 names them: showAll, noScale, noBorder or exactFit. */
  scaleMode: string;
  /** As AS3 has it: some of T, B, L and R, in that order. */
  align: string;
  showMenu: boolean;
}

/** A main movie's own stage, of `size`, which keeps what its script sets. */
export function ownStage(size: StageSize): StageHost {
  return { ...size, scaleMode: "showAll", align: "", showMenu: true };
}

const SCALE_MODES = ["showAll", "noScale", "noBorder", "exactFit"];

export function stageObject(realm: avm1.Realm, host: StageHost): avm1.Avm1Object {
  const stage = new avm1.Avm1Object(realm.objectProto);
  // Older SWFs can reveal these functions by clearing their version flags.
  avm1.initializeBroadcaster(stage, realm, 6);
  const property = (
    name: string,
    get: () => avm1.Value,
    set?: (value: avm1.Value, version: number) => void,
  ) => {
    const slot = stage.add(name, undefined, 0);
    slot.get = realm.method(get);
    if (set) {
      slot.set = realm.method((_, args, version) => {
        set(args[0], version);
        return undefined;
      });
    }
  };
  property("width", () => host.stageWidth);
  property("height", () => host.stageHeight);
  // Any case; a name of none of them is showAll.
  property(
    "scaleMode",
    () => host.scaleMode,
    (value, version) => {
      const name = avm1.stringOf(value, version).toLowerCase();
      host.scaleMode = SCALE_MODES.find((mode) => mode.toLowerCase() === name) ?? "showAll";
    },
  );
  // Read as L, T, R and B in that order, AS3's T, B, L and R.
  property(
    "align",
    () => ["L", "T", "R", "B"].filter((side) => host.align.includes(side)).join(""),
    (value, version) => {
      host.align = stageAlignment(avm1.stringOf(value, version));
    },
  );
  property(
    "showMenu",
    () => host.showMenu,
    (value, version) => {
      host.showMenu = avm1.toBoolean(value, version);
    },
  );

  return stage;
}
