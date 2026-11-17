import type { CameraCapture, CaptureHost, MicrophoneCapture } from "@swf2es/player";
import { browserCaptureHost } from "@swf2es/player-hosts/capture";
import type { CaptureKind, DesktopCapture } from "../shared/api.js";

const closing = new WeakMap<CaptureHost, Set<Promise<void>>>();
export async function captureStopped(host: CaptureHost | null | undefined): Promise<void> {
  await Promise.all(host ? [...(closing.get(host) ?? [])] : []);
}

/** Ask the shell before Chromium gets a request; late consent cannot start an old movie. */
export async function shellCapture(
  api: DesktopCapture,
  epoch: number,
): Promise<CaptureHost | null> {
  const browser = await browserCaptureHost();
  if (!browser) {
    return null;
  }
  let nextId = 0;
  const pending = new Set<Promise<void>>();
  function open<T extends CameraCapture | MicrophoneCapture>(
    kind: CaptureKind,
    signal: AbortSignal,
    denied: () => void,
    connect: (live: (active: boolean) => void) => T,
  ): { handle: () => T | null; close: () => void } {
    const id = ++nextId;
    let closed = false;
    let handle: T | null = null;
    let resolveClosed: () => void = () => {};
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    pending.add(closedPromise);
    void closedPromise.then(() => pending.delete(closedPromise));
    const live = (active: boolean) => {
      if (!closed || !active) {
        api.live(epoch, kind, id, active);
      }
    };
    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      signal.removeEventListener("abort", close);
      const opened = handle;
      handle = null;
      opened?.close();
      void (opened?.closed ?? Promise.resolve()).then(() => {
        live(false);
        resolveClosed();
      });
    };
    if (signal.aborted) {
      close();
      return { handle: () => null, close };
    }
    signal.addEventListener("abort", close, { once: true });
    void api
      .request(epoch, kind)
      .then((result) => {
        if (closed) {
          return;
        }
        if (result !== "granted") {
          close();
          denied();
          return;
        }
        // Include initialization: a microphone track can be live while its worklet loads.
        live(true);
        const opened = connect(live);
        if (closed) {
          opened.close();
        } else {
          handle = opened;
        }
      })
      .catch(() => {
        if (!closed) {
          close();
          denied();
        }
      });
    return { handle: () => handle, close };
  }
  const host: CaptureHost = {
    get cameras() {
      return browser.cameras;
    },
    get microphones() {
      return browser.microphones;
    },
    permissionStatus: (kind) => api.status(epoch, kind),
    requestPermission: (kind, signal) =>
      signal.aborted
        ? Promise.resolve("denied")
        : api.request(epoch, kind).then((result) => (signal.aborted ? "denied" : result)),
    openCamera(device, initial, events, signal) {
      let mode = initial;
      const opened = open(
        "camera",
        signal,
        () => events.state("denied"),
        (live) =>
          browser.openCamera(
            device,
            mode,
            {
              ...events,
              state(value) {
                live(value === "granted");
                events.state(value);
              },
            },
            signal,
          ),
      );
      return {
        close: opened.close,
        setMode(next) {
          mode = next;
          opened.handle()?.setMode(next);
        },
      };
    },
    openMicrophone(device, initial, events, signal) {
      let mode = initial;
      const opened = open(
        "microphone",
        signal,
        () => events.state("denied"),
        (live) => {
          if (!browser.openMicrophone) {
            throw new Error("Microphone capture unavailable");
          }
          return browser.openMicrophone(
            device,
            mode,
            {
              ...events,
              state(value) {
                live(value === "granted");
                events.state(value);
              },
            },
            signal,
          );
        },
      );
      return {
        close: opened.close,
        setMode(next) {
          mode = next;
          opened.handle()?.setMode(next);
        },
      };
    },
  };
  closing.set(host, pending);
  return host;
}
