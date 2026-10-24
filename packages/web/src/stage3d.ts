import type { Scripting } from "@swf2es/player";
import { installContext3D } from "@swf2es/player/context3d";
import { type Stage3DSurface, stage3DCanvasHost } from "@swf2es/player-hosts/stage3d";
import type { Placement } from "./layout.js";

/** A fresh, exclusively owned surface for each context requested by a player. */
export type Stage3DSurfaceFactory = (slot: number) => Stage3DSurface;

/** One load's Stage3D layers, below its transparent display-list canvas. */
export class Stage3DSession {
  private readonly layer = document.createElement("div");
  private readonly slots = new Map<number, { x: number; y: number; visible: boolean }>();
  private readonly host: ReturnType<typeof stage3DCanvasHost>;
  private readonly close: () => void;
  private destroyed = false;
  private x = 0;
  private y = 0;
  private sx = 1;
  private sy = 1;
  private readonly box: HTMLElement;
  private readonly isolation: string;

  constructor(
    box: HTMLElement,
    scripting: Scripting,
    create: Stage3DSurfaceFactory,
    changed: () => void,
  ) {
    this.box = box;
    this.isolation = box.style.isolation;
    this.layer.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:0";
    const host = stage3DCanvasHost(this.layer, create);
    this.host = host;

    try {
      box.append(this.layer);
      // Keep canvases from different overlapping players in separate stacks.
      box.style.isolation = "isolate";
      this.close = installContext3D(scripting, {
        create: (slot, lifecycle) => {
          const context = host.create(slot, lifecycle);
          this.slots.set(slot, { x: 0, y: 0, visible: true });
          changed();

          return context;
        },
        place: (slot, x, y, visible) => {
          const position = this.slots.get(slot);
          if (position) {
            position.x = x;
            position.y = y;
            position.visible = visible;
            this.place(slot, position);
          }
        },
        remove: (slot) => {
          host.remove(slot);
          if (this.slots.delete(slot) && !this.destroyed) {
            changed();
          }
        },
      });
    } catch (error) {
      this.layer.remove();
      box.style.isolation = this.isolation;
      throw error;
    }
  }

  get active(): boolean {
    return this.slots.size !== 0;
  }

  layout(placed: Placement, width: number, height: number): void {
    this.x = placed.x;
    this.y = placed.y;
    this.sx = placed.width / (width || 1);
    this.sy = placed.height / (height || 1);

    // AIR transforms viewport positions with the stage, but keeps configured
    // back-buffer sizes in pixels instead of scaling the entire surface.
    for (let slot = 0; slot < 4; slot++) {
      const position = this.slots.get(slot);
      if (position) {
        this.place(slot, position);
      }
    }
  }

  private place(slot: number, position: { x: number; y: number; visible: boolean }): void {
    this.host.place(
      slot,
      this.x + position.x * this.sx,
      this.y + position.y * this.sy,
      position.visible,
    );
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    try {
      this.close();
    } finally {
      this.layer.remove();
      this.box.style.isolation = this.isolation;
    }
  }
}
