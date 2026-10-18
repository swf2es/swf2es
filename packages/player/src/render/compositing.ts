// How the view composites each object with what is behind it (render/view.ts):
// by the GPU's own blending where it blends as Flash does, through a layer
// of its own kept while it stands, or by a blend filter (render/blend.ts),
// and whether the stage below may be less than opaque, which decides it.
import { type BLEND_MODES, type Renderer, RendererType } from "pixi.js";
import { blendFilters } from "./blend.js";
import { FilterChain } from "./filters.js";
import type { Node } from "./node.js";
import type { Planes } from "./planes.js";

/** The view's blending of the objects it syncs. */
export class Compositing {
  /** Whether the renderer was found to lack the back buffer that filter-backed blends read. */
  private backBufferChecked = false;
  /** The nodes on the list blended with erase or alpha outside any layer (checkStageClear). */
  private readonly clearing = new Set<Node>();
  /** The nodes on the list blended outside any layer in a mode the GPU blends as Flash only over opaque pixels. */
  private readonly overOpaque = new Set<Node>();
  /** Whether the stage's pixels may be less than opaque below a blend (checkStageClear). */
  private stageClear = true;

  constructor(
    private readonly renderer: Renderer,
    private readonly planes: Planes,
    /** The view, whose filter units a layer's chain is made at. */
    private readonly units: { readonly filterUnits: number },
  ) {}

  /**
   * A node synced on the list: noted where it may leave the stage's pixels
   * less than opaque or blends only over opaque ones, and blended. `refilled`
   * is whether its filters were made again, which a direct blend sets again.
   */
  sync(node: Node, isolated: boolean, refilled: boolean): void {
    // What may leave the stage's pixels less than opaque, and what blends only over opaque ones.
    if (!isolated && (node.blend === "erase" || node.blend === "alpha")) {
      this.clearing.add(node);
    } else {
      this.clearing.delete(node);
    }

    if (!isolated && (node.blend === "multiply" || node.blend === "subtract")) {
      this.overOpaque.add(node);
    } else {
      this.overOpaque.delete(node);
    }

    const layered = this.layer(node, isolated);
    this.blendDirectly(node, isolated ? null : this.directBlend(node), refilled || layered);
  }

  /** A node off the list, which no longer clears the stage or blends over it. */
  forget(node: Node): void {
    this.clearing.delete(node);
    this.overOpaque.delete(node);
  }

  /**
   * A filter-backed blend reads Pixi's back buffer, which WebGL has only
   * with `useBackBuffer: true`; without it that blend draws as normal.
   */
  checkBackBuffer(): void {
    if (this.backBufferChecked) {
      return;
    }

    this.backBufferChecked = true;
    const gl = this.renderer as unknown as { backBuffer?: { useBackBuffer: boolean } };
    if (gl.backBuffer && !gl.backBuffer.useBackBuffer) {
      console.warn(
        "swf2es: a blend mode draws as normal: make the Pixi renderer with useBackBuffer: true",
      );
    }
  }

  /**
   * Give a blend the GPU draws a layer of its own, kept while nothing in it changes: an empty
   * chain, through which the object is drawn once into a texture and the texture blended by the
   * GPU over what is behind (directBlend), and then only the texture while it stands, as a filtered
   * object's output is. Without one, a blend filter drew the object into a layer of its own and
   * copied what is behind it on every frame. Only a blend the GPU draws as Flash does, of an
   * object of more than one draw (a single fill
   * blends as it is drawn), with no filters of its own, outside any layer; the chain goes again
   * once that no longer holds. Multiply and subtract are the GPU's only over an opaque stage
   * (directBlend), which their layer is blended by while it is; else by a blend filter after its
   * chain. Whether the object's chain was made or dropped: a new one is
   * stale, so draws the object afresh.
   */
  private layer(node: Node, isolated: boolean): boolean {
    const chain = node.filters[0];
    const empty = chain instanceof FilterChain && chain.filters.length === 0;
    const wanted =
      !isolated &&
      node.singleDraw !== 1 &&
      (chain === undefined || empty) &&
      this.gpuBlends(node.blend);
    if (wanted === empty) {
      return false;
    }

    if (empty) {
      chain.destroy();
      node.filters = [];
    } else {
      node.filters = [new FilterChain([], node.container, true, this.units.filterUnits)];
    }

    return true;
  }

  /** Whether the GPU blends `mode` as Flash does here, as directBlend has it for a layer. */
  private gpuBlends(mode: string): boolean {
    const webgl = this.renderer.type === RendererType.WEBGL;
    switch (mode) {
      case "screen":
        return true;
      case "add":
        return webgl;
      case "multiply":
        return !this.stageClear;
      case "subtract":
        return webgl && !this.stageClear;
      default:
        return false;
    }
  }

  /** Blend `node` in `direct` by the GPU's own blending, or by its blend filter for null. */
  private blendDirectly(node: Node, direct: BLEND_MODES | null, refilled: boolean): void {
    if (direct === node.directBlend && !(direct && refilled)) {
      return;
    }

    // A fill blends as it is drawn; a filtered object as its chain's result is drawn.
    const container = node.container;
    const chain = node.filters[0];
    container.blendMode = direct && !chain ? direct : "inherit";
    if (chain instanceof FilterChain) {
      chain.blendOver(direct ?? "normal");
    }

    const blending = direct ? null : blendFilters(node.blend);
    container.filters =
      node.filters.length > 0 || blending ? [...node.filters, ...(blending ?? [])] : null;
    node.directBlend = direct;
    if (node.plane) {
      this.planes.blendQuad(node, node.plane);
    }
  }

  /**
   * Whether the stage's pixels may be less than opaque as what is below a
   * blend: a clear background, or an erase or alpha blend outside any layer
   * on the list, which clears what it covers on the stage as adl does.
   * Where that changes, the multiply and subtract blends drawn over it
   * choose again, before what is drawn this frame.
   */
  checkStageClear(): void {
    // A stand-in renderer may have no background: it is drawn on nothing.
    const clear = (this.renderer.background?.alpha ?? 1) < 1 || this.clearing.size > 0;
    if (clear === this.stageClear) {
      return;
    }

    this.stageClear = clear;
    for (const node of this.overOpaque) {
      this.blendDirectly(node, this.directBlend(node), false);
    }
  }

  /**
   * The mode `node` is blended in by the GPU's own blending, where that is
   * what Flash draws, else null for a blend filter (render/blend.ts). Flash
   * blends the object as one layer, so it must be drawn at once: as a
   * single fill, or as its filters' result. Flash's add and screen are the
   * GPU's over any backdrop, its subtract and multiply over an opaque one,
   * to 8-bit rounding (the `blend-formulas` case): over a clear pixel GPU
   * multiply drops the object's own colour, which Flash keeps, and
   * subtract its alpha. An isolated layer's ground may be clear where the
   * stage's is not, so none is used in one. Its lighten, darken and
   * difference blend the straight colours, which the GPU's min and max of
   * premultiplied ones are only where opaque.
   */
  private directBlend(node: Node): BLEND_MODES | null {
    if (node.singleDraw !== 1 && !(node.filters[0] instanceof FilterChain)) {
      return null;
    }

    // WebGPU's add leaves an opaque target less than opaque, and it has no subtract.
    switch (node.blend) {
      case "screen":
        return "screen";
      case "multiply":
        return this.stageClear ? null : "multiply";
      case "add":
        return this.renderer.type === RendererType.WEBGL ? "add" : null;
      case "subtract":
        return this.renderer.type === RendererType.WEBGL && !this.stageClear ? "subtract" : null;
      default:
        return null;
    }
  }
}
