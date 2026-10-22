// AVM1's Stage singleton: its dimensions belong to the outer player,
// including for a SWF loaded inside AS3. Flash exposes them as enumerable,
// deletable getters, so assigning to them never changes the stage's size.
import { avm1 } from "@swf2es/runtime";

export interface StageSize {
  readonly stageWidth: number;
  readonly stageHeight: number;
}

export function stageObject(realm: avm1.Realm, size: StageSize): avm1.Avm1Object {
  const stage = new avm1.Avm1Object(realm.objectProto);
  // Older SWFs can reveal these functions by clearing their version flags.
  avm1.initializeBroadcaster(stage, realm, 6);
  stage.add("width", undefined, 0).get = realm.method(() => size.stageWidth);
  stage.add("height", undefined, 0).get = realm.method(() => size.stageHeight);

  return stage;
}
