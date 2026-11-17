// Signals that abort with a longer-lived one, a player's or its files',
// without staying linked to it. AbortSignal.any would do, but a source keeps
// what it made for as long as it may still abort, once anything listens to
// that (Chromium): a fetch the desktop app's shell listens to the signal of
// left one behind for each load a SWF made, for as long as the player ran.

/** A signal of its own that aborts with `lifetime` and `signal`, if given, until released. */
export interface LinkedSignal {
  readonly signal: AbortSignal;
  /** Abort it, as its owner's cancel does, and let go of its sources. */
  abort(): void;
  /** Let go of its sources: it aborts with them no more. */
  release(): void;
}

export function linkedSignal(lifetime: AbortSignal, signal?: AbortSignal): LinkedSignal {
  const controller = new AbortController();
  const sources = signal ? [lifetime, signal] : [lifetime];
  const release = () => {
    for (let i = 0; i < sources.length; i++) {
      sources[i].removeEventListener("abort", aborted);
    }
  };
  const aborted = (event: Event) => {
    release();
    controller.abort((event.target as AbortSignal).reason);
  };
  const linked = {
    signal: controller.signal,
    abort: () => {
      release();
      controller.abort();
    },
    release,
  };
  for (let i = 0; i < sources.length; i++) {
    if (sources[i].aborted) {
      controller.abort(sources[i].reason);
      return linked;
    }
  }

  for (let i = 0; i < sources.length; i++) {
    sources[i].addEventListener("abort", aborted);
  }

  return linked;
}

/** `fetch` given a signal that aborts with `signal` and `lifetime` until what it gives settles. */
export function fetchWhile<R, T>(
  fetch: (request: R, signal: AbortSignal) => Promise<T>,
  request: R,
  lifetime: AbortSignal,
  signal?: AbortSignal,
): Promise<T> {
  const linked = linkedSignal(lifetime, signal);
  let task: Promise<T>;
  try {
    task = fetch(request, linked.signal);
  } catch (error) {
    linked.release();
    throw error;
  }

  return Promise.resolve(task).finally(linked.release);
}
