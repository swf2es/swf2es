import type {
  CameraCapture,
  CameraEvents,
  CameraMode,
  CaptureDevice,
  CaptureHost,
} from "@swf2es/player";

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

  let cameras: CaptureDevice[] = [];
  const refresh = async () => {
    const devices = await media.enumerateDevices();
    cameras = devices
      .filter((d) => d.kind === "videoinput")
      .map((d) => ({ id: d.deviceId, name: d.label }));
  };
  try {
    await refresh();
  } catch {
    return null;
  }

  return {
    get cameras() {
      return cameras;
    },
    openCamera(device, mode, events, signal) {
      return openCamera(media, device, mode, events, signal, () => {
        void refresh().catch(() => {});
      });
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
    setMode(next: CameraMode) {
      mode = next;
      modeVersion++;
      void apply();
    },
    close: abort,
  };
  if (signal.aborted) {
    abort();
    return capture;
  }

  signal.addEventListener("abort", abort, { once: true });
  void media
    .getUserMedia({ video: constraints(device, mode), audio: false })
    .then(async (opened) => {
      if (closed) {
        for (const live of opened.getTracks()) {
          live.stop();
        }

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
      if (!closed) {
        finish(false);
        events.state("denied");
      }
    });
  return capture;
}
