// Device behaviour follows Adobe's Camera documentation. Without a host,
// retain the no-device defaults measured under adl, including new Camera().
import { avm2 } from "@swf2es/runtime";
import type { As3 } from "../../../as3/types.js";
import { pixelRect } from "../../../bitmap/pixel-rect.js";
import { CameraState, cameraStates } from "../../../media/camera.js";
import { requestCapturePermission } from "../../../media/capture-permission.js";
import type { Scripting } from "../../../scripting.js";
import { storeOf } from "../display/BitmapData.js";

type Value = avm2.Value;

export function cameraNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const cameras = new Map<number, avm2.AsObject>();
  const state = (object: object) => cameraStates.get(object);
  const area = (value: Value) => {
    const r = value as As3<"flash.geom::Rectangle">;
    return pixelRect(
      s.rt.prop(r, "x"),
      s.rt.prop(r, "y"),
      s.rt.prop(r, "width"),
      s.rt.prop(r, "height"),
    );
  };

  /** Flash checks the arguments of the copies even with no picture to copy. */
  function required(value: Value, name: string): void {
    if (value === null || value === undefined) {
      throw s.rt.error("TypeError", 2007, name);
    }
  }

  class CameraNatives {
    static get permissionStatus(): string {
      return s.capture?.permissionStatus?.("camera") ?? "denied";
    }
    requestPermission(): void {
      requestCapturePermission(s, this, "camera");
    }

    static get isSupported(): boolean {
      return true;
    }

    /** A new array each time, as Flash's. */
    static get names(): Value {
      return s.rt.array((s.capture?.cameras ?? []).map((device) => device.name));
    }

    static getCamera(name: Value): Value {
      const index = name === null || name === undefined ? 0 : Number(s.rt.toString(name));
      if (!Number.isInteger(index) || index < 0 || s.destroyed) {
        return null;
      }

      const device = s.capture?.cameras[index];
      if (!device) {
        return null;
      }

      let camera = cameras.get(index);
      if (!camera) {
        camera = s.rt.construct(s.rt.classNamed("flash.media::Camera"));
        cameraStates.set(camera, new CameraState(s, camera, device, index));
        cameras.set(index, camera);
      }

      return camera;
    }

    get activityLevel(): number {
      return state(this)?.activityLevel ?? 0;
    }

    get bandwidth(): number {
      return state(this)?.bandwidth ?? 0;
    }

    get currentFPS(): number {
      return state(this)?.currentFPS ?? 0;
    }

    get fps(): number {
      return state(this)?.fps ?? 0;
    }

    get height(): number {
      return state(this)?.height ?? 0;
    }

    get index(): number {
      return state(this)?.index ?? 0;
    }

    get keyFrameInterval(): number {
      return state(this)?.keyFrameInterval ?? 0;
    }

    get loopback(): boolean {
      return state(this)?.loopback ?? false;
    }

    get motionLevel(): number {
      return state(this)?.motionLevel ?? 0;
    }

    get motionTimeout(): number {
      return state(this)?.motionTimeout ?? 0;
    }

    get muted(): boolean {
      return state(this)?.muted ?? false;
    }

    get name(): Value {
      const camera = state(this);
      return camera ? (s.capture?.cameras[camera.index]?.name ?? camera.device.name) : null;
    }

    get position(): Value {
      return state(this)?.position ?? null;
    }

    get quality(): number {
      return state(this)?.quality ?? 0;
    }

    get width(): number {
      return state(this)?.width ?? 0;
    }

    setCursor(_value: Value): void {}

    setKeyFrameInterval(value: Value): void {
      const camera = state(this);
      if (camera) {
        camera.keyFrameInterval = Math.max(1, Math.min(300, s.rt.toInt(value)));
      }
    }

    setLoopback(compress: Value): void {
      const camera = state(this);
      if (camera) {
        camera.loopback = !!compress;
      }
    }

    setMode(width: Value, height: Value, fps: Value, favorArea: Value): void {
      const camera = state(this);
      if (camera) {
        const rate = s.rt.toNumber(fps);
        camera.setMode({
          width: Math.max(1, s.rt.toInt(width)),
          height: Math.max(1, s.rt.toInt(height)),
          fps: Number.isFinite(rate) ? Math.max(1, Math.min(1000, rate)) : 15,
          favorArea: !!favorArea,
        });
      }
    }

    setMotionLevel(level: Value, timeout: Value): void {
      const camera = state(this);
      if (camera) {
        camera.motionLevel = Math.max(0, Math.min(100, s.rt.toInt(level)));
        camera.motionTimeout = Math.max(0, s.rt.toInt(timeout));
      }
    }

    setQuality(bandwidth: Value, quality: Value): void {
      const camera = state(this);
      if (camera) {
        camera.bandwidth = Math.max(0, s.rt.toInt(bandwidth));
        camera.quality = Math.max(0, Math.min(100, s.rt.toInt(quality)));
      }
    }

    drawToBitmapData(destination: Value): void {
      required(destination, "destination");
      const frame = state(this)?.source.bitmap();
      if (frame) {
        const target = storeOf(s, destination as avm2.AsObject);
        if (target.width < frame.width || target.height < frame.height) {
          throw s.rt.error("ArgumentError", 2015);
        }

        target.copyPixels(
          frame,
          { x: 0, y: 0, width: frame.width, height: frame.height },
          0,
          0,
          false,
        );
      }
    }

    copyToByteArray(rect: Value, destination: Value): void {
      required(rect, "rect");
      required(destination, "destination");
      const frame = state(this)?.source.bitmap();
      if (frame) {
        const rectPixels = frame.clip(area(rect));
        const bytes = avm2.bytesOf(s.rt, destination as avm2.AsObject);
        bytes.setLength(rectPixels ? rectPixels.width * rectPixels.height * 4 : 0);
        bytes.position = 0;
        const at = bytes.claim(bytes.length);
        if (rectPixels) {
          frame.getWords(rectPixels, bytes.buffer, at, bytes.littleEndian);
        }
      }
    }

    copyToVector(rect: Value, destination: Value): void {
      required(rect, "rect");
      required(destination, "destination");
      const frame = state(this)?.source.bitmap();
      if (frame) {
        const values = frame.getVector(area(rect));
        const vector = destination as avm2.AsObject;
        s.rt.setProperty(vector, s.rt.publicName("length"), values.length);
        const target = vector.$a as number[];
        for (let i = 0; i < values.length; i++) {
          target[i] = values[i];
        }
      }
    }
  }

  avm2.registerNativeClass(natives, "flash.media::Camera", CameraNatives);
  return natives;
}
