import type { FullScreen } from "../scripting/full-screen.js";

// A pending browser grant belongs to the canvas even if the player bound to it changed.
const bindings = new WeakMap<HTMLCanvasElement, () => void>();

/** Bind Stage.mouseLock to this canvas, including Escape and loss of window focus. */
export function bindMouseLock(canvas: HTMLCanvasElement, stage: FullScreen): () => void {
  const doc = canvas.ownerDocument;
  // Hosts may bind input before inserting the canvas in its document or shadow root.
  const owns = () => (canvas.getRootNode() as Document | ShadowRoot).pointerLockElement === canvas;
  let bound = true;
  let pending = false;
  let wanted = false;
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
    if (owns()) {
      if (!wanted) {
        release();
      } else if (!releasing) {
        stage.setMouseLocked(true);
      }
    } else if (releasing) {
      releasing = false;
      if (wanted) {
        void request();
      }
    } else if (stage.mouseLock) {
      lost();
    }
  };
  const request = async () => {
    if (pending || releasing || owns()) {
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
      if (owns()) {
        const current = bindings.get(canvas);
        if (current) {
          current();
        } else {
          release();
        }
      }
    } catch (error) {
      if (bound && wanted) {
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
    wanted = locked;
    stage.setMouseLocked(locked && owns() && !releasing);
    if (locked) {
      if (!needsClick) {
        void request();
      }
    } else {
      needsClick = false;
      release();
    }
  };
  bindings.set(canvas, changed);
  stage.onMouseLock = set;
  doc.addEventListener("pointerlockchange", changed);
  canvas.addEventListener("pointerdown", click, true);
  doc.defaultView?.addEventListener("blur", lost);
  set(stage.mouseLock);
  return () => {
    if (!bound) {
      return;
    }

    bound = false;
    if (bindings.get(canvas) === changed) {
      bindings.delete(canvas);
    }
    stage.onMouseLock = null;
    stage.mouseLock = false;
    release();
    doc.removeEventListener("pointerlockchange", changed);
    canvas.removeEventListener("pointerdown", click, true);
    doc.defaultView?.removeEventListener("blur", lost);
  };
}
