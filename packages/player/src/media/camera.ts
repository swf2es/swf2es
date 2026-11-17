import type { avm2 } from "@swf2es/runtime";
import type { VideoObject } from "../display/videoobject.js";
import type { CameraCapture, CameraMode, CameraPicture, CaptureDevice } from "../hosts.js";
import { dispatchEvent, heard } from "../scripting/events.js";
import type { Scripting } from "../scripting.js";
import { VideoSource } from "./video.js";

export const cameraStates = new WeakMap<avm2.AsObject, CameraState>();
const attached = new WeakMap<VideoObject, CameraState>();

/** Device behaviour follows Adobe's Camera documentation; adl here has no devices. */
export class CameraState {
  readonly source = new VideoSource();
  mode: CameraMode = { width: 160, height: 120, fps: 15, favorArea: true };
  width = 160;
  height = 120;
  fps = 15;
  currentFPS = 0;
  muted = true;
  position = "unknown";
  bandwidth = 16384;
  quality = 0;
  keyFrameInterval = 15;
  loopback = false;
  motionLevel = 50;
  motionTimeout = 2000;
  activityLevel = -1;
  private active = false;
  private generation = 0;
  private transport: CameraCapture | null = null;
  private video: WeakRef<VideoObject> | null = null;
  private previous: Uint8Array | null = null;
  private previousTime = -1;
  private lastMotion = -1;
  private activating = false;
  private frameEventGeneration = 0;

  constructor(
    private readonly s: Scripting,
    private readonly object: avm2.AsObject,
    readonly device: CaptureDevice,
    readonly index: number,
  ) {
    s.captureLifetime.signal.addEventListener("abort", () => this.detach(), { once: true });
  }

  attach(video: VideoObject): void {
    if (this.s.destroyed || this.s.captureLifetime.signal.aborted) {
      return;
    }

    const old = this.video?.deref();
    if (old && old !== video) {
      old.source = null;
      attached.delete(old);
    }

    this.video = new WeakRef(video);
    attached.set(video, this);
    video.source = this.source;
    this.start();
  }

  detach(): void {
    this.active = false;
    this.generation++;
    this.transport?.close();
    this.transport = null;
    const video = this.video?.deref();
    if (video) {
      video.source = null;
      attached.delete(video);
    }

    this.video = null;
    this.source.publish(null);
    this.previous = null;
    this.previousTime = -1;
    this.lastMotion = -1;
    this.currentFPS = 0;
    this.activityLevel = -1;
    this.activating = false;
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    if (this.transport) {
      this.transport.setMode(mode);
    } else {
      this.width = mode.width;
      this.height = mode.height;
      this.fps = mode.fps;
    }
  }

  private start(): void {
    if (
      this.active ||
      this.s.destroyed ||
      this.s.captureLifetime.signal.aborted ||
      !this.s.capture
    ) {
      return;
    }

    this.active = true;
    this.previous = null;
    this.previousTime = -1;
    this.lastMotion = -1;
    this.activating = false;
    const generation = ++this.generation;
    const current = () => generation === this.generation && !this.s.destroyed;
    const state = (state: "granted" | "denied" | "ended") => {
      if (!current()) {
        return;
      }

      this.muted = state !== "granted";
      if (this.muted) {
        this.active = false;
        this.transport?.close();
        this.transport = null;
        this.source.publish(null);
        this.currentFPS = 0;
        this.activityLevel = -1;
      }

      this.s.loads.deferHostEvent(() => {
        if (current()) {
          dispatchEvent(
            this.s,
            this.object,
            this.s.rt.construct(
              this.s.rt.classNamed("flash.events::StatusEvent"),
              "status",
              false,
              false,
              state === "granted" ? "Camera.Unmuted" : "Camera.Muted",
              "status",
            ),
          );
        }
      });
    };
    try {
      const transport = this.s.capture.openCamera(
        this.device,
        this.mode,
        {
          state,
          settings: (width, height, fps, position) => {
            if (current() && this.active) {
              this.width = width;
              this.height = height;
              this.fps = fps;
              this.position = position;
            }
          },
          frame: (picture) => {
            if (current() && this.active && !this.muted) {
              this.frame(picture);
            }
          },
        },
        this.s.captureLifetime.signal,
      );
      if (current() && this.active) {
        this.transport = transport;
      } else {
        transport.close();
      }
    } catch {
      state("denied");
    }
  }

  private frame(picture: CameraPicture): void {
    this.width = picture.width;
    this.height = picture.height;
    if (this.previousTime >= 0 && picture.time > this.previousTime) {
      this.currentFPS = 1000 / (picture.time - this.previousTime);
    }

    this.previousTime = picture.time;
    this.source.publish(picture);
    if (heard(this.object, "videoFrame") && this.frameEventGeneration !== this.generation) {
      const generation = this.generation;
      this.frameEventGeneration = generation;
      this.s.loads.deferHostEvent(() => {
        if (this.frameEventGeneration === generation) {
          this.frameEventGeneration = 0;
        }

        if (!this.s.destroyed && this.active && generation === this.generation) {
          dispatchEvent(this.s, this.object, this.s.event("videoFrame"));
        }
      });
    }

    const sample = picture.motion();
    const previous = this.previous;
    let difference = 0;
    if (previous?.length === sample.length) {
      for (let i = 0; i < sample.length; i++) {
        difference += Math.abs(sample[i] - previous[i]);
      }
    }

    this.previous = sample.slice();
    this.activityLevel = sample.length ? (difference * 100) / (sample.length * 255) : 0;
    if (this.motionLevel === 100) {
      this.lastMotion = -1;
      this.activating = false;
      return;
    }

    if (this.activityLevel >= this.motionLevel) {
      this.lastMotion = picture.time;
    }

    const activating =
      this.activityLevel >= this.motionLevel ||
      (this.lastMotion >= 0 && picture.time - this.lastMotion < this.motionTimeout);
    if (activating !== this.activating) {
      this.activating = activating;
      const generation = this.generation;
      this.s.loads.deferHostEvent(() => {
        if (
          !this.s.destroyed &&
          this.active &&
          generation === this.generation &&
          this.motionLevel !== 100
        ) {
          dispatchEvent(
            this.s,
            this.object,
            this.s.rt.construct(
              this.s.rt.classNamed("flash.events::ActivityEvent"),
              "activity",
              false,
              false,
              activating,
            ),
          );
        }
      });
    }
  }
}

export function attachCamera(video: VideoObject, camera: avm2.Value): void {
  const state = camera && typeof camera === "object" ? cameraStates.get(camera) : undefined;
  const old = attached.get(video);
  if (old && old !== state) {
    old.detach();
  }

  if (state) {
    state.attach(video);
  } else {
    video.source = null;
  }
}
