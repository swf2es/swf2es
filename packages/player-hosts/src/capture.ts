import type {
  CameraCapture,
  CameraEvents,
  CameraMode,
  CameraPicture,
  CaptureDevice,
  CaptureHost,
  CaptureKind,
  CapturePermission,
} from "@swf2es/player";

import { denied, openMedia } from "./capture-access.js";
import { openMicrophone } from "./capture-audio.js";

const positions = new Map([
  ["user", "front"],
  ["environment", "back"],
]);

function constraints(
  device: CaptureDevice,
  mode: CameraMode,
  strict = true,
): MediaTrackConstraints {
  return {
    deviceId: device.id ? (strict ? { exact: device.id } : { ideal: device.id }) : undefined,
    width: { ideal: mode.width },
    height: { ideal: mode.height },
    aspectRatio: { ideal: mode.width / mode.height },
    frameRate: strict && mode.favorArea ? { ideal: mode.fps, max: mode.fps } : { ideal: mode.fps },
  };
}

/** The browser's capture host, and its devices read again on demand. */
export interface BrowserCaptureHost extends CaptureHost {
  /** Reads the devices again, as after a grant the host did not ask for itself. */
  refresh(): Promise<void>;
}

/**
 * A kind's devices, named. Browsers leave labels empty until the page may
 * capture that kind, but Flash never names a device "": content checks
 * `names[0]` and sends `names` on, where a server may refuse an empty
 * field. So an unlabelled device is named by its kind and position
 * ("Camera", "Camera 2") until consent gives its label.
 */
function devicesOf(
  devices: readonly MediaDeviceInfo[],
  kind: MediaDeviceKind,
  base: string,
): CaptureDevice[] {
  const list: CaptureDevice[] = [];
  for (const device of devices) {
    if (device.kind !== kind) {
      continue;
    }

    const placeholder = list.length === 0 ? base : `${base} ${list.length + 1}`;
    list.push({ id: device.deviceId, name: device.label.trim() ? device.label : placeholder });
  }

  return list;
}

/**
 * The browser's capture host, its devices and permission states read
 * already. Enumerating never prompts; capture starts only at openCamera
 * and Chromium asks for consent. Null where the browser has no capture.
 */
export async function browserCaptureHost(): Promise<BrowserCaptureHost | null> {
  const host = lazyBrowserCaptureHost();
  return host && (await host.prepare?.()) ? host : null;
}

/**
 * The browser's capture host, which reads the devices and permission
 * states only at prepare: the player asks for it when a SWF names Camera
 * or Microphone, as a browser's first enumeration is slow. Until then it
 * reports no devices. Null where the browser has no capture.
 */
export function lazyBrowserCaptureHost(): BrowserCaptureHost | null {
  const media = globalThis.navigator?.mediaDevices;
  if (!media?.getUserMedia || !media.enumerateDevices) {
    return null;
  }

  const permissions: Record<CaptureKind, CapturePermission> = {
    camera: "unknown",
    microphone: "unknown",
  };
  const permissionHandles = new Map<CaptureKind, PermissionStatus>();
  let cameras: CaptureDevice[] = [];
  let microphones: CaptureDevice[] = [];
  let started = 0;
  let applied = 0;
  const refresh = async () => {
    const reading = ++started;
    const devices = await media.enumerateDevices();
    // Readings overlap at consent and device changes; one that ends late
    // must not bring back the placeholders a newer one replaced.
    if (reading < applied) {
      return;
    }

    applied = reading;
    microphones =
      typeof AudioWorkletNode === "function" ? devicesOf(devices, "audioinput", "Microphone") : [];
    cameras = devicesOf(devices, "videoinput", "Camera");
  };
  const refreshLater = () => {
    void refresh().catch(() => {});
  };
  let prepared: Promise<boolean> | null = null;
  const prepare = async (): Promise<boolean> => {
    try {
      await refresh();
    } catch {
      return false;
    }

    // Consent given elsewhere (a site setting, another tab) and devices
    // plugged in or out show up here; the labels come with consent.
    media.addEventListener("devicechange", refreshLater);
    await Promise.all(
      (["camera", "microphone"] as const).map(async (kind) => {
        try {
          const status = await navigator.permissions.query({ name: kind as PermissionName });
          permissionHandles.set(kind, status);
          status.addEventListener("change", refreshLater);
        } catch {
          /* Some hosts expose capture without the Permissions API. */
        }
      }),
    );

    return true;
  };
  const permissionStatus = (kind: CaptureKind): CapturePermission => {
    const status = permissionHandles.get(kind)?.state;
    return status === "prompt" ? "unknown" : (status ?? permissions[kind]);
  };

  return {
    prepare() {
      prepared ??= prepare();
      return prepared;
    },
    refresh,
    permissionStatus,
    async requestPermission(kind, signal) {
      if (signal.aborted) {
        return "denied";
      }

      try {
        const stream = await media.getUserMedia(
          kind === "camera" ? { video: true } : { audio: true },
        );

        for (const track of stream.getTracks()) {
          track.stop();
        }

        if (signal.aborted) {
          return "denied";
        }

        permissions[kind] = "granted";
        await refresh().catch(() => {});

        return "granted";
      } catch (error) {
        if (signal.aborted) {
          return "denied";
        }

        if (denied(error)) {
          permissions[kind] = "denied";
          return "denied";
        }

        return permissionStatus(kind);
      }
    },
    get cameras() {
      return cameras;
    },
    get microphones() {
      return microphones;
    },
    openMicrophone(device, mode, events, signal) {
      return openMicrophone(
        media,
        device,
        mode,
        {
          ...events,
          state(value) {
            if (value === "granted" || value === "denied") {
              permissions.microphone = value;
            }
            events.state(value);
          },
        },
        signal,
        refreshLater,
      );
    },
    openCamera(device, mode, events, signal) {
      return openCamera(
        media,
        device,
        mode,
        {
          ...events,
          state(value) {
            if (value === "granted" || value === "denied") {
              permissions.camera = value;
            }
            events.state(value);
          },
        },
        signal,
        refreshLater,
      );
    },
  };
}

function openCamera(
  media: MediaDevices,
  device: CaptureDevice,
  initial: CameraMode,
  events: CameraEvents,
  signal: AbortSignal,
  refresh: () => void,
): CameraCapture {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  let stream: MediaStream | null = null;
  let track: MediaStreamTrack | null = null;
  let closed = false;
  let openSettled = false;
  let acquired = false;
  const opening = new AbortController();
  let resolveClosed: () => void = () => {};
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  let callback = 0;
  let mode = initial;
  let applying = false;
  let modeVersion = 0;
  const cpu = new OffscreenCanvas(1, 1);
  const cpuContext = cpu.getContext("2d", { willReadFrequently: true });
  const small = new OffscreenCanvas(32, 24);
  const smallContext = small.getContext("2d", { willReadFrequently: true });
  if (!cpuContext || !smallContext) {
    throw new Error("Camera capture requires a 2D canvas");
  }

  const settings = () => {
    const value = track?.getSettings();
    if (value && !closed) {
      events.settings(
        value.width ?? mode.width,
        value.height ?? mode.height,
        value.frameRate ?? mode.fps,
        positions.get(value.facingMode ?? "") ?? "unknown",
      );
    }
  };
  const luminance = new Uint8Array(32 * 24);
  const picture: CameraPicture = {
    width: 0,
    height: 0,
    time: 0,
    image: video,
    opaque: true,
    readPixels() {
      if (cpu.width !== picture.width || cpu.height !== picture.height) {
        cpu.width = picture.width;
        cpu.height = picture.height;
      }

      cpuContext.drawImage(video, 0, 0, picture.width, picture.height);
      return cpuContext.getImageData(0, 0, picture.width, picture.height).data;
    },
    retain() {
      const still = new OffscreenCanvas(picture.width, picture.height);
      const context = still.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("Camera snapshot requires a 2D canvas");
      }
      context.drawImage(video, 0, 0);
      return {
        width: picture.width,
        height: picture.height,
        image: still,
        opaque: true,
        readPixels: () => context.getImageData(0, 0, still.width, still.height).data,
      };
    },
    motion() {
      smallContext.drawImage(video, 0, 0, 32, 24);
      const rgba = smallContext.getImageData(0, 0, 32, 24).data;
      for (let i = 0; i < luminance.length; i++) {
        const at = i * 4;
        luminance[i] = (rgba[at] * 77 + rgba[at + 1] * 150 + rgba[at + 2] * 29) >>> 8;
      }

      return luminance;
    },
  };
  const frame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
    if (closed) {
      return;
    }

    picture.width = video.videoWidth;
    picture.height = video.videoHeight;
    picture.time = metadata.mediaTime * 1000;
    if (picture.width > 0 && picture.height > 0) {
      events.frame(picture);
    }

    if (!closed) {
      callback = video.requestVideoFrameCallback(frame);
    }
  };
  const finish = (notify: boolean) => {
    if (closed) {
      return;
    }

    closed = true;
    opening.abort();
    signal.removeEventListener("abort", abort);
    video.cancelVideoFrameCallback(callback);

    try {
      if (notify) {
        events.state("ended");
      }
    } finally {
      video.pause();
      video.srcObject = null;
      for (const live of stream?.getTracks() ?? []) {
        live.stop();
      }

      stream = null;
      if (openSettled) {
        resolveClosed();
      }
      track = null;
    }
  };
  const abort = () => finish(false);
  const apply = async () => {
    if (applying || !track || closed) {
      return;
    }

    applying = true;
    try {
      let applied: number;
      do {
        applied = modeVersion;
        try {
          await track.applyConstraints(constraints(device, mode));
        } catch {
          // Keep the last usable native mode where a device refuses the requested one.
        }

        settings();
      } while (!closed && track && applied !== modeVersion);
    } finally {
      applying = false;
    }
  };
  const capture = {
    closed: closedPromise,
    setMode(next: CameraMode) {
      mode = next;
      modeVersion++;
      void apply();
    },
    close: abort,
  };
  if (signal.aborted) {
    openSettled = true;
    abort();
    return capture;
  }

  signal.addEventListener("abort", abort, { once: true });
  void openMedia(
    media,
    { video: constraints(device, mode), audio: false },
    { video: constraints(device, mode, false), audio: false },
    opening.signal,
  )
    .then(async (opened) => {
      openSettled = true;
      if (closed) {
        for (const live of opened.getTracks()) {
          live.stop();
        }

        resolveClosed();
        return;
      }

      acquired = true;
      stream = opened;
      track = opened.getVideoTracks()[0] ?? null;
      if (!track) {
        finish(false);
        events.state("unavailable");
        return;
      }

      track.addEventListener("ended", () => finish(true), { once: true });
      video.srcObject = opened;
      settings();
      if (modeVersion > 0) {
        await apply();
      }

      if (closed) {
        return;
      }

      await video.play();
      if (!closed) {
        events.state("granted");
        refresh();
        if (!closed) {
          callback = video.requestVideoFrameCallback(frame);
        }
      }
    })
    .catch((error) => {
      openSettled = true;
      if (closed) {
        resolveClosed();
        return;
      }

      finish(false);
      events.state(!acquired && denied(error) ? "denied" : "unavailable");
    });

  return capture;
}
