import type {
  CameraCapture,
  CameraEvents,
  CameraMode,
  CaptureDevice,
  CaptureHost,
  CaptureKind,
  CapturePermission,
} from "@swf2es/player";

import { openMicrophone } from "./capture-audio.js";

function constraints(device: CaptureDevice, mode: CameraMode): MediaTrackConstraints {
  return {
    deviceId: device.id ? { exact: device.id } : undefined,
    width: { ideal: mode.width },
    height: { ideal: mode.height },
    aspectRatio: { ideal: mode.width / mode.height },
    frameRate: mode.favorArea ? { ideal: mode.fps, max: mode.fps } : { ideal: mode.fps },
  };
}

/** Enumerating never prompts; capture starts only at openCamera and Chromium asks for consent. */
export async function browserCaptureHost(): Promise<CaptureHost | null> {
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
  const refresh = async () => {
    const devices = await media.enumerateDevices();
    microphones =
      typeof AudioWorkletNode === "function"
        ? devices
            .filter((d) => d.kind === "audioinput")
            .map((d) => ({ id: d.deviceId, name: d.label }))
        : [];
    cameras = devices
      .filter((d) => d.kind === "videoinput")
      .map((d) => ({ id: d.deviceId, name: d.label }));
  };
  try {
    await refresh();
  } catch {
    return null;
  }

  await Promise.all(
    (["camera", "microphone"] as const).map(async (kind) => {
      try {
        const status = await navigator.permissions.query({ name: kind as PermissionName });
        permissionHandles.set(kind, status);
      } catch {
        /* Some hosts expose capture without the Permissions API. */
      }
    }),
  );
  return {
    permissionStatus: (kind) => {
      const status = permissionHandles.get(kind)?.state;
      return status === "prompt" ? "unknown" : (status ?? permissions[kind]);
    },
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
      } catch {
        if (!signal.aborted) {
          permissions[kind] = "denied";
        }
        return "denied";
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
            if (value !== "ended") {
              permissions.microphone = value;
            }
            events.state(value);
          },
        },
        signal,
        () => {
          void refresh().catch(() => {});
        },
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
            if (value !== "ended") {
              permissions.camera = value;
            }
            events.state(value);
          },
        },
        signal,
        () => {
          void refresh().catch(() => {});
        },
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
      const position =
        value.facingMode === "user"
          ? "front"
          : value.facingMode === "environment"
            ? "back"
            : "unknown";
      events.settings(
        value.width ?? mode.width,
        value.height ?? mode.height,
        value.frameRate ?? mode.fps,
        position,
      );
    }
  };
  const frame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
    if (closed) {
      return;
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width > 0 && height > 0) {
      events.frame({
        width,
        height,
        image: video,
        time: metadata.mediaTime * 1000,
        readPixels() {
          if (cpu.width !== width || cpu.height !== height) {
            cpu.width = width;
            cpu.height = height;
          }

          cpuContext.drawImage(video, 0, 0, width, height);
          return cpuContext.getImageData(0, 0, width, height).data;
        },
        motion() {
          smallContext.drawImage(video, 0, 0, 32, 24);
          const rgba = smallContext.getImageData(0, 0, 32, 24).data;
          const luminance = new Uint8Array(32 * 24);
          for (let i = 0; i < luminance.length; i++) {
            const at = i * 4;
            luminance[i] = (rgba[at] * 77 + rgba[at + 1] * 150 + rgba[at + 2] * 29) >>> 8;
          }

          return luminance;
        },
      });
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
    signal.removeEventListener("abort", abort);
    video.cancelVideoFrameCallback(callback);
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
    if (notify) {
      events.state("ended");
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
  void media
    .getUserMedia({ video: constraints(device, mode), audio: false })
    .then(async (opened) => {
      openSettled = true;
      if (closed) {
        for (const live of opened.getTracks()) {
          live.stop();
        }
        resolveClosed();
        return;
      }

      stream = opened;
      track = opened.getVideoTracks()[0] ?? null;
      if (!track) {
        finish(false);
        events.state("denied");
        return;
      }

      track.addEventListener("ended", () => finish(true), { once: true });
      video.srcObject = opened;
      events.state("granted");
      settings();
      refresh();
      await apply();
      if (closed) {
        return;
      }

      await video.play();
      if (!closed) {
        callback = video.requestVideoFrameCallback(frame);
      }
    })
    .catch(() => {
      openSettled = true;
      if (closed) {
        resolveClosed();
      }
      if (!closed) {
        finish(false);
        events.state("denied");
      }
    });
  return capture;
}
