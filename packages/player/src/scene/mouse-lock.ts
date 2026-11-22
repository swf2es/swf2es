import type { FullScreen } from "../scripting/full-screen.js";

/** Bind Stage.mouseLock to this canvas, including Escape and loss of window focus. */
export function bindMouseLock(canvas: HTMLCanvasElement, stage: FullScreen): () => void {
  const doc = canvas.ownerDocument;
  const root = canvas.getRootNode() as Document | ShadowRoot;
  const owns = () => root.pointerLockElement === canvas;
  let bound = true;
  let pending = false;
  let held = false;
  let needsClick = false;
  let releasing = false;

  const release = () => {
    if (owns() && !releasing) {
      releasing = true;
      doc.exitPointerLock();
    }
  };
  const lost = () => {
    stage.mouseLock = false;
  };
  const changed = () => {
    const locked = owns();
    if (!locked && releasing) {
      releasing = false;
      if (stage.mouseLock) {
        void request();
      }
    } else if (!locked && held) {
      lost();
    }
    held = locked;
    if (held && !stage.mouseLock) {
      release();
    }
  };
  const request = async () => {
    if (pending || owns()) {
      return;
    }

    pending = true;
    needsClick = false;
    const activated = doc.defaultView?.navigator.userActivation?.isActive;
    try {
      const result = canvas.requestPointerLock();
      if (result) {
        await result;
      } else {
        // Older implementations report the same outcome only through document events.
        await new Promise<void>((resolve, reject) => {
          const events = new AbortController();
          doc.addEventListener(
            "pointerlockchange",
            () => {
              if (owns()) {
                events.abort();
                resolve();
              }
            },
            { signal: events.signal },
          );
          doc.addEventListener(
            "pointerlockerror",
            () => {
              events.abort();
              reject(new DOMException("Pointer lock denied", "NotAllowedError"));
            },
            { signal: events.signal },
          );
        });
      }
      if (!bound || !stage.mouseLock) {
        release();
      }
    } catch (error) {
      if (bound && stage.mouseLock) {
        // Entering DOM fullscreen consumes the gesture. A SWF may request lock on
        // its next frame: complete that request on the next click inside its canvas.
        if (
          activated === false &&
          error instanceof DOMException &&
          error.name === "NotAllowedError"
        ) {
          needsClick = true;
        } else {
          lost();
        }
      }
    } finally {
      pending = false;
    }
  };
  const click = (e: PointerEvent) => {
    if (needsClick && e.isTrusted && e.button === 0) {
      void request();
    }
  };
  const set = (locked: boolean) => {
    if (locked) {
      void request();
    } else {
      needsClick = false;
      release();
    }
  };
  stage.onMouseLock = set;
  doc.addEventListener("pointerlockchange", changed);
  canvas.addEventListener("pointerdown", click, true);
  doc.defaultView?.addEventListener("blur", lost);
  set(stage.mouseLock);
  return () => {
    bound = false;
    stage.onMouseLock = null;
    stage.mouseLock = false;
    release();
    doc.removeEventListener("pointerlockchange", changed);
    canvas.removeEventListener("pointerdown", click, true);
    doc.defaultView?.removeEventListener("blur", lost);
  };
}
