import type { Context3D, Context3DLifecycle, Stage3DHost } from "@swf2es/player/context3d";

export interface Stage3DSurface {
  canvas: HTMLCanvasElement;
  context: Context3D;
  /** Called once after resource disposal and listener removal, including failed attachment. */
  destroy?: () => void;
}

/** The caller supplies a positioned, clipped parent, with the display-list canvas
 * above slots 0..3. The adapter disposes resources before removing a surface. */
export function stage3DCanvasHost(
  parent: HTMLElement,
  create: (slot: number) => Stage3DSurface,
): Stage3DHost {
  const surfaces = new Map<number, Stage3DSurface & { detach: () => void }>();

  return {
    create(slot, lifecycle) {
      if (surfaces.has(slot)) {
        throw new Error("Stage3D surface must be removed before recreation");
      }

      const surface = create(slot);
      const detach = observeLoss(surface.canvas, lifecycle);
      try {
        surface.canvas.style.position = "absolute";
        surface.canvas.style.zIndex = String(slot);
        parent.append(surface.canvas);
        surfaces.set(slot, { ...surface, detach });
      } catch (error) {
        detach();
        surface.context.dispose();
        surface.canvas.remove();
        surface.destroy?.();
        throw error;
      }

      return surface.context;
    },
    place(slot, x, y, visible) {
      const surface = surfaces.get(slot);
      if (surface) {
        const style = surface.canvas.style;
        style.left = `${x}px`;
        style.top = `${y}px`;
        style.visibility = visible ? "visible" : "hidden";
      }
    },
    remove(slot) {
      const surface = surfaces.get(slot);
      if (surface) {
        surface.detach();
        surface.canvas.remove();
        surfaces.delete(slot);
        surface.destroy?.();
      }
    },
  };
}

/** The surface outlives its lost resources so the browser can signal recovery. */
export function observeLoss(canvas: HTMLCanvasElement, lifecycle: Context3DLifecycle): () => void {
  const lost = (event: Event): void => {
    event.preventDefault();
    lifecycle.lost();
  };
  const restored = (): void => lifecycle.restored();
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", restored);

  return () => {
    canvas.removeEventListener("webglcontextlost", lost);
    canvas.removeEventListener("webglcontextrestored", restored);
  };
}
