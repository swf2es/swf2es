// flash.media.Camera as Flash Player has it on a machine without a camera:
// supported, but no names and no camera to get. A Camera made with `new`
// reads as zeros, and its settings change nothing, as in Flash.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function cameraNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  /** Flash checks the arguments of the copies even with no picture to copy. */
  function required(value: Value, name: string): void {
    if (value === null || value === undefined) {
      throw s.rt.error("TypeError", 2007, name);
    }
  }

  class CameraNatives {
    static get isSupported(): boolean {
      return true;
    }

    /** A new array each time, as Flash's. */
    static get names(): Value {
      return s.rt.array([]);
    }

    static getCamera(_name: Value): Value {
      return null;
    }

    get activityLevel(): number {
      return 0;
    }

    get bandwidth(): number {
      return 0;
    }

    get currentFPS(): number {
      return 0;
    }

    get fps(): number {
      return 0;
    }

    get height(): number {
      return 0;
    }

    get index(): number {
      return 0;
    }

    get keyFrameInterval(): number {
      return 0;
    }

    get loopback(): boolean {
      return false;
    }

    get motionLevel(): number {
      return 0;
    }

    get motionTimeout(): number {
      return 0;
    }

    get muted(): boolean {
      return false;
    }

    get name(): Value {
      return null;
    }

    get position(): Value {
      return null;
    }

    get quality(): number {
      return 0;
    }

    get width(): number {
      return 0;
    }

    setCursor(_value: Value): void {}

    setKeyFrameInterval(_keyFrameInterval: Value): void {}

    setLoopback(_compress: Value): void {}

    setMode(_width: Value, _height: Value, _fps: Value, _favorArea: Value): void {}

    setMotionLevel(_motionLevel: Value, _timeout: Value): void {}

    setQuality(_bandwidth: Value, _quality: Value): void {}

    drawToBitmapData(destination: Value): void {
      required(destination, "destination");
    }

    copyToByteArray(rect: Value, destination: Value): void {
      required(rect, "rect");
      required(destination, "destination");
    }

    copyToVector(rect: Value, destination: Value): void {
      required(rect, "rect");
      required(destination, "destination");
    }
  }

  avm2.registerNativeClass(natives, "flash.media::Camera", CameraNatives);
  return natives;
}
