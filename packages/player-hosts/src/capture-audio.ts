import type {
  CaptureDevice,
  MicrophoneCapture,
  MicrophoneEvents,
  MicrophoneMode,
} from "@swf2es/player";

function constraints(device: CaptureDevice, mode: MicrophoneMode): MediaTrackConstraints {
  return {
    deviceId: device.id ? { exact: device.id } : undefined,
    channelCount: 1,
    echoCancellation: mode.echoCancellation,
    noiseSuppression: mode.noiseSuppression,
    autoGainControl: false,
  };
}

export function openMicrophone(
  media: MediaDevices,
  device: CaptureDevice,
  initial: MicrophoneMode,
  events: MicrophoneEvents,
  signal: AbortSignal,
  refresh: () => void,
): MicrophoneCapture {
  let mode = initial;
  let closed = false;
  let openSettled = false;
  let resolveClosed: () => void = () => {};
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let gain: GainNode | null = null;
  let node: AudioWorkletNode | null = null;
  let applying = false;
  let version = 0;
  const resume = () => {
    void context?.resume().catch(() => {});
  };
  const finish = (notify: boolean) => {
    if (closed) {
      return;
    }

    closed = true;
    signal.removeEventListener("abort", abort);
    globalThis.removeEventListener("pointerdown", resume, true);
    globalThis.removeEventListener("keydown", resume, true);
    if (node) {
      node.port.onmessage = null;
      node.port.close();
      node.disconnect();
    }
    source?.disconnect();
    gain?.disconnect();
    for (const track of stream?.getTracks() ?? []) {
      track.stop();
    }
    void context?.close().catch(() => {});
    stream = null;
    if (openSettled) {
      resolveClosed();
    }
    if (notify) {
      events.state("ended");
    }
  };
  const abort = () => finish(false);
  const apply = async () => {
    if (applying || closed || !stream) {
      return;
    }

    applying = true;
    try {
      let applied: number;
      do {
        applied = version;
        try {
          await stream.getAudioTracks()[0]?.applyConstraints(constraints(device, mode));
        } catch {
          // Native echo cancellation and noise suppression are best effort.
        }
      } while (!closed && stream && applied !== version);
    } finally {
      applying = false;
    }
  };
  const capture: MicrophoneCapture = {
    closed: closedPromise,
    setMode(next) {
      mode = next;
      version++;
      if (gain) {
        gain.gain.value = mode.gain / 50;
      }
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
    .getUserMedia({ audio: constraints(device, mode), video: false })
    .then(async (opened) => {
      openSettled = true;
      if (closed) {
        for (const track of opened.getTracks()) {
          track.stop();
        }
        resolveClosed();
        return;
      }

      stream = opened;
      const track = opened.getAudioTracks()[0];
      if (!track) {
        throw new Error("No microphone track");
      }
      track.addEventListener("ended", () => finish(true), { once: true });
      context = new AudioContext();
      await context.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url));
      if (closed) {
        return;
      }

      source = context.createMediaStreamSource(opened);
      gain = context.createGain();
      gain.gain.value = mode.gain / 50;
      node = new AudioWorkletNode(context, "swf2es-capture", {
        channelCount: 1,
        channelCountMode: "explicit",
      });
      node.port.onmessage = ({ data }: MessageEvent<{ samples: Float32Array; rate: number }>) => {
        if (!closed) {
          try {
            events.samples(data.samples, data.rate);
          } finally {
            node?.port.postMessage(null);
          }
        }
      };
      node.onprocessorerror = () => finish(true);
      source.connect(gain).connect(node).connect(context.destination);
      events.state("granted");
      if (closed) {
        return;
      }
      refresh();
      globalThis.addEventListener("pointerdown", resume, true);
      globalThis.addEventListener("keydown", resume, true);
      resume();
      await apply();
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
