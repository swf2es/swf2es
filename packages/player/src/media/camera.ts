import type { avm2 } from "@swf2es/runtime";
import type { Library } from "../display/timeline.js";
import type { VideoObject } from "../display/videoobject.js";
import type { CameraCapture, CameraMode, CameraPicture, CaptureDevice } from "../hosts.js";
import { removeListenersWhere } from "../playerglobal/flash/events/EventDispatcher.js";
import { dispatchEvent, heard } from "../scripting/events.js";
import type { Scripting } from "../scripting.js";
import { CaptureStatus } from "./capture-status.js";
import { VideoSource } from "./video.js";

export const cameraStates = new WeakMap<avm2.AsObject, CameraState>();
const attached = new WeakMap<VideoObject, CameraState>();
const captures = new WeakMap<Scripting, Set<WeakRef<CameraState>>>();

export function stopCameras(s: Scripting, library: Library): void {
  for (const ref of captures.get(s) ?? []) {
    const camera = ref.deref();
    if (!camera) {
      captures.get(s)?.delete(ref);
    } else {
      camera.stopForLibrary(library);
    }
  }
}

/** Device behaviour follows Adobe's Camera documentation; adl here has no devices. */
export class CameraState {
  readonly source = new VideoSource();
  mode: CameraMode = { width: 160, height: 120, fps: 15, favorArea: true };
  width = 160;
  height = 120;
  fps = 15;
  private readonly frameTimes = new Float64Array(1024);
  private frameHead = 0;
  private frameCount = 0;
  private lastArrival = 0;
  private latestTime = 0;

  get currentFPS(): number {
    const sinceArrival = this.s.timers.realTime
      ? Math.max(0, this.s.timers.realTime() - this.lastArrival)
      : 0;
    const now = this.latestTime + sinceArrival;
    while (this.frameCount && now - this.frameTimes[this.frameHead] > 1000) {
      this.frameHead = (this.frameHead + 1) % this.frameTimes.length;
      this.frameCount--;
    }

    if (this.frameCount < 2) {
      return 0;
    }

    const span = now - this.frameTimes[this.frameHead];
    return Math.min(this.fps, span > 0 ? ((this.frameCount - 1) * 1000) / span : 0);
  }

  private readonly consent: CaptureStatus;

  get muted(): boolean {
    return this.consent.muted;
  }

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
  private owner: WeakRef<Library> | null = null;
  private previous: Uint8Array | null = null;
  private lastMotion = -1;
  private activating = false;
  private reportedActivity = false;
  private activityPending = false;
  private framePending = false;

  constructor(
    private readonly s: Scripting,
    private readonly object: avm2.AsObject,
    readonly device: CaptureDevice,
    readonly index: number,
  ) {
    this.consent = new CaptureStatus(s, object, "Camera");
    let states = captures.get(s);
    if (!states) {
      states = new Set();
      captures.set(s, states);
    }

    states.add(new WeakRef(this));
    s.captureLifetime.signal.addEventListener(
      "abort",
      () => {
        const opened = this.active;
        this.detach();
        this.consent.revoke(opened);
      },
      { once: true },
    );
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

    const library = this.s.code.runningLibrary();
    this.owner = library ? new WeakRef(library) : null;
    this.video = new WeakRef(video);
    attached.set(video, this);
    video.source = this.source;
    this.start();
  }

  stopForLibrary(library: Library): void {
    removeListenersWhere(
      this.s,
      this.object,
      (fn) => this.s.code.calledLibrary(fn, null) === library,
    );

    if (this.owner?.deref() === library) {
      this.detach();
    }
  }

  detach(): void {
    const video = this.video?.deref();
    if (video) {
      try {
        const cleared = video.picture === null;
        video.source = this.s.destroyed ? null : this.source.snapshot();
        if (cleared) {
          video.clear();
        }
      } catch {
        // A host that lost its last image must still close its device.
        video.source = null;
      }
      attached.delete(video);
    }

    this.active = false;
    this.generation++;
    this.activityPending = false;
    this.framePending = false;
    this.transport?.close();
    this.transport = null;
    this.video = null;
    this.owner = null;
    this.source.publish(null);
    this.previous = null;
    this.lastMotion = -1;
    this.frameCount = 0;
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
    this.lastMotion = -1;
    this.activating = false;
    const generation = ++this.generation;
    this.activityPending = false;
    this.framePending = false;
    const current = () => generation === this.generation && !this.s.destroyed;
    const state = (state: "granted" | "denied" | "ended" | "unavailable") => {
      if (!current()) {
        return;
      }

      if (state !== "granted") {
        this.detach();
      }

      if (state === "unavailable") {
        this.consent.unavailable();
      } else {
        this.consent.set(state !== "granted");
      }
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
      state("unavailable");
    }
  }

  private frame(picture: CameraPicture): void {
    if (!this.video?.deref()) {
      this.detach();
      return;
    }

    this.width = picture.width;
    this.height = picture.height;
    if (picture.time < this.latestTime) {
      this.frameCount = 0;
    }

    if (this.frameCount === this.frameTimes.length) {
      this.frameHead = (this.frameHead + 1) % this.frameTimes.length;
      this.frameCount--;
    }

    this.frameTimes[(this.frameHead + this.frameCount++) % this.frameTimes.length] = picture.time;
    this.latestTime = picture.time;
    this.lastArrival = this.s.timers.realTime?.() ?? 0;
    this.source.publish(picture);
    if (heard(this.object, "videoFrame") && !this.framePending) {
      const generation = this.generation;
      this.framePending = true;
      this.s.loads.deferHostEvent(() => {
        if (generation !== this.generation) {
          return;
        }

        this.framePending = false;
        if (!this.s.destroyed && this.active) {
          dispatchEvent(this.s, this.object, this.s.event("videoFrame"));
        }
      });
    }

    if (!heard(this.object, "activity") || this.motionLevel === 100) {
      this.previous = null;
      if (!heard(this.object, "activity")) {
        this.reportedActivity = false;
      }

      this.activityLevel = -1;
      this.lastMotion = -1;
      this.activating = false;
      return;
    }

    const sample = picture.motion();
    const previous = this.previous;
    let difference = 0;
    if (previous?.length === sample.length) {
      for (let i = 0; i < sample.length; i++) {
        difference += Math.abs(sample[i] - previous[i]);
      }
    }

    if (!this.previous || this.previous.length !== sample.length) {
      this.previous = new Uint8Array(sample.length);
    }

    this.previous.set(sample);
    // Flash's detector is unpublished. This curve puts a 3.125% mean change at level 50.
    this.activityLevel = sample.length
      ? Math.min(100, 100 * Math.sqrt((8 * difference) / (sample.length * 255)))
      : 0;

    if (this.activityLevel >= this.motionLevel) {
      this.lastMotion = picture.time;
    }

    const activating =
      this.activityLevel >= this.motionLevel ||
      (this.lastMotion >= 0 && picture.time - this.lastMotion < this.motionTimeout);
    if (activating !== this.activating) {
      this.activating = activating;
      const generation = this.generation;
      if (!this.activityPending) {
        this.activityPending = true;
        this.s.loads.deferHostEvent(() => {
          if (generation !== this.generation) {
            return;
          }

          this.activityPending = false;
          if (
            !this.s.destroyed &&
            this.active &&
            this.motionLevel !== 100 &&
            this.reportedActivity !== this.activating
          ) {
            this.reportedActivity = this.activating;
            dispatchEvent(
              this.s,
              this.object,
              this.s.rt.construct(
                this.s.rt.classNamed("flash.events::ActivityEvent"),
                "activity",
                false,
                false,
                this.activating,
              ),
            );
          }
        });
      }
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
  }
}
