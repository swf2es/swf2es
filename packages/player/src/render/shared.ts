// SharedGraphics, the Graphics that draws a context its instances share.
import type { ColorTransform } from "@swf2es/format";
import { Graphics, type GraphicsContext } from "pixi.js";
import { forgetShown, showFor } from "./color.js";

/**
 * A Graphics of a context it does not own and that never changes once
 * built: a shape's or a drawing's fills, a glyph's, or lines, whose context
 * is swapped for the transform's as the object turns. It does not listen on
 * the context, which is destroyed only once no one holds it: a shared
 * one's listeners, one an instance or a glyph, made each swap and each
 * destroy search them all, so that a text of n glyphs of one font took
 * O(n²) to go.
 */
export class SharedGraphics extends Graphics {
  /** The context it stands for, which the cache counts: what it draws, or that drawn as a batched copy (showFor). */
  shared: GraphicsContext;
  declare flashColor?: ColorTransform | null;
  /** Whether its render group has settled, which batches it (settle). */
  declare settled?: boolean;

  constructor(context?: GraphicsContext) {
    super({ context, observeContext: false });
    this.shared = this.context;
  }

  /** Stand for `context` instead, drawn as its colour transform needs. */
  swap(context: GraphicsContext): void {
    this.shared = context;
    showFor(this, this.flashColor ?? null);
  }

  override destroy(options?: Parameters<Graphics["destroy"]>[0]): void {
    forgetShown(this);
    super.destroy(options);
  }

  /** Draw `context`, without listening on it as on any other. */
  show(context: GraphicsContext): void {
    this.context = context;
  }
}
