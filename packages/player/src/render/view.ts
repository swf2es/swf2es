// Draws the display list with PixiJS. Pixi only mirrors it: one container
// for each display object, kept from frame to frame and updated where the
// display object says it changed. A shape's fills are GraphicsContexts its
// instances share (tessellate.ts); its lines depend on its transform and are
// shared by the instances that see them through the same one (strokes.ts).
import type { ColorTransform } from "@swf2es/format";
import {
  type FederatedPointerEvent,
  type Filter,
  Graphics,
  type GraphicsContext,
  Matrix,
  Container as PixiContainer,
  Rectangle,
  type Renderer,
  RendererType,
  type RenderTexture,
  Sprite,
  type WebGLRenderer,
} from "pixi.js";
import { BitmapStore } from "../bitmap/bitmap.js";
import { toStage } from "../display/bounds.js";
import { concatColor, multipliesOnly, sameColor } from "../display/color.js";
import {
  BitmapObject,
  CHILDREN,
  CLEAN,
  Clips,
  CONTENT,
  Container,
  cached,
  type DisplayObject,
  PIXELS,
  ShapeObject,
  type StaleCache,
  StaticTextObject,
  TextObject,
  TRANSFORM,
} from "../display/display.js";
import type { Filter as FilterRecord } from "../display/filters.js";
import { shifted } from "../display/geometry.js";
import { type Slice, sliceDrawn, sliceLayers } from "../display/scale9.js";
import type { ShapeLayer } from "../display/shapes.js";
import type { ShapeCharacter } from "../display/timeline.js";
import type { PointerState } from "../input/pointer.js";
import type { TouchState } from "../input/touch.js";
import type { Player } from "../player.js";
import { retireBatchers, viewGroups } from "./batchers.js";
import { argbOf, characterStore, gpuBitmaps } from "./bitmaps.js";
import { blendFilters } from "./blend.js";
import { setFlashColor } from "./color.js";
import { displayFilters, FilterChain, sameFilterRecords } from "./filters.js";
import { SETTLE_MS, type Settling, SharedGraphics, settle } from "./patches.js";
import {
  drawTarget,
  IDLE_MS,
  PARKED_FIRST_GROUPS_MOST,
  PARKED_MOST,
  releaseDrawTarget,
  SPARE_GRAPHICS_MOST,
  trimPools,
} from "./pools.js";
import { boundedResolves } from "./resolve.js";
import {
  type Linear,
  linesContext,
  NO_LINES,
  StrokeContexts,
  sameLinear,
  scalesEvenly,
  stretchOf,
  strokeFrame,
  UNIT,
} from "./strokes.js";
import { destroyContext, fillContext, type Painter, paint, SharedFills } from "./tessellate.js";
import { drawStaticText, drawText } from "./text.js";

/** No transform, for a Graphics kept to be taken again (recycle). */
const IDENTITY = new Matrix();

const NO_RECORDS: readonly FilterRecord[] = [];
/** What an emptied node has drawn, shared by all: replaced as it draws, never added to. */
const NO_LAYERS: ShapeLayer[] = [];
const NO_FILLS: GraphicsContext[] = [];
const NO_LINES_GIVEN: readonly (GraphicsContext | undefined)[] = [];

/** Whether every one of `art` is a SharedGraphics, which a redraw keeps for its new content. */
function allShared(art: readonly PixiContainer[]): boolean {
  for (let i = 0; i < art.length; i++) {
    if (!(art[i] instanceof SharedGraphics)) {
      return false;
    }
  }

  return true;
}

/**
 * Whether Graphics that were lines where `lines` says lay out `layers`
 * alike: a fill's for each layer, then its lines' if it has any.
 */
function laidOutAs(lines: readonly boolean[], layers: readonly ShapeLayer[]): boolean {
  let k = 0;
  for (let i = 0; i < layers.length; i++) {
    if (lines[k++] !== false || (layers[i].strokes.length > 0 && lines[k++] !== true)) {
      return false;
    }
  }

  return k === lines.length;
}

/** Whether any of `children` is a timeline's mask, which clips those after it. */
function anyClips(children: readonly DisplayObject[]): boolean {
  for (let i = 0; i < children.length; i++) {
    if (children[i].clipDepth > 0) {
      return true;
    }
  }

  return false;
}

/** Whether any layer has lines of the node's own to stroke. */
function hasLines(strokes: readonly (SharedGraphics | null)[]): boolean {
  for (let i = 0; i < strokes.length; i++) {
    if (strokes[i]) {
      return true;
    }
  }

  return false;
}

/** sync's scratch, which a container's matrix is set from and which it does not keep. */
const PLACED = new Matrix();
/** restroke's scratch, which a stretch is compared in and never kept. */
const STRETCH: Linear = [0, 0, 0, 0];
/** A Shape child's slice key once its owner's slice changed: it is sliced again on its next sync. */
const STALE = "stale";

/** What the view keeps for a display object. */
interface Node {
  container: PixiContainer;
  /** The linear part of the object's transform on the stage. */
  world: Linear;
  /** A stale cache drawn, the scale it was first drawn at, and whether that has changed since. */
  stale: { cache: StaleCache; world: Linear; spent: boolean } | null;
  /** What the object itself draws, a shape's or a drawing's layers, under any children. */
  art: PixiContainer;
  /** The layers drawn, a shape's or a drawing's, as of the last redraw. */
  layers: ShapeLayer[];
  /** Their fills, one context a layer. */
  fills: GraphicsContext[];
  /**
   * Whether the fills are this node's own, a drawing's, not its character's or blend's, which
   * instances share.
   */
  ownFills: boolean;
  /** The shape, or morph's blend, whose shared fills it holds, given back as it draws another or leaves. */
  sharedFills: ShapeCharacter | null;
  /** The lines, a Graphics for each layer that has any; null where one has none. */
  strokes: (SharedGraphics | null)[];
  /** Whether the layers are a character's or a blend's, whose lines' contexts instances share. */
  sharedLines: boolean;
  /** The children as of the last arrangement, to know those that left. */
  kids: readonly DisplayObject[];
  /**
   * Whether it is off the list, released: kept whole a while
   * (`PixiView.parked`), then emptied (`emptied`), its lines given back.
   */
  released: boolean;
  /** Whether this branch has returned after leaving the display list. */
  reused: boolean;
  /** Whether its art was emptied while off the list: drawn again if it comes back. */
  emptied: boolean;
  /** The thinnest line its lines were last drawn with, to draw them again for another. */
  strokedAt: number;
  /**
   * The stretch its lines were last stroked through, where all were
   * stroked through its stretch alone (stretchOf): a turn that keeps it
   * leaves them as they are. Null otherwise.
   */
  stretched: Linear | null;
  /** A Bitmap's sprite, over its store's texture, which Bitmaps share; null for any other object. */
  bitmap: Sprite | null;
  /** Every line drawn, its own or borrowed: hidden while the object is a mask or in one. */
  lines: SharedGraphics[];
  /**
   * Between a redraw's clear and its draw, the Graphics the content left,
   * and which are lines, for the next to take in place.
   */
  spare: { graphics: SharedGraphics[]; lines: boolean[] } | null;
  /** Whether the object is a mask or in one, as of the last sync. */
  masking: boolean;
  /** The containers of the children a timeline's mask clips, each masked by it. */
  groups: PixiContainer[];
  /** Its scroll's clip: a rectangle in its space, and the container it masks, of the art and children. */
  scroll: { clip: Graphics; content: PixiContainer } | null;
  /** Whether it has a mask or a scroll's clip, to be taken off when the object's go. */
  clipped: boolean;
  /** Its colour transform from the stage down, null for none, and its parent's that it was made from. */
  color: ColorTransform | null;
  inherited: ColorTransform | null;
  /** The blend mode its filters composite it in. */
  blend: string;
  /** Its filters' records as of the last sync, and the Pixi filters made of them, its own. */
  filterRecords: readonly FilterRecord[];
  filters: Filter[];
  /** Draws in this branch, excluding those already isolated in a child render group. */
  draws: number;
  /** Zero draws, one safe draw, or more than one draw/one requiring isolation. */
  singleDraw: 0 | 1 | 2;
  /** The fixed-function blend currently applied without an offscreen filter. */
  directBlend: string | null;
  /** Whether this branch's children draw into an isolated target. */
  childIsolation: boolean;
  /** Outside partners must share the group; a hidden node must not keep an old partner alive. */
  maskLinks: WeakRef<DisplayObject>[];
  /** The 9-slice its grid gives its shapes and its Shape children's (display/scale9.ts), or null. */
  slice: Slice | null;
  /** What the slice its layers were drawn with is told by, "" for none. */
  sliceKey: string;
  /** The parent and the linear part of the matrix the slice was made under, to tell when to make it again. */
  sliceOwner: DisplayObject | null;
  sliceLinear: Linear | null;
  /**
   * The linear transform on the stage its lines' widths go by, where a
   * 9-slice draws them: the grid's owner's parent's, as Flash keeps a sliced
   * line as wide as in that space. Null for its own transform.
   */
  lineSpace: Linear | null;
}

/** Only a partner outside the branch prevents it owning a separate instruction set. */
function maskLink(
  o: DisplayObject,
  partner: DisplayObject | null,
  links: WeakRef<DisplayObject>[],
): void {
  if (partner && !o.encloses(partner)) {
    links.push(partner.ref);
  }
}

export class PixiView {
  readonly stage = new PixiContainer();
  /** What the view has built since it was made, for measuring: lines' contexts made and reused. */
  readonly counts = { strokeContexts: 0, strokeReuses: 0 };
  /** Graphics of children taken off, kept for the next content to take (SPARE_GRAPHICS_MOST). */
  private readonly spareGraphics: SharedGraphics[] = [];
  private readonly lines = new StrokeContexts(this.counts);
  private readonly nodes = new WeakMap<DisplayObject, Node>();
  /** A fresh view's fills of the shapes it built them for, shared by their instances; it destroys them with itself. */
  private readonly fills = new Map<ShapeCharacter, GraphicsContext[]>();
  private readonly shared = new SharedFills();
  /**
   * A fill painted: a bitmap's from its store's texture sampled as the fill
   * samples, in global texture space so that its matrix maps the bitmap's
   * pixels to the shape's; nothing for a bitmap that has no texture.
   */
  private readonly painter: Painter = (fill, region, hold) => {
    if (fill.type === "gradient") {
      const m = fill.matrix;
      if (m.a * m.d - m.b * m.c === 0) {
        return { color: 0, alpha: 0 };
      }

      const held = gpuBitmaps(this.renderer).gradientTexture(fill, fill.radial ? region() : null);
      hold(held.release);
      return { texture: held.texture, matrix: held.matrix, textureSpace: "global" };
    }

    if (fill.type !== "image") {
      return paint(fill);
    }

    const store = fill.image instanceof BitmapStore ? fill.image : characterStore(fill.image);
    const texture = store && gpuBitmaps(this.renderer).fillTexture(store, fill.repeat, fill.smooth);
    if (!texture) {
      return { color: 0, alpha: 0 };
    }

    const m = fill.matrix;
    return { texture, matrix: new Matrix(m.a, m.b, m.c, m.d, m.tx, m.ty), textureSpace: "global" };
  };
  /** Whether the renderer was found to lack the back buffer that filter-backed blends read. */
  private backBufferChecked = false;

  /**
   * A filter-backed blend reads Pixi's back buffer, which WebGL has only
   * with `useBackBuffer: true`; without it that blend draws as normal.
   */
  private checkBackBuffer(): void {
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

  /** What a fresh view built itself, which it destroys; what it borrowed from `source` stays. */
  private readonly built = new Set<GraphicsContext>();
  /** What a fresh view borrowed from its source's caches, which it neither gives back nor destroys. */
  private readonly borrowed = new WeakSet<GraphicsContext>();
  /**
   * The released nodes that drew something, oldest first, with the time
   * each left the list: kept whole for IDLE_MS, at most PARKED_MOST of them,
   * as a pool's objects or a panel shown and hidden come back, then emptied.
   */
  private readonly parked = new Map<Node, number>();
  /** Retain only batches, not detached display trees, while a group waits for reuse. */
  private readonly parkedGroups = new Map<
    number,
    { since: number; group: WeakRef<NonNullable<PixiContainer["renderGroup"]>> }
  >();
  private readonly parkedFirstGroups = new Set<number>();
  /** The filters a fresh view made, which it destroys with the rest. */
  private readonly builtFilters: Filter[] = [];
  /** The objects `mask` was found set on, for the masks to be placed that are not under the root. */
  private readonly maskees = new Set<WeakRef<DisplayObject>>();
  /** Where those masks are placed, beside the root. */
  private readonly offList = new PixiContainer();

  /**
   * `fresh` makes a view that draws every object as new and leaves the
   * objects' dirty flags as they were, for a one-off render such as
   * BitmapData.draw's, so the stage's own view still sees each change.
   */
  /**
   * How many screen pixels a stage pixel covers, for the thinnest line,
   * which Flash draws a pixel of the screen wide however far the stage is
   * zoomed. The renderer's resolution unless set: a host that renders
   * finer than the screen to average down, as the test page does, sets it
   * to what the screen shows. A fresh view draws a BitmapData's pixels,
   * which are the stage's, so its thinnest line is a pixel.
   */
  screenScale: number | null = null;
  /** The thinnest line it last drew the stage's lines with; a change draws them all again. */
  private strokedAt = 0;
  /** The filter units it last drew the stage's filters with; the stage's own scale changes them too. */
  private filteredAt = 0;
  /** The root the last prepare synced, to know whether an object is on the list. */
  private root: DisplayObject | null = null;
  /** Whether this prepare visits every node, to stroke and filter again for a new screen scale. */
  private rescaled = false;
  /** What a fresh view draws, under the draw's matrix: Flash slices it by no grid of its own. */
  drawRoot: DisplayObject | null = null;
  /** A fresh view's units to a pixel of the BitmapData it draws, rendered that many times larger. */
  private samples = 1;

  constructor(
    readonly renderer: Renderer,
    private readonly fresh = false,
    /** The stage's view, whose geometry and textures a fresh view borrows where they are current. */
    private readonly source: PixiView | null = null,
  ) {
    if (renderer.type === RendererType.WEBGL) {
      boundedResolves(renderer as WebGLRenderer);
    }
  }

  /**
   * Where a pointer event is on the SWF's stage. CSS `object-fit` shows the
   * canvas's pixels in a box of their own within its content box, letterboxed
   * by `contain`, cropped by `cover`: Pixi maps a point over the whole element
   * as `fill` would, so the point is taken within that box instead, centred
   * as the default `object-position` puts it, and then from the canvas's
   * pixels to Pixi's screen and the stage. `style` is the canvas's live
   * computed style, null where there is no DOM. A `size`, a touch's
   * contact, comes back in stage units after the point.
   */
  private stagePoint(
    player: Player,
    e: { clientX: number; clientY: number; global: { x: number; y: number } },
    style: CSSStyleDeclaration | null,
    size: { width: number; height: number } = { width: 0, height: 0 },
  ): [x: number, y: number, width: number, height: number] {
    const screen = this.renderer.screen;
    const toStage = (x: number, y: number, w: number, h: number) =>
      [
        (x * player.width) / screen.width,
        (y * player.height) / screen.height,
        (w * player.width) / screen.width,
        (h * player.height) / screen.height,
      ] as [number, number, number, number];
    const canvas = this.renderer.canvas as HTMLCanvasElement | undefined;
    if (!canvas?.getBoundingClientRect || !style) {
      return toStage(e.global.x, e.global.y, size.width, size.height);
    }

    // The content box: the element's rectangle within its borders and padding.
    const px = (v: string | undefined) => Number.parseFloat(v ?? "") || 0;
    const rect = canvas.getBoundingClientRect();
    let left = rect.left + px(style.borderLeftWidth) + px(style.paddingLeft);
    let top = rect.top + px(style.borderTopWidth) + px(style.paddingTop);
    const width =
      rect.width -
      px(style.borderLeftWidth) -
      px(style.paddingLeft) -
      px(style.borderRightWidth) -
      px(style.paddingRight);
    const height =
      rect.height -
      px(style.borderTopWidth) -
      px(style.paddingTop) -
      px(style.borderBottomWidth) -
      px(style.paddingBottom);

    let sx = width / canvas.width;
    let sy = height / canvas.height;
    const fit = style.objectFit;
    if (fit === "contain" || fit === "scale-down" || fit === "cover" || fit === "none") {
      let scale = fit === "cover" ? Math.max(sx, sy) : fit === "none" ? 1 : Math.min(sx, sy);
      if (fit === "scale-down") {
        scale = Math.min(scale, 1);
      }

      left += (width - canvas.width * scale) / 2;
      top += (height - canvas.height * scale) / 2;
      sx = scale;
      sy = scale;
    }

    const resolution = this.renderer.resolution || 1;
    return toStage(
      (e.clientX - left) / sx / resolution,
      (e.clientY - top) / sy / resolution,
      size.width / sx / resolution,
      size.height / sy / resolution,
    );
  }

  /** Let Pixi normalize browser coordinates; Flash's display list chooses the target. */
  bindPointer(player: Player): () => void {
    this.stage.eventMode = "static";
    this.stage.hitArea = new Rectangle(
      0,
      0,
      this.renderer.screen.width,
      this.renderer.screen.height,
    );
    // The stage is Pixi's only target: its hit test would otherwise search
    // every child on each move, which on a crowded display list made each
    // frame a third longer while the mouse moved.
    const interactiveChildren = this.stage.interactiveChildren;
    this.stage.interactiveChildren = false;
    // A move is posted, handled when the player next advances or before the
    // next press, release, leave or key; a frame callback of its own handles
    // it where the host does not advance (a paused player, say).
    let frame = 0;
    const canvas = this.renderer.canvas as HTMLCanvasElement | undefined;
    // Live: read once, it follows the element's style as the page changes it.
    const style =
      canvas?.getBoundingClientRect && typeof getComputedStyle === "function"
        ? getComputedStyle(canvas)
        : null;
    const flushSoon = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        player.pointer?.flush();
        player.touch?.flush();
      });
    };
    // Each touch's last point, which a cancel, whose own may be anywhere, ends at.
    const touches = new Map<number, TouchState>();
    // A touch goes to the player's touches, which move the mouse for the primary one.
    const touched = (type: "move" | "down" | "up" | "leave", e: FederatedPointerEvent) => {
      const touch = player.touch;
      // A lifted finger leaves the canvas too: the mouse it moved stays, as Flash's does.
      if (!touch || type === "leave") {
        return;
      }

      const [x, y, width, height] = this.stagePoint(player, e, style, e);
      const t: TouchState = {
        x,
        y,
        id: e.pointerId,
        primary: e.isPrimary,
        width,
        height,
        pressure: e.pressure,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        time: e.timeStamp,
      };
      if (type === "up") {
        touches.delete(t.id);
      } else {
        touches.set(t.id, t);
      }

      if (type === "move" && typeof requestAnimationFrame === "function") {
        touch.post(t);
        flushSoon();
        return;
      }

      touch.handle(type === "down" ? "begin" : type === "up" ? "end" : "move", t);
    };
    const send = (type: "move" | "down" | "up" | "leave") => (e: FederatedPointerEvent) => {
      if (e.pointerType === "touch") {
        touched(type, e);
        return;
      }

      const [x, y] = this.stagePoint(player, e, style);
      const p: PointerState = {
        x,
        y,
        button: e.button,
        buttons: e.buttons,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        time: e.timeStamp,
      };
      if (type === "move" && player.pointer && typeof requestAnimationFrame === "function") {
        player.pointer.post(p);
        flushSoon();
        return;
      }

      player.pointer?.handle(type, p);
    };
    const moved = send("move");
    const down = send("down");
    const up = send("up");
    const leave = send("leave");
    // Every move on the page: one over the canvas, and, while the mouse's
    // button is down after a press on it, one anywhere, as Flash keeps the
    // mouse until the release.
    const screen = this.renderer.screen;
    // A release outside after a press that held the mouse leaves it at the
    // next move outside, as Flash's mouseLeave comes.
    let leaveNext = false;
    const move = (e: FederatedPointerEvent) => {
      const { x, y } = e.global;
      const inside = x >= 0 && y >= 0 && x < screen.width && y < screen.height;
      if (inside || (e.pointerType !== "touch" && player.pointer?.captured)) {
        leaveNext = false;
        moved(e);
      } else if (leaveNext && e.pointerType !== "touch") {
        leaveNext = false;
        leave(e);
      }
    };
    const upOutside = (e: FederatedPointerEvent) => {
      const held = e.pointerType !== "touch" && !!player.pointer?.captured;
      up(e);
      leaveNext ||= held && !player.pointer?.captured;
    };
    this.stage.on("globalpointermove", move);
    this.stage.on("pointerdown", down);
    this.stage.on("pointerup", up);
    this.stage.on("pointerupoutside", upOutside);
    this.stage.on("pointerleave", leave);
    // Pixi listens for no cancel: the browser takes a touch back so, as for a
    // system gesture, and the touch ends where it last was, without its tap or click.
    const cancel = (e: Event) => {
      const t = touches.get((e as PointerEvent).pointerId);
      if (t && (e as PointerEvent).pointerType === "touch") {
        touches.delete(t.id);
        player.touch?.handle("cancel", { ...t, time: e.timeStamp });
      }
    };
    canvas?.addEventListener?.("pointercancel", cancel);
    // Pixi sets the canvas's cursor on every move, from its target's, which
    // is this stage: the player's cursor goes there, and through Pixi's own
    // setter now, which keeps Pixi's record of it right.
    const events = (
      this.renderer as {
        events?: { setCursor(mode: string | null): void; cursorStyles: Record<string, unknown> };
      }
    ).events;
    // Pixi's "default" is "inherit", which shows the page's cursor where the
    // page sets one; Flash's arrow, auto's or a forced one, is the arrow.
    const pixiDefault = events?.cursorStyles.default;
    if (events) {
      events.cursorStyles.default = "default";
    }

    const show = (cursor: string) => {
      this.stage.cursor = cursor;
      if (events) {
        events.setCursor(cursor);
      } else if (canvas?.style) {
        canvas.style.cursor = cursor;
      }
    };
    const pointer = player.pointer;
    if (pointer) {
      pointer.onCursor = show;
      show(pointer.cursor());
    }

    return () => {
      // Pixi's own default back first, then the canvas left to it, as before the bind.
      if (events) {
        events.cursorStyles.default = pixiDefault;
      }

      if (pointer) {
        pointer.onCursor = null;
        this.stage.cursor = "default";
        if (canvas?.style) {
          canvas.style.cursor = "";
        }
      }

      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }

      player.pointer?.flush();
      player.touch?.flush();
      canvas?.removeEventListener?.("pointercancel", cancel);
      this.stage.off("globalpointermove", move);
      this.stage.off("pointerdown", down);
      this.stage.off("pointerup", up);
      this.stage.off("pointerupoutside", upOutside);
      this.stage.off("pointerleave", leave);
      this.stage.eventMode = "passive";
      this.stage.hitArea = null;
      this.stage.interactiveChildren = interactiveChildren;
    };
  }

  /**
   * The source view's node for `o`, if what it drew is still `o`'s: built
   * since the content last changed. Its lines are current for its own
   * `world` alone.
   */
  private current(o: DisplayObject): Node | null {
    const node = this.source?.nodes.get(o);
    return node && !(o.dirty & CONTENT) ? node : null;
  }

  /** Destroy what this fresh view built, and its containers; what it borrowed stays its owner's. */
  dispose(root: PixiContainer): void {
    root.destroy({ children: true });
    for (const context of this.built) {
      destroyContext(context);
    }

    // A container destroyed lets go of its filters without destroying them.
    for (const filter of this.builtFilters) {
      filter.destroy();
    }
  }

  private node(o: DisplayObject): Node {
    let node = this.nodes.get(o);
    if (!node) {
      const art = new PixiContainer();
      node = {
        container: new PixiContainer(),
        world: [0, 0, 0, 0],
        stale: null,
        art,
        layers: [],
        fills: [],
        ownFills: false,
        sharedFills: null,
        strokes: [],
        sharedLines: false,
        kids: [],
        released: false,
        reused: false,
        emptied: false,
        strokedAt: 0,
        stretched: null,
        bitmap: null,
        lines: [],
        spare: null,
        masking: false,
        groups: [],
        scroll: null,
        clipped: false,
        color: null,
        inherited: null,
        blend: "normal",
        filterRecords: NO_RECORDS,
        filters: [],
        draws: 0,
        singleDraw: 0,
        directBlend: null,
        childIsolation: false,
        maskLinks: [],
        slice: null,
        sliceKey: "",
        sliceOwner: null,
        sliceLinear: null,
        lineSpace: null,
      };
      node.container.addChild(art);
      this.nodes.set(o, node);
    }

    return node;
  }

  /**
   * What `o` itself draws, built anew: a shape's layers, whose fills are
   * shared by every instance of the character, or its drawing's, which are
   * its own and change.
   */
  private redraw(o: DisplayObject, node: Node): void {
    const done = this.clear(node, true);
    // Given back after the new ones are made, so that a texture or a blend they share is kept, not
    // made again.
    try {
      this.draw(o, node);
    } finally {
      done();
      // Drawn, the new content has taken or dropped them all; one that threw has not.
      this.dropSpare(node);
    }
  }

  /**
   * Empty the node of what it drew, and return what gives back its fills
   * and lines: a drawing's fills, a blend's, and every node's lines; a
   * Graphics frees only a context it made.
   */
  private clear(node: Node, keep = false): () => void {
    // A Bitmap's texture is its store's: only the sprite goes.
    node.bitmap?.destroy();
    node.bitmap = null;
    // Of the content's arrays, none is made where it has nothing: an object is emptied and drawn
    // anew each time its content changes.
    const old = node.ownFills && !this.fresh ? node.fills : NO_FILLS;
    const oldLines =
      this.fresh || node.strokes.length === 0 ? NO_LINES_GIVEN : node.strokes.map((g) => g?.shared);
    const shared = node.sharedFills;
    // A shape's Graphics stay where they are, for the content drawn next to take in place: taken
    // off and put on, they changed the structure of its render group, which Pixi then rebuilt
    // whole, an animated character's every frame its timeline swapped a shape.
    const art = node.art.children;
    if (keep && art.length > 0 && allShared(art)) {
      const lines = node.lines;
      node.spare = {
        graphics: art.slice() as SharedGraphics[],
        lines: art.map((g) => lines.includes(g as SharedGraphics)),
      };
    } else {
      // A text's characters are in a container of their own; their shared
      // glyph fills stay, not being theirs. A shape's Graphics are kept for
      // the next content to take.
      for (const child of node.art.removeChildren()) {
        if (child instanceof SharedGraphics && !this.fresh) {
          this.recycle(child);
        } else if (!child.destroyed) {
          child.destroy({ children: true });
        }
      }
    }

    node.layers = NO_LAYERS;
    node.fills = NO_FILLS;
    node.ownFills = false;
    node.sharedFills = null;
    node.strokes = [];
    node.lines = [];
    return () => {
      for (let i = 0; i < old.length; i++) {
        destroyContext(old[i]);
      }

      for (let i = 0; i < oldLines.length; i++) {
        const context = oldLines[i];
        if (context) {
          this.lines.give(context);
        }
      }

      if (shared) {
        this.shared.give(shared);
      }
    };
  }

  /**
   * Whether `o`'s slice may have changed since its node's was made: its
   * grid, drawing or children changed, a direct child's drawing, its scale
   * (not its position, as a dragged panel's), a Shape child's matrix or
   * parent, its mask role, or its owner's slice.
   */
  private reslices(o: DisplayObject, node: Node, dirty: number, remask: boolean): boolean {
    if (
      remask ||
      node.sliceKey === STALE ||
      o.parent !== node.sliceOwner ||
      dirty & (CONTENT | CHILDREN)
    ) {
      return true;
    }

    const m = o.matrix;
    const was = node.sliceLinear;
    if (
      dirty & TRANSFORM &&
      ((o instanceof ShapeObject && o.parent?.scale9Grid) ||
        !was ||
        was[0] !== m.a ||
        was[1] !== m.b ||
        was[2] !== m.c ||
        was[3] !== m.d)
    ) {
      return true;
    }

    return (
      o instanceof Container && o.descendantsDirty && o.children.some((c) => c.dirty & CONTENT)
    );
  }

  /**
   * The slice that reshapes what `o` itself draws, and the matrix from its
   * space to the owner's, null for the owner: as display/scale9.ts's
   * sliceFor, from the slices this view keeps, which its syncs made.
   */
  private slicing(
    o: DisplayObject,
    node: Node,
  ): { slice: Slice; m: DisplayObject["matrix"] | null } | null {
    if (node.masking) {
      return null;
    }

    if (node.slice) {
      return { slice: node.slice, m: null };
    }

    const parent = o.parent;
    const slice =
      o instanceof ShapeObject && parent?.scale9Grid ? this.nodes.get(parent)?.slice : null;
    return slice ? { slice, m: o.placed } : null;
  }

  /**
   * The linear transform on the stage a sliced shape's lines are as wide
   * through: the owner's parent's, as in adl a sliced line keeps the width
   * it has in that space, times a Shape child's own, whose scale widens
   * them; `parent` is `o`'s parent's.
   */
  private lineSpace(o: DisplayObject, node: Node, parent: Linear): Linear {
    if (node.slice) {
      return parent;
    }

    const owner = this.nodes.get(o.parent as Container)?.lineSpace ?? parent;
    const m = o.matrix;
    return [
      owner[0] * m.a + owner[2] * m.b,
      owner[1] * m.a + owner[3] * m.b,
      owner[0] * m.c + owner[2] * m.d,
      owner[1] * m.c + owner[3] * m.d,
    ];
  }

  /**
   * The shape a Shape draws: the one Flash's stale bitmap cache shows,
   * while it stands on the stage at the scale it was drawn at; a mask
   * clips by the shape it is.
   */
  private shapeOf(o: ShapeObject, node: Node): ShapeCharacter | null {
    const cache = o.stale;
    if (!cache || node.masking) {
      return o.drawn();
    }

    if (node.stale?.cache !== cache) {
      node.stale = { cache, world: node.world, spent: false };
    }

    return node.stale.spent ? o.drawn() : cache.shape;
  }

  /** What `o` itself draws, into its node emptied of what it drew before. */
  private draw(o: DisplayObject, node: Node): void {
    const current = this.current(o);
    // A bitmap or a text draws no Graphics the last content's could stand for.
    if (o instanceof BitmapObject || o instanceof TextObject || o instanceof StaticTextObject) {
      this.dropSpare(node);
    }

    if (o instanceof BitmapObject) {
      this.drawBitmap(o, node);
      return;
    }

    if (o instanceof TextObject) {
      drawText(o, node.art);
      return;
    }

    if (o instanceof StaticTextObject) {
      drawStaticText(o, node.art);
      return;
    }

    const shape = o instanceof ShapeObject ? this.shapeOf(o, node) : null;
    node.layers = o.drawing?.layers ?? shape?.layers ?? [];
    const slicing = this.slicing(o, node);
    if (slicing) {
      node.layers = sliceLayers(node.layers, slicing.slice, slicing.m, o.drawing?.version);
    }

    const build = (layer: ShapeLayer) => {
      const context = fillContext(layer, this.painter);
      if (this.fresh) {
        this.built.add(context);
      }

      return context;
    };
    let fills: GraphicsContext[];
    node.ownFills = false;
    if (current && current.layers === node.layers && current.fills.length === node.layers.length) {
      fills = current.fills;
    } else if (shape && !o.drawing && !slicing && !this.fresh) {
      // A shape's, or a morph's blend's, shared and counted: they go once nothing draws them.
      fills = this.shared.take(shape, () => node.layers.map(build));
      node.sharedFills = shape;
    } else if (shape && !o.drawing && !slicing) {
      // A fresh view borrows the stage's, which its object, off the list, may no longer hold;
      // else builds its own, shared by its instances, which it destroys with the rest.
      fills = this.source?.shared.peek(shape) ?? this.fills.get(shape) ?? node.layers.map(build);
      this.fills.set(shape, fills);
    } else {
      fills = node.layers.map(build);
      node.ownFills = true;
    }

    node.fills = fills;
    // A blend's layers never change, so its lines are shared as a shape's: instances in step stroke
    // once.
    node.sharedLines = !o.drawing && shape !== null && !slicing;
    const lines =
      current &&
      !slicing &&
      sameLinear(current.world, node.world) &&
      this.source?.leastWidth === this.leastWidth
        ? current.strokes
        : null;
    // The Graphics the last content left, taken in place where it laid out
    // its fills and lines alike.
    const spare =
      node.spare && laidOutAs(node.spare.lines, node.layers) ? node.spare.graphics : null;
    if (!spare) {
      this.dropSpare(node);
    }

    node.spare = null;
    let next = 0;
    const graphic = (context?: GraphicsContext): SharedGraphics => {
      if (!spare) {
        const made = this.spareGraphics.pop() ?? new SharedGraphics(NO_LINES);
        made.swap(context ?? NO_LINES);
        node.art.addChild(made);
        return made;
      }

      const kept = spare[next++];
      // A line's shows none till restroke gives it its own, and gives back the old.
      kept.swap(context ?? NO_LINES);
      return kept;
    };

    node.layers.forEach((layer, i) => {
      graphic(fills[i]);
      const borrowed = lines?.[i];
      const strokes = layer.strokes.length ? graphic(borrowed?.shared) : null;
      if (strokes) {
        if (borrowed) {
          strokes.setFromMatrix(borrowed.localTransform);
        }

        node.lines.push(strokes);
      }

      node.strokes.push(borrowed ? null : strokes);
    });
    this.restroke(node);
  }

  /**
   * A Bitmap as a sprite over its store's texture, which every Bitmap of
   * the store shares; nothing for no store, one disposed, one of 0 by 0
   * that Flash could not read, or one too large for a texture.
   */
  private drawBitmap(o: BitmapObject, node: Node): void {
    const texture = o.store && gpuBitmaps(this.renderer).texture(o.store, o.smoothing);
    if (!texture) {
      return;
    }

    node.bitmap = new Sprite(texture);
    node.art.addChild(node.bitmap);
  }

  /**
   * An object off the list, and all below it: their lines given back, so
   * that the cache can let them go, and drawn again if they come back.
   */
  private release(o: DisplayObject): void {
    const node = this.nodes.get(o);
    if (!node || node.released) {
      return;
    }

    node.released = true;
    const group = node.container.isRenderGroup ? node.container.renderGroup : null;
    if (group) {
      const uid = group.instructionSet.uid;
      this.parkedGroups.delete(uid);
      this.parkedGroups.set(uid, { since: performance.now(), group: new WeakRef(group) });
      if (!node.reused) {
        this.parkedFirstGroups.add(uid);
        if (this.parkedFirstGroups.size > PARKED_FIRST_GROUPS_MOST) {
          const oldest = this.parkedFirstGroups.values().next().value;
          if (oldest !== undefined) {
            this.emptyGroup(oldest, this.parkedGroups.get(oldest)?.group.deref());
          }
        }
      }
    }

    const chain = node.filters[0];
    if (chain instanceof FilterChain) {
      chain.forget();
    }

    // What it drew is kept a while for it to come back to, as a pool's
    // objects do, then goes, its Graphics let go of their geometry and
    // kept for the next content to take: Pixi keeps a Graphics it has
    // drawn, with its geometry, for a minute after it was last drawn, which
    // a timeline that makes its children anew on every frame turned into
    // gigabytes.
    if (node.art.children.length > 0) {
      this.parked.delete(node);
      this.parked.set(node, performance.now());
      if (this.parked.size > PARKED_MOST) {
        this.empty(this.parked.keys().next().value as Node);
      }
    } else {
      this.empty(node);
    }

    // Those it last drew, which may since have left it too, and any it has
    // now; not one it last drew that has moved to another parent on the
    // list, which draws it.
    // Those last drawn first, then any new: one in both is released once, as a second does nothing.
    const kids = node.kids;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].parent === o || this.left(kids[i], o)) {
        this.release(kids[i]);
      }
    }

    if (o instanceof Container) {
      const children = o.children;
      for (let i = 0; i < children.length; i++) {
        this.release(children[i]);
      }
    }
  }

  /**
   * Whether `kid`, which `from` last drew, is off the list: taken out, or
   * moved to a parent that is off it too, which no sync will release.
   */
  private left(kid: DisplayObject, from: DisplayObject): boolean {
    return kid.parent === null || (kid.parent !== from && !this.root?.encloses(kid));
  }

  /** Keep the Graphics a redraw kept for its new content that it did not take, or destroy them in a fresh view. */
  private dropSpare(node: Node): void {
    for (const graphic of node.spare?.graphics ?? []) {
      graphic.parent?.removeChild(graphic);
      if (this.fresh) {
        graphic.destroy();
      } else {
        this.recycle(graphic);
      }
    }

    node.spare = null;
  }

  /**
   * Keep a Graphics of a child taken off for the next content to take, as
   * a new one would be: showing nothing, untransformed, uncoloured, shown
   * and drawn alone, its GPU data let go of as destroying it did; or
   * destroy it past the most kept.
   */
  private recycle(graphic: SharedGraphics): void {
    if (graphic.destroyed) {
      return;
    }

    if (this.spareGraphics.length >= SPARE_GRAPHICS_MOST) {
      graphic.destroy();
      return;
    }

    graphic.unload();
    graphic.settled = false;
    graphic.flashColor = null;
    graphic.swap(NO_LINES);
    graphic.setFromMatrix(IDENTITY);
    graphic.visible = true;
    this.spareGraphics.push(graphic);
  }

  /** A released node's art emptied, its fills and lines given back: drawn again if it comes back. */
  private empty(node: Node): void {
    this.parked.delete(node);
    node.emptied = true;
    this.clear(node)();
  }

  /** Return a parked group's batches without changing its nested group hierarchy. */
  private emptyGroup(
    uid: number,
    group: NonNullable<PixiContainer["renderGroup"]> | undefined,
  ): void {
    this.parkedGroups.delete(uid);
    this.parkedFirstGroups.delete(uid);
    retireBatchers(this.renderer, uid);
    if (group) {
      group.instructionSet.destroy();
      group.structureDidChange = true;
    }
  }

  /**
   * Draw the lines again for the object's transform on the stage: in the
   * stage's axes, under the inverse of that transform's linear part, or
   * for a layer whose lines scale both ways, through its stretch alone,
   * under the stretch's inverse (stretchOf).
   */
  private restroke(node: Node, moved = false): void {
    const m = node.world;
    const least = this.leastWidth;
    // Turned or mirrored, not stretched: the lines and the inverse they are under stay, as a limb's
    // that only turns on every frame.
    if (moved && node.stretched && node.strokedAt === least) {
      const stretch = stretchOf(m, STRETCH);
      if (stretch && sameLinear(stretch, node.stretched)) {
        return;
      }
    }

    node.strokedAt = least;
    const by = node.lineSpace;
    // One key and one inverse for all its layers of each kind, made as one first needs them.
    let exact: ReturnType<typeof strokeFrame> | null = null;
    let scaled: ReturnType<typeof strokeFrame> | null | undefined;
    const frameFor = (layer: ShapeLayer) => {
      if (scaled === undefined && !by && scalesEvenly(layer)) {
        const stretch = stretchOf(m);
        scaled = stretch && strokeFrame(stretch, least);
      }

      if (scaled && scalesEvenly(layer)) {
        return scaled;
      }

      exact ??= strokeFrame(m, least);
      return exact;
    };
    node.layers.forEach((layer, i) => {
      const strokes = node.strokes[i];
      if (!strokes) {
        return;
      }

      const { m: seen, key, inverse } = frameFor(layer);
      // The new context goes in before the old one goes back, as it may be the same.
      const previous = strokes.shared;
      // A fresh view borrows the stage's lines where it draws them alike.
      const kept =
        this.fresh && node.sharedLines && this.source?.leastWidth === least
          ? this.source.lines.peek(layer, key)
          : null;
      if (kept) {
        strokes.swap(kept);
        this.borrowed.add(kept);
      } else if (node.sharedLines && !this.fresh) {
        strokes.swap(this.lines.take(layer, seen, least, key));
      } else {
        strokes.swap(linesContext(layer, seen, least, by ?? seen));
        this.counts.strokeContexts++;
        if (this.fresh) {
          this.built.add(strokes.shared);
        }
      }

      if (!this.borrowed.has(previous) && !this.built.has(previous)) {
        this.lines.give(previous);
      }
      if (inverse) {
        strokes.setFromMatrix(inverse);
      }
    });
    node.stretched = scaled && !exact ? scaled.m : null;
  }

  /**
   * Bring `o`'s mirror up to date where it changed, and return it. `parent`
   * is the linear part of its parent's transform on the stage, and `moved`
   * whether that changed, which changes the lines of every shape below.
   * `own` stands in for `o`'s own matrix, as a draw's matrix does.
   */
  private sync(
    o: DisplayObject,
    parent: Linear,
    moved: boolean,
    own: DisplayObject["matrix"] = o.placed,
    inMask = false,
    tint: ColorTransform | null = null,
    isolated = false,
  ): PixiContainer {
    const node = this.node(o);
    const { container } = node;
    let dirty = this.fresh ? TRANSFORM | CHILDREN | CONTENT : o.dirty;
    if (node.released) {
      // Back from off the list: drawn again if its art was emptied, its transform as if unknown, so
      // that it and all below draw their lines again; a parked one has kept its own. Its children,
      // if it has or had any, are arranged again, as those that were emptied with it are drawn
      // again.
      node.released = false;
      node.reused = true;
      this.parked.delete(node);
      const group = node.container.renderGroup;
      if (group) {
        this.parkedGroups.delete(group.instructionSet.uid);
        this.parkedFirstGroups.delete(group.instructionSet.uid);
      }

      const kids = o instanceof Container && (o.children.length > 0 || node.kids.length > 0);
      dirty |= TRANSFORM | (kids ? CHILDREN : 0);
      if (node.emptied) {
        node.emptied = false;
        node.world = [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
        dirty |= CONTENT;
      }
    }

    // A mask is drawn, whatever its visibility, alpha and colour, by its fills alone.
    const masking = inMask || o.maskOf !== null || o.clipDepth > 0;
    const remask = masking !== node.masking;
    node.masking = masking;
    if (remask) {
      dirty |= TRANSFORM | (o instanceof ShapeObject && o.stale ? CONTENT : 0);
    }

    if (dirty & TRANSFORM) {
      const m = own;
      container.setFromMatrix(PLACED.set(m.a, m.b, m.c, m.d, m.tx, m.ty));
      container.visible = o.visible || masking;
      // A blend mode composites the object as a layer (render/blend.ts); a mask is its fills alone.
      // Its filters, then its blend: adl filters the object, then blends what they make.
      const blend = masking ? "normal" : o.blendMode;
      const records = masking ? NO_RECORDS : o.filters;
      // Filters set again with the same values, as a tween writes them on each frame, keep their
      // chain and the output it kept.
      const refiltered =
        records !== node.filterRecords && !sameFilterRecords(records, node.filterRecords);
      node.filterRecords = records;
      if (blend !== node.blend || refiltered) {
        node.blend = blend;
        for (const f of node.filters) {
          f.destroy();
        }

        // Flash's filters are WebGL's alone; Pixi skips a chain with one it
        // cannot run, so under WebGPU they are left out and the blend kept.
        const chain =
          this.renderer.type === RendererType.WEBGPU
            ? []
            : displayFilters(records, (map) => {
                // A displacement map's map: its store's texture, brought up to date as it is read.
                const store = (map as { $store?: BitmapStore }).$store;
                return store && !store.disposed
                  ? gpuBitmaps(this.renderer).texture(store, false)
                  : null;
              });
        // A view drawn once keeps no output.
        node.filters =
          chain.length > 0
            ? [new FilterChain(chain, container, !this.fresh, this.filterUnits)]
            : [];
        if (this.fresh) {
          this.builtFilters.push(...node.filters);
        }

        const blending = blendFilters(blend);
        container.filters =
          node.filters.length > 0 || blending ? [...node.filters, ...(blending ?? [])] : null;
      }

      // Most objects have neither: they pay one test.
      if (o.mask || o.scroll || node.clipped) {
        if (this.clip(o, node) && o instanceof Container) {
          dirty |= CHILDREN;
        }
      }
    }

    // The colour transform from the stage down. One that only multiplies is
    // Pixi's tint and alpha, which Pixi composes down the tree itself; any
    // other is what is drawn's own (render/color.ts), and the tint stays white.
    let recolor = false;
    if (dirty & TRANSFORM || tint !== node.inherited) {
      node.inherited = tint;
      const ct = o.colorTransform;
      const color = masking ? null : ct ? (tint ? concatColor(tint, ct) : ct) : tint;
      if (!sameColor(color, node.color)) {
        node.color = color;
        recolor = true;
      }
    }

    const flash = node.color && !multipliesOnly(node.color) ? node.color : null;
    if (dirty & TRANSFORM || recolor) {
      const ct = flash || masking ? null : o.colorTransform;
      container.alpha = ct ? Math.max(0, Math.min(1, ct.aMul)) : 1;
      const tint = ct
        ? (Math.round(Math.max(0, Math.min(1, ct.rMul)) * 255) << 16) |
          (Math.round(Math.max(0, Math.min(1, ct.gMul)) * 255) << 8) |
          Math.round(Math.max(0, Math.min(1, ct.bMul)) * 255)
        : 0xffffff;
      // Set only as it changes: Pixi parses a tint set through its Color, which allocates, though
      // most objects keep theirs white.
      if (container.tint !== tint) {
        container.tint = tint;
      }
    }

    if (moved || dirty & TRANSFORM) {
      const m = own;
      const a = parent[0] * m.a + parent[2] * m.b;
      const b = parent[1] * m.a + parent[3] * m.b;
      const c = parent[0] * m.c + parent[2] * m.d;
      const d = parent[1] * m.c + parent[3] * m.d;
      const was = node.world;
      // A new one only where it changed: others may hold the one before, which stays as it was.
      moved = a !== was[0] || b !== was[1] || c !== was[2] || d !== was[3];
      if (moved) {
        node.world = [a, b, c, d];
      }
    }

    // Flash draws a stale cache again when the object's scale on the stage changes, as by its
    // parent's, or a frame is drawn with its cache off; from then on the view draws the object
    // as it is.
    const stale = node.stale;
    if (
      stale &&
      !stale.spent &&
      o instanceof ShapeObject &&
      o.stale === stale.cache &&
      (!sameLinear(stale.world, node.world) || !cached(o))
    ) {
      stale.spent = true;
      dirty |= CONTENT;
    }

    // A 9-slice reshapes the shapes as the owner's scale, bounds or grid change, or a Shape child's
    // matrix or parent, not as anything moves; a mask, and the root of a BitmapData's draw, are not
    // sliced.
    let resliced = false;
    if (
      (o.scale9Grid || node.sliceKey || (o instanceof ShapeObject && o.parent?.scale9Grid)) &&
      this.reslices(o, node, dirty, remask)
    ) {
      node.slice = o.scale9Grid && !masking && o !== this.drawRoot ? sliceDrawn(o) : null;
      node.sliceOwner = o.parent;
      const m = o.matrix;
      node.sliceLinear = [m.a, m.b, m.c, m.d];
      const slicing = this.slicing(o, node);
      const at = slicing?.m;
      const key = !slicing
        ? ""
        : at
          ? `${slicing.slice.key};${at.a},${at.b},${at.c},${at.d},${at.tx},${at.ty}`
          : slicing.slice.key;
      if (key !== node.sliceKey) {
        node.sliceKey = key;
        dirty |= CONTENT;
        resliced = o instanceof Container;
        node.lineSpace = null;
      }
    }

    if (node.sliceKey && (moved || dirty & (TRANSFORM | CONTENT) || !node.lineSpace)) {
      node.lineSpace = this.lineSpace(o, node, parent);
    }

    if (resliced) {
      for (const child of (o as Container).children) {
        const kid = child instanceof ShapeObject ? this.nodes.get(child) : undefined;
        if (kid) {
          kid.sliceKey = STALE;
        }
      }
    }

    if (dirty & CONTENT) {
      this.redraw(o, node);
    } else if ((moved || node.strokedAt !== this.leastWidth) && hasLines(node.strokes)) {
      this.restroke(node, true);
    }

    if (dirty & CONTENT || remask) {
      for (const lines of node.lines) {
        lines.visible = !masking;
      }
    }

    if (dirty & CONTENT || recolor) {
      for (const leaf of node.art.children) {
        setFlashColor(leaf, flash);
      }
    }

    if (dirty & PIXELS && !(dirty & CONTENT)) {
      // Pixels set since: the textures brought up to date, uploaded where the CPU changed them.
      const bitmaps = gpuBitmaps(this.renderer);
      if (node.bitmap && o instanceof BitmapObject && o.store) {
        bitmaps.texture(o.store, o.smoothing);
      }

      for (const layer of node.layers) {
        for (const { fill } of layer.fills) {
          if (fill.type === "image" && fill.image instanceof BitmapStore) {
            bitmaps.fillTexture(fill.image, fill.repeat, fill.smooth);
          }
        }
      }
    }

    // What its filters' kept output was drawn from changed, but for a move.
    // (A mask from outside it does not count: adl keeps the output, clipped as it was.)
    const chain = node.filters[0];
    // Kept on the chain, as lines' strokedAt: one off the list while the screen's scale changed
    // comes back at the old units.
    if (chain instanceof FilterChain && chain.units !== this.filterUnits) {
      chain.rescale(this.filterUnits);
    }

    if (
      chain instanceof FilterChain &&
      (dirty & ~TRANSFORM ||
        moved ||
        remask ||
        recolor ||
        this.rescaled ||
        // A scroll moves what is drawn within the input; any move of a scrolled object counts.
        (dirty & TRANSFORM && (o.scroll || node.scroll)) ||
        (o instanceof Container && o.descendantsDirty))
    ) {
      chain.changed();
    }

    const childIsolation =
      isolated || node.blend !== "normal" || node.filters.length > 0 || node.clipped;
    const isolationChanged = childIsolation !== node.childIsolation;
    node.childIsolation = childIsolation;

    if (o instanceof Container) {
      if (dirty & CHILDREN) {
        this.arrange(o, node, moved, masking, childIsolation);
      } else if (
        moved ||
        remask ||
        recolor ||
        this.rescaled ||
        isolationChanged ||
        resliced ||
        o.descendantsDirty
      ) {
        for (const child of o.children) {
          if (
            moved ||
            (resliced && child instanceof ShapeObject) ||
            remask ||
            this.rescaled ||
            recolor ||
            isolationChanged ||
            child.dirty !== CLEAN ||
            (child instanceof Container && child.descendantsDirty)
          ) {
            this.sync(child, node.world, moved, child.placed, masking, node.color, childIsolation);
          }
        }
      }

      if (!this.fresh) {
        o.descendantsDirty = false;
      }
    }

    if (!this.fresh) {
      this.group(o, node);
      // Fixed-function multiply needs an opaque backdrop; screen's equation
      // also holds over transparent pixels. Add does not preserve layer alpha.
      let direct: "multiply" | "screen" | null = null;
      if (node.singleDraw === 1) {
        if (node.blend === "screen") {
          direct = "screen";
        } else if (node.blend === "multiply" && this.renderer.background.alpha === 1) {
          direct = "multiply";
        }
      }
      if (isolated) {
        direct = null;
      }

      if (direct !== node.directBlend || (direct && container.filters)) {
        container.blendMode = direct ?? "inherit";
        const blending = direct ? null : blendFilters(node.blend);
        container.filters =
          node.filters.length > 0 || blending ? [...node.filters, ...(blending ?? [])] : null;
        node.directBlend = direct;
      }
      o.dirty = CLEAN;
    }

    if (node.blend !== "normal" && node.blend !== "layer" && !node.directBlend) {
      this.checkBackBuffer();
    }

    return container;
  }

  /** Keep an animated branch from rebuilding all the stage's batches when its children change. */
  private group(o: DisplayObject, node: Node): void {
    let draws = node.art.children.length;
    let singleDraw: 0 | 1 | 2 = 0;
    if (node.art.children.length === 1) {
      const art = node.art.children[0];
      singleDraw =
        art instanceof SharedGraphics &&
        art.context.instructions.length === 1 &&
        art.context.instructions[0].action === "fill"
          ? 1
          : 2;
    } else if (node.art.children.length > 1) {
      singleDraw = 2;
    }

    const links = node.maskLinks;
    links.length = 0;
    maskLink(o, o.mask, links);
    maskLink(o, o.maskOf, links);
    if (o instanceof Container) {
      // Indexes, not for-of: this runs for every object synced.
      const children = o.children;
      for (let i = 0; i < children.length; i++) {
        const part = this.nodes.get(children[i]);
        if (part) {
          for (let k = 0; k < part.maskLinks.length; k++) {
            maskLink(o, part.maskLinks[k].deref() ?? null, links);
          }

          draws += part.container.isRenderGroup ? 0 : part.draws;
          if (part.singleDraw !== 0) {
            singleDraw =
              singleDraw === 0 &&
              part.singleDraw === 1 &&
              part.blend === "normal" &&
              !part.container.isRenderGroup
                ? 1
                : 2;
          }
        }
      }
    }

    node.draws = draws;
    node.singleDraw =
      links.length === 0 && !node.masking && !node.clipped && node.filters.length === 0
        ? singleDraw
        : 2;
    // A stencil mask's geometry is collected into the masked object's instructions. Until both
    // belong to this branch, it must share its parent's group. A timeline mask itself also stays
    // with its siblings, though their common parent may form a group.
    if ((links.length > 0 || node.masking) && node.container.isRenderGroup) {
      this.disableRenderGroup(node.container);
    } else if (
      links.length === 0 &&
      !node.masking &&
      o.parent &&
      draws >= 64 &&
      !node.container.isRenderGroup
    ) {
      // Keep the group when its animation gets smaller, avoiding repeated batcher destruction.
      node.container.enableRenderGroup();
      const set = node.container.renderGroup?.instructionSet;
      if (set) {
        viewGroups.add(set);
      }
    }
  }

  /** Retire Pixi's per-group batches before it returns the group to its pool. */
  private disableRenderGroup(container: PixiContainer): void {
    // Its Graphics join the group above, which may not have settled; and Pixi
    // pools the group, which the next to take it must find unmarked.
    const group = container.renderGroup as unknown as Settling | null;
    if (group) {
      settle(group, false);
      group.$builtAt = undefined;
      group.$settled = undefined;
      group.$settling = undefined;
      group.$seen = undefined;
    }

    const set = container.renderGroup?.instructionSet;
    if (set) {
      // Pixi pools the group, set included, for any root it renders next.
      viewGroups.delete(set);
      retireBatchers(this.renderer, set.uid);
      set.destroy();
    }

    container.disableRenderGroup();
  }

  /**
   * The children's containers in render order, under the object's art,
   * those a timeline's mask clips in a container the mask masks, nested as
   * the masks are; the masks themselves among them, where their place in
   * the tree puts them, though not drawn.
   */
  private arrange(
    o: Container,
    node: Node,
    moved: boolean,
    masking: boolean,
    isolated: boolean,
  ): void {
    const content = node.scroll?.content ?? node.container;
    // Where no mask clips them, the children's containers are put in order where they are, those
    // that kept their places left alone: taken off and put back, each was an event of Pixi's, and
    // the render group's structure changed though its order had not.
    const inPlace =
      node.groups.length === 0 && content.children[0] === node.art && !anyClips(o.children);
    if (!inPlace) {
      for (const group of node.groups) {
        group.mask = null;
        group.destroy();
      }

      node.groups = [];
      content.removeChildren();
      content.addChild(node.art);
    }

    // Those that left the list give their lines back, all the way down; one
    // moved to another parent on the list is drawn there, perhaps already this frame.
    if (!this.fresh) {
      for (const kid of node.kids) {
        if (this.left(kid, o)) {
          this.release(kid);
        }
      }

      node.kids = [...o.children];
    }

    if (inPlace) {
      const children = o.children;
      let at = 1;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const container = this.sync(
          child,
          node.world,
          moved,
          child.placed,
          masking,
          node.color,
          isolated,
        );
        if (content.children[at] !== container) {
          content.addChildAt(container, at);
        }

        at++;
      }

      // What is left after them, those that left.
      if (content.children.length > at) {
        content.removeChildren(at);
      }

      return;
    }

    const clips = new Clips();
    const open: PixiContainer[] = [];
    for (const child of o.children) {
      open.length = clips.enter(child);
      const into = open.length > 0 ? open[open.length - 1] : content;
      const container = this.sync(
        child,
        node.world,
        moved,
        child.placed,
        masking,
        node.color,
        isolated,
      );
      into.addChild(container);
      if (child.clipDepth > 0) {
        const group = new PixiContainer();
        group.mask = container;
        into.addChild(group);
        open.push(group);
        node.groups.push(group);
      }
    }
  }

  /**
   * The object's mask, and its scroll: true where the scroll's clip came
   * or went, which moves the children. A mask's own mask, or one that is
   * the object or above it, Pixi could not draw: it is left out.
   */
  private clip(o: DisplayObject, node: Node): boolean {
    const mask = o.mask && !o.maskOf && !o.mask.encloses(o) ? o.mask : null;
    node.container.mask = mask ? this.node(mask).container : null;
    if (mask) {
      this.maskees.add(o.ref);
    }

    const moved = this.scrollClip(o, node);
    node.clipped = mask !== null || node.scroll !== null;
    return moved;
  }

  /**
   * The object's scroll, as a clip of its art and children to the
   * rectangle, which its matrix's shift has moved to its place; true where
   * the clip came or went, which moves the children.
   */
  private scrollClip(o: DisplayObject, node: Node): boolean {
    const r = o.scroll;
    const scroll = node.scroll;
    if (!r) {
      if (!scroll) {
        return false;
      }

      scroll.content.mask = null;
      node.container.addChild(...scroll.content.removeChildren());
      scroll.clip.destroy();
      scroll.content.destroy();
      node.scroll = null;
      return true;
    }

    const clip = scroll?.clip ?? new Graphics();
    clip
      .clear()
      .rect(r.xMin, r.yMin, r.xMax - r.xMin, r.yMax - r.yMin)
      .fill(0xffffff);
    if (scroll) {
      return false;
    }

    const content = new PixiContainer();
    const children = node.container.removeChildren();
    if (children.length > 0) {
      content.addChild(...children);
    }

    content.mask = clip;
    node.container.addChild(clip, content);
    node.scroll = { clip, content };
    return true;
  }

  /**
   * The masks `mask` set that are not under `root`, off the display list
   * or elsewhere on it, each in `holder` at its place in the stage's space
   * (the space a draw draws into, for a draw's), as Flash places such a
   * mask; the objects they mask synced already.
   */
  private placeMasks(root: DisplayObject, holder: PixiContainer): void {
    holder.removeChildren();
    for (const ref of this.maskees) {
      const o = ref.deref();
      const mask = o?.mask;
      if (!o || !mask) {
        this.maskees.delete(ref);
        continue;
      }

      if (root.encloses(o) && !root.encloses(mask)) {
        holder.addChild(this.sync(mask, UNIT, false, toStage(mask, null), true));
      }
    }
  }

  /** Bring the stage up to date with `root`'s display list, without drawing. */
  /** The thinnest line, in stage pixels: a pixel of the screen. */
  private get leastWidth(): number {
    return this.fresh ? 1 : 1 / (this.screenScale ?? this.renderer.resolution ?? 1);
  }

  /**
   * The renderer's units to a pixel of the stage, which Flash's filters reach in: a host showing
   * the stage larger has them reach as much further on the screen, as Flash Player's do.
   */
  private get filterUnits(): number {
    const units = this.fresh ? this.samples : this.stage.scale.x;
    // A stage scaled to nothing filters at a unit a pixel rather than not at all.
    return Number.isFinite(units) && units > 0 ? units : 1;
  }

  prepare(root: DisplayObject): void {
    this.root = root;
    this.lines.tick();
    this.shared.tick();
    const now = performance.now();
    for (const [node, since] of this.parked) {
      if (now - since < IDLE_MS) {
        break;
      }

      this.empty(node);
    }
    for (const [uid, entry] of this.parkedGroups) {
      if (now - entry.since < IDLE_MS) {
        break;
      }

      this.emptyGroup(uid, entry.group.deref());
    }

    trimPools();
    const units = this.filterUnits;
    this.rescaled = this.leastWidth !== this.strokedAt || units !== this.filteredAt;
    this.strokedAt = this.leastWidth;
    this.filteredAt = units;
    const node = this.sync(root, UNIT, false);
    this.rescaled = false;
    if (node.parent !== this.stage) {
      this.stage.removeChildren();
      this.stage.addChild(node, this.offList);
    }

    this.placeMasks(root, this.offList);
    if (!this.fresh) {
      this.settleGroups();
    }
  }

  /**
   * Batch the Graphics of each render group drawn that has not been rebuilt
   * for SETTLE_MS, and draw those of one rebuilt since alone again: walking
   * Pixi's tree of groups from the stage's, which holds those drawn and no
   * other. A group rebuilt and not settled is looked through for Graphics
   * still batched, which a branch brings along as it moves under it or
   * becomes a group of its own.
   */
  private settleGroups(): void {
    const stage = this.stage.renderGroup as unknown as Settling | null;
    if (!stage) {
      return;
    }

    const now = performance.now();
    const visit = (group: Settling) => {
      const quiet = group.$builtAt !== undefined && now - group.$builtAt >= SETTLE_MS;
      if (quiet !== !!group.$settled || (!quiet && group.$seen !== group.$builtAt)) {
        settle(group, quiet);
      }

      group.$seen = group.$builtAt;
      for (const child of group.renderGroupChildren) {
        visit(child);
      }
    };
    visit(stage);
  }

  /**
   * `o` drawn alone, as BitmapData.draw takes a display object: through `m`
   * into a w x h texture, rendered at `samples` a side and averaged on the
   * GPU, as Flash covers edges (4 at its high quality). A fresh view does
   * it, borrowing the stage's current geometry, so the stage's is untouched.
   */
  private sampled(
    o: DisplayObject,
    m: { a: number; b: number; c: number; d: number; tx: number; ty: number },
    width: number,
    height: number,
    samples: number,
  ): RenderTexture {
    const n = samples;
    const view = new PixiView(this.renderer, true, this);
    view.samples = n;
    view.drawRoot = o;
    // Built at the draw's own scale, lines included, as the stage's are,
    // then rendered n times larger: the curves are no finer than on the
    // stage, and widths and hairlines scale with the samples.
    // What the view built is destroyed, and the targets given back, though a render throws.
    const scaled = new PixiContainer();
    let target = drawTarget(width * n, height * n);
    try {
      const node = view.sync(o, [1, 0, 0, 1], true, o.scroll ? shifted(m, o.scroll) : m);
      const masks = new PixiContainer();
      scaled.addChild(node, masks);
      view.placeMasks(o, masks);
      scaled.scale.set(n);
      this.renderer.render({ container: scaled, target, clear: true });
    } catch (error) {
      releaseDrawTarget(target);
      throw error;
    } finally {
      view.dispose(scaled);
    }

    // Halved until a sample a pixel: a linear sample at the corner four texels share is their mean.
    for (let k = n; k > 1; k /= 2) {
      const half = drawTarget((width * k) / 2, (height * k) / 2);
      target.source.scaleMode = "linear";
      const sprite = new Sprite(target);
      sprite.scale.set(0.5);
      try {
        this.renderer.render({ container: sprite, target: half, clear: true });
      } catch (error) {
        releaseDrawTarget(half);
        throw error;
      } finally {
        sprite.destroy();
        releaseDrawTarget(target);
      }

      target = half;
    }

    return target;
  }

  /** `o` drawn alone, as `sampled`, read back as premultiplied ARGB. */
  snapshot(
    o: DisplayObject,
    m: { a: number; b: number; c: number; d: number; tx: number; ty: number },
    width: number,
    height: number,
    samples = 4,
  ): Uint32Array {
    const target = this.sampled(o, m, width, height, samples);
    const pixels = argbOf(this.renderer.extract.pixels(target).pixels);
    releaseDrawTarget(target);
    return pixels;
  }

  /**
   * `o` drawn into `store` on the GPU, as `sampled`, source over at (x, y)
   * with nothing read back: the store is then newer on the GPU. False,
   * having done nothing, where the store can have no texture.
   */
  drawInto(
    store: BitmapStore,
    o: DisplayObject,
    m: { a: number; b: number; c: number; d: number; tx: number; ty: number },
    x: number,
    y: number,
    width: number,
    height: number,
    samples = 4,
  ): boolean {
    const bitmaps = gpuBitmaps(this.renderer);
    const texture = bitmaps.texture(store);
    if (!texture) {
      return false;
    }

    // Into a texture of its own first: the object may show the store itself.
    const drawn = this.sampled(o, m, width, height, samples);
    const sprite = new Sprite(drawn);
    sprite.position.set(x, y);
    this.renderer.render({ container: sprite, target: texture, clear: false });
    sprite.destroy();
    releaseDrawTarget(drawn);
    bitmaps.drawn(store);
    return true;
  }

  /** Draw `root`'s display list, synced first. */
  render(root: DisplayObject): void {
    this.prepare(root);
    this.renderer.render(this.stage);
  }
}
