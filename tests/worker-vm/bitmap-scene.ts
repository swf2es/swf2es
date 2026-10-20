// Deliberately limited to solid shapes, Graphics and containers. Each draw
// carries its own current subtree; this is not a retained scene/frame protocol.
import {
  Container,
  type DisplayObject,
  ShapeObject,
} from "../../packages/player/dist/display/display.js";
import { Drawing } from "../../packages/player/dist/display/drawing.js";
import type { ShapeLayer } from "../../packages/player/dist/display/shapes.js";
import type { ShapeCharacter } from "../../packages/player/dist/display/timeline.js";
import type { Drawer } from "../../packages/player/dist/hosts.js";

export const EDGE = 128;

interface Node {
  container: boolean;
  matrix: DisplayObject["matrix"];
  color: DisplayObject["colorTransform"];
  visible: boolean;
  layers: ShapeLayer[] | null;
  shape: ShapeCharacter | null;
  children: Node[];
}

export interface DrawRequest {
  serial: number;
  node: Node;
  matrix: Parameters<Drawer["snapshot"]>[1];
  width: number;
  height: number;
  samples: number;
}

export function capture(o: DisplayObject, depth = 0, budget = { left: 64 }): Node {
  if (
    --budget.left < 0 ||
    depth > 16 ||
    !(o instanceof Container || (o instanceof ShapeObject && !o.morph && !o.stale))
  ) {
    throw new Error("bitmap probe only supports solid shapes, Graphics and containers");
  }

  if (
    o.filters.length ||
    o.mask ||
    o.maskOf ||
    o.clipDepth ||
    o.scrollRect ||
    o.scale9Grid ||
    o.space ||
    o.cachedAsBitmap ||
    o.blendMode !== "normal"
  ) {
    throw new Error("bitmap probe does not support display effects");
  }

  const layers = o.drawing?.layers ?? null;
  const shape = o instanceof ShapeObject ? o.shape : null;
  const allLayers = [...(layers ?? []), ...(shape?.layers ?? [])];
  for (let i = 0; i < allLayers.length; i++) {
    const layer = allLayers[i];
    if (layer.strokes.length || layer.meshes) {
      throw new Error("bitmap probe only supports solid fills");
    }

    for (let fill = 0; fill < layer.fills.length; fill++) {
      if (layer.fills[fill].fill.type !== "solid") {
        throw new Error("bitmap probe only supports solid fills");
      }
    }
  }

  const children: Node[] = [];
  if (o instanceof Container) {
    if (o.children.length > 64) {
      throw new Error("bitmap probe subtree too large");
    }

    for (let i = 0; i < o.children.length; i++) {
      children.push(capture(o.children[i], depth + 1, budget));
    }
  }

  return {
    container: o instanceof Container,
    matrix: o.matrix,
    color: o.colorTransform,
    visible: o.visible,
    layers,
    shape,
    children,
  };
}

export function restore(node: Node): DisplayObject {
  const o = node.container ? new Container() : new ShapeObject(node.shape);
  o.matrix = node.matrix;
  o.colorTransform = node.color;
  o.visible = node.visible;
  if (node.layers) {
    o.drawing = new Drawing();
    o.drawing.layers.push(...node.layers);
    o.drawing.version++;
  }

  if (o instanceof Container) {
    for (let i = 0; i < node.children.length; i++) {
      o.placeAtDepth(restore(node.children[i]), i + 1);
    }
  }

  return o;
}

export function dimensions(width: number, height: number): number {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > EDGE ||
    height > EDGE
  ) {
    throw new RangeError("bitmap probe snapshot exceeds 128 x 128");
  }

  return width * height;
}
